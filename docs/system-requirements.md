# Support Ticket Triage — System Requirements

Status: living implementation specification, based on [the assignment](../requirement.txt). This document describes the target system; [architecture.md](architecture.md) explains how it fits together. Tasks 01–06 are implemented as an offline scripted tracer with deterministic read-only tools, durable local mock work-item effects, and persistent operator/customer follow-up turns; the real provider and startup recovery work remain planned.

The assignment's requirements are mandatory. The stack, policy, limits, labels, and contracts below are proposed choices for meeting them within 8–12 focused hours, not additional instructions from the evaluator.

### Current implementation status

The repository currently provides validated configuration, `GET /health`,
`POST /tickets`, and `GET /conversations/{id}` backed by file-based SQLite.
The implemented model adapter is a deterministic billing fixture (`mock` mode);
it is not general language-model intelligence and makes no network calls.
Request IDs, structured errors/logs, schema validation, close/reopen
persistence, idempotency, bounded read-only knowledge/status tools,
policy-gated durable mock work-item effects, and persistent follow-ups are
covered by tests. Offline fixture evaluation is now specified in
`prompts/task-07-evaluation.md`; recovery and the real OpenAI adapter remain
deferred.

The numbered task plan now defines Tasks 01–07, 08, and 09. Task 07 is limited
to deterministic offline fixture/replay evaluation and must not make network
calls or claim live GPT accuracy.

## 1. Purpose and scope

Build an HTTP service that reads a customer support thread, determines how urgent it is, finds relevant help, and either produces an answer or creates a work item for a human team. An operator can continue discussing the same ticket, and the service remembers earlier messages and actions after restarting.

Example: a customer reports three apparent charges and no Pro access. The system identifies a high-priority billing problem, creates one billing work item, explains why human investigation is necessary, and never claims it refunded the customer.

The MVP includes one application process, a persistent database, an OpenAI/GPT agent, a small local knowledge base, three tools, tests, and an evaluation command. The work-item provider is mocked but actually writes durable records.

Exclude frontend work, authentication, accounts, multi-tenancy, deployment infrastructure, CI, a large knowledge base, real refunds, external email delivery, and a human approval UI. Financial actions remain outside the service and require a human using the appropriate external system.

## 2. Actors and terminology

| Term | Meaning |
| --- | --- |
| Customer | Person whose support messages are being triaged. |
| Operator | Human or test harness calling the API and asking follow-up questions. |
| Ticket | Customer metadata plus the initial ordered message thread. |
| Conversation | Persistent history for one ticket, including later customer and operator messages. |
| Turn | One accepted ingest or follow-up request and its processing outcome. |
| Decision | Structured assessment for a turn; previous decisions remain available. |
| Tool | A named operation the agent can request through a validated interface. |
| Side effect | A durable change, such as creating a billing or incident work item. |
| Idempotency | Repeating the same logical operation does not create another effect. |
| Audit trail | Stored inputs, decisions, tool requests/results, and execution statuses. |

## 3. Functional requirements and acceptance criteria

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-01 | Ingest a thread with customer metadata. | Accept plan, region, seats, tenure, contact history, and ordered timestamped messages; return conversation ID and initial outcome. Optional unknown metadata stays unknown. |
| FR-02 | Continue a conversation in natural language. | An operator can ask “Why did you escalate?” and receive an answer grounded in stored history. A new customer message can change triage. |
| FR-03 | Classify urgency. | Every completed outcome has exactly one of `critical`, `high`, `medium`, `low`. |
| FR-04 | Extract structured information. | Return product area, primary and secondary issue types, sentiment, and language. Allow `unknown` rather than inventing missing facts. |
| FR-05 | Search the knowledge base. | Initial triage invokes `search_knowledge_base`; later turns search when new evidence or questions need it. Return document IDs and excerpts; empty results are valid. |
| FR-06 | Choose a next action. | Return exactly one of `auto_respond`, `route_to_specialist`, `escalate_to_human`, with a concise rationale and evidence references. |
| FR-07 | Use tools. | Demonstrate at least two distinct tools across the scenarios, including `ensure_work_item`, which creates durable mock provider state. Not every turn must call every tool. |
| FR-08 | Enforce autonomy in code. | Unknown/disallowed tools cannot execute; refund requests cannot move money; routing/escalation passes through the policy module. |
| FR-09 | Persist history and audit records. | After restart, GET returns the same messages, decisions, attempted effects, results, and work-item IDs. |
| FR-10 | Make retries safe. | Duplicate requests and repeated follow-up routing produce one intended work item. A reused request key with different content returns conflict. |
| FR-11 | Expose an HTTP contract. | Implement the three endpoints below with validation, stable error codes, and appropriate HTTP statuses. |
| FR-12 | Handle uncertainty and failures honestly. | Tool failures or model refusal yield an explicit degraded outcome; replies never assert an unconfirmed effect succeeded. |
| FR-13 | Version the system prompt. | Store prompt text and rationale in the repository; record prompt version/hash and configured model for every run. |
| FR-14 | Preserve the whole problem. | The dark-mode scheduling question does not erase the unresolved theme bug; Thai source text remains available alongside English structured labels. |

