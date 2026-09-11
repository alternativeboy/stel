import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createRequestHandler } from "../src/app";
import { createScriptedBillingAdapter, type ModelAdapter } from "../src/model";
import { createMockWorkItemExecutor } from "../src/effects";
import { ConversationReadSchema, TicketResponseSchema } from "../src/schemas";
import { closeStorage, openStorage } from "../src/storage";
import { createTriageApplication } from "../src/triage";

const dirs: string[] = [];
afterEach(async () => await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true }))));

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "stel-follow-http-")); dirs.push(directory);
  const storage = openStorage(join(directory, "service.sqlite"));
  const app = createTriageApplication({ storage, model: createScriptedBillingAdapter() });
  const logs: unknown[] = []; const handler = createRequestHandler((record) => logs.push(record), app);
  const initial = await handler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "initial-http" }, body: JSON.stringify({ customer: { plan: "pro" }, messages: [{ role: "customer", content: "I need help.", timestamp: "2026-09-11T00:00:00Z" }] }) }));
  return { storage, handler, logs, conversationId: (await initial.json() as { conversation_id: string }).conversation_id };
}

function followUp(conversationId: string, key: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/conversations/${conversationId}/messages`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("POST /conversations/{id}/messages", () => {
  test("accepts operator/customer follow-ups, correlates logs, and survives restart", async () => {
    const setupResult = await setup();
    const operator = await setupResult.handler(followUp(setupResult.conversationId, "follow-http-1", { role: "operator", content: "Why was this escalated?", timestamp: "2026-09-11T00:01:00Z" }, { "x-request-id": "follow-request-1" }));
    expect(operator.status).toBe(200); expect(operator.headers.get("x-request-id")).toBe("follow-request-1");
    const response = TicketResponseSchema.parse(await operator.json()); expect(response.conversation_id).toBe(setupResult.conversationId);
    const customer = await setupResult.handler(followUp(setupResult.conversationId, "follow-http-2", { role: "customer", content: "It is still failing.", timestamp: "2026-09-11T00:02:00Z" })); expect(customer.status).toBe(200);
    const replay = await setupResult.handler(followUp(setupResult.conversationId, "follow-http-1", { role: "operator", content: "Why was this escalated?", timestamp: "2026-09-11T00:01:00Z" })); expect(await replay.json()).toEqual(response);
    const conflict = await setupResult.handler(followUp(setupResult.conversationId, "follow-http-1", { role: "operator", content: "Different body", timestamp: "2026-09-11T00:01:00Z" })); expect(conflict.status).toBe(409);
    const parsedLogs = setupResult.logs.map((record) => JSON.parse(JSON.stringify(record)) as Record<string, unknown>); expect(parsedLogs.some((record) => record.conversation_id === setupResult.conversationId && record.turn_id)).toBe(true); expect(JSON.stringify(parsedLogs)).not.toContain("Why was this escalated?");
    closeStorage(setupResult.storage);
    const reopened = openStorage(join(dirs[0]!, "service.sqlite")); const restarted = createRequestHandler(() => {}, createTriageApplication({ storage: reopened, model: createScriptedBillingAdapter() }));
    const readResponse = await restarted(new Request(`http://localhost/conversations/${setupResult.conversationId}`));
    expect(readResponse.status).toBe(200);
    const read = ConversationReadSchema.parse(await readResponse.json());
    expect(read.customer.plan).toBe("pro");
    expect(read.messages.map((message) => message.content)).toEqual(["I need help.", expect.any(String), "Why was this escalated?", expect.any(String), "It is still failing.", expect.any(String)]);
    expect(read.messages[0]?.timestamp).toBe("2026-09-11T00:00:00Z");
    expect(read.messages[2]?.timestamp).toBe("2026-09-11T00:01:00Z");
    expect(read.messages[4]?.timestamp).toBe("2026-09-11T00:02:00Z");
    expect(read.decisions).toHaveLength(3);
    expect(new Set(read.decisions.map((decision) => decision.id)).size).toBe(3);
    expect(read.turn.id).toBe(read.decisions.at(-1)!.turn_id);
    expect(read.messages.map((message) => message.role)).toEqual(["customer", "assistant", "operator", "assistant", "customer", "assistant"]); closeStorage(reopened);
  });

  test("maps validation, body, route, method, and unknown-conversation errors safely", async () => {
    const { handler, storage, conversationId } = await setup();
    expect((await handler(new Request(`http://localhost/conversations/${conversationId}/messages`, { method: "GET" }))).headers.get("allow")).toBe("POST");
    expect((await handler(followUp(conversationId, "bad-json", "{"))).status).toBe(400);
    expect((await handler(followUp(conversationId, "bad-role", { role: "assistant", content: "x", timestamp: "2026-09-11T00:00:00Z" }))).status).toBe(422);
    expect((await handler(followUp(conversationId, "bad-time", { role: "customer", content: "x", timestamp: "2026-09-11T00:00:00" }))).status).toBe(422);
    expect((await handler(followUp(conversationId, "bad-content", { role: "customer", content: " ", timestamp: "2026-09-11T00:00:00Z" }))).status).toBe(422);
    expect((await handler(followUp(conversationId, "bad-type", { role: "customer", content: "x", timestamp: "2026-09-11T00:00:00Z" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handler(followUp(conversationId, "missing-key", { role: "customer", content: "x", timestamp: "2026-09-11T00:00:00Z" }, { "idempotency-key": "" }))).status).toBe(422);
    expect((await handler(followUp("missing-conversation", "unknown", { role: "customer", content: "x", timestamp: "2026-09-11T00:00:00Z" }))).status).toBe(404);
    const large = followUp(conversationId, "large", { role: "customer", content: "x".repeat(1_048_577), timestamp: "2026-09-11T00:00:00Z" }); expect((await handler(large)).status).toBe(413); closeStorage(storage);
  });

  test("returns a retryable active-turn conflict with Retry-After", async () => {
    const { handler, storage, conversationId } = await setup();
    storage.db.query("INSERT INTO turns (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at) VALUES (?, ?, 'processing', 'mock', 'scripted', 'billing', 'decision.v1', ?)").run("active-follow-turn", conversationId, "2026-09-11T00:03:00Z");
    const response = await handler(followUp(conversationId, "active-key", { role: "customer", content: "Still waiting.", timestamp: "2026-09-11T00:03:00Z" }));
    expect(response.status).toBe(409); expect(response.headers.get("retry-after")).toBe("1"); const payload = await response.json() as { error: { retryable: boolean } }; expect(payload.error.retryable).toBe(true); closeStorage(storage);
  });

  test("reuses one work item for repeated routing follow-ups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-follow-effect-http-")); dirs.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    const scripted = createScriptedBillingAdapter();
    const model: ModelAdapter = { ...scripted, async propose(context) {
      const proposal = await scripted.propose(context);
      if (context.messages.length < 2) return proposal;
      return { ...proposal, decision: { ...proposal.decision, turn_id: context.turn_id }, tool_requests: [{ id: `effect-${context.turn_id}`, name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate reported billing and access concerns.", evidence_refs: [] } }] };
    } };
    const app = createTriageApplication({ storage, model, effect: createMockWorkItemExecutor(storage) });
    const handler = createRequestHandler(() => {}, app);
    const initial = await handler(new Request("http://localhost/tickets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "effect-initial" }, body: JSON.stringify({ customer: { plan: "pro" }, messages: [{ role: "customer", content: "Billing help", timestamp: "2026-09-11T00:00:00Z" }] }) }));
    const conversationId = (await initial.json() as { conversation_id: string }).conversation_id;
    const first = await handler(followUp(conversationId, "effect-follow-1", { role: "customer", content: "Still waiting", timestamp: "2026-09-11T00:01:00Z" }));
    const second = await handler(followUp(conversationId, "effect-follow-2", { role: "customer", content: "Still waiting again", timestamp: "2026-09-11T00:02:00Z" }));
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(storage.db.query("SELECT COUNT(*) AS count FROM work_items WHERE conversation_id = ?").get(conversationId) as { count: number }).toEqual({ count: 1 });
    const read = ConversationReadSchema.parse(await (await handler(new Request(`http://localhost/conversations/${conversationId}`))).json());
    expect(read.effects).toHaveLength(1); expect(read.effects[0]?.receipt?.status).toBe("succeeded"); closeStorage(storage);
  });
});
