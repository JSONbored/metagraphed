import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyUpstreamAttempt,
  orderSafeRpcEndpoints,
  proxyWithFailover,
} from "../workers/api.mjs";

const SAFE_A = "https://bittensor-finney.api.onfinality.io/public";
const SAFE_B = "https://bittensor-public.nodies.app/rpc";
const WSS = "wss://lite.chain.opentensor.ai:443"; // trusted origin, but not HTTP-proxyable
const UNSAFE = "https://evil.example.com/rpc";

const ep = (id, url, extra = {}) => ({
  id,
  url,
  provider: "fixture",
  pool_eligible: true,
  score: 100,
  status: "ok",
  ...extra,
});

const jsonResponse = (status, body) => ({
  status,
  async text() {
    return typeof body === "string" ? body : JSON.stringify(body);
  },
});

// fetchFn that returns the i-th scripted reply (a thunk that may throw, or a
// response object), recording the URLs it was called with.
function scriptedFetch(...replies) {
  const calls = [];
  const fn = async (url) => {
    const reply = replies[calls.length];
    calls.push(url);
    if (typeof reply === "function") return reply();
    return reply;
  };
  fn.calls = calls;
  return fn;
}

describe("classifyUpstreamAttempt", () => {
  const cases = [
    ["network throw", { thrown: true }, "transient"],
    ["http 500", { status: 500 }, "transient"],
    ["http 503", { status: 503 }, "transient"],
    ["http 429", { status: 429 }, "transient"],
    ["http 400", { status: 400 }, "fatal"],
    ["http 404", { status: 404 }, "fatal"],
    ["200 result", { status: 200, parsedBody: { result: {} } }, "success"],
    [
      "200 node-internal error",
      { status: 200, parsedBody: { error: { code: -32603 } } },
      "transient",
    ],
    [
      "200 method-not-found (app error)",
      { status: 200, parsedBody: { error: { code: -32601 } } },
      "success",
    ],
    ["200 unparseable", { status: 200, parsedBody: null }, "success"],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => assert.equal(classifyUpstreamAttempt(input), expected));
  }
});

describe("orderSafeRpcEndpoints", () => {
  test("returns the full ordered safe https list", () => {
    const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints(
      { endpoints: [ep("a", SAFE_A), ep("b", SAFE_B)] },
      () => 0,
    );
    assert.deepEqual(
      endpoints.map((e) => e.id),
      ["a", "b"],
    );
    assert.equal(unsafeEndpoint, null);
  });

  test("drops wss endpoints (not HTTP-proxyable) without flagging unsafe", () => {
    const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints({
      endpoints: [ep("w", WSS), ep("a", SAFE_A)],
    });
    assert.deepEqual(
      endpoints.map((e) => e.id),
      ["a"],
    );
    assert.equal(unsafeEndpoint, null);
  });

  test("reports an unsafe endpoint only when no safe endpoint exists", () => {
    const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints({
      endpoints: [ep("u", UNSAFE)],
    });
    assert.equal(endpoints.length, 0);
    assert.equal(unsafeEndpoint.id, "u");
  });

  test("skips ineligible endpoints", () => {
    const { endpoints } = orderSafeRpcEndpoints({
      endpoints: [ep("x", SAFE_A, { pool_eligible: false }), ep("b", SAFE_B)],
    });
    assert.deepEqual(
      endpoints.map((e) => e.id),
      ["b"],
    );
  });
});

describe("proxyWithFailover", () => {
  const base = { bodyText: "{}", poolId: "finney-rpc" };

  test("fails over from a network throw to the next endpoint", async () => {
    const fetchFn = scriptedFetch(
      () => {
        throw new Error("network");
      },
      jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
    assert.equal(res.headers.get("x-metagraph-rpc-attempts"), "2");
    assert.deepEqual(fetchFn.calls, [SAFE_A, SAFE_B]);
  });

  test("fails over on HTTP 5xx", async () => {
    const fetchFn = scriptedFetch(
      jsonResponse(503, ""),
      jsonResponse(200, { result: 1 }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
  });

  test("fails over on a node-internal JSON-RPC error", async () => {
    const fetchFn = scriptedFetch(
      jsonResponse(200, { error: { code: -32603, message: "internal" } }),
      jsonResponse(200, { result: 1 }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
  });

  test("returns an application JSON-RPC error immediately (no failover)", async () => {
    const fetchFn = scriptedFetch(
      jsonResponse(200, {
        error: { code: -32601, message: "Method not found" },
      }),
      jsonResponse(200, { result: "should-not-be-used" }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "a");
    assert.equal(fetchFn.calls.length, 1);
    assert.equal((await res.json()).error.code, -32601);
  });

  test("returns 502 rpc_upstream_unavailable when all attempts fail", async () => {
    const fetchFn = scriptedFetch(
      () => {
        throw new Error("net");
      },
      () => {
        throw new Error("net");
      },
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, "rpc_upstream_unavailable");
    assert.deepEqual(body.meta.attempts, ["a", "b"]);
  });

  test("bounds attempts to maxAttempts (3) even with more endpoints", async () => {
    const fetchFn = scriptedFetch(...Array(5).fill(jsonResponse(503, "")));
    const endpoints = ["a", "b", "c", "d", "e"].map((id) => ep(id, SAFE_A));
    const res = await proxyWithFailover(endpoints, { ...base, fetchFn });
    assert.equal(res.status, 502);
    assert.equal(fetchFn.calls.length, 3);
  });
});
