import { runEvaluationCli } from "./evaluation-cli";

if (import.meta.main) process.exit(await runEvaluationCli());

