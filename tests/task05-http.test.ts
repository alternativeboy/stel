import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createRequestHandler } from "../src/app";
import { createMockWorkItemExecutor, type WorkItemEffectExecutor } from "../src/effects";
import { createScriptedBillingAdapter, type ModelAdapter } from "../src/model";
import { createLocalKnowledgeBase, createLocalServiceStatus } from "../src/read-tool-adapters";
import { ConversationReadSchema, TicketIngestSchema, TicketResponseSchema } from "../src/schemas";
import { closeStorage, openStorage } from "../src/storage";
import { createTriageApplication } from "../src/triage";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));
const body = { customer: { plan: "pro" }, messages: [{ role: "customer", content: "Three pending charges and no Pro access.", timestamp: "2026-09-11T00:00:00Z" }] };

function request(key: string) { return new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) }); }
function toolModel(decisionPatch: Record<string, unknown> = {}, effectInput = { kind: "specialist_case", queue: "billing" }) {
  const scripted = createScriptedBillingAdapter();
  return { ...scripted, async propose(context: Parameters<ModelAdapter["propose"]>[0]) {
    const proposal = await scripted.propose(context);
    return context.tool_results?.length ? { ...proposal, decision: { ...proposal.decision, ...decisionPatch } } : { ...proposal, decision: { ...proposal.decision, ...decisionPatch }, tool_requests: [{ id: "effect-http", name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", ...effectInput, title: "Specialist review", summary: "Investigate the reported support issue.", evidence_refs: [] } }] };
  } } satisfies ModelAdapter;
}

describe("Task 05 HTTP integration", () => {
  test("returns a receipt and reconstructs it after restart; replay creates no duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-05-http-")); directories.push(directory); const path = join(directory, "service.sqlite");
    const storage = openStorage(path); const app = createTriageApplication({ storage, model: toolModel(), effect: createMockWorkItemExecutor(storage), knowledge: createLocalKnowledgeBase(), status: createLocalServiceStatus() });
    const logs: unknown[] = []; const loggedHandler = createRequestHandler((record) => logs.push(record), app);
    const created = await loggedHandler(request("http-effect")); expect(created.status).toBe(201); const response = TicketResponseSchema.parse(await created.json()); expect(response.decision.execution.status).toBe("succeeded");
    expect(JSON.parse(JSON.stringify(logs[0]))).toMatchObject({ event: "request_completed", method: "POST", status: 201 }); expect(JSON.stringify(logs[0])).not.toContain("Three pending charges");
    const replay = await loggedHandler(request("http-effect")); expect(replay.status).toBe(201); expect(await replay.json()).toEqual(response); closeStorage(storage);
    const reopened = openStorage(path); const restarted = createRequestHandler(() => {}, createTriageApplication({ storage: reopened, model: toolModel(), effect: createMockWorkItemExecutor(reopened) })); const read = ConversationReadSchema.parse(await (await restarted(new Request(`http://localhost/conversations/${response.conversation_id}`))).json());
    expect(read.effects).toHaveLength(1); expect(read.effects[0]?.queue).toBe("billing"); expect(read.effects[0]?.receipt?.work_item_id).toBe(response.decision.execution.work_item_id!);
    expect(read.decisions[0]?.execution).toEqual({ status: "succeeded", work_item_id: response.decision.execution.work_item_id });
    expect(read.effects[0]?.attempts[0]).toMatchObject({ status: "succeeded", tool_call_id: "effect-http" }); closeStorage(reopened);
  });

  test("maps critical operations to an incident and keeps failed effects unconfirmed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-05-critical-")); directories.push(directory); const path = join(directory, "service.sqlite"); const storage = openStorage(path);
    const critical = createTriageApplication({ storage, model: toolModel({ urgency: "critical", action: "escalate_to_human", target_queue: "operations" }, { kind: "incident", queue: "operations" }), effect: createMockWorkItemExecutor(storage) }); const result = TicketResponseSchema.parse(await (await createRequestHandler(() => {}, critical)(request("critical-effect"))).json()); expect(result.decision.execution.status).toBe("succeeded"); closeStorage(storage);
    const failedStorage = openStorage(join(directory, "failed.sqlite")); const failing: WorkItemEffectExecutor = { ensure: async () => ({ tool: "ensure_work_item", version: "v1", status: "failed", error: { code: "mock_failure", message: "Effect unavailable." } }) }; const failed = await createRequestHandler(() => {}, createTriageApplication({ storage: failedStorage, model: toolModel(), effect: failing }))(request("failed-effect")); const failedBody = TicketResponseSchema.parse(await failed.json()); expect(failed.status).toBe(201); expect(failedBody.decision.execution).toEqual({ status: "failed" }); closeStorage(failedStorage);
    const policyStorage = openStorage(join(directory, "policy.sqlite")); const policy = await createRequestHandler(() => {}, createTriageApplication({ storage: policyStorage, model: toolModel({ action: "auto_respond", target_queue: null, requires_human: false }), effect: createMockWorkItemExecutor(policyStorage) }))(request("policy-effect")); const policyBody = TicketResponseSchema.parse(await policy.json()); expect(policy.status).toBe(201); expect(policyBody.decision.action).toBe("escalate_to_human"); expect(policyBody.decision.target_queue).toBe("manual_triage"); closeStorage(policyStorage);
    let invoked = false; const guardedStorage = openStorage(join(directory, "guarded.sqlite")); const guardedEffect: WorkItemEffectExecutor = { ensure: async () => { invoked = true; return { tool: "ensure_work_item", version: "v1", status: "succeeded", receipt: { work_item_id: "wi-guarded", status: "succeeded", created_at: "2026-09-11T00:00:00Z", reused: false } }; } }; const guarded = await createRequestHandler(() => {}, createTriageApplication({ storage: guardedStorage, model: toolModel({ action: "auto_respond", target_queue: null, requires_human: false }), effect: guardedEffect }))(request("guarded-effect")); expect(guarded.status).toBe(201); expect(invoked).toBe(false); closeStorage(guardedStorage);
  });
});
