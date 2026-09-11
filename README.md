# Support Ticket Triage Service

This repository contains a small offline, scripted billing-triage service with
`GET /health`, `POST /tickets`, and `GET /conversations/{id}`. It includes
deterministic read-only knowledge/status fixtures and a local mock work-item
executor; the mock adapter is not general language-model intelligence.

## Development

Prerequisite: Bun 1.1.17.

Install dependencies:

```sh
bun install
```

Start the service in mock mode; no OpenAI API key is required:

```sh
LLM_PROVIDER=mock bun run dev
```

In another terminal, verify the health endpoint:

```sh
curl -i http://127.0.0.1:3000/health
```

Create a billing triage (save the returned `conversation_id`):

```sh
curl -i -X POST http://127.0.0.1:3000/tickets \
  -H 'idempotency-key: readme-example-1' \
  -H 'content-type: application/json' \
  -d '{"customer":{"plan":"pro"},"messages":[{"role":"customer","content":"Three pending charges and no Pro access.","timestamp":"2026-09-11T08:00:00Z"}]}'
```

Retrieve it after replacing the ID:

```sh
curl -i http://127.0.0.1:3000/conversations/<conversation_id>
```

Run the automated checks:

```sh
bun test
bun run typecheck
```
