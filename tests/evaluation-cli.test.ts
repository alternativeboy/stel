import { describe, expect, test } from "bun:test";
import { formatEvaluationReport, runEvaluationCli } from "../src/evaluation-cli";
import { runOfflineEvaluation } from "../src/evaluation-runner";

describe("offline evaluation CLI", () => {
  test("formats a concise safe human report", async () => {
    const report = formatEvaluationReport(await runOfflineEvaluation());
    expect(report).toContain("Offline fixture/replay evaluation");
    expect(report).toContain("not live GPT accuracy");
    expect(report).toContain("7/7 passed");
    expect(report).not.toMatch(/OPENAI_API_KEY|sk-[A-Za-z0-9]{8,}/);
  });

  test("runs the documented JSON CLI mode end to end", async () => {
    const child = Bun.spawn(["bun", "run", "evaluate", "--json"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    expect(exitCode).toBe(0);
    const report = JSON.parse(output) as { evaluation_type: string; total_cases: number; failed_cases: number };
    expect(report.evaluation_type).toBe("fixture_replay");
    expect(report.total_cases).toBe(7);
    expect(report.failed_cases).toBe(0);
  });

  test("returns nonzero for a failed validated report", async () => {
    const summary = await runOfflineEvaluation();
    const failed = { ...summary, passed_cases: 0, failed_cases: summary.total_cases, cases: summary.cases.map((item) => ({ ...item, status: "failed" as const })) };
    expect(await runEvaluationCli(["--json"], async () => failed)).toBe(1);
  });
});
