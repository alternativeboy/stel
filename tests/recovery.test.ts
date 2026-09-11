import { describe, expect, test } from "bun:test";
import { RecoveryResultSchema, RecoverySummarySchema } from "../src/recovery";

const references = { request_id: "req-1", conversation_id: "conv-1", turn_id: "turn-1" };

describe("recovery contracts", () => {
  test("accepts each documented interruption classification", () => {
    expect(RecoveryResultSchema.parse({ classification: "accepted_no_plan", outcome: "finalized_degraded", references, effect_status: "not_applicable" })).toBeTruthy();
    expect(RecoveryResultSchema.parse({ classification: "frozen_plan_before_effect", outcome: "unresolved", references, effect_status: "unknown" })).toBeTruthy();
    expect(RecoveryResultSchema.parse({ classification: "effect_committed_before_response", outcome: "effect_reused", references: { ...references, work_item_id: "wi-1" }, effect_status: "succeeded" })).toBeTruthy();
    expect(RecoveryResultSchema.parse({ classification: "already_completed", outcome: "already_completed", references, effect_status: "not_applicable" })).toBeTruthy();
  });

  test("rejects invalid transitions and distinguishes unknown effects", () => {
    expect(RecoveryResultSchema.safeParse({ classification: "accepted_no_plan", outcome: "already_completed", references, effect_status: "not_applicable" }).success).toBe(false);
    expect(RecoveryResultSchema.safeParse({ classification: "frozen_plan_before_effect", outcome: "effect_reused", references, effect_status: "unknown" }).success).toBe(false);
    expect(RecoveryResultSchema.safeParse({ classification: "frozen_plan_before_effect", outcome: "unresolved", references, effect_status: "failed" }).success).toBe(false);
  });

  test("keeps summaries bounded and diagnostics secret-free", () => {
    const result = RecoveryResultSchema.parse({ classification: "accepted_no_plan", outcome: "finalized_degraded", references, effect_status: "not_applicable", details: "Manual triage was finalized." });
    expect(RecoverySummarySchema.parse({ recovery_version: "recovery.v1", scanned: 1, finalized: 1, unresolved: 0, results: [result] })).toBeTruthy();
    expect(RecoverySummarySchema.safeParse({ recovery_version: "recovery.v1", scanned: 2, finalized: 1, unresolved: 0, results: [result] }).success).toBe(false);
    expect(RecoveryResultSchema.safeParse({ ...result, details: "OPENAI_API_KEY=sk-live-secret-value" }).success).toBe(false);
    expect(RecoveryResultSchema.safeParse({ ...result, references: { ...references, request_id: "not safe/id" } }).success).toBe(false);
  });
});

