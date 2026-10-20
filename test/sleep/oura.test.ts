import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OuraTracker } from "../../src/sleep/oura.ts";

/**
 * Overnight session from 23:30 to 07:30 UTC. sleep_phase_5_min:
 * 23:30 awake, 23:40 light, 00:10 deep, 01:10 REM, 01:40 light, 07:10 awake.
 */
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/oura_sleep.json", import.meta.url), "utf8"),
);

function mockFetch(body: unknown, status = 200, urls: string[] = []): typeof fetch {
  return ((input: string | URL | Request) => {
    urls.push(input.toString());
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

function trackerAt(iso: string, body: unknown = fixture, urls?: string[]) {
  return new OuraTracker({
    token: "test-token",
    fetchFn: mockFetch(body, 200, urls),
    now: () => new Date(iso),
  });
}

test("queries from yesterday so sleep that began before midnight is seen", async () => {
  const urls: string[] = [];
  await trackerAt("2026-03-24T00:30:00Z", fixture, urls).getStatus("vlad");
  const url = new URL(urls[0]);
  assert.deepStrictEqual(url.pathname, "/v2/usercollection/sleep");
  assert.deepStrictEqual(url.searchParams.get("start_date"), "2026-03-23");
  assert.deepStrictEqual(url.searchParams.get("end_date"), "2026-03-25");
});

test("reports deep sleep from the phase string", async () => {
  const status = await trackerAt("2026-03-24T00:30:00Z").getStatus("vlad");
  assert.deepStrictEqual(status, {
    state: "deep",
    since: new Date("2026-03-24T00:10:00Z"),
  });
});

test("reports REM from the phase string", async () => {
  const status = await trackerAt("2026-03-24T01:20:00Z").getStatus("vlad");
  assert.deepStrictEqual(status, {
    state: "rem",
    since: new Date("2026-03-24T01:10:00Z"),
  });
});

test("reports light sleep before midnight", async () => {
  const status = await trackerAt("2026-03-23T23:59:00Z").getStatus("vlad");
  assert.deepStrictEqual(status, {
    state: "light",
    since: new Date("2026-03-23T23:40:00Z"),
  });
});

test("reports awake phases inside a session", async () => {
  const status = await trackerAt("2026-03-24T07:15:00Z").getStatus("vlad");
  assert.deepStrictEqual(status, {
    state: "awake",
    since: new Date("2026-03-24T07:10:00Z"),
  });
});

test("returns awake once the latest session has ended", async () => {
  const status = await trackerAt("2026-03-24T08:00:00Z").getStatus("vlad");
  assert.deepStrictEqual(status, {
    state: "awake",
    since: new Date("2026-03-24T07:30:00Z"),
  });
});

test("returns null when the phase data doesn't reach the current time", async () => {
  const [session] = fixture.data;
  const partial = {
    data: [{ ...session, sleep_phase_5_min: session.sleep_phase_5_min.slice(0, 12) }],
  };
  const status = await trackerAt("2026-03-24T03:00:00Z", partial).getStatus("vlad");
  assert.deepStrictEqual(status, null);
});

test("returns awake when there are no sleep sessions", async () => {
  const status = await trackerAt("2026-03-24T12:00:00Z", {
    data: [],
  }).getStatus("vlad");
  assert.deepStrictEqual(status?.state, "awake");
});

test("returns null on API error", async () => {
  const tracker = new OuraTracker({
    token: "test-token",
    fetchFn: mockFetch({}, 401),
  });

  const status = await tracker.getStatus("vlad");
  assert.deepStrictEqual(status, null);
});
