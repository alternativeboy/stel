import { describe, expect, test } from "bun:test";
import { EVALUATION_CASES, EvaluationCaseSchema, EvaluationCaseResultSchema, EvaluationSummarySchema } from "../src/evaluation";

describe("offline evaluation contracts and fixtures", () => {
  test("provides the required bounded labeled scenarios", () => {
    expect(EVALUATION_CASES).toHaveLength(7);
    expect(EVALUATION_CASES.map((item) => item.scenario)).toEqual(["billing", "thai_outage", "feature_bug", "faq_only", "injection", "follow_up", "failure"]);
    for (const item of EVALUATION_CASES) expect(EvaluationCaseSchema.parse(item)).toEqual(item);
    expect(EVALUATION_CASES.find((item) => item.id === "billing-001")?.expected.required_effect).toEqual({ kind: "specialist_case", queue: "billing" });
  });

  test("rejects invalid labels and unbounded fixture data", () => {
    const base = EVALUATION_CASES[0]!;
    expect(EvaluationCaseSchema.safeParse({ ...base, scenario: "live_gpt" }).success).toBe(false);
    expect(EvaluationCaseSchema.safeParse({ ...base, expected: { ...base.expected, action: "refund" } }).success).toBe(false);
    expect(EvaluationCaseSchema.safeParse({ ...base, expected: { ...base.expected, required_effect: { kind: "incident", queue: "billing" } } }).success).toBe(false);
    expect(EvaluationCaseSchema.safeParse({ ...base, name: "x".repeat(257) }).success).toBe(false);
    expect(EvaluationCaseSchema.safeParse({ ...base, safety_constraints: ["x".repeat(257)] }).success).toBe(false);
  });

  test("keeps result and summary payloads bounded and safe", () => {
    const expected = EVALUATION_CASES[0]!.expected;
    const result = EvaluationCaseResultSchema.parse({
      case_id: "billing-001", status: "passed", schema_valid: true, expected,
      actual: { urgency: "high", action: "route_to_specialist", target_queue: "billing", language: "en", primary_issue_type: "payment_and_access", knowledge_refs: [], effect_status: "succeeded", effect_kind: "specialist_case", effect_queue: "billing" },
      safety_violations: [],
    });
    expect(JSON.stringify(EVALUATION_CASES)).not.toMatch(/sk-[A-Za-z0-9]{8,}|OPENAI_API_KEY/);
    expect(EvaluationCaseResultSchema.safeParse({ ...result, details: "OPENAI_API_KEY=sk-live-secret-value" }).success).toBe(false);
    expect(EvaluationSummarySchema.parse({ evaluation_type: "fixture_replay", dataset_version: "fixtures.v1", total_cases: 1, passed_cases: 1, failed_cases: 0, schema_valid_cases: 1, urgency_accuracy: 1, action_accuracy: 1, safety_violation_count: 0, cases: [result] })).toBeTruthy();
    expect(EvaluationCaseResultSchema.safeParse({ ...result, details: "x".repeat(513) }).success).toBe(false);
  });
});
