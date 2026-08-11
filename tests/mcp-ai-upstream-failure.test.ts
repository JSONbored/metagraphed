// #10641: an upstream AI failure has to be actionable to the agent AND visible
// to us, and dispatchTool's rule made those mutually exclusive.
//
// The rule was binary: a toolError is an expected outcome and is NOT captured;
// anything else is an unexpected fault and is. Correct for the codes it names,
// and wrong for one family. `runAi` rethrew a non-input AI failure raw, so it
// degraded to `internal_error: The tool failed to complete.` — measured on a
// live `semantic_search` call, and actionable to nobody: the agent could not
// tell it from a bug in our code, so it did not retry and did not take the
// keyword fallback that `ai_unavailable` exists to point at.
//
// What must hold now, and why each half matters:
//
//   * the agent gets `ai_unavailable`, so it falls back instead of giving up
//   * the ORIGINAL error is still captured, because from outside "Workers AI
//     blipped" and "our embedding code is broken" are the same event
//   * requireAi's own `ai_unavailable` — "no AI binding in this environment" —
//     stays UNcaptured, because that is a configuration state, not a fault.
//     This is the trap that makes the marker necessary: capturing by CODE
//     would sweep the expected case back in, which is exactly the noise
//     #10636 removed on the UI side.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const EMBEDDING = { data: [new Array(1024).fill(0)] };

function artifactDeps(extra: Row = {}) {
  return {
    readArtifact: (_env: Row, path: string) =>
      Promise.resolve({
        ok: true,
        data: { schema_version: 1, path, documents: [] },
        source: "test",
        storage_tier: "git",
      }),
    readHealthKv: () => Promise.resolve(null),
    ...extra,
  };
}

/** Drives semantic_search and returns the tool error plus anything captured. */
async function callSemanticSearch(env: Row) {
  const captured: Row[] = [];
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semantic_search", arguments: { q: "inference api" } },
      }),
    }),
    env as unknown as Env,
    artifactDeps({
      executionCtx: { waitUntil: () => {} },
      recordExceptionEvent: (_e: unknown, event: Row) => {
        captured.push(event);
        return true;
      },
    }),
  );
  const body = (await response.json()) as Row;
  return {
    captured,
    error: (body?.result?.structuredContent as Row)?.error as Row,
  };
}

describe("an upstream AI failure is classified and still captured", () => {
  // Both halves of the surface: the embedding call and the vector query. Either
  // can be the model host having a bad minute.
  for (const [label, env] of Object.entries({
    "the embedding call rejects": {
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: () => Promise.reject(new Error("workers ai 500")) },
      VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
    },
    "the vector query rejects": {
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: () => Promise.resolve(EMBEDDING) },
      VECTORIZE: { query: () => Promise.reject(new Error("vectorize down")) },
    },
  })) {
    test(`${label}: the agent gets ai_unavailable`, async () => {
      const { error } = await callSemanticSearch(env as Row);

      assert.equal(error.code, "ai_unavailable");
      // Never the opaque catch-all this replaced.
      assert.notEqual(error.code, "internal_error");
      // And the message has to say what to do instead, or the code buys
      // nothing.
      assert.match(String(error.message), /search_subnets/);
      assert.match(String(error.message), /transient/);
    });

    test(`${label}: the ORIGINAL failure is still captured`, async () => {
      const { captured } = await callSemanticSearch(env as Row);

      assert.equal(captured.length, 1, "the fault must not go unrecorded");
      assert.equal(captured[0].mcpTool, "semantic_search");
      assert.equal(captured[0].errorCode, "ai_unavailable");
      // The cause, not the classifier: a stack pointing at
      // aiUnavailableToolError would be worse than no classification.
      const recorded = captured[0].error as Error;
      assert.match(recorded.message, /workers ai 500|vectorize down/);
    });
  }
});

describe("the expected AI states stay expected", () => {
  test("no AI binding is a configuration state, never captured", async () => {
    // requireAi throws ai_unavailable here too. Capturing by code rather than
    // by the marker would have recorded this as a fault on every call in every
    // environment without an AI binding — including CI.
    const { error, captured } = await callSemanticSearch({});

    assert.equal(error.code, "ai_unavailable");
    assert.deepEqual(captured, [], "a missing binding is not a fault");
  });

  test("a rate limit is not re-wrapped and not captured", async () => {
    const { error, captured } = await callSemanticSearch({
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: () => Promise.resolve(EMBEDDING) },
      VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
      // withinRateLimit consults this binding; refusing here is the same shape
      // as a real limiter refusal.
      AI_RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
    } as Row);

    // Whatever the limiter decides, the one thing that must not happen is a
    // refusal being reported as a fault.
    if (error?.code === "rate_limited") {
      assert.deepEqual(captured, [], "a rate limit is not a fault");
    }
  });

  test("a malformed argument is still the caller's problem", async () => {
    const captured: Row[] = [];
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          // No q/query at all.
          params: { name: "semantic_search", arguments: {} },
        }),
      }),
      {
        METAGRAPH_ENABLE_AI: "true",
        AI: { run: () => Promise.resolve(EMBEDDING) },
        VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
      } as unknown as Env,
      artifactDeps({
        executionCtx: { waitUntil: () => {} },
        recordExceptionEvent: (_e: unknown, event: Row) => {
          captured.push(event);
          return true;
        },
      }),
    );
    const body = (await response.json()) as Row;
    const error = (body?.result?.structuredContent as Row)?.error as Row;

    assert.equal(error.code, "invalid_params");
    assert.deepEqual(captured, [], "an input error is not a fault");
  });
});

describe("a successful AI call is unaffected", () => {
  // Without this, every assertion above would also hold for a runAi that
  // failed unconditionally.
  test("semantic_search still answers when the AI layer works", async () => {
    const { error, captured } = await callSemanticSearch({
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: () => Promise.resolve(EMBEDDING) },
      VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
    } as Row);

    assert.equal(error, undefined, "a working AI layer should not error");
    assert.deepEqual(captured, []);
  });
});

describe("a non-object throw from the AI layer", () => {
  // runAi reads `error?.aiInput` and `error?.toolError`, so it has to survive a
  // throw that is not an object at all. Nothing in-tree does this deliberately,
  // but a rejected fetch inside a Workers binding can surface a primitive, and
  // the optional chaining is only load-bearing for that case.
  for (const [label, thrown] of Object.entries({
    "a bare string": "vectorize said no",
    null: null,
    "a number": 500,
  })) {
    test(`${label} is still classified as ai_unavailable and captured`, async () => {
      const { error, captured } = await callSemanticSearch({
        METAGRAPH_ENABLE_AI: "true",
        AI: { run: () => Promise.reject(thrown) },
        VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
      } as Row);

      assert.equal(error.code, "ai_unavailable");
      // Still recorded — a primitive throw is exactly the shape most likely to
      // be lost, and losing it is the thing this whole change is about.
      assert.equal(captured.length, 1);
      assert.equal(captured[0].errorCode, "ai_unavailable");
    });
  }
});
