import { randomUUID } from "node:crypto";
import { TicketResponseSchema, TicketIngestSchema, ConversationReadSchema, type TicketIngest, type TicketResponse, type ConversationRead } from "./schemas";
import { loadConversation, saveCompletedInitialTriage, type InitialTriageAggregate, type Storage } from "./storage";
import type { ModelAdapter } from "./model";

export interface TriageApplication {
  ingest(input: TicketIngest): Promise<TicketResponse>;
  getConversation(id: string): ConversationRead;
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) { super(`Conversation not found: ${id}`); this.name = "ConversationNotFoundError"; }
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
    async ingest(input) {
      const ticket = TicketIngestSchema.parse(input);
      const conversationId = randomUUID();
      const turnId = randomUUID();
      const messageIds = ticket.messages.map(() => randomUUID());
      const context = {
        turn_id: turnId,
        ticket,
        messages: ticket.messages.map((message, index) => ({ ...message, id: messageIds[index] })),
      };
      const proposal = await dependencies.model.propose(context);
      const response = TicketResponseSchema.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        reply: proposal.reply,
        decision: proposal.decision,
      });
      const now = new Date().toISOString();
      const aggregate: InitialTriageAggregate = {
        conversation: { id: conversationId, customer: ticket.customer },
        request: { id: randomUUID(), key: `initial-${turnId}`, state: "completed", created_at: now, completed_at: now },
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
