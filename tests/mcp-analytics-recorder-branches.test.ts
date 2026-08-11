// The two recorder behaviours the resource/prompt suites do not reach.
//
// SCOPE, deliberately narrow. `tests/usage-telemetry.test.ts` already covers
// the shared poster's optional fields (session id present/blank, arguments and
// result present/omitted, a throwing transport) under "the resource/prompt
// poster's optional fields", and the deployment-stamp table there covers every
// recorder's environment/release. Re-asserting any of that here would be two
// copies of one contract, which is how they come to disagree.
//
// What is left, and is only here:
//
//   1. $mcp_missing_capability's own recorder — new, and the only one in the
//      family whose payload is an INTENT rather than a name. Its trimming and
//      its source label are the whole wire contract.
//   2. The redaction and size ceiling on a resource READ. The poster is shared
//      with $mcp_tool_call, whose redaction is proven elsewhere; a resource
//      body is the one payload here that can be the entire agent catalogue, so
//      the ceiling is asserted where that risk actually lives.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_PROJECT_TOKEN_ENV,
  recordMcpMissingCapabilityEvent,
  recordMcpResourceReadEvent,
} from "../src/usage-telemetry.ts";
import { mockEnv, type Row } from "./row-type.ts";

const CONFIGURED = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" };

function fakeFetch({
  onCall,
  ok = true,
  throws = false,
}: { onCall?: (call: Row) => void; ok?: boolean; throws?: boolean } = {}) {
  return (async (url: unknown, init: Row) => {
    if (throws) throw new Error("network unreachable");
    onCall?.({ url, body: JSON.parse(init.body) });
    return { ok };
  }) as unknown as typeof fetch;
}

function propsOf(calls: Row[]): Row {
  return (calls[0].body as Row).properties as Row;
}

describe("$mcp_missing_capability's recorder", () => {
  test("labels the intent as the agent's own words, trimmed", async () => {
    const calls: Row[] = [];
    await recordMcpMissingCapabilityEvent(
      CONFIGURED as unknown as Env,
      { intent: "  wanted per-validator slippage  ", sessionId: " sess-42 " },
      { fetch: fakeFetch({ onCall: (c) => calls.push(c) }) },
    );
    const props = propsOf(calls);
    assert.equal(props.$mcp_intent, "wanted per-validator slippage");
    // Never "inferred": the agent typed this. PostHog's own docs make the same
    // point about this event — the SDK defines the schema, the words are the
    // caller's — and the distinction is what stops a server-invented string
    // from later being read as agent speech.
    assert.equal(props.$mcp_intent_source, "context_parameter");
    assert.equal(props.$session_id, "sess-42");
  });

  test("a whitespace-only intent sets neither the intent nor its source", async () => {
    // The pair moves together or not at all. A source with no intent would
    // claim provenance for nothing.
    const calls: Row[] = [];
    await recordMcpMissingCapabilityEvent(
      CONFIGURED as unknown as Env,
      { intent: "   " },
      { fetch: fakeFetch({ onCall: (c) => calls.push(c) }) },
    );
    const props = propsOf(calls);
    assert.equal(Object.hasOwn(props, "$mcp_intent"), false);
    assert.equal(Object.hasOwn(props, "$mcp_intent_source"), false);
  });

  test("posts nothing when telemetry is unconfigured", async () => {
    let called = false;
    const result = await recordMcpMissingCapabilityEvent(
      mockEnv() as Env,
      { intent: "something" },
      { fetch: fakeFetch({ onCall: () => (called = true) }) },
    );
    assert.equal(result, false);
    assert.equal(called, false, "must not reach the network");
  });

  test("reports false when PostHog rejects the post, and when fetch throws", async () => {
    assert.equal(
      await recordMcpMissingCapabilityEvent(
        CONFIGURED as unknown as Env,
        { intent: "x" },
        { fetch: fakeFetch({ ok: false }) },
      ),
      false,
    );
    // The no-throw contract: a recorder that propagated would take the tool
    // call down with it.
    assert.equal(
      await recordMcpMissingCapabilityEvent(
        CONFIGURED as unknown as Env,
        { intent: "x" },
        { fetch: fakeFetch({ throws: true }) },
      ),
      false,
    );
  });
});

describe("a resource read's payload is bounded and redacted", () => {
  test("a credential in the parameters never reaches PostHog", async () => {
    const calls: Row[] = [];
    await recordMcpResourceReadEvent(
      CONFIGURED as unknown as Env,
      {
        resourceName: "metagraph://x",
        parameters: {
          uri: "metagraph://x",
          credential: "Bearer secret-abc123",
        },
      },
      { fetch: fakeFetch({ onCall: (c) => calls.push(c) }) },
    );
    assert.ok(
      !JSON.stringify(calls[0].body).includes("secret-abc123"),
      "a credential must never reach PostHog",
    );
  });

  test("an oversized response is truncated to a preview, not dropped", async () => {
    // A resource body can be the whole agent catalogue. Truncating keeps the
    // event useful; dropping it would make a large read indistinguishable from
    // one that returned nothing.
    const calls: Row[] = [];
    await recordMcpResourceReadEvent(
      CONFIGURED as unknown as Env,
      { resourceName: "metagraph://x", response: { blob: "x".repeat(20_000) } },
      { fetch: fakeFetch({ onCall: (c) => calls.push(c) }) },
    );
    const body = propsOf(calls).$mcp_response as Row;
    assert.equal(body.truncated, true);
    assert.ok(String(body.preview).length > 0, "a preview should survive");
  });
});
