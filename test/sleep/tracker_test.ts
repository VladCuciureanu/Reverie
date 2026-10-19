import { test } from "node:test";
import assert from "node:assert/strict";
import type { SleepTracker } from "../../src/sleep/tracker.ts";
import type { SleepStatus } from "../../src/sleep/types.ts";

class MockTracker implements SleepTracker {
  private statuses: Map<string, SleepStatus> = new Map();

  set(engineer: string, status: SleepStatus) {
    this.statuses.set(engineer, status);
  }

  getStatus(engineer: string): Promise<SleepStatus | null> {
    return Promise.resolve(this.statuses.get(engineer) ?? null);
  }
}

test("tracker returns status for known engineer", async () => {
  const tracker = new MockTracker();
  const since = new Date("2026-03-24T02:00:00Z");
  tracker.set("vlad", { state: "rem", since });

  const status = await tracker.getStatus("vlad");
  assert.deepStrictEqual(status?.state, "rem");
  assert.deepStrictEqual(status?.since, since);
});

test("tracker returns null for unknown engineer", async () => {
  const tracker = new MockTracker();
  const status = await tracker.getStatus("unknown");
  assert.deepStrictEqual(status, null);
});
