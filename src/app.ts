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
  readonly conversation_id?: string;
  readonly turn_id?: string;
  readonly decision_id?: string;
}

export type RequestLogger = (record: RequestCompletionLog) => void;
type TriageHandler = (request: Request) => Promise<Response>;
import type { TriageApplication } from "./triage";
import { ConversationNotFoundError } from "./triage";
import { TicketIngestSchema } from "./schemas";
import { IdempotencyKeySchema } from "./idempotency";
import { IdempotencyConflictError } from "./triage";
import { FollowUpMessageSchema } from "./follow-up";

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
  retryable = false,
): Response {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      request_id: requestId,
      retryable,
      details,
    },
  };

  return jsonResponse(body, status, requestId);
}

const MAX_REQUEST_BYTES = 1_048_576;

function payloadTooLargeResponse(requestId: string): Response {
  return errorResponse(413, requestId, "payload_too_large", "Request body exceeds the 1 MiB limit", {});
}

function validationDetails(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return {
    fields: error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
  };
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
  logger?: RequestLogger,
): (request: Request) => Response;
export function createRequestHandler(
  logger: RequestLogger | undefined,
  triage: TriageApplication,
): TriageHandler;
export function createRequestHandler(
  logger: RequestLogger = consoleRequestLogger,
  triage?: TriageApplication,
): (request: Request) => Response | Promise<Response> {
  return (request) => {
    const startedAt = performance.now();
    const { pathname } = new URL(request.url);
    const requestId = getRequestId(request);
    const finish = (response: Response, ids?: { conversation_id?: string; turn_id?: string; decision_id?: string }) => {
      logger({ timestamp: new Date().toISOString(), level: "info", event: "request_completed", request_id: requestId,
        method: request.method, path: pathname, status: response.status,
        duration_ms: Math.max(0, Number((performance.now() - startedAt).toFixed(3))), ...ids });
      return response;
    };

    const followUpMatch = pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    if (followUpMatch) {
      if (request.method !== "POST") {
        const response = errorResponse(405, requestId, "method_not_allowed", "Method not allowed", { allowed_methods: ["POST"] });
        response.headers.set("allow", "POST");
        return finish(response);
      }
      if (!triage) return finish(errorResponse(503, requestId, "service_unavailable", "Ticket triage is unavailable", {}));
      return (async () => {
        const keyResult = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
        if (!keyResult.success) return finish(errorResponse(422, requestId, "invalid_idempotency_key", "A valid Idempotency-Key header is required", { field: "Idempotency-Key" }));
        const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") return finish(errorResponse(415, requestId, "unsupported_media_type", "Content-Type must be application/json", {}));
        const declaredLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return finish(payloadTooLargeResponse(requestId));
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > MAX_REQUEST_BYTES) return finish(payloadTooLargeResponse(requestId));
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return finish(errorResponse(400, requestId, "malformed_json", "Request body is not valid JSON", {})); }
        const validation = FollowUpMessageSchema.safeParse(parsed);
        if (!validation.success) return finish(errorResponse(422, requestId, "invalid_follow_up", "Follow-up message failed validation", validationDetails(validation.error)));
        try {
          const result = await triage.continueConversation(followUpMatch[1]!, validation.data, { scope: `POST /conversations/${followUpMatch[1]!}/messages`, key: keyResult.data });
          return finish(jsonResponse(result, 200, requestId), { conversation_id: result.conversation_id, turn_id: result.turn_id, decision_id: result.decision.id });
        } catch (error) {
          if (error instanceof ConversationNotFoundError || (error instanceof Error && error.message === "conversation not found")) return finish(errorResponse(404, requestId, "not_found", "Conversation not found", { conversation_id: followUpMatch[1] }));
          if (error instanceof IdempotencyConflictError) {
            const response = errorResponse(409, requestId, "idempotency_conflict", error.resolution.reason === "processing" ? "A conversation turn is already processing" : "This key was already used with a different request body", { reason: error.resolution.reason }, error.resolution.retryable);
            if (error.resolution.retryable) response.headers.set("retry-after", "1");
            return finish(response);
          }
          return finish(errorResponse(503, requestId, "triage_unavailable", "Conversation turn is temporarily unavailable", {}));
        }
      })();
    }

    const conversationMatch = pathname.match(/^\/conversations\/([^/]+)$/);
    if (conversationMatch) {
      if (request.method !== "GET") {
        const response = errorResponse(405, requestId, "method_not_allowed", "Method not allowed", { allowed_methods: ["GET"] });
        response.headers.set("allow", "GET");
        return finish(response);
      }
      if (!triage) return finish(errorResponse(503, requestId, "service_unavailable", "Ticket triage is unavailable", {}));
      try {
        const result = triage.getConversation(conversationMatch[1]!);
        return finish(jsonResponse(result, 200, requestId), { conversation_id: result.conversation_id });
      } catch (error) {
        if (error instanceof ConversationNotFoundError) return finish(errorResponse(404, requestId, "not_found", "Conversation not found", { conversation_id: conversationMatch[1] }));
        return finish(errorResponse(503, requestId, "storage_unavailable", "Conversation storage is temporarily unavailable", {}));
      }
    }
    if (pathname !== "/tickets") return finish(routeRequest(request, pathname, requestId));
    if (request.method !== "POST") {
      const response = errorResponse(405, requestId, "method_not_allowed", "Method not allowed", { allowed_methods: ["POST"] });
      response.headers.set("allow", "POST");
      return finish(response);
    }
    if (!triage) return finish(errorResponse(503, requestId, "service_unavailable", "Ticket triage is unavailable", {}));
    return (async () => {
      const keyResult = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
      if (!keyResult.success) return finish(errorResponse(422, requestId, "invalid_idempotency_key", "A valid Idempotency-Key header is required", { field: "Idempotency-Key" }));
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") return finish(errorResponse(415, requestId, "unsupported_media_type", "Content-Type must be application/json", {}));
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return finish(payloadTooLargeResponse(requestId));
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_REQUEST_BYTES) return finish(payloadTooLargeResponse(requestId));
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return finish(errorResponse(400, requestId, "malformed_json", "Request body is not valid JSON", {})); }
      const validation = TicketIngestSchema.safeParse(parsed);
      if (!validation.success) return finish(errorResponse(422, requestId, "invalid_ticket", "Ticket payload failed validation", validationDetails(validation.error)));
      try {
        const result = await triage.ingest(validation.data, { scope: "POST /tickets", key: keyResult.data });
        return finish(jsonResponse(result, 201, requestId), { conversation_id: result.conversation_id, turn_id: result.turn_id, decision_id: result.decision.id });
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          const response = errorResponse(409, requestId, "idempotency_conflict", error.resolution.reason === "processing" ? "An equivalent request is already processing" : "This key was already used with a different request body", { reason: error.resolution.reason }, error.resolution.retryable);
          if (error.resolution.retryable) response.headers.set("retry-after", "1");
          return finish(response);
        }
        return finish(errorResponse(503, requestId, "triage_unavailable", "Ticket triage is temporarily unavailable", {}));
      }
    })();
  };
}

export const handleRequest = createRequestHandler();
