import { createHash } from "node:crypto";
import { z } from "zod";
import { TicketResponseSchema } from "./schemas";

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export const IdempotencyKeySchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_IDEMPOTENCY_KEY_LENGTH, `must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must contain only safe identifier characters");

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const RequestStateSchema = z.enum(["processing", "completed", "conflict"]);
export type RequestState = z.infer<typeof RequestStateSchema>;

export const RequestFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type RequestFingerprint = z.infer<typeof RequestFingerprintSchema>;

export const IdempotencyConflictDetailsSchema = z.object({
  reason: z.enum(["different_body", "processing"]),
}).strict();

export const RequestResolutionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("claimed"), state: z.literal("processing"), turn_id: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal("replay"), state: z.literal("completed"), response: TicketResponseSchema }).strict(),
  z.object({ outcome: z.literal("conflict"), state: z.literal("conflict"), retryable: z.boolean(), details: IdempotencyConflictDetailsSchema }).strict(),
]);

export type RequestResolution = z.infer<typeof RequestResolutionSchema>;

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("request body must contain only JSON values");
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  throw new TypeError("request body must contain only JSON values");
}

export function fingerprintRequestBody(body: unknown): RequestFingerprint {
  return RequestFingerprintSchema.parse(createHash("sha256").update(canonicalize(body)).digest("hex"));
}
