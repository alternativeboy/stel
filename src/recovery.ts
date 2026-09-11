import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const safeText = z.string().trim().min(1).max(256).refine((value) => !/(?:sk-[A-Za-z0-9]{8,}|OPENAI_API_KEY|authorization)/i.test(value), "must not contain secrets");

export const RecoveryClassificationSchema = z.enum([
  "accepted_no_plan",
  "frozen_plan_before_effect",
  "effect_committed_before_response",
  "already_completed",
]);

export const RecoveryEffectStatusSchema = z.enum([
  "not_applicable",
  "succeeded",
  "failed",
  "unknown",
]);

export const RecoveryOutcomeSchema = z.enum([
  "finalized_degraded",
  "effect_reused",
  "response_finalized",
  "already_completed",
  "unresolved",
]);

export const RecoveryReferencesSchema = z.object({
  request_id: identifier,
  conversation_id: identifier,
  turn_id: identifier,
  decision_id: identifier.optional(),
  effect_id: identifier.optional(),
  work_item_id: identifier.optional(),
  receipt_id: identifier.optional(),
}).strict();

export const RecoveryResultSchema = z.object({
  classification: RecoveryClassificationSchema,
  outcome: RecoveryOutcomeSchema,
  references: RecoveryReferencesSchema,
  effect_status: RecoveryEffectStatusSchema,
  details: safeText.max(512).optional(),
}).strict().superRefine((result, context) => {
  if (result.classification === "accepted_no_plan" && result.outcome !== "finalized_degraded") context.addIssue({ code: "custom", message: "accepted_no_plan must finalize as degraded" });
  if (result.classification === "frozen_plan_before_effect" && result.outcome !== "effect_reused" && result.outcome !== "unresolved") context.addIssue({ code: "custom", message: "frozen plans may only reuse or remain unresolved" });
  if (result.classification === "effect_committed_before_response" && result.outcome !== "effect_reused" && result.outcome !== "response_finalized") context.addIssue({ code: "custom", message: "committed effects must be reused or finalized" });
  if (result.classification === "already_completed" && result.outcome !== "already_completed") context.addIssue({ code: "custom", message: "completed requests remain completed" });
  if (result.outcome === "effect_reused" && result.effect_status !== "succeeded") context.addIssue({ code: "custom", message: "effect_reused requires a succeeded effect" });
  if (result.outcome === "unresolved" && result.effect_status !== "unknown") context.addIssue({ code: "custom", message: "unresolved recovery requires unknown effect status" });
});

export const RecoverySummarySchema = z.object({
  recovery_version: z.literal("recovery.v1"),
  scanned: z.number().int().nonnegative(),
  finalized: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  results: z.array(RecoveryResultSchema).max(128),
}).strict().superRefine((summary, context) => {
  if (summary.scanned !== summary.results.length) context.addIssue({ code: "custom", message: "scanned must match result count" });
  if (summary.finalized + summary.unresolved > summary.scanned) context.addIssue({ code: "custom", message: "summary counts exceed scanned requests" });
});

export type RecoveryClassification = z.infer<typeof RecoveryClassificationSchema>;
export type RecoveryEffectStatus = z.infer<typeof RecoveryEffectStatusSchema>;
export type RecoveryOutcome = z.infer<typeof RecoveryOutcomeSchema>;
export type RecoveryReferences = z.infer<typeof RecoveryReferencesSchema>;
export type RecoveryResult = z.infer<typeof RecoveryResultSchema>;
export type RecoverySummary = z.infer<typeof RecoverySummarySchema>;

