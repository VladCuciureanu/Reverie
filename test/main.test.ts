import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DeployQueue } from "../src/gate/queue.ts";
import { GitHubClient } from "../src/github/workflow.ts";
import { createHandler, type ServerDeps, startService } from "../src/main.ts";
import type { SleepTracker } from "../src/sleep/tracker.ts";
import type { SleepStatus } from "../src/sleep/types.ts";
import { WakeWatcher } from "../src/sleep/watcher.ts";

class StubTracker implements SleepTracker {
  status: SleepStatus | null = null;
  getStatus(_engineer: string): Promise<SleepStatus | null> {
    return Promise.resolve(this.status);
  }
}

function nopFetch(): typeof fetch {
  return (() => Promise.resolve(new Response(null, { status: 201 }))) as typeof fetch;
}

function makeDeps(tracker: StubTracker): ServerDeps & { queue: DeployQueue } {
  const queue = new DeployQueue(":memory:");
  return {
    tracker,
    queue,
    github: new GitHubClient({ token: "test", fetchFn: nopFetch() }),
    gateConfig: {
      block_on: ["deep", "rem"],
      allow_on: ["awake", "light"],
      fallback: "block",
      timeout_minutes: 480,
    },
    engineer: "vlad",
    apiToken: "s3cret",
  };
}

const AUTH = { Authorization: "Bearer s3cret" };

function gateCheck(body: BodyInit, headers: HeadersInit = AUTH): Request {
  return new Request("http://localhost/gate/check", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

test("GET /status returns sleep state and gate decision", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(new Request("http://localhost/status", { headers: AUTH }));
  assert.deepStrictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.engineer, "vlad");
  assert.deepStrictEqual(body.sleep_state, "awake");
  assert.deepStrictEqual(body.gate, "open");
  deps.queue.close();
});

test("POST /gate/check allows deploy when awake", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/gate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        repo: "org/repo",
        branch: "main",
        sha: "abc123",
        workflow_run_id: "run-1",
      }),
    }),
  );
  assert.deepStrictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.allowed, true);
  assert.deepStrictEqual(deps.queue.count(), 0);
  deps.queue.close();
});

test("POST /gate/check blocks and queues deploy during REM", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "rem", since: new Date("2026-03-24T03:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/gate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        repo: "org/repo",
        branch: "main",
        sha: "abc123",
        workflow_run_id: "run-1",
      }),
    }),
  );
  assert.deepStrictEqual(res.status, 423);
  const body = await res.json();
  assert.deepStrictEqual(body.allowed, false);
  assert.deepStrictEqual(deps.queue.count(), 1);
  deps.queue.close();
});

test("POST /gate/check allows override during sleep", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "deep", since: new Date("2026-03-24T02:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/gate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        repo: "org/repo",
        branch: "main",
        sha: "abc123",
        workflow_run_id: "run-1",
        override_by: "alice",
      }),
    }),
  );
  assert.deepStrictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.allowed, true);
  assert.deepStrictEqual(deps.queue.count(), 0);
  deps.queue.close();
});

test("GET /unknown returns 404", async () => {
  const tracker = new StubTracker();
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(new Request("http://localhost/unknown"));
  assert.deepStrictEqual(res.status, 404);
  deps.queue.close();
});

test("startService starts the wake watcher and stops it on close", async () => {
  const tracker = new StubTracker();
  const deps = makeDeps(tracker);
  const calls: string[] = [];
  const watcher = {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
  };

  const service = startService(deps, { port: 0, watcher });
  assert.deepStrictEqual(calls, ["start"]);

  await service.close();
  assert.deepStrictEqual(calls, ["start", "stop"]);
  deps.queue.close();
});

test("startService creates a running WakeWatcher by default", async () => {
  const tracker = new StubTracker();
  const deps = makeDeps(tracker);

  const service = startService(deps, { port: 0 });
  assert.ok(service.watcher instanceof WakeWatcher);
  assert.ok(service.watcher.isRunning());

  await service.close();
  assert.deepStrictEqual(service.watcher.isRunning(), false);
  deps.queue.close();
});

const validBody = JSON.stringify({
  repo: "org/repo",
  branch: "main",
  sha: "abc123",
  workflow_run_id: "run-1",
});

