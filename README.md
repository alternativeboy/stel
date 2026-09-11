# Support Ticket Triage Service

This repository currently contains the Bun/TypeScript service foundation and
its `GET /health` endpoint. Ticket triage endpoints are not implemented yet.

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

Run the automated checks:

```sh
bun test
bun run typecheck
```
