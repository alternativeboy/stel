import { z } from "zod";
import { TicketResponseSchema } from "./schemas";

export const MAX_FOLLOW_UP_MESSAGE_CHARACTERS = 8_000;
export const MAX_CONVERSATION_CHARACTERS = 100_000;

const nonEmpty = z.string().trim().min(1);
const safeDetails = z.object({
  conversation_id: z.string().max(128).optional(),
  field: z.string().max(64).optional(),
  reason: z.string().max(64).optional(),
}).strict().default({});

export const FollowUpMessageSchema = z.object({
  role: z.enum(["operator", "customer"]),
  content: z.string().max(MAX_FOLLOW_UP_MESSAGE_CHARACTERS).refine((value) => value.trim().length > 0, "must not be empty"),
  timestamp: z.string().datetime({ offset: true }),
}).strict();

export const FollowUpResponseSchema = TicketResponseSchema;

export const FollowUpErrorCodeSchema = z.enum(["conversation_not_found", "active_turn", "invalid_input", "degraded"]);
export const FollowUpErrorSchema = z.object({
  code: FollowUpErrorCodeSchema,
  message: nonEmpty.max(256),
  details: safeDetails,
}).strict();

export const FollowUpFailureSchema = z.object({
  status: z.literal("error"),
  error: FollowUpErrorSchema,
}).strict();

export const FollowUpDegradedOutcomeSchema = z.object({
  status: z.literal("degraded"),
  response: FollowUpResponseSchema,
  reason: nonEmpty.max(256),
}).strict();

export type FollowUpMessage = z.infer<typeof FollowUpMessageSchema>;
export type FollowUpResponse = z.infer<typeof FollowUpResponseSchema>;
export type FollowUpError = z.infer<typeof FollowUpErrorSchema>;
export type FollowUpFailure = z.infer<typeof FollowUpFailureSchema>;
export type FollowUpDegradedOutcome = z.infer<typeof FollowUpDegradedOutcomeSchema>;
