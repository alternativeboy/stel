import { describe, expect, test } from "bun:test";

import { createRequestHandler } from "../src/app";

const handleRequest = createRequestHandler(() => {});

describe("HTTP request handler", () => {
  test("reports that the service is healthy", async () => {
    const response = handleRequest(
      new Request("http://localhost/health", {
        headers: { "x-request-id": "request-123" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("generates a request ID when the caller does not provide one", async () => {
    const response = handleRequest(new Request("http://localhost/health"));
    const requestId = response.headers.get("x-request-id");

    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("returns JSON when a route does not exist", async () => {
    const response = handleRequest(
      new Request("http://localhost/missing", {
        headers: { "x-request-id": "request-404" },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("request-404");
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
        request_id: "request-404",
        retryable: false,
        details: { path: "/missing" },
      },
    });
  });

  test("returns a structured error for an unsupported method", async () => {
    const response = handleRequest(
      new Request("http://localhost/health", {
        method: "POST",
        headers: { "x-request-id": "request-405" },
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method not allowed",
        request_id: "request-405",
        retryable: false,
        details: { allowed_methods: ["GET"] },
      },
    });
  });
});
