import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

export const SEARCH_KNOWLEDGE_BASE = "search_knowledge_base" as const;
export const GET_SERVICE_STATUS = "get_service_status" as const;
export const READ_TOOL_VERSION = "v1" as const;

export const SearchKnowledgeInputSchema = z.object({
  tool: z.literal(SEARCH_KNOWLEDGE_BASE),
  version: z.literal(READ_TOOL_VERSION),
  query: nonEmpty.max(1_000),
  language: nonEmpty.max(32),
  product_area: nonEmpty.max(128).optional(),
}).strict();

export const KnowledgeMatchSchema = z.object({
  document_id: nonEmpty.max(128),
  title: nonEmpty.max(256),
  excerpt: nonEmpty.max(2_000),
  score: z.number().min(0).max(1),
  updated_at: timestamp,
}).strict();

export const SearchKnowledgeSuccessSchema = z.object({
  tool: z.literal(SEARCH_KNOWLEDGE_BASE), version: z.literal(READ_TOOL_VERSION),
  status: z.literal("ok"), matches: z.array(KnowledgeMatchSchema).max(10),
}).strict();

export const ReadToolErrorSchema = z.object({ code: nonEmpty.max(64), message: nonEmpty.max(256) }).strict();
export const SearchKnowledgeErrorSchema = z.object({
  tool: z.literal(SEARCH_KNOWLEDGE_BASE), version: z.literal(READ_TOOL_VERSION), status: z.literal("error"), error: ReadToolErrorSchema,
}).strict();
export const SearchKnowledgeResultSchema = z.union([SearchKnowledgeSuccessSchema, SearchKnowledgeErrorSchema]);

export const ServiceStatusInputSchema = z.object({
  tool: z.literal(GET_SERVICE_STATUS), version: z.literal(READ_TOOL_VERSION),
  region: nonEmpty.max(128), product_area: nonEmpty.max(128),
}).strict();

export const ServiceStatusSuccessSchema = z.object({
  tool: z.literal(GET_SERVICE_STATUS), version: z.literal(READ_TOOL_VERSION), status: z.literal("ok"),
  region: nonEmpty.max(128), product_area: nonEmpty.max(128),
  service_status: z.enum(["operational", "degraded", "partial", "outage", "unknown"]),
  source: nonEmpty.max(256), observed_at: timestamp,
  coverage: z.enum(["global", "regional", "unknown"]), summary: nonEmpty.max(2_000),
}).strict();
export const ServiceStatusErrorSchema = z.object({
  tool: z.literal(GET_SERVICE_STATUS), version: z.literal(READ_TOOL_VERSION), status: z.literal("error"), error: ReadToolErrorSchema,
}).strict();
export const ServiceStatusResultSchema = z.union([ServiceStatusSuccessSchema, ServiceStatusErrorSchema]);

export const KnowledgeEvidenceReferenceSchema = z.object({
  document_id: nonEmpty.max(128), excerpt: nonEmpty.max(2_000),
}).strict();

export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInputSchema>;
export type SearchKnowledgeResult = z.infer<typeof SearchKnowledgeResultSchema>;
export type ServiceStatusInput = z.infer<typeof ServiceStatusInputSchema>;
export type ServiceStatusResult = z.infer<typeof ServiceStatusResultSchema>;
export type KnowledgeEvidenceReference = z.infer<typeof KnowledgeEvidenceReferenceSchema>;

export const KNOWLEDGE_FIXTURES = Object.freeze([
  Object.freeze({ document_id: "kb-billing-pending", title: "Pending billing charges", excerpt: "Pending charges may require billing review before they are treated as settled payments.", score: 0.96, updated_at: "2026-01-15T00:00:00Z" }),
  Object.freeze({ document_id: "kb-pro-access", title: "Pro access after billing changes", excerpt: "Account access concerns after a billing change should be reviewed by the billing team.", score: 0.91, updated_at: "2026-01-15T00:00:00Z" }),
  Object.freeze({ document_id: "kb-outage", title: "Investigating regional access failures", excerpt: "When multiple users are affected, preserve regional and device evidence for specialist investigation.", score: 0.88, updated_at: "2026-01-15T00:00:00Z" }),
  Object.freeze({ document_id: "kb-faq-basics", title: "Common account questions", excerpt: "Find supported account guidance in the help center.", score: 0.62, updated_at: "2026-01-15T00:00:00Z" }),
]);

export const STATUS_FIXTURES = Object.freeze([
  Object.freeze({ region: "global", product_area: "platform", service_status: "operational", source: "local-status-fixture", observed_at: "2026-01-15T00:00:00Z", coverage: "global", summary: "The global platform status is operational." }),
  Object.freeze({ region: "Thailand", product_area: "platform", service_status: "operational", source: "local-status-fixture", observed_at: "2026-01-15T00:00:00Z", coverage: "regional", summary: "The regional observation is operational; this does not disprove a customer-local failure." }),
]);
