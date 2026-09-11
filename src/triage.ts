import { randomUUID } from "node:crypto";
import { TicketResponseSchema, TicketIngestSchema, ConversationReadSchema, type TicketIngest, type TicketResponse, type ConversationRead } from "./schemas";
import { claimRequest, loadConversation, saveCompletedInitialTriage, type InitialTriageAggregate, type Storage } from "./storage";
import { fingerprintRequestBody } from "./idempotency";
import type { ModelAdapter } from "./model";

export interface TriageApplication {
  ingest(input: TicketIngest, request?: { scope: string; key: string }): Promise<TicketResponse>;
  getConversation(id: string): ConversationRead;
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) { super(`Conversation not found: ${id}`); this.name = "ConversationNotFoundError"; }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly resolution: { retryable: boolean; reason: "different_body" | "processing" }) { super(`idempotency ${resolution.reason}`); this.name = "IdempotencyConflictError"; }
}

export function createTriageApplication(dependencies: { storage: Storage; model: ModelAdapter }): TriageApplication {
  return {
    getConversation(id) {
      try {
        const aggregate = loadConversation(dependencies.storage, id);
        return ConversationReadSchema.parse({
          conversation_id: aggregate.conversation.id,
          customer: aggregate.conversation.customer,
          messages: [
            ...aggregate.messages.map((message) => ({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp })),
            { id: `${aggregate.turn.id}:reply`, role: "assistant", content: aggregate.reply, timestamp: null },
          ],
          turn: aggregate.turn,
          decisions: [aggregate.decision],
          tool_calls: [],
        });
      } catch (error) {
        if (error instanceof Error && error.message === "conversation not found") throw new ConversationNotFoundError(id);
        throw error;
      }
    },
    async ingest(input, request = { scope: "legacy", key: `initial-${randomUUID()}` }) {
      const ticket = TicketIngestSchema.parse(input);
      const conversationId = randomUUID();
      const turnId = randomUUID();
      const messageIds = ticket.messages.map(() => randomUUID());
      const context = {
        turn_id: turnId,
        ticket,
        messages: ticket.messages.map((message, index) => ({ ...message, id: messageIds[index] })),
      };
      const now = new Date().toISOString();
      const fingerprint = fingerprintRequestBody(ticket);
      const claim = claimRequest(dependencies.storage, {
        ...request, fingerprint, conversation_id: conversationId, turn_id: turnId,
        initial: { customer: ticket.customer, provider: dependencies.model.provider, model_adapter: dependencies.model.model_adapter, mock_scenario: dependencies.model.scenario, decision_schema_version: "decision.v1", started_at: now },
      });
      if (claim.outcome === "replay") return claim.response;
      if (claim.outcome === "conflict") throw new IdempotencyConflictError({ retryable: claim.retryable, reason: claim.details.reason });
      const proposal = await dependencies.model.propose(context);
      const response = TicketResponseSchema.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        reply: proposal.reply,
        decision: proposal.decision,
      });
      const aggregate: InitialTriageAggregate = {
        conversation: { id: conversationId, customer: ticket.customer },
        request: { id: randomUUID(), key: request.key, scope: request.scope, fingerprint, cached_response: response, cached_status: 201, state: "completed", created_at: now, completed_at: now },
        turn: {
          id: turnId,
          state: "completed",
          provider: dependencies.model.provider,
          model_adapter: dependencies.model.model_adapter,
          mock_scenario: dependencies.model.scenario,
          decision_schema_version: response.decision.schema_version,
          started_at: now,
          completed_at: now,
        },
        messages: context.messages,
        reply: response.reply,
        decision: response.decision,
      };
      saveCompletedInitialTriage(dependencies.storage, aggregate);
      return response;
    },
  };
}
