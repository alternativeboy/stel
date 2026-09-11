import { describe, expect, test } from "bun:test";
import { FollowUpDegradedOutcomeSchema, FollowUpFailureSchema, FollowUpMessageSchema, MAX_FOLLOW_UP_MESSAGE_CHARACTERS } from "../src/follow-up";

describe("follow-up contracts", () => {
  test("accepts operator and customer messages while preserving timestamps", () => {
    const timestamp = "2026-09-11T08:00:00+07:00";
    expect(FollowUpMessageSchema.parse({ role: "operator", content: "Why was this escalated?", timestamp }).timestamp).toBe(timestamp);
    expect(FollowUpMessageSchema.parse({ role: "customer", content: "The issue is still present.", timestamp }).role).toBe("customer");
  });

  test("rejects invalid role, empty/oversized content, and timezone-less timestamps", () => {
    const valid = { role: "operator", content: "Question", timestamp: "2026-09-11T08:00:00Z" };
    expect(FollowUpMessageSchema.safeParse({ ...valid, role: "assistant" }).success).toBe(false);
    expect(FollowUpMessageSchema.safeParse({ ...valid, content: " " }).success).toBe(false);
    expect(FollowUpMessageSchema.safeParse({ ...valid, content: "x".repeat(MAX_FOLLOW_UP_MESSAGE_CHARACTERS + 1) }).success).toBe(false);
    expect(FollowUpMessageSchema.safeParse({ ...valid, timestamp: "2026-09-11T08:00:00" }).success).toBe(false);
  });

  test("keeps failure details bounded and does not echo message bodies", () => {
    const failure = FollowUpFailureSchema.parse({ status: "error", error: { code: "conversation_not_found", message: "Conversation was not found.", details: { conversation_id: "conversation-1" } } });
    expect(JSON.stringify(failure)).not.toContain("secret customer message");
    expect(FollowUpFailureSchema.safeParse({ status: "error", error: { code: "invalid_input", message: "Invalid follow-up.", details: { body: "secret customer message" } } }).success).toBe(false);
  });

  test("represents a bounded degraded outcome using the existing response contract", () => {
    expect(FollowUpDegradedOutcomeSchema.parse({ status: "degraded", reason: "Model response was unavailable.", response: { conversation_id: "conversation-1", turn_id: "turn-1", reply: "A human operator is needed.", decision: { id: "decision-1", turn_id: "turn-1", schema_version: "decision.v1", urgency: "high", extracted: { product_area: "unknown", primary_issue_type: "unknown", secondary_issue_types: [], sentiment: "unknown", language: "en" }, action: "escalate_to_human", target_queue: "manual_triage", rationale: "Manual review is required.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "degraded" } } }).status).toBe("degraded");
  });
});
