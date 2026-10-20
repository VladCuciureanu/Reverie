import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import process from "node:process";
import { Readable } from "node:stream";
import type { GateConfig, Settings } from "./config.ts";
import { loadSettings } from "./config.ts";
import { checkGate } from "./gate/gate.ts";
import { DeployQueue } from "./gate/queue.ts";
import { GitHubClient } from "./github/workflow.ts";
import { OuraTracker } from "./sleep/oura.ts";
import { SleepStateCache } from "./sleep/state.ts";
import type { SleepTracker } from "./sleep/tracker.ts";
import { WakeWatcher } from "./sleep/watcher.ts";

export interface ServerDeps {
  /** Source of the sleep stage; the service wraps Oura in a SleepStateCache. */
  tracker: SleepTracker;
  queue: DeployQueue;
  github: GitHubClient;
  gateConfig: GateConfig;
  engineer: string;
  /** Shared secret callers must send as `Authorization: Bearer <token>`. */
  apiToken: string;
}

interface GateCheckRequest {
  repo: string;
  branch: string;
  sha: string;
  workflow_run_id: string;
  /** Engineer the caller expects to gate on; must match the service's. */
  engineer?: string;
  override_by?: string;
}

/** Constant-time bearer token check. An empty configured token never matches. */
function isAuthorized(req: Request, apiToken: string): boolean {
  if (!apiToken) return false;
  const match = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(apiToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Returns the validated request, or an error message describing the problem. */
function parseGateCheck(body: unknown): GateCheckRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
  for (const field of ["repo", "branch", "sha", "workflow_run_id"] as const) {
    if (typeof b[field] !== "string" || b[field] === "") {
      return `Field "${field}" must be a non-empty string`;
    }
  }
  for (const field of ["engineer", "override_by"] as const) {
    if (b[field] !== undefined && typeof b[field] !== "string") {
      return `Field "${field}" must be a string`;
    }
  }
  return {
    repo: b.repo as string,
    branch: b.branch as string,
    sha: b.sha as string,
    workflow_run_id: b.workflow_run_id as string,
    engineer: (b.engineer as string | undefined) || undefined,
    override_by: (b.override_by as string | undefined) || undefined,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
  const { tracker, queue, github, gateConfig, engineer, apiToken } = deps;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    if (route !== "GET /status" && route !== "POST /gate/check") {
      return json({ error: "Not found" }, 404);
    }
    if (!isAuthorized(req, apiToken)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (route === "GET /status") {
      const status = await tracker.getStatus(engineer);
      const gateResult = checkGate(status, gateConfig);
      return json({
        engineer,
        sleep_state: status?.state ?? "unknown",
        since: status?.since?.toISOString() ?? null,
        gate: gateResult.allowed ? "open" : "blocked",
        queued_deploys: queue.count(),
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Request body must be valid JSON" }, 400);
    }
    const parsed = parseGateCheck(body);
    if (typeof parsed === "string") {
      return json({ error: parsed }, 400);
    }
    if (parsed.engineer && parsed.engineer !== engineer) {
      return json(
        {
          error: `This Reverie service gates on "${engineer}", not "${parsed.engineer}"`,
        },
        400,
      );
    }
    const { repo, branch, sha, workflow_run_id, override_by } = parsed;

    const status = await tracker.getStatus(engineer);
    const result = checkGate(status, gateConfig, override_by);

    if (!result.allowed) {
      queue.enqueue(repo, branch, sha, workflow_run_id);
      // The deploy is already queued; a failed status update is cosmetic
      // and must not turn the 423 into a 500.
      try {
        await github.postCommitStatus(repo, sha, "pending", `Deploy queued: ${result.reason}`);
      } catch (err) {
        console.error("Failed to post pending commit status:", err);
      }
    }

    return json(result, result.allowed ? 200 : 423);
  };
}

/** Adapts a Fetch-style handler to node:http. */
function toNodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await handler(
        new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), {
          method: req.method,
          headers: Object.entries(req.headersDistinct).flatMap(([name, values]) =>
            (values ?? []).map((value): [string, string] => [name, value]),
          ),
          body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
          duplex: "half",
        } as RequestInit),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  };
}

/** What startService needs from the wake watcher; tests substitute a fake. */
interface Watcher {
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
      tracker: deps.tracker,
      queue: deps.queue,
      github: deps.github,
      engineer: deps.engineer,
      gate: deps.gateConfig,
      timeoutMinutes: deps.gateConfig.timeout_minutes,
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

function main(): void {
  let settings: Settings;
  try {
    settings = loadSettings(process.env);
  } catch (err) {
    console.error(`reverie: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!settings.configFound) {
    console.log(`No config at ${settings.configPath}; using default gate settings`);
  }

  const tracker = new SleepStateCache(new OuraTracker({ token: settings.ouraToken }));
  const queue = new DeployQueue(settings.dbPath);
  const github = new GitHubClient({ token: settings.githubToken });

  const service = startService(
    {
      tracker,
      queue,
      github,
      gateConfig: settings.gate,
      engineer: settings.engineer,
      apiToken: settings.apiToken,
    },
    {
      port: settings.port,
      onListening: () => console.log(`Listening on http://localhost:${settings.port}/`),
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

if (import.meta.main) main();
