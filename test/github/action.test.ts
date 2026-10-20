import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ActionInputs,
  formatResult,
  runAction,
  writeOutputs,
} from "../../src/github/action.ts";

const baseInputs: ActionInputs = {
  reverieUrl: "http://localhost:8000",
  token: "s3cret",
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

  const result = await runAction({ ...baseInputs, overrideBy: "alice" }, fetchFn as typeof fetch);
  assert.deepStrictEqual(result.allowed, true);
  const parsed = JSON.parse(capturedBody);
  assert.deepStrictEqual(parsed.override_by, "alice");
});

test("action sends the bearer token", async () => {
  let capturedHeaders = new Headers();
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    return Promise.resolve(
      new Response(JSON.stringify({ allowed: true, reason: "ok", sleep_state: "awake" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  await runAction(baseInputs, fetchFn as typeof fetch);
  assert.deepStrictEqual(capturedHeaders.get("authorization"), "Bearer s3cret");
});

test("action fails when the service rejects the request", async () => {
  const result = await runAction(baseInputs, mockFetch({ error: "Unauthorized" }, 401));
  assert.deepStrictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.reason, "Unauthorized");
});

test("action sends the engineer", async () => {
  let capturedBody = "";
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return Promise.resolve(
      new Response(JSON.stringify({ allowed: true, reason: "ok", sleep_state: "awake" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  await runAction(baseInputs, fetchFn as typeof fetch);
  assert.deepStrictEqual(JSON.parse(capturedBody).engineer, "vlad");
});

test("action fails on an error status even if the body says allowed", async () => {
  const result = await runAction(baseInputs, mockFetch({ allowed: true }, 500));
  assert.deepStrictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.allowed, false);
});

test("action fails cleanly on a non-JSON response", async () => {
  const fetchFn = (() =>
    Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }))) as typeof fetch;
  const result = await runAction(baseInputs, fetchFn);
  assert.deepStrictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.allowed, false);
  assert.match(result.reason, /HTTP 502/);
});

test("action fails cleanly when the service is unreachable", async () => {
  const fetchFn = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const result = await runAction(baseInputs, fetchFn);
  assert.deepStrictEqual(result.exitCode, 1);
  assert.match(result.reason, /fetch failed/);
});

const blockedBody = {
  allowed: false,
  reason: "Engineer is in REM sleep.",
  sleep_state: "rem",
  retry_after_seconds: 1800,
};

test("a 423 is reported as blocked and queued for a re-run", async () => {
  const result = await runAction(baseInputs, mockFetch(blockedBody, 423));
  assert.deepStrictEqual(result.outcome, "blocked");
  assert.deepStrictEqual(
    formatResult(result),
    "reverie: deploy blocked (sleep state: rem): Engineer is in REM sleep. It is queued and will be re-run when the engineer wakes.",
  );
});

test("errors are not reported as queued for a re-run", async () => {
  const unreachable = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const cases: [string, typeof fetch][] = [
    ["401", mockFetch({ error: "Unauthorized" }, 401)],
    ["400", mockFetch({ error: 'Field "sha" must be a non-empty string' }, 400)],
    ["500 claiming blocked", mockFetch(blockedBody, 500)],
    ["unreachable", unreachable],
  ];
  for (const [name, fetchFn] of cases) {
    const result = await runAction(baseInputs, fetchFn);
    assert.deepStrictEqual(result.outcome, "error", name);
    assert.deepStrictEqual(result.exitCode, 1, name);
    const line = formatResult(result);
    assert.match(line, /^reverie: gate check failed: /, name);
    assert.doesNotMatch(line, /re-run|retry/, name);
  }
});

test("output is plain ASCII on one line", async () => {
  const allowed = await runAction(
    baseInputs,
    mockFetch({
      allowed: true,
      reason: "Engineer is awake. Deploy allowed.",
      sleep_state: "awake",
    }),
  );
  const blocked = await runAction(baseInputs, mockFetch(blockedBody, 423));
  const error = await runAction(baseInputs, mockFetch({ error: "Unauthorized" }, 401));
  for (const result of [allowed, blocked, error]) {
    assert.match(formatResult(result), /^[\x20-\x7e]+$/);
  }
});

function outputFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "github_output");
  writeFileSync(path, "earlier=1\n");
  return path;
}

test("writeOutputs appends allowed and sleep_state", async (t) => {
  const path = outputFile(t);
  writeOutputs(path, await runAction(baseInputs, mockFetch(blockedBody, 423)));
  assert.deepStrictEqual(readFileSync(path, "utf8"), "earlier=1\nallowed=false\nsleep_state=rem\n");

  const allowed = await runAction(
    baseInputs,
    mockFetch({ allowed: true, reason: "ok", sleep_state: "awake" }),
  );
  writeOutputs(path, allowed);
  assert.match(readFileSync(path, "utf8"), /allowed=true\nsleep_state=awake\n$/);
});

test("writeOutputs reports unknown for an unexpected sleep_state", async (t) => {
  const path = outputFile(t);
  const result = await runAction(
    baseInputs,
    mockFetch({ ...blockedBody, sleep_state: "rem\nallowed=true" }, 423),
  );
  writeOutputs(path, result);
  assert.deepStrictEqual(
    readFileSync(path, "utf8"),
    "earlier=1\nallowed=false\nsleep_state=unknown\n",
  );
});
