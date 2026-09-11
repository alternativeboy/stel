import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { closeStorage, loadConversation, openStorage } from "../src/storage";
import { TicketIngestSchema } from "../src/schemas";
import { createTriageApplication } from "../src/triage";
import { createScriptedBillingAdapter } from "../src/model";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

const ticket = TicketIngestSchema.parse({
  customer: { plan: "pro", region: "Thailand", seats: 3 },
  messages: [
    { role: "customer", content: "I see three pending charges and lost Pro access before my presentation.", timestamp: "2026-09-11T08:00:00+07:00" },
    { role: "support", content: "I understand this is urgent; I will document the billing concern.", timestamp: "2026-09-11T08:01:00+07:00" },
  ],
});

describe("initial triage application", () => {
  test("produces and persists the scripted billing decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-triage-"));
    directories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    const app = createTriageApplication({ storage, model: createScriptedBillingAdapter() });

    const response = await app.ingest(ticket);
    expect(response.decision.urgency).toBe("high");
    expect(response.decision.extracted).toMatchObject({ product_area: "billing", primary_issue_type: "payment_and_access", sentiment: "frustrated", language: "en" });
    expect(response.decision.action).toBe("route_to_specialist");
    expect(response.decision.target_queue).toBe("billing");
    expect(response.decision.execution).toEqual({ status: "unknown" });
    expect(response.decision.knowledge_refs).toEqual([]);
    expect(response.decision.tool_call_ids).toEqual([]);
    expect(`${response.reply} ${response.decision.rationale}`.toLowerCase()).not.toMatch(/refund|reversed charge|restored pro|created (a )?work item|receipt/);

    closeStorage(storage);
    const reopened = openStorage(join(directory, "service.sqlite"));
    const saved = loadConversation(reopened, response.conversation_id);
    expect(saved.turn.provider).toBe("mock");
    expect(saved.turn.model_adapter).toBe("scripted-billing-v1");
    expect(saved.turn.mock_scenario).toBe("billing");
    expect(saved.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp }))).toEqual(ticket.messages);
    expect(saved.reply).toBe(response.reply);
    closeStorage(reopened);
  });
});
