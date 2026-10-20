import assert from "node:assert/strict";
import { test } from "node:test";
import { DeployQueue } from "../../src/gate/queue.ts";
import { GitHubClient } from "../../src/github/workflow.ts";
import type { SleepTracker } from "../../src/sleep/tracker.ts";
import type { SleepStatus } from "../../src/sleep/types.ts";
import { WakeWatcher } from "../../src/sleep/watcher.ts";

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

/** Fake GitHub API: run lookups return workflow 4242; dispatches return 204 by default. */
function githubFetch(calls: Call[] = [], runStatus = 200, dispatchStatus = 204): typeof fetch {
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
      return Promise.resolve(new Response(null, { status: dispatchStatus }));
    }
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as typeof fetch;
}

function setup(calls: Call[] = [], runStatus = 200, dispatchStatus = 204) {
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:");
  const github = new GitHubClient({
    token: "test",
    fetchFn: githubFetch(calls, runStatus, dispatchStatus),
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
  assert.deepStrictEqual(calls[0].url, "https://api.github.com/repos/org/repo/actions/runs/987654");
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

test("keeps deploy queued and posts no success status when the dispatch fails", async () => {
  const calls: Call[] = [];
  const { tracker, queue, github } = setup(calls, 200, 500);
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  tracker.status = { state: "rem", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "987654");

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(queue.count(), 1);
  assert.deepStrictEqual(calls.filter((c) => c.url.endsWith("/dispatches")).length, 1);
  assert.ok(!calls.some((c) => c.url.includes("/statuses/")));

  queue.close();
});

test("fails and drops deploys queued longer than timeoutMinutes", async () => {
  const calls: Call[] = [];
  let now = new Date("2026-03-24T02:00:00Z");
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:", { now: () => now });
  const github = new GitHubClient({
    token: "test",
    fetchFn: githubFetch(calls),
  });
  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
    timeoutMinutes: 30,
    now: () => now,
  });

  tracker.status = { state: "deep", since: now };
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  now = new Date("2026-03-24T02:29:00Z");
  await watcher.poll();
  assert.deepStrictEqual(queue.count(), 1);
  assert.deepStrictEqual(calls.length, 0);

  now = new Date("2026-03-24T02:31:00Z");
  await watcher.poll();
  assert.deepStrictEqual(queue.count(), 0);
  assert.deepStrictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].url, "https://api.github.com/repos/org/repo/statuses/abc123");
  assert.deepStrictEqual(JSON.parse(calls[0].body ?? "").state, "failure");

  queue.close();
});

test("uses the gate's block_on and allow_on to decide when the engineer woke", async () => {
  const { tracker, queue, github } = setup();
  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
    gate: {
      block_on: ["deep"],
      allow_on: ["awake", "light", "rem"],
      fallback: "block",
      timeout_minutes: 480,
    },
  });

  tracker.status = { state: "deep", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  // REM is allowed by this gate, so leaving deep for REM opens it.
  tracker.status = { state: "rem", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 1);
  assert.deepStrictEqual(queue.count(), 0);

  queue.close();
});

test("does not drain while the gate still blocks the new stage", async () => {
  const { tracker, queue, github } = setup();
  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
    gate: {
      block_on: ["deep", "rem", "light"],
      allow_on: ["awake"],
      fallback: "block",
      timeout_minutes: 480,
    },
  });

  tracker.status = { state: "rem", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  tracker.status = { state: "light", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(queue.count(), 1);

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 1);

  queue.close();
});

test("drains when the stage becomes known again after an unknown poll blocked", async () => {
  const { tracker, queue, github } = setup();
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  tracker.status = { state: "rem", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  // Unknown blocks under fallback: block, so the gate is still closed.
  tracker.status = null;
  assert.deepStrictEqual(await watcher.poll(), 0);

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 1);

  queue.close();
});

test("an unknown stage never counts as waking, even with fallback: allow", async () => {
  const calls: Call[] = [];
  const { tracker, queue, github } = setup(calls);
  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
    gate: {
      block_on: ["deep", "rem"],
      allow_on: ["awake", "light"],
      fallback: "allow",
      timeout_minutes: 480,
    },
  });

  tracker.status = { state: "deep", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  // The Oura read fails: the gate allows by fallback, but that isn't a wake.
  tracker.status = null;
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(queue.count(), 1);
  assert.ok(!calls.some((c) => c.url.endsWith("/dispatches")));

  // Still asleep once the stage is known again: no wake.
  tracker.status = { state: "rem", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(queue.count(), 1);

  // A known allowed stage after the unknown poll still counts as waking.
  tracker.status = null;
  await watcher.poll();
  tracker.status = { state: "light", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 1);
  assert.deepStrictEqual(queue.count(), 0);

  queue.close();
});

test("an unknown stage that blocks still closes the gate for the next wake", async () => {
  const { tracker, queue, github } = setup();
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  tracker.status = { state: "awake", since: new Date() };
  await watcher.poll();

  // Unknown blocks under the default fallback: block, so deploys queue up.
  tracker.status = null;
  assert.deepStrictEqual(await watcher.poll(), 0);
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 1);

  queue.close();
});

