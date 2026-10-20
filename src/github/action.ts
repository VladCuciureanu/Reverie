import { appendFileSync } from "node:fs";
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

/**
 * `blocked`: the service queued the deploy and will re-run it on wake.
 * `error`: the check itself failed (bad request, auth, network); nothing is queued.
 */
export type Outcome = "allowed" | "blocked" | "error";

export interface ActionResult {
  outcome: Outcome;
  allowed: boolean;
  reason: string;
  sleep_state: string;
  exitCode: number;
}

function failure(reason: string, sleepState = "unknown"): ActionResult {
  return { outcome: "error", allowed: false, reason, sleep_state: sleepState, exitCode: 1 };
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
    return failure(`Reverie returned HTTP ${response.status} with a non-JSON body`);
  }

  const reason =
    typeof result.reason === "string"
      ? result.reason
      : typeof result.error === "string"
        ? result.error
        : `Reverie returned HTTP ${response.status}`;
  const sleepState = typeof result.sleep_state === "string" ? result.sleep_state : "unknown";

  // 200 means allowed, 423 means blocked; any other status is an error.
  if (response.ok && result.allowed === true) {
    return { outcome: "allowed", allowed: true, reason, sleep_state: sleepState, exitCode: 0 };
  }
  if (response.status === 423 && result.allowed === false) {
    return { outcome: "blocked", allowed: false, reason, sleep_state: sleepState, exitCode: 1 };
  }
  return failure(reason, sleepState);
}

/** The one line the action prints: stdout when allowed, stderr otherwise. */
export function formatResult(result: ActionResult): string {
  switch (result.outcome) {
    case "allowed":
      return `Deploy allowed: ${result.reason}`;
    case "blocked":
      return `reverie: deploy blocked (sleep state: ${result.sleep_state}): ${result.reason} It is queued and will be re-run when the engineer wakes.`;
    case "error":
      return `reverie: gate check failed: ${result.reason}`;
  }
}

/**
 * Appends the step outputs to the $GITHUB_OUTPUT file. `sleep_state` comes
 * from the service, so anything but a plain lowercase word becomes `unknown`
 * to keep it from injecting extra outputs.
 */
export function writeOutputs(path: string, result: ActionResult): void {
  const sleepState = /^[a-z]+$/.test(result.sleep_state) ? result.sleep_state : "unknown";
  appendFileSync(path, `allowed=${result.allowed}\nsleep_state=${sleepState}\n`);
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
  if (process.env.GITHUB_OUTPUT) writeOutputs(process.env.GITHUB_OUTPUT, result);
  if (result.allowed) console.log(formatResult(result));
  else console.error(formatResult(result));
  process.exitCode = result.exitCode;
}
