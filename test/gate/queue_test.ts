import { assertEquals } from "@std/assert";
import { DeployQueue } from "../../src/gate/queue.ts";

function withQueue(fn: (queue: DeployQueue) => void) {
  const queue = new DeployQueue(":memory:");
  try {
    fn(queue);
  } finally {
    queue.close();
  }
}

Deno.test("enqueue and peek", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    const items = queue.peek();
    assertEquals(items.length, 1);
    assertEquals(items[0].repo, "org/repo");
    assertEquals(items[0].branch, "main");
    assertEquals(items[0].sha, "abc123");
    assertEquals(items[0].workflow_run_id, "run-1");
  });
});

Deno.test("enqueue supersedes earlier deploy on same repo+branch", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    queue.enqueue("org/repo", "main", "def456", "run-2");
    const items = queue.peek();
    assertEquals(items.length, 1);
    assertEquals(items[0].sha, "def456");
    assertEquals(items[0].workflow_run_id, "run-2");
  });
});

Deno.test("enqueue keeps different branches separate", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    queue.enqueue("org/repo", "staging", "def456", "run-2");
    const items = queue.peek();
    assertEquals(items.length, 2);
  });
});

Deno.test("remove deletes specific entry", () => {
  withQueue((queue) => {
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    const items = queue.peek();
    queue.remove(items[0].id);
    assertEquals(queue.peek().length, 0);
  });
});

Deno.test("count returns number of queued deploys", () => {
  withQueue((queue) => {
    assertEquals(queue.count(), 0);
    queue.enqueue("org/repo", "main", "abc123", "run-1");
    assertEquals(queue.count(), 1);
    queue.enqueue("org/repo", "staging", "def456", "run-2");
    assertEquals(queue.count(), 2);
  });
});
