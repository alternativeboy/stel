# Project Context — Support Ticket Triage Service

This file captures the agreed direction and current state so future work can continue without repeating the design discussion. It describes intended behavior, not completed implementation.

## Source documents

- [requirement.txt](requirement.txt): original take-home assignment and authoritative submission requirements.
- [System requirements](docs/system-requirements.md): proposed contracts, acceptance criteria, and scope.
- [Architecture](docs/architecture.md): proposed modules, storage, tools, and retry/recovery design.
- [Visual architecture guide](docs/architecture.html): browser-readable explanation with boxes, arrows, and a billing-ticket walkthrough.

The original assignment takes precedence over proposed design details. The development-mode decision below updates the earlier architecture: use a scripted mock model during development and OpenAI/GPT for delivery.

## Objective

Build a production-shaped HTTP service that triages customer support threads and supports persistent, multi-turn conversations with a human operator or test harness.

For each turn, produce a structured decision containing:

- Urgency: `critical`, `high`, `medium`, or `low`.
- Extracted product area, issue types, sentiment, and language.
- Relevant knowledge-base references.
- Action: `auto_respond`, `route_to_specialist`, or `escalate_to_human`.
- A concise rationale grounded in evidence.
- Actual tool calls and confirmed execution status.

The assignment allows approximately 8–12 focused hours. Prioritize a coherent vertical slice, safe side effects, durable state, tests, and honest trade-offs.

## Agreed development approach

The user wants to avoid paying for model API usage during development. Use two model modes behind one small application interface:

| Mode | Behavior | Purpose |
| --- | --- | --- |
| `mock` | Scripted model responses and tool requests; no model API calls | Normal local development, deterministic tests, and offline evaluation |
| `openai` | Real GPT calls using the OpenAI API | Delivered service and live model validation |

An Anthropic adapter was discussed, but the user chose mock development followed by OpenAI delivery. Do not add Anthropic support unless requested later.

Mock mode substitutes only the model adapter. HTTP handling, orchestration, validation, policy, database persistence, audit logging, and local tools should run through the same code used in OpenAI mode.

The fake model follows an explicitly selected scenario or test fixture. It can request tools, consume their results, return a decision, or simulate refusal, malformed output, and timeout. It does not understand arbitrary natural-language tickets. Do not present mock conversations or evaluation scores as real AI performance.

Proposed application configuration:

```dotenv
# Local development: no model API key needed
LLM_PROVIDER=mock
```

```dotenv
# Delivered service: evaluator injects the key
LLM_PROVIDER=openai
OPENAI_API_KEY=<provided through the environment>
OPENAI_MODEL=<configured supported GPT model>
```

These settings are implemented for the opt-in OpenAI Responses adapter. Mock remains the default development mode, and OpenAI mode must fail clearly if its required configuration is missing; never silently fall back to mock mode. Require no key for mock mode and automated tests.

Never commit real credentials. The assignment says the evaluator will supply an OpenAI key. Do not make paid API calls without user authorization. Before claiming the OpenAI integration works, run an authorized live check; if that cannot happen before submission, explicitly disclose the lack of live validation. Mock success does not prove GPT integration or triage quality.

## Proposed technology stack

| Area | Choice |
| --- | --- |
| Language | TypeScript on Node.js |
| Runtime and package manager | Bun |
| HTTP | Bun.serve (or a small Bun-compatible framework) |
| Validation | Zod |
| Persistence | File-backed SQLite with explicit transactions and unique constraints |
| Model integration | OpenAI JavaScript/TypeScript SDK, Responses API, function calling, structured outputs |
| Knowledge base | Small local JSON/Markdown dataset with deterministic keyword search |
| Tests | Bun test with scripted model and failure-injecting tool adapters |
| Dependency management | Bun with its generated lockfile (`bun.lockb` on the currently installed Bun 1.1.17; `bun.lock` after an intentional runtime upgrade) |
| Observability | Structured JSON logs linked to durable audit records |

This is the recommended design from the conversation; dependencies and model versions have not been selected or installed. Keep orchestration in ordinary TypeScript. A frontend, agent framework, vector database, Redis, or separate background-worker service is unnecessary for the MVP.

## Architecture and execution

Use one application process with clear module responsibilities:

1. **HTTP layer:** validate requests and map outcomes/errors to responses.
2. **Triage application:** own request deduplication, turn ordering, history, deadlines, and persistence.
3. **Agent/model adapter:** gather evidence and propose a structured decision.
4. **Policy:** enforce permitted actions and normalize the execution plan in deterministic code.
5. **Effect executor:** safely create or reuse a work item and return a confirmed receipt.
6. **SQLite:** preserve messages, decisions, tool calls, effect attempts, and cached responses.

The model proposes; application code authorizes and executes. Store the approved plan before executing any side effect. Server code supplies execution status and audit IDs from actual records, rather than trusting model claims.

Required HTTP endpoints:

