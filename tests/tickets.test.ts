import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createRequestHandler, type RequestCompletionLog } from "../src/app";
import { createScriptedBillingAdapter } from "../src/model";
import { createTriageApplication } from "../src/triage";
import { closeStorage, openStorage } from "../src/storage";

const dirs: string[] = [];
afterEach(async () => await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true }))));
const payload = { customer: { plan: "pro" }, messages: [{ role: "customer", content: "Three pending charges and no Pro access.", timestamp: "2026-09-11T08:00:00Z" }] };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "stel-http-")); dirs.push(dir);
  const storage = openStorage(join(dir, "service.sqlite"));
  return { storage, handler: createRequestHandler(() => {}, createTriageApplication({ storage, model: createScriptedBillingAdapter() })) };
}

describe("POST /tickets", () => {
  test("returns the validated 201 contract and correlated IDs", async () => {
    const { storage, handler } = await setup(); const logs: RequestCompletionLog[] = [];
    const dir = await mkdtemp(join(tmpdir(), "stel-http-log-")); dirs.push(dir); closeStorage(storage);
    const reopened = openStorage(join(dir, "service.sqlite"));
    const loggedHandler = createRequestHandler((record) => logs.push(record), createTriageApplication({ storage: reopened, model: createScriptedBillingAdapter() }));
    const response = await loggedHandler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "ticket-key-1", "x-request-id": "ticket-1" }, body: JSON.stringify(payload) }));
    expect(response.status).toBe(201); expect(response.headers.get("content-type")).toBe("application/json"); expect(response.headers.get("x-request-id")).toBe("ticket-1");
    const body = await response.json() as { conversation_id: string; turn_id: string; decision: { id: string; urgency: string } }; expect(body).toMatchObject({ conversation_id: expect.any(String), turn_id: expect.any(String), reply: expect.any(String), decision: { id: expect.any(String), urgency: "high" } });
    expect(logs[0]).toMatchObject({ request_id: "ticket-1", status: 201, conversation_id: body.conversation_id, turn_id: body.turn_id, decision_id: body.decision.id }); closeStorage(reopened);
  });

  test("maps malformed, wrong-type, invalid, and oversized bodies safely", async () => {
    const { storage, handler } = await setup();
    const request = (body: string, contentType = "application/json") => handler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": contentType, "idempotency-key": `key-${Math.random()}` }, body }));
    expect((await request("{bad")).status).toBe(400);
    expect((await request("{}", "text/plain")).status).toBe(415);
    const invalid = await request(JSON.stringify({ customer: { plan: "" }, messages: [] })); expect(invalid.status).toBe(422); expect(JSON.stringify(await invalid.json())).not.toContain("secret");
    expect((await request("x".repeat(1_048_577))).status).toBe(413); closeStorage(storage);
  });

  test("returns Allow for unsupported methods", async () => {
    const { storage, handler } = await setup(); const response = await handler(new Request("http://localhost/tickets", { method: "GET" }));
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST"); closeStorage(storage);
  });

  test("requires a key and replays/conflicts deterministically", async () => {
    const { storage, handler } = await setup();
    const make = (body: unknown, key?: string, requestId?: string) => handler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...(requestId ? { "x-request-id": requestId } : {}) }, body: JSON.stringify(body) }));
    expect((await make(payload)).status).toBe(422);
    const first = await make(payload, "replay-http", "first"); const firstBody = await first.json();
    const replay = await make(payload, "replay-http", "second"); expect(replay.status).toBe(201); expect(replay.headers.get("x-request-id")).toBe("second"); expect(await replay.json()).toEqual(firstBody);
    const conflict = await make({ ...payload, customer: { plan: "enterprise" } }, "replay-http"); const conflictBody = await conflict.json() as { error: { retryable: boolean } }; expect(conflict.status).toBe(409); expect(conflictBody.error.retryable).toBe(false); closeStorage(storage);
  });

  test("returns retryable 409 when an equivalent request is already processing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-processing-")); dirs.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    const scripted = createScriptedBillingAdapter(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = { ...scripted, async propose(context: Parameters<typeof scripted.propose>[0]) { await gate; return scripted.propose(context); } };
    const handler = createRequestHandler(() => {}, createTriageApplication({ storage, model }));
    const request = () => new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "processing-key" }, body: JSON.stringify(payload) });
    const first = handler(request()); await Promise.resolve();
    const second = await handler(request()); const secondBody = await second.json() as { error: { retryable: boolean } }; expect(second.status).toBe(409); expect(second.headers.get("retry-after")).toBe("1"); expect(secondBody.error.retryable).toBe(true);
    release(); await first; closeStorage(storage);
  });
});
