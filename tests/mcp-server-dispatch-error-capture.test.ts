// metagraphed#8081: dispatchMessage's catch (src/mcp-server.ts, the
// resources/read | resources/subscribe | prompts/get | etc. dispatch layer,
// one level above callTool's own catch) only ever logged a genuinely
// unexpected fault to console -- unlike its sibling in callTool, it never
// reached Sentry or PostHog. A separate small file rather than folded into
// tests/mcp-server-sentry-args-safety.test.ts: vi.mock is file-scoped and
// hoisted, and that file's other tests already exercise the real (unmocked)
// Sentry.captureException through a different call path -- mocking it there
// risks disturbing tests this issue doesn't own. Mirrors that file's and
// tests/graphql-sentry-and-error-code.test.ts's own identical rationale.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/cloudflare", () => ({
  captureException,
}));

const { handleMcpRequest } = await import("../src/mcp-server.ts");

afterEach(() => {
  captureException.mockClear();
});

// resources/read for a valid subnet URI routes through loadArtifactData,
// which calls ctx.readArtifact -- a rejection there is exactly the
// "readArtifact rejection" case dispatchMessage's own comment names as a
// genuine (non-toolError) fault, propagating uncaught to dispatchMessage's
// catch. deps.executionCtx.waitUntil is captured so the fire-and-forget
// PostHog scheduling (never awaited by the main response path, by design --
// it must not delay the client) can be awaited explicitly before asserting.
async function readResourceExpectingDispatchFault(env: Row = {}) {
  const waited: Promise<unknown>[] = [];
  const response = await handleMcpRequest(
    new Request("https://metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "metagraph://subnet/5" },
      }),
    }),
    env as unknown as Env,
    {
      readArtifact: async () => {
        throw new Error("R2 get failed");
      },
      executionCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
    },
  );
  await Promise.all(waited);
  return { body: (await response.json()) as Row };
}

test("a genuine dispatch-level fault reaches Sentry, tagged with the JSON-RPC method", async () => {
  const { body } = await readResourceExpectingDispatchFault();

  assert.equal(body.error?.message, "Internal error.");
  assert.equal(captureException.mock.calls.length, 1);
  const [capturedError, context] = captureException.mock.calls[0];
  assert.equal(capturedError.message, "R2 get failed");
  assert.deepEqual(context, { tags: { mcp_method: "resources/read" } });
});

test("the same fault also reaches PostHog as $exception, tagged mcp-dispatch:resources/read", async () => {
  const original = globalThis.fetch;
  const posted: Row[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    await readResourceExpectingDispatchFault({
      [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.event, "$exception");
    assert.equal(
      posted[0].body.properties.route,
      "mcp-dispatch:resources/read",
    );
    assert.equal(posted[0].body.properties.error_code, "internal_error");
    assert.equal(
      posted[0].body.properties.$exception_list[0].value,
      "R2 get failed",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a handled toolError (e.g. an unknown resource URI) never reaches Sentry or PostHog", async () => {
  const original = globalThis.fetch;
  const posted: Row[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "not-a-metagraph-uri" },
        }),
      }),
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" } as unknown as Env,
      {},
    );
    const body = (await response.json()) as Row;
    assert.equal(body.error?.code, -32602);
    assert.equal(captureException.mock.calls.length, 0);
    assert.equal(posted.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
