// metagraphed#8081: dispatchMessage's catch (src/mcp-server.ts, the
// resources/read | resources/subscribe | prompts/get | etc. dispatch layer,
// one level above callTool's own catch) only ever logged a genuinely
// unexpected fault to console -- unlike its sibling in callTool, it never
// reached PostHog. metagraphed#7766: this file used to also assert
// Sentry.captureException alongside PostHog's $exception capture -- Sentry
// fully removed once PostHog parity was proven. A separate small file
// rather than folded into tests/mcp-server-trace-span-args-safety.test.ts:
// that file's other tests already exercise a different call path.
import assert from "node:assert/strict";
import { test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

const { handleMcpRequest } = await import("../src/mcp-server.ts");

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

test("a genuine dispatch-level fault returns a clean Internal error", async () => {
  const { body } = await readResourceExpectingDispatchFault();

  assert.equal(body.error?.message, "Internal error.");
});

test("a genuine dispatch-level fault reaches PostHog as $exception, tagged mcp-dispatch:resources/read", async () => {
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
    // #8993 made every protocol method emit a usage_event, so this path now
    // posts twice. Filter by event rather than counting posts: what this test
    // is about is the $exception, and asserting a total made it fail the
    // moment an unrelated, correct event was added alongside it.
    const exceptions = posted.filter((p) => p.body.event === "$exception");
    assert.equal(exceptions.length, 1);
    assert.equal(
      exceptions[0].body.properties.route,
      "mcp-dispatch:resources/read",
    );
    assert.equal(exceptions[0].body.properties.error_code, "internal_error");
    assert.equal(
      exceptions[0].body.properties.$exception_list[0].value,
      "R2 get failed",
    );
    // ...and the protocol event rode along, recorded as a failure.
    const usage = posted.filter((p) => p.body.event === "usage_event");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].body.properties.route, "mcp:resources/read");
    assert.equal(usage[0].body.properties.ok, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("a handled toolError (e.g. an unknown resource URI) never reaches PostHog", async () => {
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
    // A handled toolError still posts NO $exception -- that is the invariant
    // this test exists for. It does now post the #8993 protocol usage_event,
    // which is the point of that change: a bad-params outcome is still a
    // dispatched request and should be counted as one.
    assert.deepEqual(
      posted.filter((p) => p.body.event === "$exception"),
      [],
    );
  } finally {
    globalThis.fetch = original;
  }
});
