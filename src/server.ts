import { createRequestHandler } from "./app";
import { ConfigurationError, parseConfiguration } from "./config";
import { openStorage } from "./storage";
import { createScriptedBillingAdapter } from "./model";
import { createTriageApplication } from "./triage";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

try {
  const config = parseConfiguration(Bun.env);
  if (config.llmProvider === "openai") {
    throw new Error("OpenAI provider is not available in this build; refusing to start");
  }
  const databasePath = config.databasePath ?? "./data/service.sqlite";
  await mkdir(dirname(databasePath), { recursive: true });
  const storage = openStorage(databasePath);
  const application = createTriageApplication({ storage, model: createScriptedBillingAdapter() });
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
