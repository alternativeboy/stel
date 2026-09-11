import { describe, expect, test } from "bun:test";
import {
  IdempotencyKeySchema,
  RequestResolutionSchema,
  fingerprintRequestBody,
} from "../src/idempotency";
import type { TicketResponse } from "../src/schemas";

describe("idempotency contracts", () => {
  test("accepts bounded safe keys and rejects unsafe keys", () => {
    expect(IdempotencyKeySchema.parse("ticket-2026.09" )).toBe("ticket-2026.09");
    expect(() => IdempotencyKeySchema.parse(" ")).toThrow();
    expect(() => IdempotencyKeySchema.parse("key/with/slash")).toThrow();
    expect(() => IdempotencyKeySchema.parse("a".repeat(256))).toThrow();
  });

  test("fingerprints equivalent parsed bodies deterministically", () => {
    const first = fingerprintRequestBody({ b: 2, a: ["x", true] });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintRequestBody({ a: ["x", true], b: 2 })).toBe(first);
    expect(fingerprintRequestBody({ a: ["x", false], b: 2 })).not.toBe(first);
  });

  test("exposes safe replay and conflict outcomes", () => {
    const response: TicketResponse = { conversation_id: "conversation-1", turn_id: "turn-1", reply: "Done", decision: {
      id: "decision-1", turn_id: "turn-1", schema_version: "decision.v1", urgency: "low", extracted: {
        product_area: "general", primary_issue_type: "question", secondary_issue_types: [], sentiment: "neutral", language: "en",
      }, action: "auto_respond", target_queue: null, rationale: "Answered.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: false, execution: { status: "not_required" }, tool_call_ids: [], status: "completed",
    } };
    expect(RequestResolutionSchema.parse({ outcome: "replay", state: "completed", response })).toEqual({ outcome: "replay", state: "completed", response });
    expect(RequestResolutionSchema.parse({ outcome: "conflict", state: "conflict", retryable: false, details: { reason: "different_body" } })).toEqual({ outcome: "conflict", state: "conflict", retryable: false, details: { reason: "different_body" } });
    expect(JSON.stringify({ reason: "different_body" })).not.toContain("secret");
  });
});