- `POST /tickets`: ingest a customer thread and return the initial triage.
- `POST /conversations/{id}/messages`: add an operator or customer turn and return an updated outcome.
- `GET /conversations/{id}`: retrieve history, decisions, tool calls, and side-effect attempts.

Conversation memory lives in SQLite and survives restart. Preserve whole-thread context within explicit input limits; reject oversized input rather than silently losing earlier evidence.

## Tools and autonomy

| Tool | Behavior |
| --- | --- |
| `search_knowledge_base` | Read-only retrieval of relevant help documents and excerpts |
| `get_service_status` | Read-only mocked status lookup; results can be stale or misleading |
| `ensure_work_item` | Create or reuse a durable mock specialist case or incident |

Demonstrate at least two distinct tools, including the side-effecting work-item tool. Every tool needs a validated contract, timeout behavior, and audit trail.

The work-item provider is mocked in both model modes for the MVP, but it actually writes persistent records. “Real model” does not imply a real external ticketing integration.

Allow autonomous KB/status reads and work-item creation. Refunds, charges, account modifications, and real paging are unavailable. Financial requests go to a human team. A conversational approval cannot grant unavailable capabilities.

`auto_respond` means return and persist an answer for the caller; it does not send an external email. Route to billing/product support for specialist work, operations for urgent incidents, or manual triage when reliable processing is unavailable.

## Safety and retry invariants

- Require a scoped `Idempotency-Key` on POST requests. Same key/body replays the saved response; changed body with the same key is a conflict.
- Allow one active turn per conversation. Reject competing turns before accepting their messages.
- Deduplicate business effects separately from HTTP requests: derive the work-item key from conversation, kind, and queue in application code.
- Freeze the first work-item payload. Subsequent turns reuse the existing item; work-item updates and cross-ticket incident merging are deferred.
- Use database uniqueness and transactions, not in-memory duplicate tracking.
- For the local mock, commit the work item and its effect receipt atomically. Keep model/network waits outside database transactions.
- Recover interrupted turns on startup before accepting traffic, reusing saved plans and confirmed receipts.
- Distinguish `pending`, `succeeded`, `failed`, and `unknown` effects. A timeout is not proof that a remote action did not happen.
- Never claim a refund, resolved outage, restored access, or created work item without the corresponding verified evidence.
- Treat customer text and tool/document content as untrusted data. Enforce tool permissions in code.

A future real provider needs its own durable idempotency and reconciliation support; local transactions alone cannot guarantee safe remote retries.

## Sample-ticket expectations

These are proposed evaluation labels, not official labels supplied by the assignment.

| Scenario | Expected behavior |
| --- | --- |
| Billing with apparent repeated charges and an imminent presentation | High urgency; route to billing; distinguish reported pending charges from confirmed payments; no automatic refund |
| Thai enterprise outage affecting multiple coworkers | Critical urgency; escalate to operations; preserve Thai text; do not dismiss the outage because a status page says operational |
| Dark-mode question evolving into a bug and scheduling request | Medium urgency; route to product support; retain both unresolved bug and secondary feature request |
| Additional simple FAQ-only fixture | Low urgency; supported automatic answer; no work item |

Follow-up turns should explain previous decisions and incorporate new evidence without duplicating effects. Customer-facing replies should follow the customer's identifiable language; operator explanations should follow the operator's language.

## Testing and delivery

Test policy, API validation, multi-turn persistence, restart recovery, duplicate/concurrent requests, side-effect retries, model/tool failures, and misleading evidence through the real application interface with test adapters.

Provide an offline evaluation command using labeled scenarios and scripted/recorded model responses. Report per-case outcomes, urgency/action correctness, schema validity, and safety violations. Label these as fixture/replay results. Keep an opt-in live OpenAI evaluation path separate, using mock side effects and recording prompt/model versions.

Deliverables still required:

- Working application and three endpoints.
- Versioned system prompt with design rationale.
- Tool schemas and implementations.
- Persistent conversations, decisions, and audit trail.
- Tests and offline evaluation harness.
- Key-free example configuration and one copy-pasteable setup/run path.
- Maximum-two-page implementation write-up with architecture, trade-offs, ticket-specific failure analysis, and production evaluation.
- GitHub repository or source archive including `.git`.

Do not spend the assignment budget on authentication, multi-tenancy, polished UI, deployment infrastructure, or CI pipelines.

## Current state and next step

The offline tracer and opt-in provider path are implemented. The service includes validated configuration, a key-free mock default, `GET /health`, ticket/conversation/follow-up routes, file-backed SQLite persistence, scripted billing triage, read-only tools, policy-gated mock effects, idempotency, recovery, fixture evaluation, structured errors/logs, and an injectable OpenAI Responses adapter. The mock adapter is fixture-driven rather than general intelligence.

The user had difficulty reading diagrams in Markdown. Use the visual HTML guide and plain-language walkthroughs when explaining the design. It was opened in the user's browser during this conversation.

The next work should focus on provider hardening and reconciliation rather than adding another adapter; the OpenAI path remains explicitly opt-in and live validation requires user authorization.
