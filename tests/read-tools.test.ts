import { describe, expect, test } from "bun:test";
import { KnowledgeEvidenceReferenceSchema, KnowledgeMatchSchema, KNOWLEDGE_FIXTURES, SearchKnowledgeErrorSchema, SearchKnowledgeInputSchema, SearchKnowledgeSuccessSchema, ServiceStatusErrorSchema, ServiceStatusSuccessSchema, STATUS_FIXTURES } from "../src/read-tools";

describe("read-tool contracts and fixtures", () => {
  test("accepts versioned knowledge results including empty matches", () => {
    expect(SearchKnowledgeInputSchema.parse({ tool: "search_knowledge_base", version: "v1", query: "pending charges", language: "en" }).version).toBe("v1");
    expect(SearchKnowledgeSuccessSchema.parse({ tool: "search_knowledge_base", version: "v1", status: "ok", matches: [] }).matches).toEqual([]);
    expect(KNOWLEDGE_FIXTURES.some((fixture) => fixture.document_id === "kb-billing-pending")).toBe(true);
    expect(KNOWLEDGE_FIXTURES.every((fixture) => KnowledgeMatchSchema.safeParse(fixture).success)).toBe(true);
  });

  test("accepts scoped status observations and safe evidence references", () => {
    expect(ServiceStatusSuccessSchema.parse({ tool: "get_service_status", version: "v1", status: "ok", ...STATUS_FIXTURES[1] }).coverage).toBe("regional");
    expect(KnowledgeEvidenceReferenceSchema.parse({ document_id: "kb-billing-pending", excerpt: "Pending charges require review." }).document_id).toBe("kb-billing-pending");
  });

  test("rejects invalid enums, oversized inputs, and malformed timestamps", () => {
    expect(() => SearchKnowledgeInputSchema.parse({ tool: "unknown", version: "v1", query: "x", language: "en" })).toThrow();
    expect(() => SearchKnowledgeInputSchema.parse({ tool: "search_knowledge_base", version: "v1", query: "x".repeat(1_001), language: "en" })).toThrow();
    expect(() => ServiceStatusSuccessSchema.parse({ tool: "get_service_status", version: "v1", status: "ok", service_status: "bad", source: "fixture", observed_at: "2026-01-15T00:00:00", coverage: "global", summary: "x" })).toThrow();
  });

  test("keeps error details bounded and free of secret echoes", () => {
    const result = SearchKnowledgeErrorSchema.parse({ tool: "search_knowledge_base", version: "v1", status: "error", error: { code: "invalid_query", message: "Query is invalid." } });
    expect(ServiceStatusErrorSchema.parse({ tool: "get_service_status", version: "v1", status: "error", error: { code: "status_unavailable", message: "Status is unavailable." } }).status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
