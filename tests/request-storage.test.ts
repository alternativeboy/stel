import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fingerprintRequestBody } from "../src/idempotency";
import { claimRequest, closeStorage, completeRequest, loadRequest, openStorage } from "../src/storage";
import type { TicketResponse } from "../src/schemas";

const dirs: string[] = [];
afterEach(async () => await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true }))));

describe("SQLite request claims", () => {
  test("claims, replays, conflicts, and reloads cached responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-request-")); dirs.push(directory); const path = join(directory, "service.sqlite");
    const storage = openStorage(path);
    const fingerprint = fingerprintRequestBody({ ticket: "billing" });
    const initial = { customer: { plan: "pro" }, provider: "mock", model_adapter: "test", mock_scenario: "billing", decision_schema_version: "decision.v1", started_at: "2026-09-11T00:00:00Z" };
    expect(claimRequest(storage, { scope: "POST /tickets", key: "request-1", fingerprint, conversation_id: "conversation-claim", turn_id: "turn-claim", initial })).toEqual({ outcome: "claimed", state: "processing", turn_id: "turn-claim" });
    expect(claimRequest(storage, { scope: "POST /tickets", key: "request-1", fingerprint, conversation_id: "conversation-claim", turn_id: "another-turn" })).toEqual({ outcome: "conflict", state: "conflict", retryable: true, details: { reason: "processing" } });
    const response: TicketResponse = { conversation_id: "conversation-claim", turn_id: "turn-claim", reply: "Queued for review.", decision: { id: "decision-claim", turn_id: "turn-claim", schema_version: "decision.v1", urgency: "high", extracted: { product_area: "billing", primary_issue_type: "question", secondary_issue_types: [], sentiment: "neutral", language: "en" }, action: "route_to_specialist", target_queue: "billing", rationale: "Needs review.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "completed" } };
    completeRequest(storage, "POST /tickets", "request-1", response);
    expect(claimRequest(storage, { scope: "POST /tickets", key: "request-1", fingerprint, conversation_id: "conversation-claim", turn_id: "another-turn" })).toMatchObject({ outcome: "replay", state: "completed", response });
    expect(claimRequest(storage, { scope: "POST /tickets", key: "request-1", fingerprint: fingerprintRequestBody({ ticket: "other" }), conversation_id: "conversation-claim", turn_id: "another-turn" })).toEqual({ outcome: "conflict", state: "conflict", retryable: false, details: { reason: "different_body" } });
    closeStorage(storage);
    const reopened = openStorage(path); expect(loadRequest(reopened, "POST /tickets", "request-1")?.cached_response).toEqual(response); closeStorage(reopened);
  });
});
