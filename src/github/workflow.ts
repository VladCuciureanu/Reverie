/** Commit status context shown on gated commits. */
const STATUS_CONTEXT = "reverie/gate";

/** Per-request timeout; well under the wake watcher's 2-minute poll interval. */
const DEFAULT_TIMEOUT_MS = 30 * 1000;

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Aborts a request that takes longer than this; defaults to 30 seconds. */
  timeoutMs?: number;
}

export class GitHubClient {
  private token: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /**
   * Looks up the workflow that produced a run. Returns the workflow ID
   * (usable with the workflow_dispatch API), or null if the run doesn't exist
   * (404) or has no workflow ID. Throws on any other error response, which
   * may be transient (5xx, rate limits) or fixable (token permissions).
   */
  async getWorkflowIdForRun(repo: string, runId: string): Promise<string | null> {
    const url = `${this.baseUrl}/repos/${repo}/actions/runs/${runId}`;
    const response = await this.request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`GitHub returned ${response.status} looking up run ${runId} in ${repo}`);
    }

    const run = (await response.json()) as { workflow_id?: unknown };
    return typeof run.workflow_id === "number" || typeof run.workflow_id === "string"
      ? String(run.workflow_id)
      : null;
  }

  async retriggerWorkflow(repo: string, workflowId: string, ref: string): Promise<boolean> {
    const url = `${this.baseUrl}/repos/${repo}/actions/workflows/${workflowId}/dispatches`;
    const response = await this.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref }),
    });

    return response.status === 204;
  }

  /** The status is informational, so an error response is ignored; network errors and timeouts still throw. */
  async postCommitStatus(
    repo: string,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/repos/${repo}/statuses/${sha}`;
    await this.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, description, context: STATUS_CONTEXT }),
    });
  }
}
