import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fingerprintRequestBody } from "../src/idempotency";
import { DecisionSchema, TicketResponseSchema } from "../src/schemas";
import { claimFollowUpRequest, closeStorage, loadConversationHistory, openStorage, saveCompletedFollowUp } from "../src/storage";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

const decision = DecisionSchema.parse({ id: "decision-follow", turn_id: "turn-follow", schema_version: "decision.v1", urgency: "low", extracted: { product_area: "account", primary_issue_type: "question", secondary_issue_types: [], sentiment: "neutral", language: "en" }, action: "auto_respond", target_queue: null, rationale: "Guidance provided.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: false, execution: { status: "not_required" }, tool_call_ids: [], status: "completed" });

describe("SQLite follow-up persistence", () => {
  test("claims, stores, reloads, replays, and conflicts a follow-up turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-follow-storage-")); directories.push(directory); const storage = openStorage(join(directory, "service.sqlite"));
    storage.db.query("INSERT INTO conversations (id, customer_json) VALUES (?, ?)").run("conversation-follow", JSON.stringify({ plan: "pro" }));
    storage.db.query("INSERT INTO turns (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at) VALUES (?, ?, 'completed', 'mock', 'scripted', 'billing', 'decision.v1', ?)").run("turn-initial", "conversation-follow", "2026-09-11T00:00:00Z");
    storage.db.query("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) VALUES (?, ?, ?, 1, 'customer', ?, ?)").run("message-initial", "conversation-follow", "turn-initial", "Initial question", "2026-09-11T00:00:00Z");
    const body = { role: "operator" as const, content: "Please explain the decision.", timestamp: "2026-09-11T00:01:00Z" };
    const claim = { conversation_id: "conversation-follow", scope: "POST /conversations/conversation-follow/messages", key: "follow-key", fingerprint: fingerprintRequestBody(body), turn_id: "turn-follow", provider: "mock", model_adapter: "scripted", mock_scenario: "billing", decision_schema_version: "decision.v1", started_at: "2026-09-11T00:01:00Z" };
    expect(claimFollowUpRequest(storage, claim).outcome).toBe("claimed");
    const response = TicketResponseSchema.parse({ conversation_id: "conversation-follow", turn_id: "turn-follow", reply: "The decision reflects the stored evidence.", decision });
    saveCompletedFollowUp(storage, { conversation_id: "conversation-follow", request: { scope: claim.scope, key: claim.key, fingerprint: claim.fingerprint, turn_id: claim.turn_id, created_at: claim.started_at, completed_at: "2026-09-11T00:02:00Z" }, turn: { id: claim.turn_id, provider: claim.provider, model_adapter: claim.model_adapter, mock_scenario: claim.mock_scenario, decision_schema_version: claim.decision_schema_version, started_at: claim.started_at, completed_at: "2026-09-11T00:02:00Z" }, message: { id: "message-follow", ...body }, response });
    const replay = claimFollowUpRequest(storage, claim); expect(replay.outcome).toBe("replay"); if (replay.outcome === "replay") expect(replay.response).toEqual(response);
    expect(claimFollowUpRequest(storage, { ...claim, turn_id: "turn-other", fingerprint: fingerprintRequestBody({ ...body, content: "different" }) }).outcome).toBe("conflict");
    const history = loadConversationHistory(storage, "conversation-follow"); expect(history.messages.map((message) => message.role)).toEqual(["customer", "operator", "assistant"]); expect(history.messages[1]?.content).toBe(body.content); expect(history.decisions).toHaveLength(1);
    closeStorage(storage);
  });

  test("rejects a second claimed turn while one is active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-follow-active-")); directories.push(directory); const storage = openStorage(join(directory, "service.sqlite")); storage.db.query("INSERT INTO conversations (id, customer_json) VALUES (?, ?)").run("conversation-active", JSON.stringify({ plan: "free" }));
    const claim = { conversation_id: "conversation-active", scope: "follow", key: "active-one", fingerprint: fingerprintRequestBody({ role: "customer", content: "Still broken", timestamp: "2026-09-11T00:00:00Z" }), turn_id: "turn-active", provider: "mock", model_adapter: "scripted", mock_scenario: "billing", decision_schema_version: "decision.v1", started_at: "2026-09-11T00:00:00Z" };
    expect(claimFollowUpRequest(storage, claim).outcome).toBe("claimed"); expect(claimFollowUpRequest(storage, { ...claim, key: "active-two", turn_id: "turn-active-2" }).outcome).toBe("conflict"); closeStorage(storage);
  });
});
