export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class GitHubClient {
  private token: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async retriggerWorkflow(
    repo: string,
    workflowId: string,
    ref: string,
  ): Promise<boolean> {
    const url =
      `${this.baseUrl}/repos/${repo}/actions/workflows/${workflowId}/dispatches`;
    const response = await this.fetchFn(url, {
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

  async postCommitStatus(
    repo: string,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
    context = "reverie/gate",
  ): Promise<boolean> {
    const url = `${this.baseUrl}/repos/${repo}/statuses/${sha}`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, description, context }),
    });

    return response.status === 201;
  }
}
