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
    const response = await loggedHandler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "x-request-id": "ticket-1" }, body: JSON.stringify(payload) }));
    expect(response.status).toBe(201); expect(response.headers.get("content-type")).toBe("application/json"); expect(response.headers.get("x-request-id")).toBe("ticket-1");
    const body = await response.json() as { conversation_id: string; turn_id: string; decision: { id: string; urgency: string } }; expect(body).toMatchObject({ conversation_id: expect.any(String), turn_id: expect.any(String), reply: expect.any(String), decision: { id: expect.any(String), urgency: "high" } });
    expect(logs[0]).toMatchObject({ request_id: "ticket-1", status: 201, conversation_id: body.conversation_id, turn_id: body.turn_id, decision_id: body.decision.id }); closeStorage(reopened);
  });

  test("maps malformed, wrong-type, invalid, and oversized bodies safely", async () => {
    const { storage, handler } = await setup();
    const request = (body: string, contentType = "application/json") => handler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": contentType }, body }));
    expect((await request("{bad")).status).toBe(400);
    expect((await request("{}", "text/plain")).status).toBe(415);
    const invalid = await request(JSON.stringify({ customer: { plan: "" }, messages: [] })); expect(invalid.status).toBe(422); expect(JSON.stringify(await invalid.json())).not.toContain("secret");
    expect((await request("x".repeat(1_048_577))).status).toBe(413); closeStorage(storage);
  });

  test("returns Allow for unsupported methods", async () => {
    const { storage, handler } = await setup(); const response = await handler(new Request("http://localhost/tickets", { method: "GET" }));
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST"); closeStorage(storage);
  });
});
