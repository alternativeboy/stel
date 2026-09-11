import {
  ConfirmedReceiptSchema,
  EnsureWorkItemInputSchema,
  EnsureWorkItemResultSchema,
  OperationIdentitySchema,
  StoredEffectAttemptSchema,
  type EnsureWorkItemInput,
  type EnsureWorkItemResult,
  type OperationIdentity,
} from "./policy-effects";
import { completeEffectAttempt, createOrReuseWorkItem, recordEffectAttempt, type Storage } from "./storage";

export interface WorkItemEffectExecutor {
  ensure(input: EnsureWorkItemInput, identity: OperationIdentity, context: { turn_id: string; tool_call_id: string; attempt_id?: string }): Promise<EnsureWorkItemResult>;
}

export function createMockWorkItemExecutor(storage: Storage): WorkItemEffectExecutor {
  return {
    async ensure(rawInput, rawIdentity, context) {
      const input = EnsureWorkItemInputSchema.parse(rawInput);
      const identity = OperationIdentitySchema.parse(rawIdentity);
      const workItem = createOrReuseWorkItem(storage, identity, input, "mock");
      const existingAttempt = context.attempt_id ? storage.db.query("SELECT * FROM effect_attempts WHERE id = ? AND status = 'pending'").get(context.attempt_id) as Record<string, string | null> | null : null;
      const attempt = existingAttempt ? StoredEffectAttemptSchema.parse({ id: existingAttempt.id, work_item_id: existingAttempt.work_item_id, turn_id: existingAttempt.turn_id, tool_call_id: existingAttempt.tool_call_id, status: existingAttempt.status, result: null, started_at: existingAttempt.started_at, completed_at: null }) : recordEffectAttempt(storage, {
        id: `attempt-${crypto.randomUUID()}`,
        work_item_id: workItem.workItem.id,
        turn_id: context.turn_id,
        tool_call_id: context.tool_call_id,
        started_at: new Date().toISOString(),
      });
      const receipt = ConfirmedReceiptSchema.parse({
        work_item_id: workItem.workItem.id,
        status: "succeeded",
        created_at: workItem.workItem.receipt?.created_at ?? new Date().toISOString(),
        reused: workItem.reused,
      });
      const result = EnsureWorkItemResultSchema.parse({
        tool: "ensure_work_item",
        version: "v1",
        status: workItem.reused ? "reused" : "succeeded",
        receipt,
      });
      completeEffectAttempt(storage, attempt.id, result);
      return result;
    },
  };
}
