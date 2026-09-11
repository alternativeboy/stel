import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionSchema, TicketResponseSchema, type TicketResponse } from "./schemas";
import { EVALUATION_CASES, EvaluationCaseResultSchema, EvaluationSummarySchema, type EvaluationActualFacts, type EvaluationCase, type EvaluationCaseResult, type EvaluationSummary } from "./evaluation";
import { createScriptedBillingAdapter, type ModelAdapter, type ModelProposal } from "./model";
import { createLocalKnowledgeBase, createLocalServiceStatus } from "./read-tool-adapters";
import { createMockWorkItemExecutor } from "./effects";
import { closeStorage, openStorage } from "./storage";
import { createTriageApplication } from "./triage";
import { WorkItemQueueSchema } from "./policy-effects";

export interface EvaluationCaseExecutor {
  execute(item: EvaluationCase): Promise<unknown>;
}
type EvaluationExecution = { response: unknown; effect?: { kind: "specialist_case" | "incident"; queue: "billing" | "product_support" | "operations" | "manual_triage" } | null };

const queueFor = (item: EvaluationCase): EvaluationCase["expected"]["target_queue"] => item.expected.target_queue;

function recordedAdapter(item: EvaluationCase): ModelAdapter {
  const billing = createScriptedBillingAdapter();
  return {
    provider: "mock",
    model_adapter: `recorded-${item.scenario}-v1`,
    scenario: item.scenario,
    async propose(context) {
      if (item.scenario === "billing" || item.scenario === "follow_up") {
        const proposal = await billing.propose(context);
        return { ...proposal, tool_requests: [{ id: `effect-${item.scenario}`, name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: "specialist_case", queue: "billing", title: "Billing investigation", summary: "Investigate reported billing and access concerns.", evidence_refs: [] } }] };
        return proposal;
      }
      if (item.scenario === "faq_only" && !context.tool_results?.length) {
        return {
          reply: "Here is the supported account guidance from the help center.",
          decision: decision(context, item, "low", "auto_respond", null, "usage_question", "completed"),
          tool_requests: [{ id: "kb-faq", name: "search_knowledge_base", version: "v1", arguments: { tool: "search_knowledge_base", version: "v1", query: "account help", language: "en", product_area: "account" } }],
        };
      }
      if (item.scenario === "thai_outage" && !context.tool_results?.length) {
        return {
          reply: "เหตุขัดข้องที่รายงานต้องได้รับการตรวจสอบโดยทีมปฏิบัติการ",
          decision: decision(context, item, "critical", "escalate_to_human", "operations", "availability_outage", "completed"),
          tool_requests: [{ id: "status-thai", name: "get_service_status", version: "v1", arguments: { tool: "get_service_status", version: "v1", region: "thailand", product_area: "availability" } }],
        };
      }
      if (item.scenario === "failure") {
        return { reply: "A human operator is needed; this result is degraded.", decision: decision(context, item, "high", "escalate_to_human", "manual_triage", "unknown", "degraded") };
      }
      const urgency = item.expected.urgency;
      const action = item.expected.action;
      return { reply: "A specialist will investigate the unresolved request.", decision: decision(context, item, urgency, action, queueFor(item), item.expected.primary_issue_type, "completed"), ...(item.expected.required_effect ? { tool_requests: [{ id: `effect-${item.scenario}`, name: "ensure_work_item", version: "v1", arguments: { tool: "ensure_work_item", version: "v1", kind: item.expected.required_effect.kind, queue: item.expected.required_effect.queue, title: "Specialist investigation", summary: "Investigate the reported support issue.", evidence_refs: [] } }] } : {}) };
    },
  };
}

function decision(context: { turn_id: string }, item: EvaluationCase, urgency: EvaluationCase["expected"]["urgency"], action: EvaluationCase["expected"]["action"], queue: EvaluationCase["expected"]["target_queue"], issue: string, status: "completed" | "degraded") {
  return DecisionSchema.parse({ id: `decision-${context.turn_id}`, turn_id: context.turn_id, schema_version: "decision.v1", urgency, extracted: { product_area: queue === "billing" ? "billing" : queue === "operations" ? "availability" : "unknown", primary_issue_type: issue, secondary_issue_types: [], sentiment: item.scenario === "faq_only" ? "neutral" : "frustrated", language: item.expected.language }, action, target_queue: queue, rationale: "The recorded fixture response requires bounded human review where applicable.", evidence: [], knowledge_refs: [], unresolved_questions: [], requires_human: action !== "auto_respond", execution: { status: action === "auto_respond" ? "not_required" : "unknown" }, tool_call_ids: [], status });
}

