import process from "node:process";

export interface ActionInputs {
  reverieUrl: string;
  /** Bearer token for the Reverie service (REVERIE_API_TOKEN). */
  token: string;
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

function failure(reason: string, sleepState = "unknown"): ActionResult {
  return { allowed: false, reason, sleep_state: sleepState, exitCode: 1 };
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
    engineer: inputs.engineer || undefined,
    override_by: inputs.overrideBy || undefined,
  };

  let response: Response;
  let text: string;
  try {
    response = await fetchFn(`${inputs.reverieUrl}/gate/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inputs.token}`,
      },
      body: JSON.stringify(body),
    });
    text = await response.text();
  } catch (err) {
    return failure(`Could not reach Reverie: ${(err as Error).message}`);
  }

  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    result = parsed as Record<string, unknown>;
  } catch {
    return failure(
      `Reverie returned HTTP ${response.status} with a non-JSON body`,
    );
  }

  const reason =
    typeof result.reason === "string"
      ? result.reason
      : typeof result.error === "string"
        ? result.error
        : `Reverie returned HTTP ${response.status}`;
  const sleepState =
    typeof result.sleep_state === "string" ? result.sleep_state : "unknown";

  // 200 means allowed, 423 means blocked; any other status is an error.
  if (response.ok && result.allowed === true) {
    return { allowed: true, reason, sleep_state: sleepState, exitCode: 0 };
  }
  return failure(reason, sleepState);
}

if (import.meta.main) {
  const inputs: ActionInputs = {
    reverieUrl: process.env.INPUT_REVERIE_URL ?? "",
    token: process.env.INPUT_REVERIE_TOKEN ?? "",
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
