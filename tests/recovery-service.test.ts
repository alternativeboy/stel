import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMockWorkItemExecutor } from "../src/effects";
import { createRecoveryService } from "../src/recovery-service";
import { DecisionSchema } from "../src/schemas";
import { createOrReuseWorkItem, claimRequest, closeStorage, inspectInterruptedRequests, loadRequest, openStorage } from "../src/storage";
import { deriveOperationIdentity } from "../src/policy-effects";

const dirs: string[] = [];
afterEach(async () => await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true }))));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "stel-recovery-service-")); dirs.push(dir);
  const storage = openStorage(join(dir, "service.sqlite"));
  claimRequest(storage, { scope: "recovery", key: "service-key", fingerprint: "b".repeat(64), conversation_id: "conv-service", turn_id: "turn-service", initial: { customer: { plan: "pro" }, provider: "mock", model_adapter: "scripted", mock_scenario: "billing", decision_schema_version: "decision.v1", started_at: "2026-01-01T00:00:00Z" } });
  return { dir, storage, request: inspectInterruptedRequests(storage)[0]! };
}

function frozenDecision(turnId: string) {
  return DecisionSchema.parse({ id: `decision-${turnId}`, turn_id: turnId, schema_version: "decision.v1", urgency: "high", extracted: { product_area: "billing", primary_issue_type: "payment_and_access", secondary_issue_types: [], sentiment: "frustrated", language: "en" }, action: "route_to_specialist", target_queue: "billing", rationale: "Human billing review is needed.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "completed" });
}

describe("startup recovery service", () => {
  test("finalizes no-plan recovery and is repeatable after restart", async () => {
    const { dir, storage, request } = await setup();
    const first = await createRecoveryService({ storage, effect: createMockWorkItemExecutor(storage) }).recover();
    expect(first.finalized).toBe(1); expect(first.unresolved).toBe(0); closeStorage(storage);
    const reopened = openStorage(join(dir, "service.sqlite"));
    const second = await createRecoveryService({ storage: reopened, effect: createMockWorkItemExecutor(reopened) }).recover();
    expect(second.scanned).toBe(0);
    expect(loadRequest(reopened, request.request_scope, request.request_key)?.state).toBe("completed"); closeStorage(reopened);
  });

  test("resumes a pending mock effect and reuses it on repeated recovery", async () => {
    const { storage, request } = await setup();
    const decision = frozenDecision(request.references.turn_id);
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?)").run(decision.id, decision.turn_id, decision.schema_version, JSON.stringify(decision), "2026-01-01T00:01:00Z");
    createOrReuseWorkItem(storage, deriveOperationIdentity("conv-service", "specialist_case", "billing"), { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate billing.", evidence_refs: [] });
    const service = createRecoveryService({ storage, effect: createMockWorkItemExecutor(storage) });
    const first = await service.recover();
    expect(first.finalized).toBe(1); expect(first.results[0]?.outcome).toBe("effect_reused");
    expect((storage.db.query("SELECT COUNT(*) AS count FROM work_items WHERE conversation_id = ?").get("conv-service") as { count: number }).count).toBe(1);
    expect((await service.recover()).scanned).toBe(0); closeStorage(storage);
  });

  test("leaves unknown effects unresolved without a success claim", async () => {
    const { storage, request } = await setup();
    const decision = frozenDecision(request.references.turn_id);
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?)").run(decision.id, decision.turn_id, decision.schema_version, JSON.stringify(decision), "2026-01-01T00:01:00Z");
    const item = createOrReuseWorkItem(storage, deriveOperationIdentity("conv-service", "specialist_case", "billing"), { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing review", summary: "Investigate billing.", evidence_refs: [] });
    storage.db.query("UPDATE work_items SET status = 'unknown' WHERE id = ?").run(item.workItem.id);
    const summary = await createRecoveryService({ storage }).recover();
    expect(summary.unresolved).toBe(1); expect(summary.results[0]?.effect_status).toBe("unknown"); expect(loadRequest(storage, request.request_scope, request.request_key)?.state).toBe("processing"); closeStorage(storage);
  });
});

