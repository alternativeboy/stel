import { z } from "zod";

export const MAX_INITIAL_MESSAGES = 100;
export const MAX_MESSAGE_CHARACTERS = 8_000;
export const MAX_THREAD_CHARACTERS = 100_000;

const identifierSchema = z.string().min(1);
const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty");

export const CustomerMetadataSchema = z
  .object({
    plan: nonEmptyStringSchema,
    region: nonEmptyStringSchema.optional(),
    seats: z.number().int().positive().optional(),
    tenure_months: z.number().int().nonnegative().optional(),
    prior_ticket_count: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CustomerMetadata = z.infer<typeof CustomerMetadataSchema>;

export const InitialMessageSchema = z
  .object({
    role: z.enum(["customer", "support"]),
    content: z
      .string()
      .max(MAX_MESSAGE_CHARACTERS)
      .refine((value) => value.trim().length > 0, "must not be empty"),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type InitialMessage = z.infer<typeof InitialMessageSchema>;

export const InitialMessagesSchema = z
  .array(InitialMessageSchema)
  .min(1, "at least one message is required")
  .max(MAX_INITIAL_MESSAGES, `at most ${MAX_INITIAL_MESSAGES} messages are allowed`)
  .superRefine((messages, context) => {
    const totalCharacters = messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    if (totalCharacters > MAX_THREAD_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: `thread content must not exceed ${MAX_THREAD_CHARACTERS} characters`,
      });
    }
  });

export const TicketIngestSchema = z
  .object({
    customer: CustomerMetadataSchema,
    messages: InitialMessagesSchema,
  })
  .strict();

export type TicketIngest = z.infer<typeof TicketIngestSchema>;

export const UrgencySchema = z.enum(["critical", "high", "medium", "low"]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const ActionSchema = z.enum([
  "auto_respond",
  "route_to_specialist",
  "escalate_to_human",
]);
export type Action = z.infer<typeof ActionSchema>;

export const SentimentSchema = z.enum([
  "positive",
  "neutral",
  "negative",
  "frustrated",
  "angry",
  "unknown",
]);
export type Sentiment = z.infer<typeof SentimentSchema>;

export const ExtractedFieldsSchema = z
  .object({
    product_area: nonEmptyStringSchema,
    primary_issue_type: nonEmptyStringSchema,
    secondary_issue_types: z.array(nonEmptyStringSchema),
    sentiment: SentimentSchema,
    language: nonEmptyStringSchema,
  })
  .strict();

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

export const EvidenceReferenceSchema = z
  .object({
    message_id: identifierSchema,
    summary: nonEmptyStringSchema,
  })
  .strict();

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ExecutionSchema = z
  .object({
    status: z.enum([
      "not_required",
      "succeeded",
      "failed",
      "unknown",
    ]),
    work_item_id: identifierSchema.optional(),
  })
  .strict();

export type Execution = z.infer<typeof ExecutionSchema>;

export const DecisionSchema = z
  .object({
    id: identifierSchema,
    turn_id: identifierSchema,
    schema_version: identifierSchema,
    urgency: UrgencySchema,
    extracted: ExtractedFieldsSchema,
    action: ActionSchema,
    target_queue: nonEmptyStringSchema.nullable(),
    rationale: nonEmptyStringSchema,
    evidence: z.array(EvidenceReferenceSchema),
    knowledge_refs: z.array(identifierSchema),
    unresolved_questions: z.array(nonEmptyStringSchema),
    requires_human: z.boolean(),
    execution: ExecutionSchema,
    tool_call_ids: z.array(identifierSchema),
    status: z.enum(["completed", "degraded"]),
  })
  .strict();

export type Decision = z.infer<typeof DecisionSchema>;

export const TicketResponseSchema = z
  .object({
    conversation_id: identifierSchema,
    turn_id: identifierSchema,
    reply: nonEmptyStringSchema,
    decision: DecisionSchema,
  })
  .strict();

export type TicketResponse = z.infer<typeof TicketResponseSchema>;

export const ConversationMessageSchema = z.object({
  id: identifierSchema,
  role: z.enum(["customer", "support", "assistant"]),
  content: nonEmptyStringSchema,
  timestamp: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const ConversationReadSchema = z.object({
  conversation_id: identifierSchema,
  customer: CustomerMetadataSchema,
  messages: z.array(ConversationMessageSchema),
  turn: z.object({
    id: identifierSchema,
    state: z.literal("completed"),
    provider: nonEmptyStringSchema,
    model_adapter: nonEmptyStringSchema,
    mock_scenario: nonEmptyStringSchema,
    decision_schema_version: identifierSchema,
    started_at: z.string().datetime({ offset: true }),
    completed_at: z.string().datetime({ offset: true }),
  }).strict(),
  decisions: z.array(DecisionSchema),
  tool_calls: z.array(z.never()),
  effects: z.array(z.object({
    work_item_id: identifierSchema,
    kind: z.enum(["specialist_case", "incident"]),
    queue: z.enum(["billing", "product_support", "operations", "manual_triage"]),
    operation_key: identifierSchema,
    status: z.enum(["pending", "succeeded", "failed", "unknown"]),
    provider: nonEmptyStringSchema,
    receipt: z.object({ work_item_id: identifierSchema, status: z.literal("succeeded"), created_at: z.string().datetime({ offset: true }), reused: z.boolean() }).nullable(),
    attempts: z.array(z.object({ id: identifierSchema, status: z.enum(["pending", "succeeded", "failed", "unknown"]), tool_call_id: identifierSchema.nullable(), result: z.unknown().nullable() }).strict()),
  }).strict()).default([]),
}).strict();

export type ConversationRead = z.infer<typeof ConversationReadSchema>;
