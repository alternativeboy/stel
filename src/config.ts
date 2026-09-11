import { z } from "zod";

export type ConfigurationEnvironment = Readonly<
  Record<string, string | undefined>
>;

interface CommonConfiguration {
  readonly host: string;
  readonly port: number;
  readonly databasePath?: string;
}

export interface MockConfiguration extends CommonConfiguration {
  readonly llmProvider: "mock";
}

export interface OpenAIConfiguration extends CommonConfiguration {
  readonly llmProvider: "openai";
  readonly openaiApiKey: string;
  readonly openaiModel: string;
  readonly openaiTimeoutMs: number;
  readonly openaiMaxRetries: number;
}

export type Configuration = MockConfiguration | OpenAIConfiguration;

export interface ConfigurationIssue {
  readonly setting: string;
  readonly message: string;
}

export class ConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    const message = issues
      .map((issue) => `- ${issue.setting}: ${issue.message}`)
      .join("\n");

    super(`Invalid configuration:\n${message}`);
    this.name = "ConfigurationError";
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
  }
}

const portSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "must be an integer between 1 and 65535")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));
const timeoutSchema = z.string().trim().regex(/^\d+$/, "must be an integer between 1000 and 120000").transform(Number).pipe(z.number().int().min(1000).max(120000));

const environmentSchema = z
  .object({
    LLM_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
    HOST: z.string().trim().min(1, "must not be empty").default("127.0.0.1"),
    PORT: z.preprocess((value) => value ?? "3000", portSchema),
    DATABASE_PATH: z.string().trim().min(1, "must not be empty").optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    OPENAI_TIMEOUT_MS: z.preprocess((value) => value ?? "30000", timeoutSchema).optional(),
    OPENAI_MAX_RETRIES: z.preprocess((value) => value ?? "2", z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(3))).optional(),
  })
  .superRefine((environment, context) => {
    if (environment.LLM_PROVIDER !== "openai") {
      return;
    }

    if (!environment.OPENAI_API_KEY?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "is required when LLM_PROVIDER is openai",
      });
    }

    if (!environment.OPENAI_MODEL?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_MODEL"],
        message: "is required when LLM_PROVIDER is openai",
      });
    }
  });

export function parseConfiguration(
  environment: ConfigurationEnvironment,
): Configuration {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => ({
        setting: String(issue.path[0] ?? "environment"),
        message: issue.message,
      })),
    );
  }

  const common = {
    host: result.data.HOST,
    port: result.data.PORT,
    ...(result.data.DATABASE_PATH === undefined
      ? {}
      : { databasePath: result.data.DATABASE_PATH }),
  };

  if (result.data.LLM_PROVIDER === "mock") {
    return Object.freeze({
      llmProvider: "mock",
      ...common,
    });
  }

  return Object.freeze({
    llmProvider: "openai",
    ...common,
    openaiApiKey: result.data.OPENAI_API_KEY!.trim(),
    openaiModel: result.data.OPENAI_MODEL!.trim(),
    openaiTimeoutMs: result.data.OPENAI_TIMEOUT_MS ?? 30000,
    openaiMaxRetries: result.data.OPENAI_MAX_RETRIES ?? 2,
  });
}