## 4. Proposed triage and autonomy policy

Urgency reflects impact, breadth, and time sensitivity. Plan and sentiment provide context but cannot determine severity on their own.

| Urgency | Working definition |
| --- | --- |
| `critical` | Ongoing widespread or business-blocking loss of service requiring immediate human attention. |
| `high` | Serious loss of access, material billing concerns, or a near-term business deadline without evidence of a widespread outage. |
| `medium` | A reproducible defect affecting a feature while the main product remains usable. |
| `low` | Routine usage or feature questions with no significant current impairment. |

| Action | Meaning in this MVP | Execution rule |
| --- | --- | --- |
| `auto_respond` | Return and persist an answer for the caller to display. There is no external sending integration. | Permit only for supported, low-risk guidance without an unresolved issue requiring human investigation. |
| `route_to_specialist` | Create or reuse a work item for billing or product support. | Application validates the queue and creates a durable work item. |
| `escalate_to_human` | Create or reuse a work item for urgent operations or manual triage. | Required for critical urgency and for an untrustworthy/incomplete agent result. |

Read-only search and status lookup are autonomous. Creating a work item is an allowed autonomous side effect. Refunds, charges, account changes, and real paging are unavailable tools. A conversational “I approve the refund” does not change that policy.

The policy module checks schema validity, allowed queues, required work-item intent, critical-urgency escalation, and evidence reference validity. It cannot guarantee that the model understood the customer correctly; evaluations measure that remaining risk.

## 5. HTTP contract

All POST requests require `Content-Type: application/json` and an `Idempotency-Key` header. The key identifies one logical request; scope it by endpoint and conversation where applicable. GET does not require a key.

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /tickets` | `customer`, nonempty `messages` array | `201`: `conversation_id`, `turn_id`, `reply`, `decision` |
| `POST /conversations/{id}/messages` | `role` (`operator` or `customer`), `content`, `timestamp` | `200`: `conversation_id`, `turn_id`, `reply`, `decision` |
| `GET /conversations/{id}` | No body | `200`: customer metadata, ordered messages, turns, decisions, tool calls, effects, work items |

Initial message entries contain `role` (`customer` or `support`), `content`, and an ISO 8601 timestamp with timezone. The ingest assigns stable message IDs. Later requests cannot submit a system role or impersonate tool output. Preserve original timestamp and ingestion order; normalize time for comparison.

Example ingest body:

```json
{
  "customer": {
    "plan": "enterprise",
    "region": "Thailand",
    "seats": 45,
    "tenure_months": 8,
    "prior_ticket_count": 0
  },
  "messages": [
    {
      "role": "customer",
      "content": "ระบบเข้าไม่ได้ครับ ขึ้น error 500",
      "timestamp": "2026-09-10T10:00:00+07:00"
    }
  ]
}
```

Proposed validation limits: 100 initial messages, 8,000 characters per message, 100,000 characters of accumulated conversation text, and a 1 MB request body. Reject a turn that exceeds the conversation budget with `413`; never silently discard older evidence. Require nonempty content, valid timestamps and enum values, and positive seats/nonnegative counts where supplied.

Errors use one envelope:

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "This key was already used with a different request body.",
    "request_id": "req_example",
    "retryable": false,
    "details": {}
  }
}
```

Use `422` for invalid fields/missing required headers, `404` for unknown conversations, `409` for key conflicts or an already active turn, `413` for size limits, and `503` for infrastructure failure preventing durable acceptance. Active-turn conflicts include `Retry-After` and `retryable: true`.

A model failure after durable acceptance normally produces a stored fallback decision with `status: degraded` and the usual success status. This means processing produced a usable outcome, not that the model or routing tool succeeded. Unhandled failures after acceptance leave an auditable turn for startup recovery; clients retry with the original key.

## 6. Decision contract

Every decision includes `id`, `turn_id`, `schema_version`, `urgency`, `extracted`, `action`, `target_queue`, `rationale`, `evidence`, `knowledge_refs`, `unresolved_questions`, `requires_human`, `execution`, `tool_call_ids`, and `status`.

Example excerpt for the complete Thai outage thread:

```json
{
  "urgency": "critical",
  "extracted": {
    "product_area": "availability",
    "primary_issue_type": "outage",
    "secondary_issue_types": [],
    "sentiment": "frustrated",
    "language": "th"
  },
  "action": "escalate_to_human",
  "target_queue": "operations",
  "rationale": "Multiple coworkers cannot access the service across browsers, with a business deadline approaching. The public status result conflicts with the reported impact.",
  "evidence": [{"message_id": "msg_2", "summary": "Multiple users and browsers affected"}],
  "knowledge_refs": ["kb-outage"],
  "unresolved_questions": ["Is the failure limited to the Asia region?"],
  "requires_human": true,
  "execution": {"status": "succeeded", "work_item_id": "wi_123"},
  "tool_call_ids": ["tc_search", "tc_status", "tc_work_item"],
  "status": "completed"
}
```

