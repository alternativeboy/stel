import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createRequestHandler } from "../src/app";
import { createScriptedBillingAdapter } from "../src/model";
import { createTriageApplication } from "../src/triage";
import { closeStorage, openStorage } from "../src/storage";

const dirs: string[] = [];
afterEach(async () => await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true }))));
const payload = { customer: { plan: "pro", region: "Thailand", seats: 3 }, messages: [{ role: "customer", content: "Three pending charges and no Pro access.", timestamp: "2026-09-11T08:00:00+07:00" }] };

describe("GET /conversations/{id}", () => {
  test("reconstructs the conversation after fresh storage and app instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-restart-")); dirs.push(directory); const path = join(directory, "service.sqlite");
    const firstStorage = openStorage(path); const firstApp = createTriageApplication({ storage: firstStorage, model: createScriptedBillingAdapter() });
    const post = createRequestHandler(() => {}, firstApp);
    const created = await post(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
    const createdBody = await created.json() as { conversation_id: string };
    closeStorage(firstStorage);
    const secondStorage = openStorage(path); const get = createRequestHandler(() => {}, createTriageApplication({ storage: secondStorage, model: createScriptedBillingAdapter() }));
    const response = await get(new Request(`http://localhost/conversations/${createdBody.conversation_id}`, { headers: { "x-request-id": "read-1" } }));
    expect(response.status).toBe(200); expect(response.headers.get("x-request-id")).toBe("read-1");
    const body = await response.json() as { conversation_id: string; customer: unknown; messages: Array<{ id: string; role: string; content: string; timestamp: string | null }>; turn: Record<string, string>; decisions: Array<Record<string, unknown>>; tool_calls: unknown[] };
    expect(body.conversation_id).toBe(createdBody.conversation_id); expect(body.customer).toEqual(payload.customer);
    expect(body.messages).toEqual([{ id: expect.any(String), ...payload.messages[0] }, { id: expect.any(String), role: "assistant", content: expect.any(String), timestamp: null }]);
    expect(body.turn).toMatchObject({ provider: "mock", model_adapter: "scripted-billing-v1", mock_scenario: "billing" });
    expect(body.decisions[0]).toMatchObject({ urgency: "high", target_queue: "billing" }); expect(body.tool_calls).toEqual([]); closeStorage(secondStorage);
  });

  test("returns safe errors for unknown and malformed routes and 405 for methods", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-get-")); dirs.push(directory); const storage = openStorage(join(directory, "service.sqlite"));
    const handler = createRequestHandler(() => {}, createTriageApplication({ storage, model: createScriptedBillingAdapter() }));
    expect((await handler(new Request("http://localhost/conversations/unknown"))).status).toBe(404);
    expect((await handler(new Request("http://localhost/conversations/"))).status).toBe(404);
    const method = await handler(new Request("http://localhost/conversations/unknown", { method: "POST" })); expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET"); closeStorage(storage);
  });
});
