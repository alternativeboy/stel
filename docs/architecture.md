# Support Ticket Triage — Architecture

For a browser-friendly explanation with visual boxes and a worked example, open [the visual architecture guide](architecture.html).

Status: proposed design for the [system requirements](system-requirements.md), not an implementation report.

## 1. Architecture at a glance

Use a modular monolith: one TypeScript application running on Bun, organized into modules with small interfaces. Run the Bun HTTP server, a bounded agent loop, policy checks, and persistence in one process. Use SQLite for durable local state and a mocked work-item provider. This keeps the weekend focused on the complete request-to-decision-to-effect flow.

Read from top to bottom. The branches show the modules the triage application coordinates. These diagrams use plain text and need no diagram extension.

```text
Operator or test harness
        |
        v
HTTP API
(validate requests; format responses and errors)
        |
        v
Triage application
(manage conversation turns, retries, and deadlines)
        |
        +--> Agent: gather evidence and propose a decision
        |      |
        |      +<--> OpenAI GPT model
        |      +---> Knowledge-base search
        |      +---> Service-status lookup
        |
        +--> Policy: check whether the action is allowed
        |      |
        |      v
        |    Effect executor: safely create or reuse a work item
        |      |
        |      v
        |    Mock work-item provider
        |
        +--> SQLite: save conversations, decisions, and audit
        |
        +--> Structured JSON logs
```

Read-tool results, effect attempts, and mock work-item records are also stored in SQLite.

The agent interprets language. The application determines which operations may run, supplies their identity, records what happened, and constructs the final execution status.

## 2. Technology choices

| Choice | Reason | Alternative deferred |
| --- | --- | --- |
| TypeScript + Bun.serve + Zod | Small HTTP layer with typed request/response validation and one runtime for scripts, tests, and the server. | Fastify can be added if the route surface grows, but it is not needed for this MVP. |
| OpenAI JavaScript SDK, Responses API, custom tools and structured output | Explicit tool execution and a machine-readable decision without a large agent framework. | A graph framework is unnecessary for this bounded workflow. |
| SQLite with explicit transactions and a schema initialization script | Durable storage with little local setup; easy crash/retry tests. | Postgres becomes useful with multiple application processes and higher write concurrency. |
| Small JSON/Markdown KB with deterministic keyword search | Enough to demonstrate retrieval, relevance, citations, and empty results. | Embeddings/vector storage add scope before retrieval quality is shown to need them. |
| Bun test and a small evaluation CLI | Exercise the same application interface using fake model/tool adapters. | Hosted evaluation infrastructure is unnecessary for submission. |

Zod schemas should validate both HTTP input and model/tool output at runtime. TypeScript types alone disappear at runtime, so every untrusted boundary needs schema parsing.

