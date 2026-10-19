import { test } from "node:test";
import assert from "node:assert/strict";
import { runAction, type ActionInputs } from "../../src/github/action.ts";

const baseInputs: ActionInputs = {
  reverieUrl: "http://localhost:8000",
  engineer: "vlad",
  repo: "org/repo",
  branch: "main",
  sha: "abc123",
  workflowRunId: "run-1",
};

function mockFetch(response: unknown, status = 200): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

test("action exits 0 when deploy is allowed", async () => {
  const result = await runAction(
    baseInputs,
    mockFetch({
      allowed: true,
      reason: "Engineer is awake. Deploy allowed.",
      sleep_state: "awake",
    }),
  );
  assert.deepStrictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.allowed, true);
});

test("action exits 1 when deploy is blocked", async () => {
  const result = await runAction(
    baseInputs,
    mockFetch(
      {
        allowed: false,
        reason: "Engineer is in REM sleep.",
        sleep_state: "rem",
        retry_after_seconds: 1800,
      },
      423,
    ),
  );
  assert.deepStrictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.allowed, false);
  assert.deepStrictEqual(result.sleep_state, "rem");
});

test("action passes override_by when provided", async () => {
  let capturedBody = "";
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          allowed: true,
          reason: "Gate overridden by alice.",
          sleep_state: "rem",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const result = await runAction(
    { ...baseInputs, overrideBy: "alice" },
    fetchFn as typeof fetch,
  );
  assert.deepStrictEqual(result.allowed, true);
  const parsed = JSON.parse(capturedBody);
  assert.deepStrictEqual(parsed.override_by, "alice");
});
