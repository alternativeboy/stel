import { handleRequest } from "./app";
import { ConfigurationError, parseConfiguration } from "./config";

try {
  const config = parseConfiguration(Bun.env);
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
