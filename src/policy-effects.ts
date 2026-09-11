import { z } from "zod";
import { DecisionSchema, type Decision } from "./schemas";

const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.string().datetime({ offset: true });

export const ENSURE_WORK_ITEM = "ensure_work_item" as const;
export const EFFECT_VERSION = "v1" as const;
export const WorkItemKindSchema = z.enum(["specialist_case", "incident"]);
export const WorkItemQueueSchema = z.enum(["billing", "product_support", "operations", "manual_triage"]);

export const WorkItemEvidenceReferenceSchema = z.object({
  message_id: identifier,
  summary: nonEmpty.max(512),
}).strict();

export const EnsureWorkItemInputSchema = z.object({
  tool: z.literal(ENSURE_WORK_ITEM),
  version: z.literal(EFFECT_VERSION),
  kind: WorkItemKindSchema,
  queue: WorkItemQueueSchema,
  title: nonEmpty.max(256),
  summary: nonEmpty.max(2_000),
  evidence_refs: z.array(WorkItemEvidenceReferenceSchema).max(32),
}).strict();

export const OperationIdentitySchema = z.object({
  conversation_id: identifier,
  kind: WorkItemKindSchema,
  queue: WorkItemQueueSchema,
  operation_key: identifier.max(512),
}).strict();

export const EffectStatusSchema = z.enum(["pending", "succeeded", "failed", "unknown"]);
export const ConfirmedReceiptSchema = z.object({
  work_item_id: identifier,
  status: z.literal("succeeded"),
  created_at: timestamp,
  reused: z.boolean(),
}).strict();

export const EffectSuccessSchema = z.object({
  tool: z.literal(ENSURE_WORK_ITEM),
  version: z.literal(EFFECT_VERSION),
  status: z.enum(["succeeded", "reused"]),
  receipt: ConfirmedReceiptSchema,
}).strict();
export const EffectFailureSchema = z.object({
  tool: z.literal(ENSURE_WORK_ITEM),
  version: z.literal(EFFECT_VERSION),
  status: z.enum(["failed", "unknown"]),
  error: z.object({ code: nonEmpty.max(64), message: nonEmpty.max(256) }).strict(),
}).strict();
export const EnsureWorkItemResultSchema = z.union([EffectSuccessSchema, EffectFailureSchema]);

export const PolicyOverrideSchema = z.object({
  reason: nonEmpty.max(256),
  action: z.literal("escalate_to_human"),
  target_queue: z.literal("manual_triage"),
}).strict();
export const PolicyAcceptedSchema = z.object({
  status: z.literal("accepted"),
  reason: nonEmpty.max(256),
  override: z.null(),
}).strict();
export const PolicyRejectedSchema = z.object({
  status: z.literal("rejected"),
  reason: nonEmpty.max(256),
  override: PolicyOverrideSchema,
}).strict();
export const PolicyOutcomeSchema = z.union([PolicyAcceptedSchema, PolicyRejectedSchema]);

export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;
export type WorkItemQueue = z.infer<typeof WorkItemQueueSchema>;
export type EnsureWorkItemInput = z.infer<typeof EnsureWorkItemInputSchema>;
export type OperationIdentity = z.infer<typeof OperationIdentitySchema>;
export type EffectStatus = z.infer<typeof EffectStatusSchema>;
export type ConfirmedReceipt = z.infer<typeof ConfirmedReceiptSchema>;
export type EnsureWorkItemResult = z.infer<typeof EnsureWorkItemResultSchema>;
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;

export function deriveOperationIdentity(conversationId: string, kind: WorkItemKind, queue: WorkItemQueue): OperationIdentity {
  const identity = OperationIdentitySchema.parse({
    conversation_id: conversationId,
    kind,
    queue,
    operation_key: `work-item:${conversationId}:${kind}:${queue}`,
  });
  return identity;
}

export function evaluatePolicy(decision: Decision): PolicyOutcome {
  const candidate = DecisionSchema.parse(decision);
  const queue = candidate.target_queue;
  const validQueue = queue !== null && WorkItemQueueSchema.safeParse(queue).success;
  if (candidate.urgency === "critical" && (candidate.action !== "escalate_to_human" || queue !== "operations")) {
    return PolicyOutcomeSchema.parse({ status: "rejected", reason: "Critical outcomes must escalate to operations.", override: { reason: "Critical urgency requires human operations handling.", action: "escalate_to_human", target_queue: "manual_triage" } });
  }
  if (candidate.action === "auto_respond") {
    if (candidate.requires_human || queue !== null) return PolicyOutcomeSchema.parse({ status: "rejected", reason: "Automatic responses cannot require human handling or a work-item queue.", override: { reason: "The candidate requires human review.", action: "escalate_to_human", target_queue: "manual_triage" } });
    return PolicyOutcomeSchema.parse({ status: "accepted", reason: "Low-risk automatic response requires no work item.", override: null });
  }
  if (!candidate.requires_human || !validQueue) return PolicyOutcomeSchema.parse({ status: "rejected", reason: "Routing and escalation require a supported queue and human handling.", override: { reason: "The candidate is incomplete or unsafe for autonomous routing.", action: "escalate_to_human", target_queue: "manual_triage" } });
  return PolicyOutcomeSchema.parse({ status: "accepted", reason: "Human-handled routing is supported by policy.", override: null });
}