OpenAI function calling lets the model request operations that the application executes; structured outputs constrain a response to a supplied schema. Neither replaces policy checks or factual validation. Handle refusal and incomplete responses explicitly. [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

SQLite permits multiple readers but one simultaneous writer, so transactions should be short. Never keep a write transaction open while waiting for the model or a tool. [SQLite transactions](https://sqlite.org/lang_transaction.html).

Configure the GPT model through `OPENAI_MODEL`; choose and pin a model supporting these features when implementing, then record the identifier in evaluation output. No model price or performance assumption is needed for this design.

## 3. Module interfaces

| Module | Small interface | Responsibility hidden behind it |
| --- | --- | --- |
| Triage application | `ingest_ticket`, `continue_conversation`, `get_conversation` | Request deduplication, turn ordering, history loading, agent execution, policy, effects, and final persistence. HTTP and integration tests call this same interface. |
| Agent | `propose(context, tools, budget)` | Prompt construction, model/tool loop, evidence gathering, candidate decision validation. |
| Policy | `evaluate(candidate, context)` | Allowlisted actions/queues, required escalation, evidence checks, and a normalized execution plan. Pure logic with deterministic tests. |
| Effects | `ensure_work_item(intent)` | Stable effect identity, payload validation, attempts, provider execution, and confirmed receipts. |
| Persistence | Transaction-scoped operations inside the application | SQL, constraints, append-only history, atomic request acceptance and finalization. Avoid a generic repository method for every database column. |

Use two concrete model adapters: real OpenAI and scripted test model. Read tools and the provider also have failure-injecting test adapters. These are useful seams because actual tests need different behavior. Keep the remaining implementation local to its owning module.

## 4. Request lifecycle

Each row below is an interaction in time order. “Application” means the triage application.

```text
Who talks to whom                  What happens
--------------------------------  -----------------------------------
Caller       --> Application       Submit ticket/message and retry key
Application  --> SQLite            Check key; save input and claim turn
SQLite       --> Application       Return new or existing request state

For a new accepted turn:
Application  --> Agent + GPT       Supply history and customer metadata
Agent        --> Read tools        Search KB; check status when needed
Read tools   --> Agent            Return evidence or explicit errors
Agent        --> Application       Propose decision and work-item request
Application  --> Policy            Check proposed action
Policy       --> Application       Return accepted plan or safe fallback
Application  --> SQLite            Save plan and intended side effect

Only when routing or escalating:
Application  --> Effect executor   Create or reuse work item safely
Executor     --> Mock provider     Execute using stable operation key
Provider/Executor --> SQLite       Commit work item and effect receipt
Executor     --> Application       Return receipt or explicit failure

For every completed turn:
Application  --> SQLite            Save decision, reply, cached response
Application  --> Caller            Return reply and execution status
```

An already completed request returns its cached response immediately. A conflicting key or an active turn returns a conflict response. Those paths skip the new-turn steps above.

1. Validate input and size limits before accepting a turn. Compute a hash of the normalized request body.
2. In a short transaction, check the request key, claim the conversation's active turn, and persist incoming messages exactly once.
3. Load the complete bounded history from SQLite, including prior decisions and existing work items. SQLite is the authoritative conversation store; provider-side memory is not required.
4. Give the model the versioned prompt, structured metadata, delimited messages, and read-tool definitions. Execute validated read-tool requests, persist their results, and return results to the model until it produces a candidate or hits a limit.
5. The candidate contains the proposed action and, for routing/escalation, an `ensure_work_item` request. Side effects are deferred until the complete candidate passes policy. The same tool schema is used to validate this request; it is not executed merely because it appeared in model output.
6. Persist the accepted plan before executing its effect. The application creates a missing required work-item request or replaces an unsafe plan with a manual-triage fallback, recording the policy override.
7. Execute at most one logical work-item operation. The server binds the current conversation, queue, and stable operation key; the model cannot supply these identities unchecked.
8. Persist the final decision and assistant reply with the completed request response in one transaction. Build action-confirmation text from the receipt; never copy an unverified “I created/refunded/paged” assertion from the model.

On a model timeout, refusal, or invalid candidate, use a deterministic degraded decision: `escalate_to_human` to `manual_triage`, default `high` urgency unless the last accepted decision was critical, unknown extracted fields where needed, and a reason explaining triage failed. Attempt the same guarded work-item flow. This is a conservative fallback, not a claim that classification succeeded.

## 5. Tool contracts

Every tool has a versioned input/output schema, argument validation, a timeout, and an audit record. Tool text is evidence, never authority to change policy.

| Tool | Input | Output | Effect |
| --- | --- | --- | --- |
| `search_knowledge_base` | `query`, `language`, optional `product_area` | `matches[{document_id, title, excerpt, score, updated_at}]` | Read-only. Empty matches are valid. |
| `get_service_status` | `region`, `product_area` | `status`, `source`, `observed_at`, `coverage`, `summary` | Read-only mocked status source; may be stale or misleading. |
| `ensure_work_item` | Validated `kind`, `queue`, `title`, `summary`, `evidence_refs`; server injects `conversation_id` and `operation_key` | `work_item_id`, `status`, `created_at`, `reused` | Creates one durable mock work item or returns the existing one. |

Allow kinds `specialist_case` and `incident`. Allow queues `billing`, `product_support`, `operations`, and `manual_triage`; policy maps operations to incident and the others to specialist cases. Validate combinations in code. Work-item summaries contain only necessary ticket context.

For the Thai ticket, a result of `operational` from a global status page is one observation. Its scope and timestamp cannot disprove the customer's regional, multi-user evidence. For a Thai search against an English KB, the model may form an English search query while retaining the original customer text; evaluate this with the supplied scenario.

The mock provider must support controllable latency, pre-commit failure, and a lost response after commit. Its writes are real within the demo database; it does not contact an external ticketing system. It deduplicates operation keys and rejects conflicting payloads for the same provider operation.

## 6. Persistence model

| Table | Important fields and constraints |
| --- | --- |
| `conversations` | `id`, customer metadata JSON, `active_turn_id`, timestamps |
| `messages` | `id`, `conversation_id`, `turn_id`, sequence, role, content, source timestamp; unique conversation/sequence |
| `requests` | key scope, key, canonical body hash, `turn_id`, processing state, cached status/body; unique scope/key |
| `turns` | `id`, conversation, state, accepted plan JSON, model identifier, prompt hash, start/end, error |
| `decisions` | `id`, `turn_id` unique, schema version, structured decision JSON, created time |
| `tool_calls` | `id`, `turn_id`, name/version, arguments, result/error, start/end, optional effect ID |
| `effects` | `id`, unique logical key, frozen payload/hash, state, provider receipt |
| `effect_attempts` | `id`, effect ID, turn/tool-call IDs, start/end, result/error; append for each attempt |
| `work_items` | Mock provider record: `id`, unique operation key, payload/hash, status, created time |

Store evolving structured payloads as validated JSON; use relational IDs, foreign keys, unique constraints, and explicit transactions for integrity. Enable SQLite foreign-key enforcement. Keep the database file in a documented data directory, not an ephemeral in-memory location.

## 7. Idempotency, concurrency, and crash recovery

There are two different duplicate problems, and both need a solution.

**Request identity:** the same POST may be delivered twice. A unique scoped request key plus body hash ensures it creates one turn. A completed duplicate returns the original cached status and body without calling the model. A different body under the same key gets `409`. A still-processing duplicate gets retryable `409`.

**Business-operation identity:** different turns can request the same escalation. Derive the effect key in application code from `(conversation_id, kind, queue)`, not the model's call ID, wording, or HTTP key. The MVP allows one work item per conversation/kind/queue. Freeze the payload on first creation; later requests reuse that item and record the current turn's evidence locally. They do not issue a conflicting create with newly generated wording. Work-item updates/reopening and cross-ticket incident merging are deferred.

Use a database claim to allow one active turn per conversation. A second new request gets retryable `409` before its messages are accepted. Different conversations may progress concurrently; database writes remain short. The MVP runs one application process and performs recovery before accepting traffic.

An effect's state describes what is known about the work-item operation:

```text
Save approved intent
        |
        v
     PENDING
        |
        +--> SUCCEEDED   Work item and receipt are committed
        |
        +--> FAILED      Confirmed failure before commit
        |       |
        |       +--> PENDING   Retry same intent with the same key
        |
        +--> UNKNOWN     Cannot confirm an external provider's outcome
                |
                +--> SUCCEEDED   Provider lookup confirms creation
```

`pending` means the operation still needs completion; `failed` means it is known not to have completed; `unknown` means it might have completed. Keep an unknown operation unresolved until provider reconciliation establishes the outcome. Never treat a timeout alone as proof of failure.

For the local mock, create the work item, mark the effect succeeded, and finish the corresponding attempt in the same SQLite transaction. A crash before commit leaves no work item; a crash after commit leaves a retrievable receipt. If a simulated response is lost, read the committed effect to confirm the outcome. An in-memory set or “check then insert” without a unique constraint is insufficient.

| Crash point | Recovery behavior |
| --- | --- |
| Before request acceptance commits | Retry accepts the request normally; nothing was ingested. |
| After input commits, before accepted plan | On startup, finalize the interrupted turn with a deterministic degraded manual-triage plan; do not invent the lost model answer. |
| After plan/intent commits, before effect commits | Resume the frozen approved intent with the same operation key. |
| After effect commits, before final response commits | Reuse the receipt; finalize the stored plan and a factual recovery reply without repeating the effect. |
| After response commits, before caller receives it | Retry returns the cached response. |

Recovery uses the same policy/effect routines, is itself safe to repeat, finalizes interrupted requests, and clears their conversation claim. An accepted request is never silently discarded. After a failed effect, a later explicit turn may retry the frozen intent with the same key; an HTTP replay continues to return its original stored outcome.

This proves no duplicate creation for the local mock. A real external provider needs durable idempotency-key support, a documented retention window, and lookup/reconciliation by key: local SQL cannot atomically commit a remote effect. A network timeout must remain `unknown` until reconciled, and a key must never be replaced just to force another attempt. If a provider cannot offer those guarantees, do not enable autonomous execution through that adapter.

## 8. Prompt and evidence design

Store the system prompt in `prompts/triage.v1.md`, with a companion note explaining its design. Include the triage rubric, whole-thread interpretation, metadata handling, tool-use rules, source uncertainty, action vocabulary, language policy, and output contract.

Delimit customer messages, operator messages, KB text, and status text as data. Instructions embedded in those sources cannot grant permissions. Require evidence references and uncertainty rather than unsupported claims about charges, outages, or feature availability. Do not hard-code ticket numbers or expected fixture labels into the prompt.

Preserve unresolved issues from prior turns, but allow later evidence to correct earlier decisions. A prior model answer is not a verified fact. Store enough of each run's sanitized model input/output, tool exchanges, model identifier, prompt hash, and policy outcome to explain the decision later; reconstruction does not mean the model can be rerun to yield identical text.

## 9. Proposed project layout and build order

```text
src/
  server.ts               # Bun HTTP wiring and startup recovery
  api.ts                  # Endpoints and error mapping
  schemas.ts              # Zod HTTP, decision, and tool contracts
  triage.ts               # Application interface and turn lifecycle
  agent.ts                # Bounded evidence-gathering/model loop
  policy.ts               # Deterministic autonomy rules
  effects.ts              # Safe work-item execution
  storage.ts              # SQLite transactions and queries
  adapters/
    openai-model.ts
    knowledge-base.ts
    service-status.ts
    work-items.ts
prompts/
  triage.v1.md
  rationale.md
data/
  knowledge_base.json
evals/
  tickets.jsonl
  fixtures/
  run.ts
tests/
docs/
  system-requirements.md
  architecture.md
  write-up.md             # Final implementation report, max 2 pages
.env.example
README.md
```

This is a proposed layout; only the two design documents exist at this stage.

| Time budget | Deliverable |
| --- | --- |
| 1 hour | Schemas, policy rubric, prompt draft, and sample labels |
| 2 hours | SQLite schema, three endpoints, conversation persistence, request deduplication |
| 2 hours | GPT adapter, bounded tool loop, KB/status tools, structured candidate |
| 2 hours | Guarded work-item effect, cross-turn deduplication, startup recovery |
| 2 hours | Safety/persistence tests and offline/live evaluation modes |
| 1 hour | Setup path, sample walkthroughs, concise write-up and final verification |
| 0–2 hours buffer | Fix integration failures and simplify rough edges |

Build an ingest → stored decision → GET slice early, initially with a scripted model, then connect GPT and the durable effect. Add follow-ups and failure scenarios through the same application interface. If time becomes tight, cut streaming, sophisticated retrieval, and extra provider tools; retain persistence, policy enforcement, retries, and evals.

With another week, prioritize real provider reconciliation, stronger multilingual and adversarial evals, human-review workflow, work-item updates, and measured latency/cost improvements. Multiple processes or background workers require a revised turn-claim/recovery design, not merely changing the server worker count.
