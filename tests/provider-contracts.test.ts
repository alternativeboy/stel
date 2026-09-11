import { describe, expect, test } from "bun:test";
import { parseProviderSettings, ProviderFailureSchema, ProviderRequestSchema, ProviderSettingsSchema, TRIAGE_PROMPT_HASH, TRIAGE_PROMPT_VERSION } from "../src/provider-contracts";

describe("real-provider contracts", () => {
  test("validates bounded settings and keeps prompt identity stable", () => {
    const settings = parseProviderSettings({ OPENAI_API_KEY: "secret-value", OPENAI_MODEL: "gpt-test" });
    expect(settings.model).toBe("gpt-test");
    expect(settings.timeout_ms).toBe(30_000); expect(settings.max_retries).toBe(2);
    expect(settings.prompt_version).toBe(TRIAGE_PROMPT_VERSION);
    expect(settings.prompt_hash).toBe(TRIAGE_PROMPT_HASH);
    expect(JSON.stringify({ ...settings, api_key: undefined })).not.toContain("secret-value");
  });

  test("rejects missing or unbounded settings without echoing keys", () => {
    expect(() => parseProviderSettings({ OPENAI_MODEL: "gpt-test" })).toThrow();
    expect(() => ProviderSettingsSchema.parse({ api_key: "secret", model: "gpt", timeout_ms: 100, max_retries: 0, prompt_version: TRIAGE_PROMPT_VERSION, prompt_hash: TRIAGE_PROMPT_HASH })).toThrow();
    expect(() => parseProviderSettings({ OPENAI_API_KEY: "sk-secret-value", OPENAI_MODEL: "gpt-test", OPENAI_TIMEOUT_MS: 30_000, OPENAI_MAX_RETRIES: 4 })).toThrow();
  });

  test("keeps provider failures typed and retryability explicit", () => {
    expect(ProviderFailureSchema.parse({ kind: "timeout", retryable: true, message: "Provider timed out." })).toBeTruthy();
    expect(ProviderFailureSchema.safeParse({ kind: "authentication", retryable: true, message: "Authentication failed." }).success).toBe(false);
    expect(ProviderFailureSchema.safeParse({ kind: "timeout", retryable: true, message: "sk-secretvalue" }).success).toBe(false);
  });

  test("keeps the request provider-neutral", () => {
    expect(ProviderRequestSchema.parse({ model: "gpt-test", prompt_version: TRIAGE_PROMPT_VERSION, prompt_hash: TRIAGE_PROMPT_HASH, context: { messages: [] } })).toBeTruthy();
  });
});
