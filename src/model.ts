import { DecisionSchema, TicketIngestSchema, type Decision, type TicketIngest } from "./schemas";

export interface ModelContext {
  turn_id: string;
  ticket: TicketIngest;
  messages: Array<TicketIngest["messages"][number] & { id: string }>;
}

export interface ModelProposal {
  reply: string;
  decision: Decision;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model_adapter: string;
  readonly scenario: string;
  propose(context: ModelContext): Promise<ModelProposal>;
}

export function createScriptedBillingAdapter(): ModelAdapter {
  return {
    provider: "mock",
    model_adapter: "scripted-billing-v1",
    scenario: "billing",
    async propose(context) {
      const customerMessage = context.messages.find((message) => message.role === "customer");
      const evidenceMessage = customerMessage ?? context.messages[0];
      const decision = DecisionSchema.parse({
        id: `decision-${context.turn_id}`,
        turn_id: context.turn_id,
        schema_version: "decision.v1",
        urgency: "high",
        extracted: {
          product_area: "billing",
          primary_issue_type: "payment_and_access",
          secondary_issue_types: ["pending_charge", "pro_access"],
          sentiment: "frustrated",
          language: "en",
        },
        action: "route_to_specialist",
        target_queue: "billing",
        rationale: "Customer-reported pending charges and missing Pro access need human billing investigation; the charges are not confirmed settled payments.",
        evidence: [{ message_id: evidenceMessage.id, summary: "Customer reports pending charges and lost Pro access." }],
        knowledge_refs: [],
        unresolved_questions: ["Which reported charges have settled?"],
        requires_human: true,
        execution: { status: "unknown" },
        tool_call_ids: [],
        status: "completed",
      });
      return {
        reply: "I’m sending this reported billing concern to a billing specialist for human investigation. Pending charges are not treated as confirmed payments.",
        decision,
      };
    },
  };
}
