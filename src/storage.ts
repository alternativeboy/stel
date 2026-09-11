import { Database } from "bun:sqlite";
import {
  CustomerMetadataSchema,
  DecisionSchema,
  InitialMessageSchema,
  InitialMessagesSchema,
  type CustomerMetadata,
  type Decision,
  type InitialMessage,
} from "./schemas";

export type StoredMessage = InitialMessage & { id: string };

export interface InitialTriageAggregate {
  conversation: { id: string; customer: CustomerMetadata };
  request: {
    id: string;
    key: string;
    state: "completed";
    created_at: string;
    completed_at: string;
  };
  turn: {
    id: string;
    state: "completed";
    provider: string;
    model_adapter: string;
    mock_scenario: string;
    decision_schema_version: string;
    started_at: string;
    completed_at: string;
  };
  messages: StoredMessage[];
  reply: string;
  decision: Decision;
}

export interface Storage { db: Database }

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    customer_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    state TEXT NOT NULL CHECK (state = 'completed'),
    provider TEXT NOT NULL,
    model_adapter TEXT NOT NULL,
    mock_scenario TEXT NOT NULL,
    decision_schema_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    UNIQUE (id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
    request_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state = 'completed'),
    created_at TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    role TEXT NOT NULL CHECK (role IN ('customer', 'support', 'assistant')),
    content TEXT NOT NULL,
    source_timestamp TEXT,
    UNIQUE (conversation_id, sequence),
    FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
    schema_version TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export function openStorage(path: string): Storage {
  const db = new Database(path);
  db.exec(schema);
  return { db };
}

export function closeStorage(storage: Storage): void {
  storage.db.close();
}

export function saveCompletedInitialTriage(storage: Storage, aggregate: InitialTriageAggregate): void {
  CustomerMetadataSchema.parse(aggregate.conversation.customer);
  InitialMessagesSchema.parse(aggregate.messages.map(({ id: _id, ...message }) => message));
  const decision = DecisionSchema.parse(aggregate.decision);
  if (decision.turn_id !== aggregate.turn.id) throw new Error("decision turn_id does not match turn");
  if (!aggregate.reply.trim()) throw new Error("reply must not be empty");

  const write = storage.db.transaction(() => {
    storage.db.query("INSERT INTO conversations (id, customer_json) VALUES (?, ?)").run(
      aggregate.conversation.id,
      JSON.stringify(aggregate.conversation.customer),
    );
    storage.db.query(`INSERT INTO turns
      (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(aggregate.turn.id, aggregate.conversation.id, aggregate.turn.state, aggregate.turn.provider,
        aggregate.turn.model_adapter, aggregate.turn.mock_scenario, aggregate.turn.decision_schema_version,
        aggregate.turn.started_at, aggregate.turn.completed_at);
    storage.db.query(`INSERT INTO requests
      (id, conversation_id, turn_id, request_key, state, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(aggregate.request.id, aggregate.conversation.id, aggregate.turn.id, aggregate.request.key,
        aggregate.request.state, aggregate.request.created_at, aggregate.request.completed_at);
    aggregate.messages.forEach((message, index) => storage.db.query(`INSERT INTO messages
      (id, conversation_id, turn_id, sequence, role, content, source_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, aggregate.conversation.id, aggregate.turn.id, index + 1, message.role, message.content, message.timestamp));
    storage.db.query(`INSERT INTO messages
      (id, conversation_id, turn_id, sequence, role, content, source_timestamp)
      VALUES (?, ?, ?, ?, 'assistant', ?, NULL)`)
      .run(`${aggregate.turn.id}:reply`, aggregate.conversation.id, aggregate.turn.id, aggregate.messages.length + 1, aggregate.reply);
    storage.db.query(`INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(decision.id, aggregate.turn.id, decision.schema_version, JSON.stringify(decision), aggregate.turn.completed_at);
  });
  write();
}

export function loadConversation(storage: Storage, conversationId: string): InitialTriageAggregate {
  const conversation = storage.db.query("SELECT id, customer_json FROM conversations WHERE id = ?").get(conversationId) as
    | { id: string; customer_json: string } | null;
  if (!conversation) throw new Error("conversation not found");
  const customer = CustomerMetadataSchema.parse(JSON.parse(conversation.customer_json));
  const turn = storage.db.query("SELECT * FROM turns WHERE conversation_id = ? ORDER BY started_at LIMIT 1").get(conversationId) as Record<string, string> | null;
  if (!turn) throw new Error("conversation turn not found");
  const request = storage.db.query("SELECT * FROM requests WHERE conversation_id = ?").get(conversationId) as Record<string, string>;
  const rows = storage.db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence").all(conversationId) as Array<Record<string, string | number | null>>;
  const reply = rows.at(-1);
  if (!reply || reply.role !== "assistant") throw new Error("assistant reply not found");
  const messages = rows.slice(0, -1).map((row) => InitialMessageSchema.parse({ role: row.role, content: row.content, timestamp: row.source_timestamp }));
  const decisionRow = storage.db.query("SELECT decision_json FROM decisions WHERE turn_id = ?").get(turn.id) as { decision_json: string } | null;
  if (!decisionRow) throw new Error("decision not found");
  return {
    conversation: { id: conversation.id, customer },
    request: { id: request.id, key: request.request_key, state: "completed", created_at: request.created_at, completed_at: request.completed_at },
    turn: { id: turn.id, state: "completed", provider: turn.provider, model_adapter: turn.model_adapter, mock_scenario: turn.mock_scenario, decision_schema_version: turn.decision_schema_version, started_at: turn.started_at, completed_at: turn.completed_at },
    messages: messages.map((message, index) => ({ ...message, id: rows[index].id as string })),
    reply: reply.content as string,
    decision: DecisionSchema.parse(JSON.parse(decisionRow.decision_json)),
  };
}
