import {
  GET_SERVICE_STATUS,
  KNOWLEDGE_FIXTURES,
  READ_TOOL_VERSION,
  SEARCH_KNOWLEDGE_BASE,
  STATUS_FIXTURES,
  SearchKnowledgeInputSchema,
  SearchKnowledgeResultSchema,
  ServiceStatusInputSchema,
  ServiceStatusResultSchema,
  type SearchKnowledgeInput,
  type SearchKnowledgeResult,
  type ServiceStatusInput,
  type ServiceStatusResult,
} from "./read-tools";

export interface KnowledgeBaseSearch {
  search(input: SearchKnowledgeInput): SearchKnowledgeResult;
}

export interface ServiceStatusLookup {
  lookup(input: ServiceStatusInput): ServiceStatusResult;
}

const tokens = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const lexicalCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function createLocalKnowledgeBase(): KnowledgeBaseSearch {
  return {
    search(rawInput) {
      const parsed = SearchKnowledgeInputSchema.safeParse(rawInput);
      if (!parsed.success) return SearchKnowledgeResultSchema.parse({ tool: SEARCH_KNOWLEDGE_BASE, version: READ_TOOL_VERSION, status: "error", error: { code: "invalid_input", message: "Knowledge search arguments are invalid." } });
      const queryTokens = new Set(tokens(parsed.data.query));
      const areaTokens = parsed.data.product_area ? tokens(parsed.data.product_area) : [];
      const matches = KNOWLEDGE_FIXTURES.map((fixture) => {
        const haystack = new Set(tokens(`${fixture.title} ${fixture.excerpt} ${fixture.document_id}`));
        const matched = [...queryTokens].filter((token) => haystack.has(token)).length;
        const areaMatched = areaTokens.length === 0 || areaTokens.some((token) => haystack.has(token));
        return { fixture, matched, areaMatched };
      }).filter(({ matched, areaMatched }) => matched > 0 && areaMatched)
        .sort((left, right) => right.matched - left.matched || right.fixture.score - left.fixture.score || lexicalCompare(left.fixture.document_id, right.fixture.document_id))
        .slice(0, 10)
        .map(({ fixture, matched }) => ({ ...fixture, score: Math.min(1, fixture.score + matched * 0.01) }));
      return SearchKnowledgeResultSchema.parse({ tool: SEARCH_KNOWLEDGE_BASE, version: READ_TOOL_VERSION, status: "ok", matches });
    },
  };
}

export function createLocalServiceStatus(): ServiceStatusLookup {
  return {
    lookup(rawInput) {
      const parsed = ServiceStatusInputSchema.safeParse(rawInput);
      if (!parsed.success) return ServiceStatusResultSchema.parse({ tool: GET_SERVICE_STATUS, version: READ_TOOL_VERSION, status: "error", error: { code: "invalid_input", message: "Service status arguments are invalid." } });
      const exact = STATUS_FIXTURES.find((fixture) => fixture.region.toLowerCase() === parsed.data.region.toLowerCase() && fixture.product_area.toLowerCase() === parsed.data.product_area.toLowerCase());
      const global = STATUS_FIXTURES.find((fixture) => fixture.region === "global" && fixture.product_area.toLowerCase() === parsed.data.product_area.toLowerCase());
      const fixture = exact ?? global;
      if (!fixture) return ServiceStatusResultSchema.parse({ tool: GET_SERVICE_STATUS, version: READ_TOOL_VERSION, status: "error", error: { code: "status_unavailable", message: "No status observation is available for that scope." } });
      return ServiceStatusResultSchema.parse({ tool: GET_SERVICE_STATUS, version: READ_TOOL_VERSION, status: "ok", ...fixture });
    },
  };
}
