import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createOrReuseWorkItem, closeStorage, completeEffectAttempt, loadConversationEffects, openStorage, recordEffectAttempt } from "../src/storage";
import { deriveOperationIdentity, EnsureWorkItemInputSchema } from "../src/policy-effects";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

describe("SQLite durable mock effects", () => {
  test("creates, reuses, completes, and reloads one work item", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-effects-")); directories.push(directory);
    const path = join(directory, "service.sqlite");
    const storage = openStorage(path);
    storage.db.query("INSERT INTO conversations (id, customer_json) VALUES (?, ?)").run("conversation-1", JSON.stringify({ plan: "pro" }));
    const identity = deriveOperationIdentity("conversation-1", "specialist_case", "billing");
    const input = EnsureWorkItemInputSchema.parse({ tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate reported charges.", evidence_refs: [{ message_id: "message-1", summary: "Charge reported." }] });
    const first = createOrReuseWorkItem(storage, identity, input);
    const second = createOrReuseWorkItem(storage, identity, input);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.workItem.id).toBe(first.workItem.id);
    const attempt = recordEffectAttempt(storage, { id: "attempt-1", work_item_id: first.workItem.id, turn_id: null, tool_call_id: "tool-effect-1", started_at: "2026-09-11T00:00:00Z" });
    expect(attempt.status).toBe("pending");
    const completed = completeEffectAttempt(storage, attempt.id, { tool: "ensure_work_item", version: "v1", status: "succeeded", receipt: { work_item_id: first.workItem.id, status: "succeeded", created_at: "2026-09-11T00:00:01Z", reused: false } });
    expect(completed.status).toBe("succeeded");
    closeStorage(storage);
    const reopened = openStorage(path);
    const loaded = loadConversationEffects(reopened, "conversation-1");
    expect(loaded.work_items[0]).toMatchObject({ id: first.workItem.id, status: "succeeded", intent: input, receipt: { work_item_id: first.workItem.id, reused: false } });
    expect(loaded.attempts[0]).toMatchObject({ id: "attempt-1", status: "succeeded", tool_call_id: "tool-effect-1" });
    closeStorage(reopened);
  });

  test("enforces operation uniqueness and foreign keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-effects-integrity-")); directories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    storage.db.query("INSERT INTO conversations (id, customer_json) VALUES (?, ?)").run("conversation-2", JSON.stringify({ plan: "free" }));
    const identity = deriveOperationIdentity("conversation-2", "incident", "operations");
    const input = EnsureWorkItemInputSchema.parse({ tool: "ensure_work_item", version: "v1", kind: "incident", queue: "operations", title: "Outage", summary: "Investigate regional impact.", evidence_refs: [] });
    const first = createOrReuseWorkItem(storage, identity, input);
    expect(() => createOrReuseWorkItem(storage, { ...identity, kind: "specialist_case" }, input)).toThrow("does not match");
    expect(() => storage.db.query("INSERT INTO work_items (id, conversation_id, kind, queue, operation_key, intent_json, status, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'mock', ?, ?)").run("wi-duplicate", "conversation-2", "incident", "operations", identity.operation_key, JSON.stringify(input), "2026-09-11T00:00:00Z", "2026-09-11T00:00:00Z")).toThrow();
    expect(() => recordEffectAttempt(storage, { id: "attempt-bad", work_item_id: "missing-work-item", turn_id: null, tool_call_id: null, started_at: "2026-09-11T00:00:00Z" })).toThrow();
    expect(first.workItem.operation_key).toContain("conversation-2");
    closeStorage(storage);
  });
});
