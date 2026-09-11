import { randomUUID } from "node:crypto";
import { DecisionSchema, TicketResponseSchema, TicketIngestSchema, ConversationReadSchema, type TicketIngest, type TicketResponse, type ConversationRead } from "./schemas";
import { claimFollowUpRequest, claimRequest, loadConversation, loadConversationEffects, loadConversationHistory, saveCompletedFollowUp, saveCompletedInitialTriage, type InitialTriageAggregate, type Storage } from "./storage";
import { fingerprintRequestBody } from "./idempotency";
import type { ModelAdapter, ModelContext } from "./model";
import { validateToolRequests } from "./model";
import { GET_SERVICE_STATUS, SEARCH_KNOWLEDGE_BASE, SearchKnowledgeInputSchema, ServiceStatusInputSchema, ToolResultSchema, type ToolResult } from "./read-tools";
import type { KnowledgeBaseSearch, ServiceStatusLookup } from "./read-tool-adapters";
import { EnsureWorkItemInputSchema, EnsureWorkItemResultSchema, ENSURE_WORK_ITEM, deriveOperationIdentity, evaluatePolicy, type EnsureWorkItemInput } from "./policy-effects";
import type { WorkItemEffectExecutor } from "./effects";
import { FollowUpMessageSchema } from "./follow-up";

const MAX_TOOL_CALLS = 3;

