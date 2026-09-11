import { describe, expect, test } from "bun:test";
import { DecisionSchema } from "../src/schemas";
import { deriveOperationIdentity, EnsureWorkItemInputSchema, EnsureWorkItemResultSchema, evaluatePolicy, PolicyOutcomeSchema } from "../src/policy-effects";

const decision = (overrides: Record<string, unknown> = {}) => DecisionSchema.parse({
  id: "decision-1", turn_id: "turn-1", schema_version: "decision.v1", urgency: "high",
  extracted: { product_area: "billing", primary_issue_type: "payment", secondary_issue_types: [], sentiment: "frustrated", language: "en" },
  action: "route_to_specialist", target_queue: "billing", rationale: "Human review is needed.", evidence: [{ message_id: "message-1", summary: "Customer reports a billing concern." }], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "completed", ...overrides,
});

describe("policy and effect contracts", () => {
  test("accepts billing and operations work-item intents without server IDs", () => {
    const billing = EnsureWorkItemInputSchema.parse({ tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate reported pending charges.", evidence_refs: [{ message_id: "message-1", summary: "Pending charges reported." }] });
    expect(billing).not.toHaveProperty("conversation_id");
    expect(EnsureWorkItemInputSchema.parse({ ...billing, kind: "incident", queue: "operations" }).queue).toBe("operations");
  });

  test("rejects invalid fields and unsafe effect results", () => {
    expect(EnsureWorkItemInputSchema.safeParse({ tool: "ensure_work_item", version: "v1", kind: "refund", queue: "billing", title: "x", summary: "x", evidence_refs: [] }).success).toBe(false);
    expect(EnsureWorkItemInputSchema.safeParse({ tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "", summary: "x", evidence_refs: [] }).success).toBe(false);
    expect(EnsureWorkItemResultSchema.safeParse({ tool: "ensure_work_item", version: "v1", status: "succeeded", receipt: { work_item_id: "wi-1", status: "succeeded", created_at: "2026-09-11T00:00:00Z", reused: false } }).success).toBe(true);
    const failure = EnsureWorkItemResultSchema.parse({ tool: "ensure_work_item", version: "v1", status: "failed", error: { code: "effect_unavailable", message: "The mock effect is unavailable." } });
    expect(JSON.stringify(failure)).not.toContain("secret-customer-body");
  });

  test("derives stable operation identity and applies deterministic policy", () => {
    expect(deriveOperationIdentity("conversation-1", "specialist_case", "billing")).toEqual(deriveOperationIdentity("conversation-1", "specialist_case", "billing"));
    expect(evaluatePolicy(decision())).toMatchObject({ status: "accepted", override: null });
    expect(evaluatePolicy(decision({ urgency: "critical", action: "route_to_specialist" }))).toMatchObject({ status: "rejected", override: { action: "escalate_to_human", target_queue: "manual_triage" } });
    expect(evaluatePolicy(decision({ action: "auto_respond", target_queue: null, requires_human: false }))).toMatchObject({ status: "accepted" });
    expect(PolicyOutcomeSchema.parse(evaluatePolicy(decision({ action: "escalate_to_human", target_queue: null, requires_human: true })))).toMatchObject({ status: "rejected" });
  });
});