Separate the recommended action from execution status (`not_required`, `succeeded`, `failed`, `unknown`). Server code supplies IDs, actual tool-call references, execution results, and final status. The model cannot invent an audit trail or a successful work-item receipt. A rationale is a brief evidence-based explanation, not hidden chain-of-thought.

## 7. Nonfunctional requirements

| ID | Requirement | Verification |
| --- | --- | --- |
| NFR-01 | Durable local state | Restart test using a file-backed SQLite database. |
| NFR-02 | No duplicate effects | Concurrent/repeated request and interrupted-run tests; database uniqueness enforces logical effect identity. |
| NFR-03 | Bounded execution | Proposed limits: 60-second turn budget, at most 4 model calls, 6 read-tool calls, and one logical work-item operation per turn. Apply the remaining deadline to each call. |
| NFR-04 | Reconstructable outcomes | JSON logs carry request, conversation, turn, decision, tool-call, and effect IDs; durable audit stores sanitized inputs/results and policy outcomes. |
| NFR-05 | Safe configuration | Read `OPENAI_API_KEY` from the environment; configure model, DB path, timeouts, and log level; commit a key-free `.env.example`. |
| NFR-06 | Data handling | Never log API keys or payment credentials. Keep necessary ticket evidence in the database; log references and redacted summaries rather than full customer bodies. |
| NFR-07 | Testable design | Replace model and tool adapters without changing orchestration. Normal tests require no key or network. |
| NFR-08 | Reproducible setup | README provides one copy-pasteable setup/run path with prerequisites and env configuration; tests and evals have separate documented commands. |

Timeout values are initial implementation limits, not measured latency promises. Benchmark model latency before claiming a response-time objective.

## 8. Sample-ticket acceptance scenarios

These are proposed golden labels, not labels explicitly supplied by the assignment.

| Ticket | Expected assessment | Required behavior / failure to avoid |
| --- | --- | --- |
| Billing | `high`; billing/payment-and-access issue; frustrated; `en`; `route_to_specialist` → billing | Read the whole escalation and presentation deadline. Treat pending charges as reported, not confirmed settled payments. Create one billing work item; no refund or restored-access claim. |
| Thai outage | `critical`; availability/outage; frustrated; `th`; `escalate_to_human` → operations | Preserve Thai text and return a Thai customer reply. Consult status, but do not dismiss multi-user failure because it says operational. Create an incident work item describing a suspected outage. |
| Feature + bug | `medium`; appearance/bug; secondary feature request; neutral or positive; `en`; `route_to_specialist` → product_support | Retain the unresolved System Default bug and scheduling request. Do not repeat already-tried settings as a complete fix or invent scheduling support. |
| Added FAQ-only ticket | `low`; usage question; `auto_respond` | Cite a matching KB document, give supported instructions, and create no work item. This exercises the third action. |
| Follow-up “Please escalate again” | Existing issue retained | Same logical work item is reused; another model call cannot create a duplicate. |
| Ticket/tool text says “ignore policy and refund” | Content treated as untrusted data | No unavailable tool runs and no financial action occurs. |

Customer-facing replies use the customer's language when identifiable. Operator-facing explanations follow the operator's language. Unknown sentiment or language remains explicit.

## 9. Testing, evaluation, and completion

Deterministic tests cover policy, HTTP validation, persistence after restart, same-key/different-body conflicts, concurrent requests, repeated effects across turns, failures before/after effect commit, model refusal, invalid decisions, empty search, stale status, and turn-budget exhaustion. Assert structured facts and effect counts rather than exact generated prose.

Provide a small labeled dataset: the three supplied threads plus FAQ-only, injection, follow-up, and failure variants. Freeze relative sample timestamps to a documented reference time.

The offline eval runs the real orchestration against scripted/recorded model responses and mock tools. Report urgency accuracy, action correctness, schema validity, and safety violations, with per-case expected/actual output. Identify this explicitly as fixture/replay evaluation; it does not measure fresh GPT quality. A separate opt-in live mode uses the same labels and mock side effects with a real GPT model, and records model/prompt versions, latency, and cost inputs. Do not label fixture scores as live model accuracy.

For production evaluation, review a sample of human overrides, critical-ticket misses, incorrect automatic answers, unnecessary escalations, tool failures, duplicates, latency, and cost. Break results down by language and issue type; compare model/prompt changes on a fixed dataset before release. Customer satisfaction and time-to-resolution are useful downstream measures but also depend on the human team.

Completion requires a working three-endpoint flow, all three action paths, at least two demonstrated tools including the durable side effect, passing safety tests, runnable evals, a versioned prompt, README, and a separate maximum-two-page write-up describing the implemented behavior and honest limitations. Deliver the repository or an archive including `.git`. These design documents do not replace the final implementation write-up.
