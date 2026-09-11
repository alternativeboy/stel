function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function handleRequest(request: Request): Response {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/health") {
    return jsonResponse({ status: "ok" }, 200);
  }

  return jsonResponse({ error: "Not found" }, 404);
}
