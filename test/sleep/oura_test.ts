import { assertEquals } from "@std/assert";
import { OuraTracker } from "../../src/sleep/oura.ts";

function mockFetch(body: unknown, status = 200): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

Deno.test("returns awake when no sleep sessions today", async () => {
  const tracker = new OuraTracker({
    token: "test-token",
    fetchFn: mockFetch({ data: [] }),
  });

  const status = await tracker.getStatus("vlad");
  assertEquals(status?.state, "awake");
});

Deno.test("returns awake when sleep session has ended", async () => {
  const pastEnd = new Date(Date.now() - 3600_000).toISOString();
  const pastStart = new Date(Date.now() - 28800_000).toISOString();

  const tracker = new OuraTracker({
    token: "test-token",
    fetchFn: mockFetch({
      data: [{
        type: "long_sleep",
        bedtime_start: pastStart,
        bedtime_end: pastEnd,
      }],
    }),
  });

  const status = await tracker.getStatus("vlad");
  assertEquals(status?.state, "awake");
});

Deno.test("returns sleep state when session is ongoing", async () => {
  const futureEnd = new Date(Date.now() + 3600_000).toISOString();
  const pastStart = new Date(Date.now() - 3600_000).toISOString();

  const tracker = new OuraTracker({
    token: "test-token",
    fetchFn: mockFetch({
      data: [{
        type: "long_sleep",
        bedtime_start: pastStart,
        bedtime_end: futureEnd,
      }],
    }),
  });

  const status = await tracker.getStatus("vlad");
  assertEquals(status?.state, "deep");
});

Deno.test("returns null on API error", async () => {
  const tracker = new OuraTracker({
    token: "test-token",
    fetchFn: mockFetch({}, 401),
  });

  const status = await tracker.getStatus("vlad");
  assertEquals(status, null);
});
