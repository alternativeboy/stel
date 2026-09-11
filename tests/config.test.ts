import { describe, expect, test } from "bun:test";

import { ConfigurationError, parseConfiguration } from "../src/config";

describe("runtime configuration", () => {
  test("uses safe local mock defaults", () => {
    const config = parseConfiguration({});

    expect(config).toEqual({
      llmProvider: "mock",
      host: "127.0.0.1",
      port: 3000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("accepts explicit mock mode and optional local settings", () => {
    const config = parseConfiguration({
      LLM_PROVIDER: "mock",
      HOST: "0.0.0.0",
      PORT: "8080",
      DATABASE_PATH: "./data/triage.sqlite",
      OPENAI_API_KEY: "unused-in-mock-mode",
      OPENAI_MODEL: "unused-in-mock-mode",
    });

    expect(config).toEqual({
      llmProvider: "mock",
      host: "0.0.0.0",
      port: 8080,
      databasePath: "./data/triage.sqlite",
    });
    expect(config).not.toHaveProperty("openaiApiKey");
    expect(config).not.toHaveProperty("openaiModel");
  });

  test("accepts OpenAI mode when both required settings are present", () => {
    const config = parseConfiguration({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "test-only-key",
      OPENAI_MODEL: "gpt-test",
    });

    expect(config.llmProvider).toBe("openai");
    if (config.llmProvider !== "openai") {
      throw new Error("Expected OpenAI configuration");
    }
    expect(config.openaiApiKey).toBe("test-only-key");
    expect(config.openaiModel).toBe("gpt-test");
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("validates OpenAI timeout and retry bounds", () => {
    const config = parseConfiguration({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_MODEL: "model", OPENAI_TIMEOUT_MS: "120000", OPENAI_MAX_RETRIES: "3" });
    if (config.llmProvider !== "openai") throw new Error("Expected OpenAI configuration");
    expect(config.openaiTimeoutMs).toBe(120000);
    expect(config.openaiMaxRetries).toBe(3);
    expect(() => parseConfiguration({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_MODEL: "model", OPENAI_TIMEOUT_MS: "999" })).toThrow();
    expect(() => parseConfiguration({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_MODEL: "model", OPENAI_TIMEOUT_MS: "120001" })).toThrow();
  });

  test("rejects an unsupported provider", () => {
    expect(() =>
      parseConfiguration({ LLM_PROVIDER: "anthropic" }),
    ).toThrow(ConfigurationError);
  });

  test("rejects a port that is not a valid TCP port", () => {
    expect(() => parseConfiguration({ PORT: "3000.5" })).toThrow(
      "PORT: must be an integer between 1 and 65535",
    );
    expect(() => parseConfiguration({ PORT: "65536" })).toThrow(
      ConfigurationError,
    );
  });

  test("requires OpenAI settings without exposing a supplied key", () => {
    expect(() => parseConfiguration({ LLM_PROVIDER: "openai" })).toThrow(
      /OPENAI_API_KEY.*OPENAI_MODEL/s,
    );

    const secret = "must-not-appear-in-the-error";

    try {
      parseConfiguration({
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: secret,
      });
      throw new Error("Expected configuration parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain("OPENAI_MODEL");
      expect(String(error)).not.toContain(secret);
    }
  });
});
