import assert from "node:assert/strict";
import { test } from "node:test";
import { DeployQueue } from "../../src/gate/queue.ts";

function withQueue(fn: (queue: DeployQueue) => void) {
  const queue = new DeployQueue(":memory:");
  try {
    fn(queue);
  } finally {
    queue.close();
  }
}

test("enqueue and peek", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    const items = queue.peek();
    assert.deepStrictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].repo, "org/repo");
    assert.deepStrictEqual(items[0].branch, "main");
    assert.deepStrictEqual(items[0].sha, "abc123");
    assert.deepStrictEqual(items[0].workflow_run_id, "run-1");
  });
});

test("enqueue supersedes earlier deploy on same repo+branch", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    queue.enqueue("org/repo", "main", "def456", "run-2");
    const items = queue.peek();
    assert.deepStrictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].sha, "def456");
    assert.deepStrictEqual(items[0].workflow_run_id, "run-2");
  });
});

test("enqueue keeps different branches separate", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    queue.enqueue("org/repo", "staging", "def456", "run-2");
    const items = queue.peek();
    assert.deepStrictEqual(items.length, 2);
  });
});

test("remove deletes specific entry", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    const items = queue.peek();
    queue.remove(items[0].id);
    assert.deepStrictEqual(queue.peek().length, 0);
  });
});

test("count returns number of queued deploys", () => {
  withQueue((queue) => {
    assert.deepStrictEqual(queue.count(), 0);
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    assert.deepStrictEqual(queue.count(), 1);
    queue.enqueue("org/repo", "staging", "def456", "run-2");
    assert.deepStrictEqual(queue.count(), 2);
  });
});

test("enqueue keeps the earlier deploy if the insert fails", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    assert.throws(() => queue.enqueue("org/repo", "main", null as unknown as string, "run-2"));
    const items = queue.peek();
    assert.deepStrictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].sha, "abc123");
  });
});

test("expireOlderThan removes and returns only stale deploys", () => {
  let now = new Date("2026-03-24T02:00:00Z");
  const queue = new DeployQueue(":memory:", { now: () => now });
  try {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    now = new Date("2026-03-24T02:10:00Z");
    queue.enqueue("org/repo", "staging", "def456", "run-2");

    const expired = queue.expireOlderThan(new Date("2026-03-24T02:05:00Z"));
    assert.deepStrictEqual(
      expired.map((d) => d.sha),
      ["abc123"],
    );
    assert.deepStrictEqual(
      queue.peek().map((d) => d.sha),
      ["def456"],
    );
  } finally {
    queue.close();
  }
});
