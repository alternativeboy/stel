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
import {
  EnsureWorkItemInputSchema,
  EnsureWorkItemResultSchema,
  OperationIdentitySchema,
  StoredEffectAttemptSchema,
  StoredWorkItemSchema,
  type EnsureWorkItemInput,
  type EnsureWorkItemResult,
  type OperationIdentity,
  type StoredEffectAttempt,
  type StoredWorkItem,
} from "./policy-effects";
import { FollowUpMessageSchema, type FollowUpMessage } from "./follow-up";
import { RecoveryClassificationSchema, RecoveryEffectStatusSchema, RecoveryOutcomeSchema, RecoveryReferencesSchema, RecoveryResultSchema, type RecoveryClassification, type RecoveryEffectStatus, type RecoveryResult } from "./recovery";

export type StoredMessage = (InitialMessage | FollowUpMessage) & { id: string };

export interface InitialTriageAggregate {
  conversation: { id: string; customer: CustomerMetadata };
  request: {
    id: string;
    key: string;
    scope?: string;
    fingerprint?: string;
    cached_response?: TicketResponse;
    cached_status?: number;
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
    messages?: StoredMessage[];
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
  initial?: {
    customer: CustomerMetadata;
    provider: string;
    model_adapter: string;
    mock_scenario: string;
    decision_schema_version: string;
    started_at: string;
    messages?: StoredMessage[];
  };
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

export interface FollowUpClaim {
  conversation_id: string;
  scope: string;
  key: IdempotencyKey;
  fingerprint: RequestFingerprint;
  turn_id: string;
  provider: string;
  model_adapter: string;
  mock_scenario: string;
  decision_schema_version: string;
  started_at: string;
}

export interface FollowUpAggregate {
  conversation_id: string;
  request: { scope: string; key: IdempotencyKey; fingerprint: RequestFingerprint; turn_id: string; created_at: string; completed_at: string };
  turn: { id: string; provider: string; model_adapter: string; mock_scenario: string; decision_schema_version: string; started_at: string; completed_at: string };
  message: { id: string; role: "operator" | "customer"; content: string; timestamp: string };
  response: TicketResponse;
}

export interface ConversationHistory {
  conversation: { id: string; customer: CustomerMetadata };
  messages: Array<{ id: string; turn_id: string; sequence: number; role: "customer" | "support" | "operator" | "assistant"; content: string; timestamp: string | null }>;
  turns: Array<{ id: string; state: "processing" | "completed"; provider: string; model_adapter: string; mock_scenario: string; decision_schema_version: string; started_at: string; completed_at: string | null }>;
  decisions: Decision[];
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

const turnsTable = `CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
    provider TEXT NOT NULL,
    model_adapter TEXT NOT NULL,
    mock_scenario TEXT NOT NULL,
    decision_schema_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, conversation_id)
  );`;

const effectsTables = `
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    kind TEXT NOT NULL CHECK (kind IN ('specialist_case', 'incident')),
    queue TEXT NOT NULL CHECK (queue IN ('billing', 'product_support', 'operations', 'manual_triage')),
    operation_key TEXT NOT NULL UNIQUE,
    intent_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
    provider TEXT NOT NULL,
    receipt_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, kind, queue)
  );
  CREATE TABLE IF NOT EXISTS effect_attempts (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    turn_id TEXT REFERENCES turns(id),
    tool_call_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
    result_json TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );`;

const messagesTable = `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    role TEXT NOT NULL CHECK (role IN ('customer', 'support', 'operator', 'assistant')),
    content TEXT NOT NULL,
    source_timestamp TEXT,
    UNIQUE (conversation_id, sequence),
    FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(id, conversation_id)
  );`;

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    customer_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ${turnsTable}
  ${requestsTable}
  ${messagesTable}
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
    schema_version TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  ${effectsTables}
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
  const turnDefinition = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get() as { sql: string } | null;
  if (turnDefinition?.sql.includes("state = 'completed'")) {
    db.exec("ALTER TABLE turns RENAME TO turns_legacy;");
    db.exec(turnsTable);
    db.exec(`INSERT INTO turns (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at, completed_at)
      SELECT id, conversation_id, 'completed', provider, model_adapter, mock_scenario, decision_schema_version, started_at, completed_at FROM turns_legacy;`);
    db.exec("DROP TABLE turns_legacy;");
  }
  const messageDefinition = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string } | null;
  if (messageDefinition && !messageDefinition.sql.includes("'operator'")) {
    db.exec("PRAGMA foreign_keys = OFF; ALTER TABLE messages RENAME TO messages_legacy;");
    db.exec(messagesTable);
    db.exec("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) SELECT id, conversation_id, turn_id, sequence, role, content, source_timestamp FROM messages_legacy;");
    db.exec("DROP TABLE messages_legacy; PRAGMA foreign_keys = ON;");
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
    storage.db.query("INSERT OR IGNORE INTO conversations (id, customer_json) VALUES (?, ?)").run(
      aggregate.conversation.id,
      JSON.stringify(aggregate.conversation.customer),
    );
    storage.db.query(`INSERT OR IGNORE INTO turns
      (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(aggregate.turn.id, aggregate.conversation.id, aggregate.turn.state, aggregate.turn.provider,
        aggregate.turn.model_adapter, aggregate.turn.mock_scenario, aggregate.turn.decision_schema_version,
        aggregate.turn.started_at, aggregate.turn.completed_at);
    storage.db.query(`UPDATE turns SET state = 'completed', completed_at = ?, provider = ?, model_adapter = ?, mock_scenario = ?, decision_schema_version = ? WHERE id = ?`)
      .run(aggregate.turn.completed_at, aggregate.turn.provider, aggregate.turn.model_adapter, aggregate.turn.mock_scenario, aggregate.turn.decision_schema_version, aggregate.turn.id);
    storage.db.query(`INSERT INTO requests
      (id, conversation_id, turn_id, endpoint_scope, request_key, body_fingerprint, state, cached_status, cached_response_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_scope, request_key) DO UPDATE SET state = excluded.state, cached_status = excluded.cached_status, cached_response_json = excluded.cached_response_json, completed_at = excluded.completed_at
        WHERE requests.turn_id = excluded.turn_id AND requests.body_fingerprint = excluded.body_fingerprint`)
      .run(aggregate.request.id, aggregate.conversation.id, aggregate.turn.id, aggregate.request.scope ?? "legacy", aggregate.request.key,
        aggregate.request.fingerprint ?? "0000000000000000000000000000000000000000000000000000000000000000", aggregate.request.state,
        aggregate.request.cached_status ?? null, aggregate.request.cached_response ? JSON.stringify(TicketResponseSchema.parse(aggregate.request.cached_response)) : null,
        aggregate.request.created_at, aggregate.request.completed_at);
    aggregate.messages.forEach((message, index) => storage.db.query(`INSERT OR IGNORE INTO messages
      (id, conversation_id, turn_id, sequence, role, content, source_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, aggregate.conversation.id, aggregate.turn.id, index + 1, message.role, message.content, message.timestamp));
    storage.db.query(`INSERT OR IGNORE INTO messages
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
  const messages = rows.slice(0, -1).map((row) => row.role === "operator"
    ? FollowUpMessageSchema.parse({ role: row.role, content: row.content, timestamp: row.source_timestamp })
    : InitialMessageSchema.parse({ role: row.role, content: row.content, timestamp: row.source_timestamp }));
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
    if (!claim.initial) throw new Error("initial request metadata is required");
    CustomerMetadataSchema.parse(claim.initial.customer);
    storage.db.query("INSERT INTO conversations (id, customer_json) VALUES (?, ?)").run(claim.conversation_id, JSON.stringify(claim.initial.customer));
    storage.db.query(`INSERT INTO turns (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at, completed_at)
      VALUES (?, ?, 'processing', ?, ?, ?, ?, ?, ?)`)
      .run(claim.turn_id, claim.conversation_id, claim.initial.provider, claim.initial.model_adapter, claim.initial.mock_scenario, claim.initial.decision_schema_version, claim.initial.started_at, null);
    for (const [index, message] of (claim.initial.messages ?? []).entries()) {
      const { id: _id, ...messagePayload } = message;
      const parsedMessage = message.role === "operator" ? FollowUpMessageSchema.parse(messagePayload) : InitialMessageSchema.parse(messagePayload);
      storage.db.query("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)").run(message.id, claim.conversation_id, claim.turn_id, index + 1, parsedMessage.role, parsedMessage.content, parsedMessage.timestamp);
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

export function createOrReuseWorkItem(
  storage: Storage,
  identity: OperationIdentity,
  input: EnsureWorkItemInput,
  provider = "mock",
): { workItem: StoredWorkItem; reused: boolean } {
  const parsedIdentity = OperationIdentitySchema.parse(identity);
  const parsedInput = EnsureWorkItemInputSchema.parse(input);
  if (parsedIdentity.kind !== parsedInput.kind || parsedIdentity.queue !== parsedInput.queue) {
    throw new Error("work-item identity does not match intent");
  }
  const expectedOperationKey = `work-item:${parsedIdentity.conversation_id}:${parsedIdentity.kind}:${parsedIdentity.queue}`;
  if (parsedIdentity.operation_key !== expectedOperationKey) throw new Error("operation key is not server-derived");
  const now = new Date().toISOString();
  const transact = storage.db.transaction(() => {
    const existing = storage.db.query("SELECT * FROM work_items WHERE operation_key = ?").get(parsedIdentity.operation_key) as Record<string, string | null> | null;
    if (existing) return { workItem: parseStoredWorkItem(existing), reused: true };
    const id = `wi-${crypto.randomUUID()}`;
    storage.db.query(`INSERT INTO work_items
      (id, conversation_id, kind, queue, operation_key, intent_json, status, provider, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`)
      .run(id, parsedIdentity.conversation_id, parsedIdentity.kind, parsedIdentity.queue, parsedIdentity.operation_key, JSON.stringify(parsedInput), provider, now, now);
    return { workItem: StoredWorkItemSchema.parse({ id, conversation_id: parsedIdentity.conversation_id, kind: parsedIdentity.kind, queue: parsedIdentity.queue, operation_key: parsedIdentity.operation_key, intent: parsedInput, status: "pending", provider, receipt: null, created_at: now, updated_at: now }), reused: false };
  });
  return transact();
}

export function recordEffectAttempt(storage: Storage, attempt: Omit<StoredEffectAttempt, "status" | "result" | "completed_at">): StoredEffectAttempt {
  const parsed = StoredEffectAttemptSchema.parse({ ...attempt, status: "pending", result: null, completed_at: null });
  storage.db.query(`INSERT INTO effect_attempts (id, work_item_id, turn_id, tool_call_id, status, result_json, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)`).run(parsed.id, parsed.work_item_id, parsed.turn_id, parsed.tool_call_id, parsed.started_at);
  return parsed;
}

export function completeEffectAttempt(storage: Storage, attemptId: string, result: EnsureWorkItemResult): StoredEffectAttempt {
  const parsedResult = EnsureWorkItemResultSchema.parse(result);
  const completedAt = new Date().toISOString();
  const transact = storage.db.transaction(() => {
    const row = storage.db.query("SELECT * FROM effect_attempts WHERE id = ?").get(attemptId) as Record<string, string | null> | null;
    if (!row) throw new Error("effect attempt not found");
    if (row.status !== "pending") throw new Error("effect attempt is already completed");
    if ((parsedResult.status === "succeeded" || parsedResult.status === "reused") && parsedResult.receipt.work_item_id !== row.work_item_id) {
      throw new Error("effect receipt does not match work item");
    }
    const status = parsedResult.status === "reused" ? "succeeded" : parsedResult.status;
    storage.db.query("UPDATE effect_attempts SET status = ?, result_json = ?, completed_at = ? WHERE id = ?")
      .run(status, JSON.stringify(parsedResult), completedAt, attemptId);
    if (parsedResult.status === "succeeded" || parsedResult.status === "reused") {
      storage.db.query("UPDATE work_items SET status = 'succeeded', receipt_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(parsedResult.receipt), completedAt, row.work_item_id);
    } else {
      storage.db.query("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?")
        .run(parsedResult.status, completedAt, row.work_item_id);
    }
    const updated = storage.db.query("SELECT * FROM effect_attempts WHERE id = ?").get(attemptId) as Record<string, string | null>;
    return parseStoredEffectAttempt(updated);
  });
  return transact();
}

export function loadConversationEffects(storage: Storage, conversationId: string): { work_items: StoredWorkItem[]; attempts: StoredEffectAttempt[] } {
  const items = storage.db.query("SELECT * FROM work_items WHERE conversation_id = ? ORDER BY created_at, id").all(conversationId) as Array<Record<string, string | null>>;
  const workItems = items.map(parseStoredWorkItem);
  const attempts = storage.db.query(`SELECT ea.* FROM effect_attempts ea JOIN work_items wi ON wi.id = ea.work_item_id WHERE wi.conversation_id = ? ORDER BY ea.started_at, ea.id`).all(conversationId) as Array<Record<string, string | null>>;
  return { work_items: workItems, attempts: attempts.map(parseStoredEffectAttempt) };
}

function parseStoredWorkItem(row: Record<string, string | null>): StoredWorkItem {
  return StoredWorkItemSchema.parse({ id: row.id, conversation_id: row.conversation_id, kind: row.kind, queue: row.queue, operation_key: row.operation_key, intent: JSON.parse(row.intent_json!), status: row.status, provider: row.provider, receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json), created_at: row.created_at, updated_at: row.updated_at });
}

function parseStoredEffectAttempt(row: Record<string, string | null>): StoredEffectAttempt {
  return StoredEffectAttemptSchema.parse({ id: row.id, work_item_id: row.work_item_id, turn_id: row.turn_id, tool_call_id: row.tool_call_id, status: row.status, result: row.result_json === null ? null : JSON.parse(row.result_json), started_at: row.started_at, completed_at: row.completed_at });
}

export function claimFollowUpRequest(storage: Storage, claim: FollowUpClaim): RequestResolution {
  IdempotencyKeySchema.parse(claim.key);
  RequestFingerprintSchema.parse(claim.fingerprint);
  const resolve = storage.db.transaction((): RequestResolution => {
    const existing = storage.db.query("SELECT state, body_fingerprint, cached_response_json FROM requests WHERE endpoint_scope = ? AND request_key = ?").get(claim.scope, claim.key) as { state: string; body_fingerprint: string; cached_response_json: string | null } | null;
    if (existing) {
      if (existing.body_fingerprint !== claim.fingerprint) return RequestResolutionSchema.parse({ outcome: "conflict", state: "conflict", retryable: false, details: { reason: "different_body" } });
      if (existing.state === "completed" && existing.cached_response_json) return RequestResolutionSchema.parse({ outcome: "replay", state: "completed", response: TicketResponseSchema.parse(JSON.parse(existing.cached_response_json)) });
      return RequestResolutionSchema.parse({ outcome: "conflict", state: "conflict", retryable: true, details: { reason: "processing" } });
    }
    const conversation = storage.db.query("SELECT id FROM conversations WHERE id = ?").get(claim.conversation_id);
    if (!conversation) throw new Error("conversation not found");
    const active = storage.db.query("SELECT id FROM turns WHERE conversation_id = ? AND state = 'processing' LIMIT 1").get(claim.conversation_id);
    if (active) return RequestResolutionSchema.parse({ outcome: "conflict", state: "conflict", retryable: true, details: { reason: "processing" } });
    storage.db.query(`INSERT INTO turns (id, conversation_id, state, provider, model_adapter, mock_scenario, decision_schema_version, started_at, completed_at) VALUES (?, ?, 'processing', ?, ?, ?, ?, ?, NULL)`).run(claim.turn_id, claim.conversation_id, claim.provider, claim.model_adapter, claim.mock_scenario, claim.decision_schema_version, claim.started_at);
    storage.db.query(`INSERT INTO requests (id, conversation_id, turn_id, endpoint_scope, request_key, body_fingerprint, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`).run(crypto.randomUUID(), claim.conversation_id, claim.turn_id, claim.scope, claim.key, claim.fingerprint, new Date().toISOString());
    return RequestResolutionSchema.parse({ outcome: "claimed", state: "processing", turn_id: claim.turn_id });
  });
  return resolve();
}

export function saveCompletedFollowUp(storage: Storage, aggregate: FollowUpAggregate): void {
  const { id: _messageId, ...messageInput } = aggregate.message;
  FollowUpMessageSchema.parse(messageInput);
  const response = TicketResponseSchema.parse(aggregate.response);
  if (response.conversation_id !== aggregate.conversation_id || response.turn_id !== aggregate.turn.id) throw new Error("follow-up response identity does not match turn");
  const write = storage.db.transaction(() => {
    const max = storage.db.query("SELECT MAX(sequence) AS sequence FROM messages WHERE conversation_id = ?").get(aggregate.conversation_id) as { sequence: number | null };
    const start = (max.sequence ?? 0) + 1;
    storage.db.query("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)").run(aggregate.message.id, aggregate.conversation_id, aggregate.turn.id, start, aggregate.message.role, aggregate.message.content, aggregate.message.timestamp);
    storage.db.query("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) VALUES (?, ?, ?, ?, 'assistant', ?, NULL)").run(`${aggregate.turn.id}:reply`, aggregate.conversation_id, aggregate.turn.id, start + 1, response.reply);
    storage.db.query("UPDATE turns SET state = 'completed', completed_at = ? WHERE id = ? AND conversation_id = ?").run(aggregate.turn.completed_at, aggregate.turn.id, aggregate.conversation_id);
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?)").run(response.decision.id, aggregate.turn.id, response.decision.schema_version, JSON.stringify(response.decision), aggregate.turn.completed_at);
    storage.db.query("UPDATE requests SET state = 'completed', cached_status = 200, cached_response_json = ?, completed_at = ? WHERE endpoint_scope = ? AND request_key = ? AND turn_id = ?").run(JSON.stringify(response), aggregate.turn.completed_at, aggregate.request.scope, aggregate.request.key, aggregate.turn.id);
  });
  write();
}

export function loadConversationHistory(storage: Storage, conversationId: string): ConversationHistory {
  const row = storage.db.query("SELECT id, customer_json FROM conversations WHERE id = ?").get(conversationId) as { id: string; customer_json: string } | null;
  if (!row) throw new Error("conversation not found");
  const customer = CustomerMetadataSchema.parse(JSON.parse(row.customer_json));
  const turns = (storage.db.query("SELECT * FROM turns WHERE conversation_id = ? ORDER BY started_at, id").all(conversationId) as Array<Record<string, string | null>>).map((turn) => ({ id: turn.id!, state: turn.state as "processing" | "completed", provider: turn.provider!, model_adapter: turn.model_adapter!, mock_scenario: turn.mock_scenario!, decision_schema_version: turn.decision_schema_version!, started_at: turn.started_at!, completed_at: turn.completed_at }));
  const messages = (storage.db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence").all(conversationId) as Array<Record<string, string | number | null>>).map((message) => ({ id: String(message.id), turn_id: String(message.turn_id), sequence: Number(message.sequence), role: message.role as ConversationHistory["messages"][number]["role"], content: String(message.content), timestamp: message.source_timestamp as string | null }));
  const decisions = (storage.db.query("SELECT decision_json FROM decisions WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id = ?) ORDER BY created_at, id").all(conversationId) as Array<{ decision_json: string }>).map((decision) => DecisionSchema.parse(JSON.parse(decision.decision_json)));
  return { conversation: { id: row.id, customer }, messages, turns, decisions };
}

export interface InterruptedRequest {
  classification: RecoveryClassification;
  effect_status: RecoveryEffectStatus;
  references: { request_id: string; conversation_id: string; turn_id: string; decision_id?: string; effect_id?: string; work_item_id?: string; receipt_id?: string };
  request_scope: string;
  request_key: IdempotencyKey;
  fingerprint: RequestFingerprint;
}

function recoveryReferences(row: Record<string, string | null>): InterruptedRequest["references"] {
  return RecoveryReferencesSchema.parse({ request_id: row.request_id, conversation_id: row.conversation_id, turn_id: row.turn_id, ...(row.decision_id ? { decision_id: row.decision_id } : {}), ...(row.effect_id ? { effect_id: row.effect_id } : {}), ...(row.work_item_id ? { work_item_id: row.work_item_id } : {}), ...(row.receipt_id ? { receipt_id: row.receipt_id } : {}) });
}

export function inspectInterruptedRequests(storage: Storage): InterruptedRequest[] {
  const rows = storage.db.query(`SELECT r.id AS request_id, r.conversation_id, r.turn_id, r.endpoint_scope, r.request_key, r.body_fingerprint,
      t.state AS turn_state, d.id AS decision_id, wi.id AS work_item_id, wi.status AS effect_status,
      ea.id AS effect_id, wi.receipt_json
    FROM requests r JOIN turns t ON t.id = r.turn_id
    LEFT JOIN decisions d ON d.turn_id = t.id
    LEFT JOIN work_items wi ON wi.id = (SELECT id FROM work_items WHERE conversation_id = r.conversation_id ORDER BY created_at DESC, id DESC LIMIT 1)
    LEFT JOIN effect_attempts ea ON ea.id = (SELECT id FROM effect_attempts WHERE work_item_id = wi.id ORDER BY started_at DESC, id DESC LIMIT 1)
    WHERE r.state = 'processing' OR t.state = 'processing'
    ORDER BY r.created_at, r.id`).all() as Array<Record<string, string | null>>;
  return rows.map((row) => {
    const hasDecision = Boolean(row.decision_id);
    const hasEffect = Boolean(row.work_item_id);
    const classification = RecoveryClassificationSchema.parse(!hasDecision ? "accepted_no_plan" : row.effect_status === "succeeded" && row.receipt_json ? "effect_committed_before_response" : hasEffect ? "frozen_plan_before_effect" : "frozen_plan_before_effect");
    const effectStatus = RecoveryEffectStatusSchema.parse(hasEffect ? row.effect_status === "succeeded" && row.receipt_json ? "succeeded" : row.effect_status === "failed" ? "failed" : row.effect_status === "pending" ? "pending" : "unknown" : "not_applicable");
    return { classification, effect_status: effectStatus, references: recoveryReferences(row), request_scope: row.endpoint_scope!, request_key: IdempotencyKeySchema.parse(row.request_key), fingerprint: RequestFingerprintSchema.parse(row.body_fingerprint) };
  });
}

export function finalizeInterruptedNoPlan(storage: Storage, requestId: string): RecoveryResult {
  const existing = inspectInterruptedRequests(storage).find((candidate) => candidate.references.request_id === requestId);
  if (!existing) throw new Error("interrupted request not found");
  const now = new Date().toISOString();
  const response = TicketResponseSchema.parse({ conversation_id: existing.references.conversation_id, turn_id: existing.references.turn_id, reply: "A human operator is needed to continue this request; automated triage did not complete.", decision: { id: `decision-recovery-${existing.references.turn_id}`, turn_id: existing.references.turn_id, schema_version: "decision.v1", urgency: "high", extracted: { product_area: "unknown", primary_issue_type: "unknown", secondary_issue_types: [], sentiment: "unknown", language: "unknown" }, action: "escalate_to_human", target_queue: "manual_triage", rationale: "The request was accepted before an automated plan was durable; manual triage is required.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "degraded" } });
  const write = storage.db.transaction(() => {
    const row = storage.db.query("SELECT state, cached_response_json FROM requests WHERE id = ?").get(requestId) as { state: string; cached_response_json: string | null } | null;
    if (!row) throw new Error("interrupted request not found");
    if (row.state === "completed" && row.cached_response_json) {
      return RecoveryResultSchema.parse({ classification: "already_completed", outcome: "already_completed", references: existing.references, effect_status: existing.effect_status });
    }
    storage.db.query("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) VALUES (?, ?, ?, COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id = ?), 0) + 1, 'assistant', ?, NULL)").run(`recovery:${existing.references.turn_id}`, existing.references.conversation_id, existing.references.turn_id, existing.references.conversation_id, response.reply);
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?)").run(response.decision.id, existing.references.turn_id, response.decision.schema_version, JSON.stringify(response.decision), now);
    storage.db.query("UPDATE turns SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'processing'").run(now, existing.references.turn_id);
    storage.db.query("UPDATE requests SET state = 'completed', cached_status = COALESCE(cached_status, 201), cached_response_json = ?, completed_at = ? WHERE id = ? AND state = 'processing'").run(JSON.stringify(response), now, requestId);
    return RecoveryResultSchema.parse({ classification: "accepted_no_plan", outcome: "finalized_degraded", references: { ...existing.references, decision_id: response.decision.id }, effect_status: "not_applicable" });
  });
  return write();
}

export function finalizeRecoveredResponse(storage: Storage, requestId: string, response: TicketResponse, status = 200): RecoveryResult {
  const parsed = TicketResponseSchema.parse(response);
  const existing = inspectInterruptedRequests(storage).find((candidate) => candidate.references.request_id === requestId);
  if (!existing) throw new Error("interrupted request not found");
  const write = storage.db.transaction(() => {
    const row = storage.db.query("SELECT state, cached_response_json FROM requests WHERE id = ?").get(requestId) as { state: string; cached_response_json: string | null } | null;
    if (!row) throw new Error("interrupted request not found");
    if (row.state === "completed" && row.cached_response_json) return RecoveryResultSchema.parse({ classification: "already_completed", outcome: "already_completed", references: existing.references, effect_status: existing.effect_status });
    if (existing.effect_status !== "succeeded") return RecoveryResultSchema.parse({ classification: existing.classification, outcome: "unresolved", references: existing.references, effect_status: "unknown" });
    storage.db.query("INSERT INTO messages (id, conversation_id, turn_id, sequence, role, content, source_timestamp) VALUES (?, ?, ?, COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id = ?), 0) + 1, 'assistant', ?, NULL)").run(`recovery:${parsed.turn_id}`, parsed.conversation_id, parsed.turn_id, parsed.conversation_id, parsed.reply);
    storage.db.query("INSERT INTO decisions (id, turn_id, schema_version, decision_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET decision_json = excluded.decision_json, schema_version = excluded.schema_version").run(parsed.decision.id, parsed.turn_id, parsed.decision.schema_version, JSON.stringify(parsed.decision), new Date().toISOString());
    storage.db.query("UPDATE turns SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'processing'").run(new Date().toISOString(), parsed.turn_id);
    storage.db.query("UPDATE requests SET state = 'completed', cached_status = ?, cached_response_json = ?, completed_at = ? WHERE id = ? AND state = 'processing'").run(status, JSON.stringify(parsed), new Date().toISOString(), requestId);
    return RecoveryResultSchema.parse({ classification: existing.classification, outcome: existing.effect_status === "succeeded" ? "effect_reused" : "response_finalized", references: { ...existing.references, decision_id: parsed.decision.id }, effect_status: existing.effect_status });
  });
  return write();
}
