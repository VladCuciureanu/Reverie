import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export interface ActionInputs {
  reverieUrl: string;
  engineer: string;
  repo: string;
  branch: string;
  sha: string;
  workflowRunId: string;
  overrideBy?: string;
}

export interface ActionResult {
  allowed: boolean;
  reason: string;
  sleep_state: string;
  exitCode: number;
}

export async function runAction(
  inputs: ActionInputs,
  fetchFn: typeof fetch = fetch,
): Promise<ActionResult> {
  const body = {
    repo: inputs.repo,
    branch: inputs.branch,
    sha: inputs.sha,
    workflow_run_id: inputs.workflowRunId,
    override_by: inputs.overrideBy || undefined,
  };

  const response = await fetchFn(`${inputs.reverieUrl}/gate/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  return {
    allowed: result.allowed,
    reason: result.reason,
    sleep_state: result.sleep_state,
    exitCode: result.allowed ? 0 : 1,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const inputs: ActionInputs = {
    reverieUrl: process.env.INPUT_REVERIE_URL ?? "",
    engineer: process.env.INPUT_ENGINEER ?? "",
    repo: process.env.GITHUB_REPOSITORY ?? "",
    branch: process.env.GITHUB_REF_NAME ?? "",
    sha: process.env.GITHUB_SHA ?? "",
    workflowRunId: process.env.GITHUB_RUN_ID ?? "",
    overrideBy: process.env.INPUT_OVERRIDE_BY || undefined,
  };

  const result = await runAction(inputs);

  if (result.allowed) {
    console.log(`✅ ${result.reason}`);
  } else {
    console.error(`❌ Deployment rejected: ${result.reason}`);
    console.error(`   Current state: ${result.sleep_state}`);
    console.error(`   Deploy will auto-retry when engineer is awake.`);
  }

  process.exit(result.exitCode);
}
