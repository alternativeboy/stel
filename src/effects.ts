import {
  ConfirmedReceiptSchema,
  EnsureWorkItemInputSchema,
  EnsureWorkItemResultSchema,
  OperationIdentitySchema,
  type EnsureWorkItemInput,
  type EnsureWorkItemResult,
  type OperationIdentity,
} from "./policy-effects";
import { completeEffectAttempt, createOrReuseWorkItem, recordEffectAttempt, type Storage } from "./storage";

export interface WorkItemEffectExecutor {
  ensure(input: EnsureWorkItemInput, identity: OperationIdentity, context: { turn_id: string; tool_call_id: string }): Promise<EnsureWorkItemResult>;
}

export function createMockWorkItemExecutor(storage: Storage): WorkItemEffectExecutor {
  return {
    async ensure(rawInput, rawIdentity, context) {
      const input = EnsureWorkItemInputSchema.parse(rawInput);
      const identity = OperationIdentitySchema.parse(rawIdentity);
      const workItem = createOrReuseWorkItem(storage, identity, input, "mock");
      const attempt = recordEffectAttempt(storage, {
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
