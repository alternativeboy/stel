import { randomUUID } from "node:crypto";
import { DecisionSchema, TicketResponseSchema, TicketIngestSchema, ConversationReadSchema, type TicketIngest, type TicketResponse, type ConversationRead } from "./schemas";
import { claimRequest, loadConversation, saveCompletedInitialTriage, type InitialTriageAggregate, type Storage } from "./storage";
import { fingerprintRequestBody } from "./idempotency";
import type { ModelAdapter, ModelContext } from "./model";
import { validateToolRequests } from "./model";
import { GET_SERVICE_STATUS, SEARCH_KNOWLEDGE_BASE, SearchKnowledgeInputSchema, ServiceStatusInputSchema, ToolResultSchema, type ToolResult } from "./read-tools";
import type { KnowledgeBaseSearch, ServiceStatusLookup } from "./read-tool-adapters";

const MAX_TOOL_CALLS = 3;

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

export class ToolLoopError extends Error {
  constructor(message: string) { super(message); this.name = "ToolLoopError"; }
}

export function createTriageApplication(dependencies: { storage: Storage; model: ModelAdapter; knowledge?: KnowledgeBaseSearch; status?: ServiceStatusLookup }): TriageApplication {
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
      const context: ModelContext = {
        turn_id: turnId,
        ticket,
        messages: ticket.messages.map((message, index) => ({ ...message, id: messageIds[index] })),
        tool_results: [],
      };
      const now = new Date().toISOString();
      const fingerprint = fingerprintRequestBody(ticket);
      const claim = claimRequest(dependencies.storage, {
        ...request, fingerprint, conversation_id: conversationId, turn_id: turnId,
        initial: { customer: ticket.customer, provider: dependencies.model.provider, model_adapter: dependencies.model.model_adapter, mock_scenario: dependencies.model.scenario, decision_schema_version: "decision.v1", started_at: now },
      });
      if (claim.outcome === "replay") return claim.response;
      if (claim.outcome === "conflict") throw new IdempotencyConflictError({ retryable: claim.retryable, reason: claim.details.reason });
      let proposal = await dependencies.model.propose(context);
      const executedToolIds: string[] = [];
      const knowledgeRefs: string[] = [];
      for (let round = 0; ; round += 1) {
        let requests;
        try {
          requests = validateToolRequests(proposal.tool_requests);
        } catch {
          throw new ToolLoopError("Tool request is invalid.");
        }
        if (requests.length === 0) break;
        if (requests.some((request, index) => requests.findIndex((candidate) => candidate.id === request.id) !== index || executedToolIds.includes(request.id))) {
          throw new ToolLoopError("Tool request IDs must be unique.");
        }
        if (executedToolIds.length + requests.length > MAX_TOOL_CALLS) throw new ToolLoopError("Tool call limit exceeded.");
        const results: ToolResult[] = [];
        for (const request of requests) {
          let result: ToolResult["result"];
          if (request.name === SEARCH_KNOWLEDGE_BASE) {
            if (!dependencies.knowledge) throw new ToolLoopError("Knowledge search is unavailable.");
            let input;
            try { input = SearchKnowledgeInputSchema.parse(request.arguments); } catch { throw new ToolLoopError("Knowledge search arguments are invalid."); }
            result = dependencies.knowledge.search(input);
            if (result.status === "ok") knowledgeRefs.push(...result.matches.map((match) => match.document_id));
          } else if (request.name === GET_SERVICE_STATUS) {
            if (!dependencies.status) throw new ToolLoopError("Service status is unavailable.");
            let input;
            try { input = ServiceStatusInputSchema.parse(request.arguments); } catch { throw new ToolLoopError("Service status arguments are invalid."); }
            result = dependencies.status.lookup(input);
          } else {
            throw new ToolLoopError("Unknown tool requested.");
          }
          executedToolIds.push(request.id);
          results.push(ToolResultSchema.parse({ id: request.id, name: request.name, version: request.version, result }));
        }
        context.tool_results = [...(context.tool_results ?? []), ...results];
        proposal = await dependencies.model.propose(context);
        if (round >= MAX_TOOL_CALLS) throw new ToolLoopError("Tool call limit exceeded.");
      }
      const candidate = DecisionSchema.parse(proposal.decision);
      const response = TicketResponseSchema.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        reply: proposal.reply,
        decision: { ...candidate, tool_call_ids: executedToolIds, knowledge_refs: [...new Set(knowledgeRefs)] },
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
