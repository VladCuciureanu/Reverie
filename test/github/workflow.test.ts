import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubClient } from "../../src/github/workflow.ts";

function capturingFetch(status: number): {
  fetchFn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

test("retriggerWorkflow sends dispatch request", async () => {
  const { fetchFn, calls } = capturingFetch(204);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  const result = await client.retriggerWorkflow("org/repo", "deploy.yml", "main");
  assert.deepStrictEqual(result, true);
  assert.deepStrictEqual(calls.length, 1);
  assert.deepStrictEqual(
    calls[0].url,
    "https://api.github.com/repos/org/repo/actions/workflows/deploy.yml/dispatches",
  );
  assert.deepStrictEqual(calls[0].init.method, "POST");

  const body = JSON.parse(calls[0].init.body as string);
  assert.deepStrictEqual(body.ref, "main");
});

test("retriggerWorkflow returns false on failure", async () => {
  const { fetchFn } = capturingFetch(403);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  const result = await client.retriggerWorkflow("org/repo", "deploy.yml", "main");
  assert.deepStrictEqual(result, false);
});

test("postCommitStatus sends status request", async () => {
  const { fetchFn, calls } = capturingFetch(201);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  await client.postCommitStatus(
    "org/repo",
    "abc123",
    "pending",
    "Deploy queued: engineer is in REM sleep.",
  );
  assert.deepStrictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].url, "https://api.github.com/repos/org/repo/statuses/abc123");

  const body = JSON.parse(calls[0].init.body as string);
  assert.deepStrictEqual(body.state, "pending");
  assert.deepStrictEqual(body.context, "reverie/gate");
});

test("getWorkflowIdForRun returns the run's workflow_id", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return Promise.resolve(
      new Response(JSON.stringify({ id: 987654, workflow_id: 4242 }), {
        status: 200,
      }),
    );
  };
  const client = new GitHubClient({
    token: "gh-token",
    fetchFn: fetchFn as typeof fetch,
  });

  const id = await client.getWorkflowIdForRun("org/repo", "987654");
  assert.deepStrictEqual(id, "4242");
  assert.deepStrictEqual(calls[0].url, "https://api.github.com/repos/org/repo/actions/runs/987654");
  assert.deepStrictEqual(calls[0].init?.method, "GET");
});

test("getWorkflowIdForRun returns null on failure", async () => {
  const { fetchFn } = capturingFetch(404);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  assert.deepStrictEqual(await client.getWorkflowIdForRun("org/repo", "987654"), null);
});

test("GitHub requests time out instead of hanging", async () => {
  // Never settles unless the request is aborted.
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  const client = new GitHubClient({ token: "gh-token", fetchFn, timeoutMs: 10 });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), 1000);
  });
  try {
    for (const call of [
      () => client.getWorkflowIdForRun("org/repo", "987654"),
      () => client.retriggerWorkflow("org/repo", "4242", "main"),
      () => client.postCommitStatus("org/repo", "abc123", "pending", "Deploy queued."),
    ]) {
      const outcome = await Promise.race([
        call().then(
          () => "settled",
          (err: Error) => err.name,
        ),
        hung,
      ]);
      assert.deepStrictEqual(outcome, "TimeoutError");
    }
  } finally {
    clearTimeout(timer);
  }
});
