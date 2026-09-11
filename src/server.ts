import { handleRequest } from "./app";

const server = Bun.serve({
  port: 3000,
  fetch: handleRequest,
});

console.log(`Support ticket triage service listening on ${server.url}`);
