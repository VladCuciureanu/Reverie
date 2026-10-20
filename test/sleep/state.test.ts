import { test } from "node:test";
import assert from "node:assert/strict";
import { SleepStateCache } from "../../src/sleep/state.ts";
import type { SleepTracker } from "../../src/sleep/tracker.ts";
import type { SleepStatus } from "../../src/sleep/types.ts";

class CallCountingTracker implements SleepTracker {
  calls = 0;
  status: SleepStatus | null = null;

  getStatus(_engineer: string): Promise<SleepStatus | null> {
    this.calls++;
    return Promise.resolve(this.status);
  }
}

test("cache returns cached value within TTL", async () => {
  let now = 0;
  const inner = new CallCountingTracker();
  inner.status = { state: "rem", since: new Date("2026-03-24T02:00:00Z") };
  const cache = new SleepStateCache(inner, { ttlMs: 1000, now: () => now });

  await cache.getStatus("vlad");
  assert.deepStrictEqual(inner.calls, 1);

  now = 500; // still within TTL
  const result = await cache.getStatus("vlad");
  assert.deepStrictEqual(inner.calls, 1); // no new call
  assert.deepStrictEqual(result?.state, "rem");
});

test("cache refetches after TTL expires", async () => {
  let now = 0;
  const inner = new CallCountingTracker();
  inner.status = { state: "rem", since: new Date("2026-03-24T02:00:00Z") };
  const cache = new SleepStateCache(inner, { ttlMs: 1000, now: () => now });

  await cache.getStatus("vlad");
  assert.deepStrictEqual(inner.calls, 1);

  now = 1500; // past TTL
  inner.status = { state: "awake", since: new Date("2026-03-24T08:00:00Z") };
  const result = await cache.getStatus("vlad");
  assert.deepStrictEqual(inner.calls, 2);
  assert.deepStrictEqual(result?.state, "awake");
});

test("cache returns null when tracker returns null", async () => {
  const inner = new CallCountingTracker();
  inner.status = null;
  const cache = new SleepStateCache(inner, { ttlMs: 1000 });

  const result = await cache.getStatus("vlad");
  assert.deepStrictEqual(result, null);
});
