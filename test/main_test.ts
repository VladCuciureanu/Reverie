import { assertEquals } from "@std/assert";
import { createHandler, type ServerDeps } from "../src/main.ts";
import type { SleepTracker } from "../src/sleep/tracker.ts";
import type { SleepStatus } from "../src/sleep/types.ts";
import { DeployQueue } from "../src/gate/queue.ts";
import { GitHubClient } from "../src/github/workflow.ts";

class StubTracker implements SleepTracker {
  status: SleepStatus | null = null;
  getStatus(_engineer: string): Promise<SleepStatus | null> {
    return Promise.resolve(this.status);
  }
}

function nopFetch(): typeof fetch {
  return (() =>
    Promise.resolve(new Response(null, { status: 201 }))) as typeof fetch;
}

function makeDeps(tracker: StubTracker): ServerDeps & { queue: DeployQueue } {
  const queue = new DeployQueue(":memory:");
  return {
    sleepCache: tracker,
    queue,
    github: new GitHubClient({ token: "test", fetchFn: nopFetch() }),
    gateConfig: {
      block_on: ["deep", "rem"],
      allow_on: ["awake", "light"],
      fallback: "block",
      timeout_minutes: 480,
    },
    engineer: "vlad",
  };
}

Deno.test("GET /status returns sleep state and gate decision", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(new Request("http://localhost/status"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.engineer, "vlad");
  assertEquals(body.sleep_state, "awake");
  assertEquals(body.gate, "open");
  deps.queue.close();
});

Deno.test("POST /gate/check allows deploy when awake", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/gate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        branch: "main",
        sha: "abc123",
        workflow_run_id: "run-1",
      }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.allowed, true);
  assertEquals(deps.queue.count(), 0);
  deps.queue.close();
});

Deno.test("POST /gate/check blocks and queues deploy during REM", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "rem", since: new Date("2026-03-24T03:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/gate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        branch: "main",
        sha: "abc123",
        workflow_run_id: "run-1",
      }),
    }),
  );
  assertEquals(res.status, 423);
  const body = await res.json();
  assertEquals(body.allowed, false);
  assertEquals(deps.queue.count(), 1);
  deps.queue.close();
});

Deno.test("POST /gate/check allows override during sleep", async () => {
  const tracker = new StubTracker();
  tracker.status = { state: "deep", since: new Date("2026-03-24T02:00:00Z") };
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(
    new Request("http://localhost/gate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        branch: "main",
        sha: "abc123",
        workflow_run_id: "run-1",
        override_by: "alice",
      }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.allowed, true);
  assertEquals(deps.queue.count(), 0);
  deps.queue.close();
});

Deno.test("GET /unknown returns 404", async () => {
  const tracker = new StubTracker();
  const deps = makeDeps(tracker);
  const handler = createHandler(deps);

  const res = await handler(new Request("http://localhost/unknown"));
  assertEquals(res.status, 404);
  deps.queue.close();
});
