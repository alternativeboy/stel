import { createHash } from "node:crypto";
import { ProviderFailureSchema, ProviderRequestSchema, ProviderResponseSchema, TRIAGE_PROMPT_HASH, TRIAGE_PROMPT_VERSION, type ProviderFailure, type ProviderSettings } from "./provider-contracts";
import type { ModelAdapter, ModelContext, ModelProposal } from "./model";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_PROVIDER_REQUEST_BYTES = 1_048_576;
const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;
type Transport = (input: string, init: RequestInit) => Promise<Response>;

export class OpenAIAdapterError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure) { super(failure.message); this.name = "OpenAIAdapterError"; this.failure = failure; }
}
const makeFailure = (kind: ProviderFailure["kind"], retryable: boolean, message: string) => ProviderFailureSchema.parse({ kind, retryable, message });
const invalid = (message: string) => new OpenAIAdapterError(makeFailure("invalid_response", false, message));
function classifyStatus(status: number): ProviderFailure {
  if (status === 401 || status === 403) return makeFailure("authentication", false, "OpenAI authentication failed.");
  if (status === 408) return makeFailure("timeout", true, "OpenAI request timed out.");
  if (status === 429) return makeFailure("rate_limit", true, "OpenAI request was rate limited.");
  if (status >= 500) return makeFailure("unavailable", true, "OpenAI is temporarily unavailable.");
  return makeFailure("invalid_response", false, "OpenAI returned an invalid response.");
}
function hashPrompt(prompt: string): string { return `sha256:${createHash("sha256").update(prompt).digest("hex")}`; }
function proposalFromPayload(payload: unknown): ModelProposal { try { return ProviderResponseSchema.parse(payload); } catch { throw invalid("OpenAI response did not match the decision contract."); } }
function extractJson(response: unknown): unknown {
  if (!response || typeof response !== "object") throw invalid("OpenAI response was not an object.");
  const record = response as Record<string, unknown>;
  let outputText = typeof record.output_text === "string" ? record.output_text : undefined;
  if (!outputText && Array.isArray(record.output)) {
    const parts = record.output.flatMap((item) => {
      if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "message" || (item as Record<string, unknown>).role !== "assistant" || !Array.isArray((item as Record<string, unknown>).content)) return [];
      return ((item as Record<string, unknown>).content as unknown[]).flatMap((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "output_text" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []);
    });
    if (parts.length) outputText = parts.join("");
  }
  if (!outputText) throw invalid("OpenAI response did not contain structured output.");
  try { return JSON.parse(outputText); } catch { throw invalid("OpenAI structured output was not valid JSON."); }
}
async function readResponseBody(response: Response, controller: AbortController, timeoutMs: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) throw invalid("OpenAI response was too large.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([response.text(), new Promise<string>((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error("timed out"); error.name = "AbortError"; reject(error); }, timeoutMs); })]);
    if (new TextEncoder().encode(body).byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw invalid("OpenAI response was too large.");
    return body;
  } finally { if (timer) clearTimeout(timer); }
}

export function createOpenAIAdapter(settings: ProviderSettings, options: { transport?: Transport; prompt?: string; prompt_hash?: string } = {}): ModelAdapter {
  const transport = options.transport ?? fetch;
  const promptPromise = options.prompt ? Promise.resolve(options.prompt) : Bun.file(new URL("../prompts/triage.v1.md", import.meta.url).pathname).text();
  return { provider: "openai", model_adapter: "openai-responses-v1", scenario: "live", async propose(context: ModelContext) {
    let prompt: string;
    try { prompt = await promptPromise; } catch { throw invalid("OpenAI prompt could not be loaded."); }
    const actualHash = hashPrompt(prompt);
    const expectedHash = options.prompt ? options.prompt_hash : settings.prompt_hash;
    if (actualHash !== expectedHash || (!options.prompt && actualHash !== TRIAGE_PROMPT_HASH)) throw invalid("OpenAI prompt configuration is invalid.");
    const request = ProviderRequestSchema.parse({ model: settings.model, prompt_version: TRIAGE_PROMPT_VERSION, prompt_hash: expectedHash, context });
    const body = JSON.stringify({ model: request.model, instructions: prompt, input: JSON.stringify(request.context), temperature: 0 });
    if (new TextEncoder().encode(body).byteLength > MAX_PROVIDER_REQUEST_BYTES) throw invalid("OpenAI request was too large.");
    let attempt = 0;
    while (true) {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), settings.timeout_ms);
      try {
        const response = await transport(OPENAI_RESPONSES_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${settings.api_key}` }, body, signal: controller.signal });
        if (!response.ok) throw new OpenAIAdapterError(classifyStatus(response.status));
        let payload: unknown;
        try { payload = JSON.parse(await readResponseBody(response, controller, settings.timeout_ms)); } catch (error) {
          if (error instanceof OpenAIAdapterError) throw error;
          if (error instanceof Error && error.name === "AbortError") throw new OpenAIAdapterError(makeFailure("timeout", true, "OpenAI request timed out."));
          throw invalid("OpenAI response could not be decoded.");
        }
        return proposalFromPayload(extractJson(payload));
      } catch (error) {
        const mapped = error instanceof OpenAIAdapterError ? error.failure : error instanceof Error && error.name === "AbortError" ? makeFailure("timeout", true, "OpenAI request timed out.") : makeFailure("unavailable", true, "OpenAI is unavailable.");
        if (!mapped.retryable || attempt >= settings.max_retries) throw new OpenAIAdapterError(mapped);
        attempt += 1;
      } finally { clearTimeout(timeout); }
    }
  } };
}
