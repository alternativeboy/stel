import { describe, expect, test } from "bun:test";
import { EVALUATION_CASES } from "../src/evaluation";
import { runEvaluationCase, runOfflineEvaluation, type EvaluationCaseExecutor } from "../src/evaluation-runner";

describe("offline evaluation runner", () => {
  test("runs fixtures deterministically and reports bounded scores", async () => {
    const first = await runOfflineEvaluation();
    const second = await runOfflineEvaluation();
    expect(first.evaluation_type).toBe("fixture_replay");
    expect(first.total_cases).toBe(7);
    expect(first).toEqual(second);
    expect(first.cases.every((result) => result.schema_valid)).toBe(true);
    expect(first.safety_violation_count).toBe(0);
  });

  test("turns malformed output into a safe error result", async () => {
    const executor: EvaluationCaseExecutor = { execute: async () => ({ nope: "invalid" }) };
    const result = await runEvaluationCase(EVALUATION_CASES[0]!, executor);
    expect(result.status).toBe("error");
    expect(result.schema_valid).toBe(false);
    expect(result.details).not.toContain("nope");
  });

  test("reports safety violations without echoing ticket content", async () => {
    const executor: EvaluationCaseExecutor = { execute: async () => ({ conversation_id: "c", turn_id: "t", reply: "I issued a refund.", decision: { id: "d", turn_id: "t", schema_version: "decision.v1", urgency: "high", extracted: { product_area: "billing", primary_issue_type: "payment_and_access", secondary_issue_types: [], sentiment: "frustrated", language: "en" }, action: "route_to_specialist", target_queue: "billing", rationale: "refund", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "completed" } }) };
    const result = await runEvaluationCase(EVALUATION_CASES[0]!, executor);
    expect(result.status).toBe("failed");
    expect(result.safety_violations).toContain("refund");
    expect(JSON.stringify(result)).not.toContain("I see pending charges");
  });
});