test("POST /gate/check rejects missing or wrong token with 401", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "rem", since: new Date("2026-03-24T03:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const badHeaders: Record<string, string>[] = [
    {},
    { Authorization: "Bearer wrong" },
    { Authorization: "Bearer s3cret-but-longer" },
    { Authorization: "s3cret" },
  ];
  for (const headers of badHeaders) {
    const res = await handler(gateCheck(validBody, headers));
    assert.deepStrictEqual(res.status, 401);
  }
  assert.deepStrictEqual(deps.queue.count(), 0);
  deps.queue.close();
});

test("POST /gate/check rejects everything when no token is configured", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = { ...makeDeps(tracker), apiToken: "" };
  const handler = createHandler(deps);

  const res = await handler(gateCheck(validBody, { Authorization: "Bearer " }));
  assert.deepStrictEqual(res.status, 401);
  deps.queue.close();
});

test("POST /gate/check rejects malformed bodies with 400", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "rem", since: new Date("2026-03-24T03:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const bad: string[] = [
    "{not json",
    "",
    "null",
    "[]",
    '"string"',
    JSON.stringify({ branch: "main", sha: "abc123", workflow_run_id: "1" }),
    JSON.stringify({
      repo: "org/repo",
      branch: "main",
      sha: "abc123",
      workflow_run_id: 123,
    }),
    JSON.stringify({
      repo: "",
      branch: "main",
      sha: "abc123",
      workflow_run_id: "1",
    }),
    JSON.stringify({
      repo: "org/repo",
      branch: "main",
      sha: "abc123",
      workflow_run_id: "1",
      override_by: 42,
    }),
  ];
  for (const body of bad) {
    const res = await handler(gateCheck(body));
    assert.deepStrictEqual(res.status, 400, `expected 400 for ${body}`);
    const payload = await res.json();
    assert.ok(typeof payload.error === "string");
  }
  assert.deepStrictEqual(deps.queue.count(), 0);
  deps.queue.close();
});

test("POST /gate/check accepts a valid token and body", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(gateCheck(validBody));
  assert.deepStrictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).allowed, true);
  deps.queue.close();
});

test("POST /gate/check still answers 423 when the commit status call throws", async (t) => {
  const tracker = new StubTracker();
  tracker.status = { state: "rem", since: new Date("2026-03-24T03:00:00Z") };
  const deps = {
    ...makeDeps(tracker),
    github: new GitHubClient({
      token: "test",
      fetchFn: (() => Promise.reject(new Error("network down"))) as typeof fetch,
    }),
  };
  const errors = t.mock.method(console, "error", () => {});
  const handler = createHandler(deps);

  const res = await handler(gateCheck(validBody));
  assert.deepStrictEqual(res.status, 423);
  assert.deepStrictEqual((await res.json()).allowed, false);
  assert.deepStrictEqual(deps.queue.count(), 1);
  assert.ok(errors.mock.callCount() >= 1);
  deps.queue.close();
});

test("POST /gate/check rejects a request for a different engineer", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const body = (engineer: unknown) => JSON.stringify({ ...JSON.parse(validBody), engineer });
  assert.deepStrictEqual((await handler(gateCheck(body("alice")))).status, 400);
  assert.deepStrictEqual((await handler(gateCheck(body(7)))).status, 400);
  assert.deepStrictEqual((await handler(gateCheck(body("vlad")))).status, 200);
  assert.deepStrictEqual((await handler(gateCheck(body("")))).status, 200);
  deps.queue.close();
});

test("POST /webhook/sleep is not served", async () => {
  const deps = makeDeps(new StubTracker());
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/webhook/sleep", {
      method: "POST",
      body: JSON.stringify({ state: "awake" }),
    }),
  );
  assert.deepStrictEqual(res.status, 404);
  deps.queue.close();
});

test("the service exits 1 with a one-line error when a required variable is missing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const result = spawnSync(process.execPath, [main], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      REVERIE_API_TOKEN: "api",
      GITHUB_TOKEN: "gh",
      REVERIE_ENGINEER: "vlad",
      PORT: "0",
    },
  });
  assert.deepStrictEqual(result.status, 1);
  assert.deepStrictEqual(result.stderr, "reverie: OURA_TOKEN must be set\n");
});

test("GET /status rejects missing or wrong token with 401", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "rem", since: new Date("2026-03-24T03:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  for (const headers of [{}, { Authorization: "Bearer wrong" }] as Record<string, string>[]) {
    const res = await handler(new Request("http://localhost/status", { headers }));
    assert.deepStrictEqual(res.status, 401);
    assert.deepStrictEqual(await res.json(), { error: "Unauthorized" });
  }
  deps.queue.close();
});
