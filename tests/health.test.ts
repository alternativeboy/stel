import { describe, expect, test } from "bun:test";

import { handleRequest } from "../src/app";

describe("HTTP request handler", () => {
  test("reports that the service is healthy", async () => {
    const response = handleRequest(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("returns JSON when a route does not exist", async () => {
    const response = handleRequest(new Request("http://localhost/missing"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
