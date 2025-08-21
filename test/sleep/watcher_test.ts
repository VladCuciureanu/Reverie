import { assertEquals } from "@std/assert";
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

function nopFetch(status = 204): typeof fetch {
  return (() =>
    Promise.resolve(new Response(null, { status }))) as typeof fetch;
}

function setup() {
  const tracker = new ControllableTracker();
  const queue = new DeployQueue(":memory:");
  const github = new GitHubClient({ token: "test", fetchFn: nopFetch() });
  return { tracker, queue, github };
}

Deno.test("drains queue on sleep-to-awake transition", async () => {
  const { tracker, queue, github } = setup();
  let drainedCount = 0;

  const watcher = new WakeWatcher({
    tracker,
    queue,
    github,
    engineer: "vlad",
    onDrain: (n) => drainedCount = n,
  });

  // First poll: asleep
  tracker.status = { state: "rem", since: new Date() };
  await watcher.poll();
  assertEquals(drainedCount, 0);

  // Enqueue a deploy while asleep
  queue.enqueue("org/repo", "main", "abc123", "run-1");
  assertEquals(queue.count(), 1);

  // Second poll: awake — should drain
  tracker.status = { state: "awake", since: new Date() };
  const drained = await watcher.poll();
  assertEquals(drained, 1);
  assertEquals(queue.count(), 0);
  assertEquals(drainedCount, 1);

  queue.close();
});

Deno.test("does not drain when staying awake", async () => {
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
  assertEquals(drained, 0);
  assertEquals(queue.count(), 1);

  queue.close();
});

Deno.test("does not drain when staying asleep", async () => {
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
  assertEquals(drained, 0);
  assertEquals(queue.count(), 1);

  queue.close();
});
