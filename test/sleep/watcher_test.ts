import { test } from "node:test";
import assert from "node:assert/strict";
import { WakeWatcher } from "../../src/sleep/watcher.ts";
import type { SleepTracker } from "../../src/sleep/tracker.ts";
import type { SleepStatus } from "../../src/sleep/types.ts";
import { DeployQueue } from "../../src/gate/queue.ts";
import { GitHubClient } from "../../src/github/workflow.ts";

class ControllableTracker implements SleepTracker {
  status: SleepStatus | null = null;
  getStatus(_engineer: string): Promise<SleepStatus | null> {
    return Promise.resolve(this.status);
  }
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** Fake GitHub API: run lookups return workflow 4242; dispatches return 204. */
function githubFetch(calls: Call[] = [], runStatus = 200): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    if (method === "GET" && url.includes("/actions/runs/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1, workflow_id: 4242 }), {
          status: runStatus,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/dispatches")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as typeof fetch;
}

function setup(calls: Call[] = [], runStatus = 200) {
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:");
  const github = new GitHubClient({
    token: "test",
    fetchFn: githubFetch(calls, runStatus),
  });
  return { tracker, queue, github };
}

test("drains queue on sleep-to-awake transition", async () => {
  const { tracker, queue, github } = setup();
  let drainedCount = 0;

  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
    onDrain: (n) => (drainedCount = n),
  });

  // First poll: asleep
  tracker.status = { state: "rem", since: new Date() };
  await watcher.poll();
  assert.deepStrictEqual(drainedCount, 0);

  // Enqueue a deploy while asleep
  queue.enqueue("org/repo", "main", "abc123", "run-1");
  assert.deepStrictEqual(queue.count(), 1);

  // Second poll: awake — should drain
  tracker.status = { state: "awake", since: new Date() };
  const drained = await watcher.poll();
  assert.deepStrictEqual(drained, 1);
  assert.deepStrictEqual(queue.count(), 0);
  assert.deepStrictEqual(drainedCount, 1);

  queue.close();
});

test("does not drain when staying awake", async () => {
  const { tracker, queue, github } = setup();

  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
  });

  tracker.status = { state: "awake", since: new Date() };
  await watcher.poll();

  queue.enqueue("org/repo", "main", "abc123", "run-1");

  tracker.status = { state: "awake", since: new Date() };
  const drained = await watcher.poll();
  assert.deepStrictEqual(drained, 0);
  assert.deepStrictEqual(queue.count(), 1);

  queue.close();
});

test("does not drain when staying asleep", async () => {
  const { tracker, queue, github } = setup();

  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
  });

  tracker.status = { state: "deep", since: new Date() };
  await watcher.poll();

  queue.enqueue("org/repo", "main", "abc123", "run-1");

  tracker.status = { state: "rem", since: new Date() };
  const drained = await watcher.poll();
  assert.deepStrictEqual(drained, 0);
  assert.deepStrictEqual(queue.count(), 1);

  queue.close();
});

test("dispatches the run's workflow ID, not the run ID", async () => {
  const calls: Call[] = [];
  const { tracker, queue, github } = setup(calls);
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  tracker.status = { state: "deep", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "987654");

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 1);

  assert.deepStrictEqual(calls[0].method, "GET");
  assert.deepStrictEqual(
    calls[0].url,
    "https://api.github.com/repos/org/repo/actions/runs/987654",
  );
  const dispatch = calls.find((c) => c.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  assert.deepStrictEqual(
    dispatch.url,
    "https://api.github.com/repos/org/repo/actions/workflows/4242/dispatches",
  );
  assert.deepStrictEqual(dispatch.method, "POST");
  assert.deepStrictEqual(JSON.parse(dispatch.body ?? ""), { ref: "main" });
  assert.ok(!calls.some((c) => c.url.includes("/workflows/987654/")));

  queue.close();
});

test("keeps deploy queued when the run's workflow can't be resolved", async () => {
  const calls: Call[] = [];
  const { tracker, queue, github } = setup(calls, 404);
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  tracker.status = { state: "rem", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "987654");

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(queue.count(), 1);
  assert.ok(!calls.some((c) => c.url.endsWith("/dispatches")));

  queue.close();
});
