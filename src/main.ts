import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { SleepStateCache } from "./sleep/state.ts";
import { OuraTracker } from "./sleep/oura.ts";
import { checkGate } from "./gate/gate.ts";
import { DeployQueue } from "./gate/queue.ts";
import { GitHubClient } from "./github/workflow.ts";
import { WakeWatcher } from "./sleep/watcher.ts";
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

export function createHandler(
  deps: ServerDeps,
): (req: Request) => Promise<Response> {
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
      const body = (await req.json()) as SleepStatus;
      // Webhook pushes are handled by the cache layer refreshing on next poll.
      // This endpoint exists for future direct push support.
      return json({ received: true, state: body.state });
    }

    return json({ error: "Not found" }, 404);
  };
}

/** Adapts a Fetch-style handler to node:http (replacement for Deno.serve). */
function toNodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        duplex: hasBody ? "half" : undefined,
      } as RequestInit);

      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      if (!res.headersSent)
        res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  };
}

export interface Watcher {
  start(): void;
  stop(): void;
}

export interface Service {
  server: Server;
  watcher: Watcher;
  /** Stops the wake watcher and closes the HTTP server. */
  close(): Promise<void>;
}

/**
 * Starts the HTTP server and the wake watcher that re-triggers queued
 * deploys once the engineer wakes up.
 */
export function startService(
  deps: ServerDeps,
  options: { port: number; watcher?: Watcher; onListening?: () => void },
): Service {
  const watcher =
    options.watcher ??
    new WakeWatcher({
      tracker: deps.sleepCache,
      queue: deps.queue,
      github: deps.github,
      engineer: deps.engineer,
      onDrain: (count) => {
        if (count > 0) console.log(`Re-triggered ${count} queued deploy(s)`);
      },
    });

  const server = createServer(toNodeListener(createHandler(deps)));
  server.listen(options.port, options.onListening);
  watcher.start();

  return {
    server,
    watcher,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        watcher.stop();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const ouraToken = process.env.OURA_TOKEN ?? "";
  const ghToken = process.env.GITHUB_TOKEN ?? "";
  const engineerName = process.env.REVERIE_ENGINEER ?? "engineer";
  const port = Number(process.env.PORT ?? "8000");
  const dbPath = process.env.REVERIE_DB ?? "reverie.db";

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

  const service = startService(
    { sleepCache, queue, github, gateConfig, engineer: engineerName },
    {
      port,
      onListening: () => console.log(`Listening on http://localhost:${port}/`),
    },
  );

  const shutdown = async () => {
    await service.close();
    queue.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
