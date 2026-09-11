import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { closeStorage, openStorage } from "../src/storage";
import { TicketIngestSchema } from "../src/schemas";
import { createScriptedBillingAdapter, type ModelAdapter } from "../src/model";
import { createLocalKnowledgeBase, createLocalServiceStatus } from "../src/read-tool-adapters";
import { createTriageApplication, ToolLoopError } from "../src/triage";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

const ticket = TicketIngestSchema.parse({
  customer: { plan: "pro", region: "Thailand" },
  messages: [{ role: "customer", content: "Please investigate my billing access.", timestamp: "2026-09-11T08:00:00+07:00" }],
});

function appWithModel(model: ModelAdapter) {
  return mkdtemp(join(tmpdir(), "stel-tool-loop-")).then((directory) => {
    directories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    return { app: createTriageApplication({ storage, model, knowledge: createLocalKnowledgeBase(), status: createLocalServiceStatus() }), storage };
  });
}

describe("bounded read-tool orchestration", () => {
  test("executes billing search and Thai status, then cites actual evidence", async () => {
    const scripted = createScriptedBillingAdapter();
    let calls = 0;
    const model: ModelAdapter = { ...scripted, async propose(context) {
      calls += 1;
      const proposal = await scripted.propose(context);
      if (calls === 1) return { ...proposal, tool_requests: [
        { id: "tool-search-1", name: "search_knowledge_base", version: "v1", arguments: { tool: "search_knowledge_base", version: "v1", query: "pending billing", language: "en", product_area: "billing" } },
        { id: "tool-status-1", name: "get_service_status", version: "v1", arguments: { tool: "get_service_status", version: "v1", region: "Thailand", product_area: "platform" } },
      ] };
      return proposal;
    } };
    const { app, storage } = await appWithModel(model);
    const response = await app.ingest(ticket, { scope: "POST /tickets", key: "tools-billing" });
    expect(response.decision.tool_call_ids).toEqual(["tool-search-1", "tool-status-1"]);
    expect(response.decision.knowledge_refs).toContain("kb-billing-pending");
    expect(response.decision.knowledge_refs).not.toContain("tool-status-1");
    expect(calls).toBe(2);
    const replay = await app.ingest(ticket, { scope: "POST /tickets", key: "tools-billing" });
    expect(replay).toEqual(response);
    expect(calls).toBe(2);
    closeStorage(storage);
  });

  test("preserves an empty search result without inventing evidence", async () => {
    const scripted = createScriptedBillingAdapter();
    let calls = 0;
    const model: ModelAdapter = { ...scripted, async propose(context) {
      calls += 1;
      const proposal = await scripted.propose(context);
      return calls === 1 ? { ...proposal, tool_requests: [{ id: "tool-empty", name: "search_knowledge_base", version: "v1", arguments: { tool: "search_knowledge_base", version: "v1", query: "no matching document", language: "en" } }] } : proposal;
    } };
    const { app, storage } = await appWithModel(model);
    const response = await app.ingest(ticket, { scope: "POST /tickets", key: "tools-empty" });
    expect(response.decision.tool_call_ids).toEqual(["tool-empty"]);
    expect(response.decision.knowledge_refs).toEqual([]);
    closeStorage(storage);
  });

  test("rejects unknown tools and enforces the per-turn call limit", async () => {
    const scripted = createScriptedBillingAdapter();
    const unknown: ModelAdapter = { ...scripted, async propose(context) {
      const proposal = await scripted.propose(context);
      return { ...proposal, tool_requests: [{ id: "bad", name: "unknown_tool", version: "v1", arguments: {} }] as never };
    } };
    const first = await appWithModel(unknown);
    await expect(first.app.ingest(ticket, { scope: "POST /tickets", key: "tools-unknown" })).rejects.toThrow(ToolLoopError);
    closeStorage(first.storage);

    const limit: ModelAdapter = { ...scripted, async propose(context) {
      const proposal = await scripted.propose(context);
      return { ...proposal, tool_requests: [{ id: `loop-${context.tool_results?.length ?? 0}`, name: "search_knowledge_base", version: "v1", arguments: { tool: "search_knowledge_base", version: "v1", query: "billing", language: "en" } }] };
    } };
    const second = await appWithModel(limit);
    await expect(second.app.ingest(ticket, { scope: "POST /tickets", key: "tools-limit" })).rejects.toThrow("Tool call limit exceeded");
    closeStorage(second.storage);
  });
});
