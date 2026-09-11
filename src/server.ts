import { createRequestHandler } from "./app";
import { ConfigurationError, parseConfiguration } from "./config";
import { openStorage } from "./storage";
import { createScriptedBillingAdapter } from "./model";
import { createTriageApplication } from "./triage";
import { createLocalKnowledgeBase, createLocalServiceStatus } from "./read-tool-adapters";
import { createMockWorkItemExecutor } from "./effects";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRecoveryService } from "./recovery-service";
import { createOpenAIAdapter } from "./openai-adapter";
import { ProviderSettingsSchema, TRIAGE_PROMPT_HASH, TRIAGE_PROMPT_VERSION } from "./provider-contracts";

try {
  const config = parseConfiguration(Bun.env);
  const model = config.llmProvider === "openai"
    ? createOpenAIAdapter(ProviderSettingsSchema.parse({ api_key: config.openaiApiKey, model: config.openaiModel, timeout_ms: config.openaiTimeoutMs, max_retries: config.openaiMaxRetries, prompt_version: TRIAGE_PROMPT_VERSION, prompt_hash: TRIAGE_PROMPT_HASH }))
    : createScriptedBillingAdapter();
  const databasePath = config.databasePath ?? "./data/service.sqlite";
  await mkdir(dirname(databasePath), { recursive: true });
  const storage = openStorage(databasePath);
  const effect = createMockWorkItemExecutor(storage);
  await createRecoveryService({ storage, effect }).recover();
  const application = createTriageApplication({
    storage,
    model,
    knowledge: createLocalKnowledgeBase(),
    status: createLocalServiceStatus(),
    effect,
  });
  const handleRequest = createRequestHandler(undefined, application);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: handleRequest,
  });

  console.log(`Support ticket triage service listening on ${server.url}`);
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    process.exit(1);
  }

  throw error;
}