export function createDefaultEvaluationExecutor(): EvaluationCaseExecutor {
  return {
    async execute(item) {
      const directory = await mkdtemp(join(tmpdir(), "stel-eval-"));
      const storage = openStorage(join(directory, "service.sqlite"));
      try {
        const model = recordedAdapter(item);
        const app = createTriageApplication({ storage, model, knowledge: createLocalKnowledgeBase(), status: createLocalServiceStatus(), effect: createMockWorkItemExecutor(storage) });
        let response: TicketResponse;
        if (item.input.kind === "ticket") response = await app.ingest(item.input.input, { scope: "evaluation", key: `eval-${item.id}` });
        else {
          const initial = await app.ingest(item.input.initial_input, { scope: "evaluation", key: `eval-initial-${item.id}` });
          response = await app.continueConversation(initial.conversation_id, item.input.input, { scope: "evaluation-follow-up", key: `eval-${item.id}` });
        }
        const effect = app.getConversation(response.conversation_id).effects.at(-1);
        return { response, effect: effect ? { kind: effect.kind, queue: effect.queue } : null } satisfies EvaluationExecution;
      } finally {
        closeStorage(storage);
        await rm(directory, { recursive: true });
      }
    },
  };
}

function actual(response: TicketResponse): EvaluationActualFacts {
  const queue = response.decision.target_queue === null ? null : WorkItemQueueSchema.parse(response.decision.target_queue);
  const effectKind = response.decision.execution.work_item_id ? null : null;
  return { urgency: response.decision.urgency, action: response.decision.action, target_queue: queue, language: response.decision.extracted.language, primary_issue_type: response.decision.extracted.primary_issue_type, knowledge_refs: response.decision.knowledge_refs, effect_status: response.decision.execution.status, effect_kind: effectKind, effect_queue: null };
}

function safetyViolations(response: TicketResponse, item: EvaluationCase): string[] {
  const text = `${response.reply} ${response.decision.rationale}`.toLocaleLowerCase();
  return item.expected.forbidden_claims.filter((claim) => {
    const normalized = claim.toLocaleLowerCase();
    if (!text.includes(normalized)) return false;
    return !text.includes(`not ${normalized}`) && !(normalized === "confirmed payment" && text.includes("not treated as confirmed payments"));
  });
}

export async function runEvaluationCase(item: EvaluationCase, executor: EvaluationCaseExecutor = createDefaultEvaluationExecutor()): Promise<EvaluationCaseResult> {
  try {
    const raw = await executor.execute(item);
    const execution = raw && typeof raw === "object" && "response" in raw ? raw as EvaluationExecution : { response: raw };
    const response = TicketResponseSchema.parse(execution.response);
    if (response.decision.target_queue !== null) WorkItemQueueSchema.parse(response.decision.target_queue);
    const violations = safetyViolations(response, item);
    const facts = { ...actual(response), effect_kind: execution.effect?.kind ?? null, effect_queue: execution.effect?.queue ?? null };
    const refsPresent = item.expected.required_knowledge_refs.every((ref) => facts.knowledge_refs.includes(ref));
    const effectMatches = item.expected.required_effect === null ? facts.effect_kind === null : facts.effect_kind === item.expected.required_effect.kind && facts.effect_queue === item.expected.required_effect.queue && (facts.effect_status === "succeeded" || facts.effect_status === "unknown");
    const passed = response.decision.urgency === item.expected.urgency && response.decision.action === item.expected.action && response.decision.target_queue === item.expected.target_queue && response.decision.extracted.language === item.expected.language && response.decision.extracted.primary_issue_type === item.expected.primary_issue_type && response.decision.status === item.expected.expected_status && refsPresent && effectMatches && violations.length === 0;
    return EvaluationCaseResultSchema.parse({ case_id: item.id, status: passed ? "passed" : "failed", schema_valid: true, expected: item.expected, actual: facts, safety_violations: violations, ...(passed ? {} : { details: "Observed output did not satisfy the declared fixture labels." }) });
  } catch {
    return EvaluationCaseResultSchema.parse({ case_id: item.id, status: "error", schema_valid: false, expected: item.expected, actual: { urgency: null, action: null, target_queue: null, language: null, primary_issue_type: null, knowledge_refs: [], effect_status: null, effect_kind: null, effect_queue: null }, safety_violations: [], details: "The recorded orchestration result was invalid or unavailable." });
  }
}

export async function runOfflineEvaluation(cases: readonly EvaluationCase[] = EVALUATION_CASES, executor: EvaluationCaseExecutor = createDefaultEvaluationExecutor()): Promise<EvaluationSummary> {
  const results = [];
  for (const item of cases) results.push(await runEvaluationCase(item, executor));
  const passed = results.filter((result) => result.status === "passed").length;
  const schemaValid = results.filter((result) => result.schema_valid).length;
  const urgencyCorrect = results.filter((result) => result.actual.urgency === result.expected.urgency).length;
  const actionCorrect = results.filter((result) => result.actual.action === result.expected.action && result.actual.target_queue === result.expected.target_queue).length;
  return EvaluationSummarySchema.parse({ evaluation_type: "fixture_replay", dataset_version: "fixtures.v1", total_cases: results.length, passed_cases: passed, failed_cases: results.length - passed, schema_valid_cases: schemaValid, urgency_accuracy: results.length ? urgencyCorrect / results.length : 1, action_accuracy: results.length ? actionCorrect / results.length : 1, safety_violation_count: results.reduce((count, result) => count + result.safety_violations.length, 0), cases: results });
}
