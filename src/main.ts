import { SleepStateCache } from "./sleep/state.ts";
import { OuraTracker } from "./sleep/oura.ts";
import { checkGate } from "./gate/gate.ts";
import { DeployQueue } from "./gate/queue.ts";
import { GitHubClient } from "./github/workflow.ts";
import type { SleepTracker } from "./sleep/tracker.ts";
import type { GateConfig } from "./config.ts";
import type { SleepStatus } from "./sleep/types.ts";

export interface ServerDeps {
  sleepCache: SleepTracker;
  queue: DeployQueue;
  github: GitHubClient;
  gateConfig: GateConfig;
  engineer: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
  const { sleepCache, queue, github, gateConfig, engineer } = deps;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/status") {
      const status = await sleepCache.getStatus(engineer);
      const gateResult = checkGate(status, gateConfig);
      return json({
        engineer,
        sleep_state: status?.state ?? "unknown",
        since: status?.since?.toISOString() ?? null,
        gate: gateResult.allowed ? "open" : "blocked",
        queued_deploys: queue.count(),
      });
    }

    if (req.method === "POST" && url.pathname === "/gate/check") {
      const body = await req.json();
      const { repo, branch, sha, workflow_run_id, override_by } = body as {
        repo: string;
        branch: string;
        sha: string;
        workflow_run_id: string;
        override_by?: string;
      };

      const status = await sleepCache.getStatus(engineer);
      const result = checkGate(status, gateConfig, override_by);

      if (!result.allowed) {
        queue.enqueue(repo, branch, sha, workflow_run_id);
        await github.postCommitStatus(
          repo,
          sha,
          "pending",
          `Deploy queued: ${result.reason}`,
        );
      }

      return json(result, result.allowed ? 200 : 423);
    }

    if (req.method === "POST" && url.pathname === "/webhook/sleep") {
      const body = await req.json() as SleepStatus;
      // Webhook pushes are handled by the cache layer refreshing on next poll.
      // This endpoint exists for future direct push support.
      return json({ received: true, state: body.state });
    }

    return json({ error: "Not found" }, 404);
  };
}

if (import.meta.main) {
  const ouraToken = Deno.env.get("OURA_TOKEN") ?? "";
  const ghToken = Deno.env.get("GITHUB_TOKEN") ?? "";
  const engineerName = Deno.env.get("REVERIE_ENGINEER") ?? "engineer";
  const port = Number(Deno.env.get("PORT") ?? "8000");
  const dbPath = Deno.env.get("REVERIE_DB") ?? "reverie.db";

  const tracker = new OuraTracker({ token: ouraToken });
  const sleepCache = new SleepStateCache(tracker);
  const queue = new DeployQueue(dbPath);
  const github = new GitHubClient({ token: ghToken });

  const gateConfig: GateConfig = {
    block_on: ["deep", "rem"],
    allow_on: ["awake", "light"],
    fallback: "block",
    timeout_minutes: 480,
  };

  const handler = createHandler({
    sleepCache,
    queue,
    github,
    gateConfig,
    engineer: engineerName,
  });

  Deno.serve({ port }, handler);
}
