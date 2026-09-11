import { describe, expect, test } from "bun:test";

import {
  createRequestHandler,
  type RequestCompletionLog,
} from "../src/app";

describe("request completion logging", () => {
  test("emits one safe structured record for a completed request", () => {
    const records: RequestCompletionLog[] = [];
    const handleRequest = createRequestHandler((record) => {
      records.push(record);
    });
    const response = handleRequest(
      new Request("http://localhost/health?token=query-secret", {
        method: "POST",
        headers: {
          authorization: "Bearer header-secret",
          "x-request-id": "request-log-1",
        },
        body: "body-secret",
      }),
    );

    expect(response.status).toBe(405);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      timestamp: expect.any(String),
      level: "info",
      event: "request_completed",
      request_id: "request-log-1",
      method: "POST",
      path: "/health",
      status: 405,
      duration_ms: expect.any(Number),
    });
    expect(Number.isNaN(Date.parse(records[0]!.timestamp))).toBe(false);
    expect(records[0]!.duration_ms).toBeGreaterThanOrEqual(0);

    const serializedRecord = JSON.stringify(records[0]);
    expect(serializedRecord).not.toContain("query-secret");
    expect(serializedRecord).not.toContain("header-secret");
    expect(serializedRecord).not.toContain("body-secret");
    expect(serializedRecord).not.toContain("\n");
  });
});
