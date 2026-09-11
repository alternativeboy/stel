import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMockWorkItemExecutor, type WorkItemEffectExecutor } from "../src/effects";
import { createScriptedBillingAdapter, type ModelAdapter } from "../src/model";
import { EnsureWorkItemResultSchema } from "../src/policy-effects";
import { TicketIngestSchema } from "../src/schemas";
import { closeStorage, loadConversationEffects, openStorage } from "../src/storage";
import { createTriageApplication } from "../src/triage";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));
const ticket = TicketIngestSchema.parse({ customer: { plan: "pro" }, messages: [{ role: "customer", content: "Please investigate billing.", timestamp: "2026-09-11T00:00:00Z" }] });

describe("policy-gated mock effects", () => {
  test("executes billing effect, persists receipt, and replays without calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-effect-app-")); directories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    const scripted = createScriptedBillingAdapter(); let modelCalls = 0; let effectCalls = 0;
    const model: ModelAdapter = { ...scripted, async propose(context) { modelCalls += 1; const proposal = await scripted.propose(context); return context.tool_results?.length ? proposal : { ...proposal, tool_requests: [{ id: "effect-1", name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate reported billing concern.", evidence_refs: [] } }] }; } };
    const mock = createMockWorkItemExecutor(storage);
    const effect: WorkItemEffectExecutor = { async ensure(input, identity, context) { effectCalls += 1; return mock.ensure(input, identity, context); } };
    const app = createTriageApplication({ storage, model, effect });
    const first = await app.ingest(ticket, { scope: "POST /tickets", key: "effect-key" });
    expect(first.decision.execution.status).toBe("succeeded");
    expect(first.decision.execution.work_item_id).toBeTruthy();
    const replay = await app.ingest(ticket, { scope: "POST /tickets", key: "effect-key" });
    expect(replay).toEqual(first); expect(modelCalls).toBe(1); expect(effectCalls).toBe(1);
    const effects = loadConversationEffects(storage, first.conversation_id);
    expect(effects.work_items).toHaveLength(1); expect(effects.work_items[0]?.receipt?.work_item_id).toBe(first.decision.execution.work_item_id!);
    closeStorage(storage);
  });

  test("escalates critical operations and applies manual fallback for unsafe candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-effect-policy-")); directories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite")); const scripted = createScriptedBillingAdapter();
    const criticalModel: ModelAdapter = { ...scripted, async propose(context) { const proposal = await scripted.propose(context); return { ...proposal, decision: { ...proposal.decision, turn_id: context.turn_id, urgency: "critical", action: "escalate_to_human", target_queue: "operations", extracted: { ...proposal.decision.extracted, product_area: "availability" } }, tool_requests: [{ id: "effect-critical", name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: "incident", queue: "operations", title: "Operations escalation", summary: "Investigate reported availability impact.", evidence_refs: [] } }] } as never; } };
    const app = createTriageApplication({ storage, model: criticalModel, effect: createMockWorkItemExecutor(storage) });
    const critical = await app.ingest(ticket, { scope: "POST /tickets", key: "critical-key" });
    expect(critical.decision.execution.status).toBe("succeeded"); expect(critical.decision.execution.work_item_id).toBeTruthy();
    closeStorage(storage);

    const fallbackStorage = openStorage(join(directory, "fallback.sqlite"));
    const unsafeModel: ModelAdapter = { ...scripted, async propose(context) { const proposal = await scripted.propose(context); return { ...proposal, decision: { ...proposal.decision, requires_human: false }, tool_requests: [{ id: "effect-unsafe", name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Unsafe", summary: "Unsafe route", evidence_refs: [] } }] }; } };
    const fallback = await createTriageApplication({ storage: fallbackStorage, model: unsafeModel, effect: createMockWorkItemExecutor(fallbackStorage) }).ingest(ticket, { scope: "POST /tickets", key: "unsafe-key" });
    expect(fallback.decision.action).toBe("escalate_to_human"); expect(fallback.decision.target_queue).toBe("manual_triage"); expect(fallback.decision.execution.status).toBe("unknown");
    closeStorage(fallbackStorage);
  });

  test("keeps effect failures explicit and never invents a receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-effect-failure-")); directories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite")); const scripted = createScriptedBillingAdapter();
    const model: ModelAdapter = { ...scripted, async propose(context) { const proposal = await scripted.propose(context); return context.tool_results?.length ? proposal : { ...proposal, tool_requests: [{ id: "effect-failed", name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing", summary: "Investigate billing.", evidence_refs: [] } }] }; } };
    const effect: WorkItemEffectExecutor = { async ensure() { return EnsureWorkItemResultSchema.parse({ tool: "ensure_work_item", version: "v1", status: "failed", error: { code: "mock_failure", message: "Mock effect failed before confirmation." } }); } };
    const result = await createTriageApplication({ storage, model, effect }).ingest(ticket, { scope: "POST /tickets", key: "failure-key" });
    expect(result.decision.execution).toEqual({ status: "failed" }); closeStorage(storage);
  });
});