test("dequeues a dispatched deploy even if posting its commit status fails", async () => {
  const calls: Call[] = [];
  const base = githubFetch(calls);
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    input.toString().includes("/statuses/")
      ? Promise.reject(new Error("network down"))
      : base(input, init)) as typeof fetch;
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:");
  const github = new GitHubClient({ token: "test", fetchFn });
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    tracker.status = { state: "deep", since: new Date() };
    await watcher.poll();
    queue.enqueue("org/repo", "main", "abc123", "run-1");

    tracker.status = { state: "awake", since: new Date() };
    assert.deepStrictEqual(await watcher.poll(), 1);
    assert.deepStrictEqual(queue.count(), 0);
    assert.deepStrictEqual(errors.length, 1);

    // The next wake must not dispatch it again.
    tracker.status = { state: "deep", since: new Date() };
    await watcher.poll();
    tracker.status = { state: "awake", since: new Date() };
    assert.deepStrictEqual(await watcher.poll(), 0);
    assert.deepStrictEqual(calls.filter((c) => c.url.endsWith("/dispatches")).length, 1);
  } finally {
    console.error = originalError;
    queue.close();
  }
});

test("a network error on one deploy doesn't stop the rest of the drain", async () => {
  const calls: Call[] = [];
  const base = githubFetch(calls);
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    input.toString().includes("/actions/runs/run-1")
      ? Promise.reject(new Error("network down"))
      : base(input, init)) as typeof fetch;
  let now = new Date("2026-03-24T02:00:00Z");
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:", { now: () => now });
  const github = new GitHubClient({ token: "test", fetchFn });
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    tracker.status = { state: "deep", since: now };
    await watcher.poll();
    queue.enqueue("org/a", "main", "aaa", "run-1");
    now = new Date("2026-03-24T02:01:00Z");
    queue.enqueue("org/b", "main", "bbb", "run-2");

    tracker.status = { state: "awake", since: now };
    assert.deepStrictEqual(await watcher.poll(), 1);
    assert.deepStrictEqual(errors.length, 1);
    assert.deepStrictEqual(
      queue.peek().map((d) => d.repo),
      ["org/a"],
    );
    const dispatches = calls.filter((c) => c.url.endsWith("/dispatches"));
    assert.deepStrictEqual(dispatches.length, 1);
    assert.ok(dispatches[0].url.startsWith("https://api.github.com/repos/org/b/"));
  } finally {
    console.error = originalError;
    queue.close();
  }
});

test("retries a failed dispatch once per poll while the gate stays open", async () => {
  const calls: Call[] = [];
  let dispatchStatus = 500;
  const base = githubFetch(calls);
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    if (!input.toString().endsWith("/dispatches")) return base(input, init);
    calls.push({ url: input.toString(), method: init?.method ?? "GET" });
    return Promise.resolve(new Response(null, { status: dispatchStatus }));
  }) as typeof fetch;
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:");
  const github = new GitHubClient({ token: "test", fetchFn });
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });
  const dispatchCount = () => calls.filter((c) => c.url.endsWith("/dispatches")).length;

  tracker.status = { state: "deep", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(dispatchCount(), 1);

  // Still failing: one more attempt on the next poll, no more.
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(dispatchCount(), 2);

  // The gate closes: no retries until it opens again.
  tracker.status = { state: "rem", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(dispatchCount(), 2);

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(dispatchCount(), 3);

  // GitHub recovers while the engineer stays awake.
  dispatchStatus = 204;
  assert.deepStrictEqual(await watcher.poll(), 1);
  assert.deepStrictEqual(queue.count(), 0);
  assert.deepStrictEqual(dispatchCount(), 4);

  // Nothing left to retry.
  queue.enqueue("org/repo", "main", "def456", "run-2");
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(dispatchCount(), 4);

  queue.close();
});

test("a poll that overlaps an in-flight retry doesn't dispatch the deploy again", async () => {
  const calls: Call[] = [];
  const base = githubFetch(calls);
  let release: (res: Response) => void = () => {};
  const responses: (() => Promise<Response>)[] = [
    () => Promise.resolve(new Response(null, { status: 500 })),
    () => new Promise<Response>((resolve) => (release = resolve)),
  ];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    if (!input.toString().endsWith("/dispatches")) return base(input, init);
    calls.push({ url: input.toString(), method: init?.method ?? "GET" });
    const next = responses.shift();
    return next ? next() : Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:");
  const github = new GitHubClient({ token: "test", fetchFn });
  const watcher = new WakeWatcher({ tracker, queue, github, engineer: "vlad" });
  const dispatchCount = () => calls.filter((c) => c.url.endsWith("/dispatches")).length;

  tracker.status = { state: "deep", since: new Date() };
  await watcher.poll();
  queue.enqueue("org/repo", "main", "abc123", "run-1");

  tracker.status = { state: "awake", since: new Date() };
  assert.deepStrictEqual(await watcher.poll(), 0);

  // The retry's dispatch hangs; the next tick fires before it settles.
  const slow = watcher.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(dispatchCount(), 2);
  assert.deepStrictEqual(await watcher.poll(), 0);
  assert.deepStrictEqual(dispatchCount(), 2);

  release(new Response(null, { status: 204 }));
  assert.deepStrictEqual(await slow, 1);
  assert.deepStrictEqual(queue.count(), 0);
  assert.deepStrictEqual(dispatchCount(), 2);

  queue.close();
});
