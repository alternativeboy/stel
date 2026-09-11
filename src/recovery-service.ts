import { RecoveryResultSchema, RecoverySummarySchema, type RecoveryResult, type RecoverySummary } from "./recovery";
import { DecisionSchema, TicketResponseSchema } from "./schemas";
import { deriveOperationIdentity } from "./policy-effects";
import type { WorkItemEffectExecutor } from "./effects";
import { finalizeInterruptedNoPlan, finalizeRecoveredResponse, inspectInterruptedRequests, loadConversationEffects, loadConversationHistory, type Storage } from "./storage";

export interface RecoveryService {
  recover(): Promise<RecoverySummary>;
}

export function createRecoveryService(dependencies: { storage: Storage; effect?: WorkItemEffectExecutor }): RecoveryService {
  return {
    async recover() {
      const candidates = inspectInterruptedRequests(dependencies.storage);
      const results: RecoveryResult[] = [];
      for (const candidate of candidates) {
        if (candidate.classification === "accepted_no_plan") {
          results.push(finalizeInterruptedNoPlan(dependencies.storage, candidate.references.request_id));
          continue;
        }
        let effectStatus = candidate.effect_status;
        let effects = loadConversationEffects(dependencies.storage, candidate.references.conversation_id);
        let workItem = candidate.references.work_item_id ? effects.work_items.find((item) => item.id === candidate.references.work_item_id) : effects.work_items[0];
        if (effectStatus === "pending" && workItem && dependencies.effect) {
          try {
            await dependencies.effect.ensure(workItem.intent, deriveOperationIdentity(workItem.conversation_id, workItem.kind, workItem.queue), { turn_id: candidate.references.turn_id, tool_call_id: candidate.references.effect_id ?? `recovery-${candidate.references.turn_id}`, attempt_id: candidate.references.effect_id });
            effects = loadConversationEffects(dependencies.storage, candidate.references.conversation_id);
            workItem = effects.work_items.find((item) => item.id === workItem!.id) ?? workItem;
            effectStatus = workItem.receipt ? "succeeded" : "unknown";
          } catch {
            effectStatus = "unknown";
          }
        }
        if (effectStatus === "succeeded" && workItem) {
          const history = loadConversationHistory(dependencies.storage, candidate.references.conversation_id);
          const storedDecision = history.decisions.find((decision) => decision.turn_id === candidate.references.turn_id);
          if (!storedDecision) {
            results.push(RecoveryResultSchema.parse({ classification: candidate.classification, outcome: "unresolved", references: candidate.references, effect_status: "unknown" }));
            continue;
          }
          const decision = DecisionSchema.parse({ ...storedDecision, execution: { status: "succeeded", work_item_id: workItem.id } });
          const response = TicketResponseSchema.parse({ conversation_id: candidate.references.conversation_id, turn_id: candidate.references.turn_id, reply: "Your request is recorded and the existing work item remains under human review.", decision });
          results.push(finalizeRecoveredResponse(dependencies.storage, candidate.references.request_id, response));
        } else {
          results.push(RecoveryResultSchema.parse({ classification: candidate.classification, outcome: "unresolved", references: candidate.references, effect_status: "unknown" }));
        }
      }
      return RecoverySummarySchema.parse({ recovery_version: "recovery.v1", scanned: candidates.length, finalized: results.filter((result) => result.outcome !== "unresolved").length, unresolved: results.filter((result) => result.outcome === "unresolved").length, results });
    },
  };
}
