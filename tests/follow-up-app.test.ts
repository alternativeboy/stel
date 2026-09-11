import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createScriptedBillingAdapter, type ModelAdapter } from "../src/model";
import { TicketIngestSchema, TicketResponseSchema } from "../src/schemas";
import { closeStorage, openStorage } from "../src/storage";
import { createTriageApplication } from "../src/triage";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

test("continueConversation stores operator/customer turns and replays without rerunning the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stel-follow-app-")); directories.push(directory); const storage = openStorage(join(directory, "service.sqlite"));
  const scripted = createScriptedBillingAdapter(); let calls = 0;
  const model: ModelAdapter = { ...scripted, async propose(context) { calls += 1; const proposal = await scripted.propose(context); return { ...proposal, decision: { ...proposal.decision, turn_id: context.turn_id, action: "auto_respond", target_queue: null, requires_human: false, execution: { status: "not_required" }, urgency: "low" } }; } };
  const app = createTriageApplication({ storage, model });
  const initial = await app.ingest(TicketIngestSchema.parse({ customer: { plan: "pro" }, messages: [{ role: "customer", content: "I need billing context.", timestamp: "2026-09-11T00:00:00Z" }] }), { scope: "POST /tickets", key: "follow-initial" });
  calls = 0;
  const message = { role: "operator" as const, content: "Why was this escalated?", timestamp: "2026-09-11T00:01:00Z" };
  const response = await app.continueConversation(initial.conversation_id, message, { scope: `POST /conversations/${initial.conversation_id}/messages`, key: "follow-one" });
  expect(TicketResponseSchema.parse(response).decision.action).toBe("auto_respond");
  const replay = await app.continueConversation(initial.conversation_id, message, { scope: `POST /conversations/${initial.conversation_id}/messages`, key: "follow-one" });
  expect(replay).toEqual(response); expect(calls).toBe(1);
  closeStorage(storage);
});
