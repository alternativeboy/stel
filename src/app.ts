const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly retryable: boolean;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

export interface RequestCompletionLog {
  readonly timestamp: string;
  readonly level: "info";
  readonly event: "request_completed";
  readonly request_id: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly duration_ms: number;
}

export type RequestLogger = (record: RequestCompletionLog) => void;

function getRequestId(request: Request): string {
  const providedRequestId = request.headers.get("x-request-id");

  if (providedRequestId && REQUEST_ID_PATTERN.test(providedRequestId)) {
    return providedRequestId;
  }

  return crypto.randomUUID();
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function errorResponse(
  status: number,
  requestId: string,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): Response {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      request_id: requestId,
      retryable: false,
      details,
    },
  };

  return jsonResponse(body, status, requestId);
}

function routeRequest(
  request: Request,
  pathname: string,
  requestId: string,
): Response {
  if (pathname === "/health") {
    if (request.method === "GET") {
      return jsonResponse({ status: "ok" }, 200, requestId);
    }

    const response = errorResponse(
      405,
      requestId,
      "method_not_allowed",
      "Method not allowed",
      { allowed_methods: ["GET"] },
    );
    response.headers.set("allow", "GET");
    return response;
  }

  return errorResponse(404, requestId, "not_found", "Route not found", {
    path: pathname,
  });
}

const consoleRequestLogger: RequestLogger = (record) => {
  console.log(JSON.stringify(record));
};

export function createRequestHandler(
  logger: RequestLogger = consoleRequestLogger,
): (request: Request) => Response {
  return (request) => {
    const startedAt = performance.now();
    const { pathname } = new URL(request.url);
    const requestId = getRequestId(request);
    const response = routeRequest(request, pathname, requestId);

    logger({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "request_completed",
      request_id: requestId,
      method: request.method,
      path: pathname,
      status: response.status,
      duration_ms: Math.max(
        0,
        Number((performance.now() - startedAt).toFixed(3)),
      ),
    });

    return response;
  };
}

export const handleRequest = createRequestHandler();
