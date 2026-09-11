import { describe, expect, test } from "bun:test";
import { createLocalKnowledgeBase, createLocalServiceStatus } from "../src/read-tool-adapters";

describe("local read-only tools", () => {
  test("searches billing and FAQ fixtures with deterministic ordering", () => {
    const search = createLocalKnowledgeBase();
    const billing = search.search({ tool: "search_knowledge_base", version: "v1", query: "pending billing charges", language: "en" });
    expect(billing.status).toBe("ok"); if (billing.status === "ok") expect(billing.matches.map((match) => match.document_id)).toEqual(["kb-billing-pending", "kb-pro-access"]);
    const faq = search.search({ tool: "search_knowledge_base", version: "v1", query: "common account questions", language: "en" });
    expect(faq.status).toBe("ok"); if (faq.status === "ok") expect(faq.matches[0]?.document_id).toBe("kb-faq-basics");
    const thaiOutage = search.search({ tool: "search_knowledge_base", version: "v1", query: "เหตุขัดข้อง ประเทศไทย", language: "th" });
    expect(thaiOutage.status).toBe("ok"); if (thaiOutage.status === "ok") expect(thaiOutage.matches[0]?.document_id).toBe("kb-outage");
    expect(search.search({ tool: "search_knowledge_base", version: "v1", query: "pending billing charges", language: "en" })).toEqual(billing);
    expect(search.search({ tool: "search_knowledge_base", version: "v1", query: "zzzz-no-match", language: "en" })).toEqual({ tool: "search_knowledge_base", version: "v1", status: "ok", matches: [] });
  });

  test("returns scoped Thai status and explicit failures", () => {
    const status = createLocalServiceStatus();
    const result = status.lookup({ tool: "get_service_status", version: "v1", region: "Thailand", product_area: "platform" });
    expect(result).toMatchObject({ status: "ok", region: "Thailand", coverage: "regional", service_status: "operational" });
    expect(status.lookup({ tool: "get_service_status", version: "v1", region: "Mars", product_area: "platform" })).toMatchObject({ status: "ok", region: "global", coverage: "global" });
    expect(status.lookup({ tool: "get_service_status", version: "v1", region: "Mars", product_area: "unknown" })).toMatchObject({ status: "error", error: { code: "status_unavailable" } });
    expect(status.lookup({ tool: "get_service_status", version: "v1", region: "", product_area: "platform" })).toMatchObject({ status: "error", error: { code: "invalid_input" } });
  });

  test("does not echo arbitrary input in failures", () => {
    const result = createLocalKnowledgeBase().search({ tool: "search_knowledge_base", version: "v1", query: "secret-customer-body", language: "en" } as never);
    expect(JSON.stringify(result)).not.toContain("secret-customer-body");
  });
});
