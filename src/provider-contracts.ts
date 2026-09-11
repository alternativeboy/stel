import { z } from "zod";
import { DecisionSchema } from "./schemas";
import { ToolRequestSchema } from "./read-tools";

const bounded = z.string().trim().min(1).max(256);
const safeMessage = z.string().trim().min(1).max(256).refine((value) => !/(?:sk-[A-Za-z0-9]{8,}|OPENAI_API_KEY)/i.test(value), "must not contain secrets");
const secret = z.string().min(1).max(512);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/, "must be a SHA-256 prompt hash");

export const TRIAGE_PROMPT_VERSION = "triage.v1" as const;
export const TRIAGE_PROMPT_HASH = "sha256:fc3cf233052c3b4f21613d110b78bfd92127ae744a1bbc7f21a093005dbbb9f5" as const;

export const ProviderSettingsSchema = z.object({
  api_key: secret,
  model: bounded.max(128),
  timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
  max_retries: z.number().int().min(0).max(3).default(2),
  prompt_version: z.literal(TRIAGE_PROMPT_VERSION),
  prompt_hash: hash,
}).strict();

export const ProviderSettingsInputSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().optional(),
  OPENAI_MAX_RETRIES: z.coerce.number().int().optional(),
}).strict();

export function parseProviderSettings(input: unknown) {
  const environment = ProviderSettingsInputSchema.parse(input);
  return ProviderSettingsSchema.parse({
    api_key: environment.OPENAI_API_KEY?.trim(),
    model: environment.OPENAI_MODEL?.trim(),
    timeout_ms: environment.OPENAI_TIMEOUT_MS,
    max_retries: environment.OPENAI_MAX_RETRIES,
    prompt_version: TRIAGE_PROMPT_VERSION,
    prompt_hash: TRIAGE_PROMPT_HASH,
  });
}

export const ProviderRequestSchema = z.object({
  model: bounded.max(128),
  prompt_version: z.literal(TRIAGE_PROMPT_VERSION),
  prompt_hash: hash,
  context: z.unknown(),
}).strict();

export const ProviderResponseSchema = z.object({
  reply: z.string().trim().min(1).max(8_000),
  decision: DecisionSchema,
  tool_requests: ToolRequestSchema.array().max(3).optional(),
}).strict();

export const ProviderFailureKindSchema = z.enum(["authentication", "rate_limit", "timeout", "invalid_response", "unavailable"]);
export const ProviderFailureSchema = z.object({
  kind: ProviderFailureKindSchema,
  retryable: z.boolean(),
  message: safeMessage,
}).strict().superRefine((failure, context) => {
  const expectedRetryable = failure.kind === "rate_limit" || failure.kind === "timeout" || failure.kind === "unavailable";
  if (failure.retryable !== expectedRetryable) context.addIssue({ code: "custom", message: "retryability does not match failure kind" });
});

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;