export interface TriageApplication {
  ingest(input: TicketIngest, request?: { scope: string; key: string }): Promise<TicketResponse>;
  continueConversation(conversationId: string, message: import("./follow-up").FollowUpMessage, request: { scope: string; key: string }): Promise<TicketResponse>;
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

export function createTriageApplication(dependencies: { storage: Storage; model: ModelAdapter; knowledge?: KnowledgeBaseSearch; status?: ServiceStatusLookup; effect?: WorkItemEffectExecutor }): TriageApplication {
  return {
    getConversation(id) {
      try {
        const aggregate = loadConversation(dependencies.storage, id);
        const storedEffects = loadConversationEffects(dependencies.storage, id);
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
          effects: storedEffects.work_items.map((item) => ({
          work_item_id: item.id,
          kind: item.kind,
          queue: item.queue,
          operation_key: item.operation_key,
          status: item.status,
          provider: item.provider,
          receipt: item.receipt,
          attempts: storedEffects.attempts.filter((attempt) => attempt.work_item_id === item.id).map((attempt) => ({ id: attempt.id, status: attempt.status, tool_call_id: attempt.tool_call_id, result: attempt.result })),
          })),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "conversation not found") throw new ConversationNotFoundError(id);
        throw error;
      }
    },
    async continueConversation(conversationId, rawMessage, request) {
      const message = FollowUpMessageSchema.parse(rawMessage);
      const history = loadConversationHistory(dependencies.storage, conversationId);
      const turnId = randomUUID();
      const messageId = randomUUID();
      const startedAt = new Date().toISOString();
      const fingerprint = fingerprintRequestBody({ conversation_id: conversationId, message });
      const claim = claimFollowUpRequest(dependencies.storage, {
        conversation_id: conversationId, ...request, fingerprint, turn_id: turnId,
        provider: dependencies.model.provider, model_adapter: dependencies.model.model_adapter,
        mock_scenario: dependencies.model.scenario, decision_schema_version: "decision.v1", started_at: startedAt,
      });
      if (claim.outcome === "replay") return claim.response;
      if (claim.outcome === "conflict") throw new IdempotencyConflictError({ retryable: claim.retryable, reason: claim.details.reason });
      const initialMessages = history.messages.filter((item) => item.role !== "assistant" && (item.role === "customer" || item.role === "support")).map(({ role, content, timestamp }) => ({ role, content, timestamp }));
      const modelMessages = history.messages.filter((item) => item.role !== "assistant" && item.timestamp !== null).map(({ role, content, timestamp, id }) => ({ role, content, timestamp: timestamp!, id })) as ModelContext["messages"];
      modelMessages.push({ ...message, id: messageId });
      const context: ModelContext = { turn_id: turnId, ticket: TicketIngestSchema.parse({ customer: history.conversation.customer, messages: initialMessages }), messages: modelMessages, tool_results: [], prior_decisions: history.decisions };
      let proposal;
      try {
        proposal = await dependencies.model.propose(context);
      } catch {
        const completedAt = new Date().toISOString();
        const degraded = TicketResponseSchema.parse({ conversation_id: conversationId, turn_id: turnId, reply: "A human operator is needed to continue this conversation.", decision: { id: `decision-${turnId}`, turn_id: turnId, schema_version: "decision.v1", urgency: "high", extracted: { product_area: "unknown", primary_issue_type: "unknown", secondary_issue_types: [], sentiment: "unknown", language: "unknown" }, action: "escalate_to_human", target_queue: "manual_triage", rationale: "The follow-up model response was unavailable; manual triage is required.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: true, execution: { status: "unknown" }, tool_call_ids: [], status: "degraded" } });
        saveCompletedFollowUp(dependencies.storage, { conversation_id: conversationId, request: { scope: request.scope, key: request.key as import("./idempotency").IdempotencyKey, fingerprint, turn_id: turnId, created_at: startedAt, completed_at: completedAt }, turn: { id: turnId, provider: dependencies.model.provider, model_adapter: dependencies.model.model_adapter, mock_scenario: dependencies.model.scenario, decision_schema_version: "decision.v1", started_at: startedAt, completed_at: completedAt }, message: { id: messageId, ...message }, response: degraded });
        return degraded;
      }
      const requests = validateToolRequests(proposal.tool_requests);
      const toolIds: string[] = [];
      const knowledgeRefs: string[] = [];
      let effectRequest: { id: string; input: EnsureWorkItemInput } | undefined;
      for (let round = 0; ; round += 1) {
        let currentRequests;
        try { currentRequests = validateToolRequests(proposal.tool_requests); } catch { throw new ToolLoopError("Tool request is invalid."); }
        if (currentRequests.length === 0) break;
        if (currentRequests.length + toolIds.length > MAX_TOOL_CALLS) throw new ToolLoopError("Tool call limit exceeded.");
        if (currentRequests.some((tool, index) => currentRequests.findIndex((candidate) => candidate.id === tool.id) !== index || toolIds.includes(tool.id))) throw new ToolLoopError("Tool request IDs must be unique.");
        const requestedEffect = currentRequests.find((item) => item.name === ENSURE_WORK_ITEM);
        if (requestedEffect) {
          if (currentRequests.length !== 1) throw new ToolLoopError("Effect requests must be made after read tools.");
          try { effectRequest = { id: requestedEffect.id, input: EnsureWorkItemInputSchema.parse(requestedEffect.arguments) }; } catch { throw new ToolLoopError("Work-item arguments are invalid."); }
          break;
        }
        const results: ToolResult[] = [];
        for (const tool of currentRequests) {
          let result: ToolResult["result"];
          try {
            if (tool.name === SEARCH_KNOWLEDGE_BASE) {
              if (!dependencies.knowledge) throw new Error();
              result = dependencies.knowledge.search(SearchKnowledgeInputSchema.parse(tool.arguments));
              if (result.status === "ok") knowledgeRefs.push(...result.matches.map((match) => match.document_id));
            } else if (tool.name === GET_SERVICE_STATUS) {
              if (!dependencies.status) throw new Error();
              result = dependencies.status.lookup(ServiceStatusInputSchema.parse(tool.arguments));
            } else throw new Error();
            results.push(ToolResultSchema.parse({ id: tool.id, name: tool.name, version: tool.version, result }));
          } catch { throw new ToolLoopError("Tool request or result is invalid."); }
          toolIds.push(tool.id);
        }
        context.tool_results = [...(context.tool_results ?? []), ...results];
        proposal = await dependencies.model.propose(context);
        if (round >= MAX_TOOL_CALLS) throw new ToolLoopError("Tool call limit exceeded.");
      }
      const candidate = DecisionSchema.parse(proposal.decision);
      const policy = evaluatePolicy(candidate);
      let finalDecision = policy.status === "accepted" ? candidate : DecisionSchema.parse({ ...candidate, action: "escalate_to_human", target_queue: "manual_triage", requires_human: true, execution: { status: "unknown" } });
      const expectedKind = candidate.target_queue === "operations" ? "incident" : "specialist_case";
      const messageIds = new Set(modelMessages.map((item) => item.id));
      const effectMatches = effectRequest && candidate.action !== "auto_respond" && candidate.target_queue === effectRequest.input.queue && expectedKind === effectRequest.input.kind && effectRequest.input.evidence_refs.every((ref) => messageIds.has(ref.message_id));
      if (effectRequest && !effectMatches) finalDecision = DecisionSchema.parse({ ...candidate, action: "escalate_to_human", target_queue: "manual_triage", requires_human: true, execution: { status: "unknown" } });
      if (effectRequest && effectMatches && dependencies.effect && policy.status === "accepted") {
        toolIds.push(effectRequest.id);
        try {
          const result = EnsureWorkItemResultSchema.parse(await dependencies.effect.ensure(effectRequest.input, deriveOperationIdentity(conversationId, effectRequest.input.kind, effectRequest.input.queue), { turn_id: turnId, tool_call_id: effectRequest.id }));
          finalDecision = DecisionSchema.parse({ ...finalDecision, execution: result.status === "succeeded" || result.status === "reused" ? { status: "succeeded", work_item_id: result.receipt.work_item_id } : { status: result.status } });
        } catch { finalDecision = DecisionSchema.parse({ ...finalDecision, execution: { status: "unknown" } }); }
      } else if (effectRequest && effectMatches && !dependencies.effect) {
        finalDecision = DecisionSchema.parse({ ...finalDecision, execution: { status: "unknown" } });
      }
      const response = TicketResponseSchema.parse({ conversation_id: conversationId, turn_id: turnId, reply: proposal.reply, decision: { ...finalDecision, tool_call_ids: toolIds, knowledge_refs: [...new Set(knowledgeRefs)] } });
      saveCompletedFollowUp(dependencies.storage, { conversation_id: conversationId, request: { scope: request.scope, key: request.key as import("./idempotency").IdempotencyKey, fingerprint, turn_id: turnId, created_at: startedAt, completed_at: new Date().toISOString() }, turn: { id: turnId, provider: dependencies.model.provider, model_adapter: dependencies.model.model_adapter, mock_scenario: dependencies.model.scenario, decision_schema_version: response.decision.schema_version, started_at: startedAt, completed_at: new Date().toISOString() }, message: { id: messageId, ...message }, response });
      return response;
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
      let effectRequest: { id: string; input: EnsureWorkItemInput } | undefined;
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
        const requestedEffect = requests.find((request) => request.name === ENSURE_WORK_ITEM);
        if (requestedEffect) {
          if (requests.length !== 1) throw new ToolLoopError("Effect requests must be made after read tools.");
          let input: EnsureWorkItemInput;
          try { input = EnsureWorkItemInputSchema.parse(requestedEffect.arguments); } catch { throw new ToolLoopError("Work-item arguments are invalid."); }
          effectRequest = { id: requestedEffect.id, input };
          break;
        }
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
          try {
            results.push(ToolResultSchema.parse({ id: request.id, name: request.name, version: request.version, result }));
          } catch {
            throw new ToolLoopError("Tool result is invalid.");
          }
        }
        context.tool_results = [...(context.tool_results ?? []), ...results];
        proposal = await dependencies.model.propose(context);
        if (round >= MAX_TOOL_CALLS) throw new ToolLoopError("Tool call limit exceeded.");
      }
      const candidate = DecisionSchema.parse(proposal.decision);
      const policy = evaluatePolicy(candidate);
      let finalDecision = candidate;
      const fallbackDecision = () => DecisionSchema.parse({ ...candidate, action: "escalate_to_human", target_queue: "manual_triage", requires_human: true, execution: { status: "unknown" } });
      if (policy.status === "rejected") {
        finalDecision = fallbackDecision();
      }
      const expectedKind = candidate.target_queue === "operations" ? "incident" : "specialist_case";
      const contextMessageIds = new Set(context.messages.map((message) => message.id));
      const evidenceIsBound = effectRequest?.input.evidence_refs.every((reference) => contextMessageIds.has(reference.message_id)) ?? false;
      const effectMatchesPlan = effectRequest && candidate.action !== "auto_respond" && candidate.target_queue === effectRequest.input.queue && expectedKind === effectRequest.input.kind && evidenceIsBound;
      if (effectRequest && !effectMatchesPlan) finalDecision = fallbackDecision();
      if (effectRequest && effectMatchesPlan && !dependencies.effect) throw new ToolLoopError("Work-item effect is unavailable.");
      if (effectRequest && dependencies.effect && policy.status === "accepted" && effectMatchesPlan) {
        const identity = deriveOperationIdentity(conversationId, effectRequest.input.kind, effectRequest.input.queue);
        executedToolIds.push(effectRequest.id);
        try {
          const effectResult = EnsureWorkItemResultSchema.parse(await dependencies.effect.ensure(effectRequest.input, identity, { turn_id: turnId, tool_call_id: effectRequest.id }));
          if (effectResult.status === "succeeded" || effectResult.status === "reused") {
            finalDecision = DecisionSchema.parse({ ...finalDecision, execution: { status: "succeeded", work_item_id: effectResult.receipt.work_item_id } });
          } else {
            finalDecision = DecisionSchema.parse({ ...finalDecision, execution: { status: effectResult.status } });
          }
        } catch {
          finalDecision = DecisionSchema.parse({ ...finalDecision, execution: { status: "unknown" } });
        }
      }
      const response = TicketResponseSchema.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        reply: proposal.reply,
        decision: { ...finalDecision, tool_call_ids: executedToolIds, knowledge_refs: [...new Set(knowledgeRefs)] },
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
