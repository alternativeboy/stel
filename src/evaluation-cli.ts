import { EvaluationSummarySchema, type EvaluationSummary } from "./evaluation";
import { runOfflineEvaluation } from "./evaluation-runner";

export function formatEvaluationReport(rawSummary: EvaluationSummary): string {
  const summary = EvaluationSummarySchema.parse(rawSummary);
  const lines = [
    "Offline fixture/replay evaluation (not live GPT accuracy)",
    `Dataset: ${summary.dataset_version}`,
    `Cases: ${summary.passed_cases}/${summary.total_cases} passed`,
    `Schema-valid: ${summary.schema_valid_cases}/${summary.total_cases}`,
    `Urgency accuracy: ${(summary.urgency_accuracy * 100).toFixed(1)}%`,
    `Action/queue accuracy: ${(summary.action_accuracy * 100).toFixed(1)}%`,
    `Safety violations: ${summary.safety_violation_count}`,
  ];
  for (const result of summary.cases) lines.push(`- ${result.case_id}: ${result.status} (expected ${result.expected.urgency}/${result.expected.action}/${result.expected.target_queue ?? "none"}; actual ${result.actual.urgency ?? "none"}/${result.actual.action ?? "none"}/${result.actual.target_queue ?? "none"}; safety ${result.safety_violations.length})`);
  return `${lines.join("\n")}\n`;
}

export async function runEvaluationCli(args: readonly string[] = process.argv.slice(2), runner: () => ReturnType<typeof runOfflineEvaluation> = runOfflineEvaluation): Promise<number> {
  const summary = await runner();
  if (args.includes("--json")) console.log(JSON.stringify(summary));
  else console.log(formatEvaluationReport(summary));
  return summary.failed_cases === 0 ? 0 : 1;
}
