import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeStorage,
  loadConversation,
  openStorage,
  saveCompletedInitialTriage,
  type InitialTriageAggregate,
} from "../src/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const aggregate: InitialTriageAggregate = {
  conversation: {
    id: "conversation-1",
    customer: { plan: "pro", region: "eu", seats: 4, tenure_months: 18, prior_ticket_count: 2 },
  },
  request: {
    id: "request-1",
    key: "initial-request",
    state: "completed",
    created_at: "2026-09-11T08:00:00.000Z",
    completed_at: "2026-09-11T08:00:01.000Z",
  },
  turn: {
    id: "turn-1",
    state: "completed",
    provider: "mock",
    model_adapter: "mock-billing-v1",
    mock_scenario: "billing",
    decision_schema_version: "decision.v1",
    started_at: "2026-09-11T08:00:00.100Z",
    completed_at: "2026-09-11T08:00:00.900Z",
  },
  messages: [
    { id: "message-1", role: "customer", content: "Please help with my invoice.", timestamp: "2026-09-11T08:00:00Z" },
    { id: "message-2", role: "support", content: "I will investigate that for you.", timestamp: "2026-09-11T08:00:00.500Z" },
  ],
  reply: "I routed this billing question to the billing team.",
  decision: {
    id: "decision-1",
    turn_id: "turn-1",
    schema_version: "decision.v1",
    urgency: "high",
    extracted: {
      product_area: "billing",
      primary_issue_type: "invoice_question",
      secondary_issue_types: [],
      sentiment: "frustrated",
      language: "en",
    },
    action: "route_to_specialist",
    target_queue: "billing",
    rationale: "Invoice questions require billing review.",
    evidence: [{ message_id: "message-1", summary: "Customer asks about an invoice." }],
    knowledge_refs: [],
    unresolved_questions: [],
    requires_human: true,
    execution: { status: "unknown" },
    tool_call_ids: [],
    status: "completed",
  },
};

describe("SQLite initial triage persistence", () => {
  test("round-trips a completed aggregate after closing and reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-storage-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "service.sqlite");

    const first = openStorage(path);
    saveCompletedInitialTriage(first, aggregate);
    closeStorage(first);

    const reopened = openStorage(path);
    expect(loadConversation(reopened, aggregate.conversation.id)).toEqual(aggregate);
    closeStorage(reopened);
  });

  test("enforces relational message ordering uniqueness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stel-storage-"));
    temporaryDirectories.push(directory);
    const storage = openStorage(join(directory, "service.sqlite"));
    saveCompletedInitialTriage(storage, aggregate);

    expect(() => storage.db.query(`INSERT INTO messages
      (id, conversation_id, turn_id, sequence, role, content, source_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("message-duplicate-sequence", aggregate.conversation.id, aggregate.turn.id, 1,
        "customer", "duplicate", "2026-09-11T08:01:00Z")).toThrow();
    closeStorage(storage);
  });
});
