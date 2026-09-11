import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createRequestHandler } from "../src/app";
import { createScriptedBillingAdapter, type ModelAdapter } from "../src/model";
import { createLocalKnowledgeBase, createLocalServiceStatus } from "../src/read-tool-adapters";
import { ConversationReadSchema, TicketResponseSchema } from "../src/schemas";
import { closeStorage, openStorage } from "../src/storage";
import { createTriageApplication } from "../src/triage";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

const body = {
  customer: { plan: "pro", region: "Thailand" },
  messages: [{ role: "customer", content: "Three pending charges and no Pro access.", timestamp: "2026-09-11T08:00:00+07:00" }],
};

function makeModel() {
  const scripted = createScriptedBillingAdapter();
  let calls = 0;
  const model: ModelAdapter = { ...scripted, async propose(context) {
    calls += 1;
    const proposal = await scripted.propose(context);
    if (!context.tool_results?.length) return { ...proposal, tool_requests: [{ id: "tc-billing-search", name: "search_knowledge_base", version: "v1", arguments: { tool: "search_knowledge_base", version: "v1", query: "pending charges", language: "en", product_area: "billing" } }] };
    return proposal;
  } };
  return { model, calls: () => calls };
}

describe("Task 04 read-tool integration", () => {
  test("POST returns a schema-valid tool-backed result and GET survives restart/replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-04d-")); directories.push(directory);
    const path = join(directory, "service.sqlite");
    const firstModel = makeModel();
    const firstStorage = openStorage(path);
    const firstApp = createTriageApplication({ storage: firstStorage, model: firstModel.model, knowledge: createLocalKnowledgeBase(), status: createLocalServiceStatus() });
    const firstHandler = createRequestHandler(() => {}, firstApp);
    const request = () => new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "task04-replay" }, body: JSON.stringify(body) });
    const created = await firstHandler(request());
    expect(created.status).toBe(201);
    const response = TicketResponseSchema.parse(await created.json());
    expect(response.decision.tool_call_ids).toEqual(["tc-billing-search"]);
    expect(response.decision.knowledge_refs).toContain("kb-billing-pending");
    expect(firstModel.calls()).toBe(2);
    closeStorage(firstStorage);

    const secondModel = makeModel();
    const secondStorage = openStorage(path);
    const secondApp = createTriageApplication({ storage: secondStorage, model: secondModel.model, knowledge: createLocalKnowledgeBase(), status: createLocalServiceStatus() });
    const secondHandler = createRequestHandler(() => {}, secondApp);
    const replay = await secondHandler(request());
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(response);
    expect(secondModel.calls()).toBe(0);
    const conversation = await secondHandler(new Request(`http://localhost/conversations/${response.conversation_id}`, { method: "GET" }));
    expect(conversation.status).toBe(200);
    const read = ConversationReadSchema.parse(await conversation.json());
    expect(read.decisions[0].tool_call_ids).toEqual(["tc-billing-search"]);
    expect(read.decisions[0].knowledge_refs).toContain("kb-billing-pending");
    closeStorage(secondStorage);
  });
});
