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

if (import.meta.main) {
  const inputs: ActionInputs = {
    reverieUrl: Deno.env.get("INPUT_REVERIE_URL") ?? "",
    engineer: Deno.env.get("INPUT_ENGINEER") ?? "",
    repo: Deno.env.get("GITHUB_REPOSITORY") ?? "",
    branch: Deno.env.get("GITHUB_REF_NAME") ?? "",
    sha: Deno.env.get("GITHUB_SHA") ?? "",
    workflowRunId: Deno.env.get("GITHUB_RUN_ID") ?? "",
    overrideBy: Deno.env.get("INPUT_OVERRIDE_BY") || undefined,
  };

  const result = await runAction(inputs);

  if (result.allowed) {
    console.log(`✅ ${result.reason}`);
  } else {
    console.error(`❌ Deployment rejected: ${result.reason}`);
    console.error(
      `   Current state: ${result.sleep_state}`,
    );
    console.error(`   Deploy will auto-retry when engineer is awake.`);
  }

  Deno.exit(result.exitCode);
}
