import { assertEquals } from "@std/assert";
import { GitHubClient } from "../../src/github/workflow.ts";

function capturingFetch(
  status: number,
): { fetchFn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init! });
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

Deno.test("retriggerWorkflow sends dispatch request", async () => {
  const { fetchFn, calls } = capturingFetch(204);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  const result = await client.retriggerWorkflow(
    "org/repo",
    "deploy.yml",
    "main",
  );
  assertEquals(result, true);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://api.github.com/repos/org/repo/actions/workflows/deploy.yml/dispatches",
  );
  assertEquals(calls[0].init.method, "POST");

  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.ref, "main");
});

Deno.test("retriggerWorkflow returns false on failure", async () => {
  const { fetchFn } = capturingFetch(403);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  const result = await client.retriggerWorkflow(
    "org/repo",
    "deploy.yml",
    "main",
  );
  assertEquals(result, false);
});

Deno.test("postCommitStatus sends status request", async () => {
  const { fetchFn, calls } = capturingFetch(201);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  const result = await client.postCommitStatus(
    "org/repo",
    "abc123",
    "pending",
    "Deploy queued: engineer is in REM sleep.",
  );
  assertEquals(result, true);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://api.github.com/repos/org/repo/statuses/abc123",
  );

  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.state, "pending");
  assertEquals(body.context, "reverie/gate");
});

Deno.test("postCommitStatus returns false on failure", async () => {
  const { fetchFn } = capturingFetch(403);
  const client = new GitHubClient({ token: "gh-token", fetchFn });

  const result = await client.postCommitStatus(
    "org/repo",
    "abc123",
    "pending",
    "test",
  );
  assertEquals(result, false);
});
