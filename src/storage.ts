import { Database } from "bun:sqlite";
import {
  CustomerMetadataSchema,
  DecisionSchema,
  InitialMessageSchema,
  InitialMessagesSchema,
  TicketResponseSchema,
  type CustomerMetadata,
  type Decision,
  type InitialMessage,
  type TicketResponse,
} from "./schemas";
import {
  IdempotencyKeySchema,
  RequestFingerprintSchema,
  RequestResolutionSchema,
  RequestStateSchema,
  type IdempotencyKey,
  type RequestFingerprint,
  type RequestResolution,
} from "./idempotency";

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

export interface RequestClaim {
  scope: string;
  key: IdempotencyKey;
  fingerprint: RequestFingerprint;
  conversation_id: string;
  turn_id: string;
}

export interface StoredRequest {
  scope: string;
  key: IdempotencyKey;
  fingerprint: RequestFingerprint;
  state: "processing" | "completed" | "conflict";
  turn_id: string;
  cached_status: number | null;
  cached_response: TicketResponse | null;
  created_at: string;
  completed_at: string | null;
}

const requestsTable = `CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
    endpoint_scope TEXT NOT NULL DEFAULT 'legacy',
    request_key TEXT NOT NULL,
    body_fingerprint TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'conflict')),
    cached_status INTEGER,
    cached_response_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (endpoint_scope, request_key)
  );`;

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
  ${requestsTable}
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
  const columns = db.query("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "endpoint_scope")) {
    db.exec("ALTER TABLE requests RENAME TO requests_legacy;");
    db.exec(requestsTable);
    db.exec(`INSERT INTO requests (id, conversation_id, turn_id, endpoint_scope, request_key, body_fingerprint, state, created_at, completed_at)
      SELECT id, conversation_id, turn_id, 'legacy', request_key,
        '0000000000000000000000000000000000000000000000000000000000000000', 'completed', created_at, completed_at
      FROM requests_legacy;`);
    db.exec("DROP TABLE requests_legacy;");
  }
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

export function claimRequest(storage: Storage, claim: RequestClaim): RequestResolution {
  if (!claim.scope.trim()) throw new Error("request scope must not be empty");
  IdempotencyKeySchema.parse(claim.key);
  RequestFingerprintSchema.parse(claim.fingerprint);
  const resolve = storage.db.transaction((): RequestResolution => {
    const existing = storage.db.query("SELECT state, body_fingerprint, turn_id, cached_response_json FROM requests WHERE endpoint_scope = ? AND request_key = ?").get(claim.scope, claim.key) as
      | { state: string; body_fingerprint: string; turn_id: string; cached_response_json: string | null } | null;
    if (existing) {
      if (existing.body_fingerprint !== claim.fingerprint) return RequestResolutionSchema.parse({ outcome: "conflict", state: "conflict", retryable: false, details: { reason: "different_body" } });
      if (existing.state === "completed" && existing.cached_response_json) return RequestResolutionSchema.parse({ outcome: "replay", state: "completed", response: TicketResponseSchema.parse(JSON.parse(existing.cached_response_json)) });
      return RequestResolutionSchema.parse({ outcome: "conflict", state: "conflict", retryable: true, details: { reason: "processing" } });
    }
    storage.db.query(`INSERT INTO requests (id, conversation_id, turn_id, endpoint_scope, request_key, body_fingerprint, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`)
      .run(crypto.randomUUID(), claim.conversation_id, claim.turn_id, claim.scope, claim.key, claim.fingerprint, new Date().toISOString());
    return RequestResolutionSchema.parse({ outcome: "claimed", state: "processing", turn_id: claim.turn_id });
  });
  return resolve();
}

export function loadRequest(storage: Storage, scope: string, key: string): StoredRequest | null {
  const row = storage.db.query("SELECT * FROM requests WHERE endpoint_scope = ? AND request_key = ?").get(scope, key) as Record<string, string | number | null> | null;
  if (!row) return null;
  return {
    scope: row.endpoint_scope as string,
    key: IdempotencyKeySchema.parse(row.request_key),
    fingerprint: RequestFingerprintSchema.parse(row.body_fingerprint),
    state: RequestStateSchema.parse(row.state),
    turn_id: row.turn_id as string,
    cached_status: row.cached_status as number | null,
    cached_response: row.cached_response_json === null ? null : TicketResponseSchema.parse(JSON.parse(row.cached_response_json as string)),
    created_at: row.created_at as string,
    completed_at: row.completed_at as string | null,
  };
}

export function completeRequest(storage: Storage, scope: string, key: string, response: TicketResponse, status = 201): void {
  const parsed = TicketResponseSchema.parse(response);
  storage.db.query(`UPDATE requests SET state = 'completed', cached_status = ?, cached_response_json = ?, completed_at = ?
    WHERE endpoint_scope = ? AND request_key = ?`)
    .run(status, JSON.stringify(parsed), new Date().toISOString(), scope, key);
}
