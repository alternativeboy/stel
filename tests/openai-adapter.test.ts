import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createOpenAIAdapter, OpenAIAdapterError } from "../src/openai-adapter";
import { DecisionSchema } from "../src/schemas";
import { ProviderSettingsSchema, TRIAGE_PROMPT_HASH, TRIAGE_PROMPT_VERSION } from "../src/provider-contracts";

const settings = ProviderSettingsSchema.parse({ api_key: "secret-key", model: "gpt-test", prompt_version: TRIAGE_PROMPT_VERSION, prompt_hash: TRIAGE_PROMPT_HASH });
const testPrompt = "prompt-v1";
const testPromptHash = `sha256:${createHash("sha256").update(testPrompt).digest("hex")}`;
const testSettings = ProviderSettingsSchema.parse({ ...settings, prompt_hash: testPromptHash });
const decision = (turnId: string) => DecisionSchema.parse({ id: "decision-1", turn_id: turnId, schema_version: "decision.v1", urgency: "low", extracted: { product_area: "account", primary_issue_type: "usage_question", secondary_issue_types: [], sentiment: "neutral", language: "en" }, action: "auto_respond", target_queue: null, rationale: "Supported guidance is available.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: false, execution: { status: "not_required" }, tool_call_ids: [], status: "completed" });
const context = { turn_id: "turn-1", ticket: { customer: { plan: "pro" }, messages: [{ role: "customer" as const, content: "How do I update settings?", timestamp: "2026-01-01T00:00:00Z" }] }, messages: [{ id: "m-1", role: "customer" as const, content: "How do I update settings?", timestamp: "2026-01-01T00:00:00Z" }] };

describe("OpenAI adapter seam", () => {
  test("maps a provider response and request metadata without using a live network", async () => {
    let requestBody = "";
    const adapter = createOpenAIAdapter(testSettings, { prompt: testPrompt, prompt_hash: testPromptHash, transport: async (url, init) => { expect(url).toBe("https://api.openai.com/v1/responses"); expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key"); requestBody = String(init.body); return new Response(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ reply: "Use the help center.", decision: decision("turn-1") }) }] }] }), { status: 200 }); } });
    const result = await adapter.propose(context);
    expect(result.reply).toBe("Use the help center."); expect(JSON.parse(requestBody).model).toBe("gpt-test"); expect(JSON.parse(requestBody).instructions).toBe("prompt-v1"); expect(JSON.parse(JSON.parse(requestBody).input).turn_id).toBe("turn-1");
  });

  test("retries bounded transient failures and maps auth failures safely", async () => {
    let attempts = 0;
    const adapter = createOpenAIAdapter(testSettings, { prompt: testPrompt, prompt_hash: testPromptHash, transport: async () => { attempts += 1; return attempts < 3 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ output_text: JSON.stringify({ reply: "ok", decision: decision("turn-1") }) }), { status: 200 }); } });
    await adapter.propose(context); expect(attempts).toBe(3);
    const auth = createOpenAIAdapter(settings, { transport: async () => new Response("no", { status: 401 }) });
    await expect(auth.propose(context)).rejects.toMatchObject({ failure: { kind: "authentication", retryable: false } });
  });

  test("maps malformed output and timeout without exposing the key", async () => {
    const malformed = createOpenAIAdapter(settings, { transport: async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 }) });
    await expect(malformed.propose(context)).rejects.toBeInstanceOf(OpenAIAdapterError);
    const timeoutSettings = ProviderSettingsSchema.parse({ ...settings, timeout_ms: 1_000, max_retries: 0 });
    const timeout = createOpenAIAdapter(timeoutSettings, { transport: async (_url, init) => await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); })) });
    try { await timeout.propose(context); } catch (error) { expect(String(error)).not.toContain("secret-key"); }
  });

  test("rejects oversized provider responses and malformed decisions safely", async () => {
    const oversized = createOpenAIAdapter(settings, { transport: async () => new Response("x", { status: 200, headers: { "content-length": "2000000" } }) });
    await expect(oversized.propose(context)).rejects.toMatchObject({ failure: { kind: "invalid_response", retryable: false } });
    const malformed = createOpenAIAdapter(settings, { transport: async () => new Response(JSON.stringify({ output_text: JSON.stringify({ reply: "ok", decision: { nope: true } }) }), { status: 200 }) });
    await expect(malformed.propose(context)).rejects.toMatchObject({ failure: { kind: "invalid_response" } });
    const unknownTool = createOpenAIAdapter(settings, { transport: async () => new Response(JSON.stringify({ output_text: JSON.stringify({ reply: "ok", decision: decision("turn-1"), tool_requests: [{ id: "t1", name: "delete_account", version: "read-tools.v1", arguments: {} }] }) }), { status: 200 }) });
    await expect(unknownTool.propose(context)).rejects.toMatchObject({ failure: { kind: "invalid_response" } });
  });
});
