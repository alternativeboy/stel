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
LLM_PROVIDER=mock 
run command: bun run dev
```

Startup scans the configured SQLite database for interrupted turns before the
HTTP listener accepts traffic. No-plan turns receive a degraded manual-triage
outcome; committed local effects are reused, while unknown effects remain
explicitly unresolved.

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

Run the deterministic offline fixture evaluation (no OpenAI key or network is
required):

```sh
bun run evaluate
bun run evaluate --json
```

The report is explicitly fixture/replay evaluation, not live GPT accuracy.

Opt-in real-provider mode uses the OpenAI Responses API and requires a
user-supplied key. It can incur external usage costs; keep it out of normal
tests:

```sh
LLM_PROVIDER=openai OPENAI_API_KEY='your-key' OPENAI_MODEL='gpt-4o-mini'
run command: bun run start
```

To call only the provider adapter explicitly (also requiring a key), run:

```sh
OPENAI_API_KEY='your-key' OPENAI_MODEL='gpt-4o-mini'
run command:  bun run smoke:openai
```

This smoke command makes one live provider call and does not represent full
application/effect behavior.
