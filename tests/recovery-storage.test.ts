import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DecisionSchema } from "../src/schemas";
import { createOrReuseWorkItem, recordEffectAttempt, completeEffectAttempt, claimRequest, closeStorage, finalizeInterruptedNoPlan, finalizeRecoveredResponse, inspectInterruptedRequests, openStorage } from "../src/storage";
import { deriveOperationIdentity } from "../src/policy-effects";
import { TicketResponseSchema } from "../src/schemas";

const dirs: string[] = [];
afterEach(async () => await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true }))));

async function processingStorage() {
  const directory = await mkdtemp(join(tmpdir(), "stel-recovery-storage-")); dirs.push(directory);
  const storage = openStorage(join(directory, "service.sqlite"));
  claimRequest(storage, { scope: "POST /tickets", key: "recovery-key", fingerprint: "a".repeat(64), conversation_id: "conv-recovery", turn_id: "turn-recovery", initial: { customer: { plan: "pro" }, provider: "mock", model_adapter: "scripted", mock_scenario: "billing", decision_schema_version: "decision.v1", started_at: "2026-01-01T00:00:00Z" } });
  const request = inspectInterruptedRequests(storage)[0]!;
  return { directory, storage, request };
}

describe("SQLite recovery boundary", () => {
  test("inspects and atomically finalizes accepted-no-plan, then is idempotent after restart", async () => {
    const { directory, storage, request } = await processingStorage();
    expect(request.classification).toBe("accepted_no_plan");
    const finalized = finalizeInterruptedNoPlan(storage, request.references.request_id);
    expect(finalized.outcome).toBe("finalized_degraded");
    closeStorage(storage);
    const reopened = openStorage(join(directory, "service.sqlite"));
    expect(inspectInterruptedRequests(reopened)).toHaveLength(0);
    expect(finalizeInterruptedNoPlan).toBeDefined();
    closeStorage(reopened);
  });

  test("classifies frozen plans and unknown effects without claiming success", async () => {
    const { storage, request } = await processingStorage();
    const decision = DecisionSchema.parse({ id: "decision-frozen", turn_id: request.references.turn_id, schema_version: "decision.v1", urgency: "high", extracted: { product_area: "billing", primary_issue_type: "payment_and_access", secondary_issue_types: [], sentiment: "frustrated", language: "en" }, action: "route_to_specialist", target_queue: "billing", rationale: "Human billing review is needed.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "completed" });
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?)").run(decision.id, decision.turn_id, decision.schema_version, JSON.stringify(decision), "2026-01-01T00:01:00Z");
    createOrReuseWorkItem(storage, deriveOperationIdentity("conv-recovery", "specialist_case", "billing"), { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate billing.", evidence_refs: [] });
    const inspected = inspectInterruptedRequests(storage)[0]!;
    expect(inspected.classification).toBe("frozen_plan_before_effect");
    expect(inspected.effect_status).toBe("unknown");
    const unresolved = finalizeRecoveredResponse(storage, request.references.request_id, TicketResponseSchema.parse({ conversation_id: "conv-recovery", turn_id: request.references.turn_id, reply: "Recovery requires human review.", decision }));
    expect(unresolved.outcome).toBe("unresolved");
    closeStorage(storage);
  });

  test("reuses a committed receipt and finalizes the cached response once", async () => {
    const { storage, request } = await processingStorage();
    const decision = DecisionSchema.parse({ id: "decision-committed", turn_id: request.references.turn_id, schema_version: "decision.v1", urgency: "high", extracted: { product_area: "billing", primary_issue_type: "payment_and_access", secondary_issue_types: [], sentiment: "frustrated", language: "en" }, action: "route_to_specialist", target_queue: "billing", rationale: "Human billing review is needed.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "completed" });
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?)").run(decision.id, decision.turn_id, decision.schema_version, JSON.stringify(decision), "2026-01-01T00:01:00Z");
    const item = createOrReuseWorkItem(storage, deriveOperationIdentity("conv-recovery", "specialist_case", "billing"), { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate billing.", evidence_refs: [] });
    const attempt = recordEffectAttempt(storage, { id: "attempt-recovery", work_item_id: item.workItem.id, turn_id: request.references.turn_id, tool_call_id: "effect-recovery", started_at: "2026-01-01T00:02:00Z" });
    completeEffectAttempt(storage, attempt.id, { tool: "ensure_work_item", version: "v1", status: "succeeded", receipt: { work_item_id: item.workItem.id, status: "succeeded", created_at: "2026-01-01T00:02:00Z", reused: false } });
    const response = TicketResponseSchema.parse({ conversation_id: "conv-recovery", turn_id: request.references.turn_id, reply: "Your billing case is under human review.", decision: { ...decision, execution: { status: "succeeded", work_item_id: item.workItem.id } } });
    const result = finalizeRecoveredResponse(storage, request.references.request_id, response);
    expect(result.outcome).toBe("effect_reused");
    expect(inspectInterruptedRequests(storage)).toHaveLength(0);
    closeStorage(storage);
  });
});

