import { createOpenAIAdapter } from "./openai-adapter";
import { parseProviderSettings } from "./provider-contracts";
import { TicketIngestSchema } from "./schemas";

const key = Bun.env.OPENAI_API_KEY?.trim();
const model = Bun.env.OPENAI_MODEL?.trim();
if (!key || !model) {
  console.error("OPENAI_API_KEY and OPENAI_MODEL are required for the opt-in live smoke test.");
  process.exit(1);
}

const settings = parseProviderSettings({
  OPENAI_API_KEY: key,
  OPENAI_MODEL: model,
  OPENAI_TIMEOUT_MS: Bun.env.OPENAI_TIMEOUT_MS,
  OPENAI_MAX_RETRIES: Bun.env.OPENAI_MAX_RETRIES,
});
const adapter = createOpenAIAdapter({
  api_key: settings.api_key,
  model: settings.model,
  timeout_ms: settings.timeout_ms,
  max_retries: settings.max_retries,
  prompt_version: settings.prompt_version,
  prompt_hash: settings.prompt_hash,
});
const ticket = TicketIngestSchema.parse({
  customer: { plan: "pro" },
  messages: [{ role: "customer", content: "Please explain the billing process.", timestamp: new Date().toISOString() }],
});
const result = await adapter.propose({
  turn_id: crypto.randomUUID(),
  ticket,
  messages: ticket.messages.map((message) => ({ ...message, id: crypto.randomUUID() })),
});
console.log(JSON.stringify({ provider: adapter.provider, model: adapter.model_adapter, decision: result.decision }));
