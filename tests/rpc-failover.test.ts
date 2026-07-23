import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyUpstreamAttempt,
  isRpcEndpointEjected,
  orderSafeRpcEndpoints,
  proxyWithFailover,
  recordRpcFailure,
  recordRpcSuccess,
} from "../workers/api.mjs";
import type { AnyFn, Row } from "./row-type.ts";

const SAFE_A = "https://bittensor-finney.api.onfinality.io/public";
const SAFE_B = "https://bittensor-public.nodies.app/rpc";
const WSS = "wss://lite.chain.opentensor.ai:443"; // trusted origin, but not HTTP-proxyable
const UNSAFE = "https://evil.example.com/rpc";

const ep = (id: string, url: string, extra: Row = {}) => ({
  id,
  url,
  provider: "fixture",
  pool_eligible: true,
  score: 100,
  status: "ok",
  ...extra,
});

const jsonResponse = (status: number, body: unknown) => ({
  status,
  async text() {
    return typeof body === "string" ? body : JSON.stringify(body);
  },
});

// fetchFn that returns the i-th scripted reply (a thunk that may throw, or a
// response object), recording the URLs AND init options it was called with so a
// test can assert the security-critical fetch options (e.g. redirect:"manual").
function scriptedFetch(...replies: unknown[]) {
  const calls: unknown[] = [];
  const inits: unknown[] = [];
  const fn = async (url: unknown, init: unknown) => {
    const reply = replies[calls.length];
    calls.push(url);
    inits.push(init);
    if (typeof reply === "function") return (reply as AnyFn)();
    return reply;
  };
  (fn as Row).calls = calls;
  (fn as Row).inits = inits;
  return fn as typeof fn & Row;
}

describe("classifyUpstreamAttempt", () => {
  const cases: [string, Row, string][] = [
    ["network throw", { thrown: true }, "transient"],
    ["http 500", { status: 500 }, "transient"],
    ["http 503", { status: 503 }, "transient"],
    ["http 429", { status: 429 }, "transient"],
    // 3xx redirects + the opaqueredirect sentinel (status 0) are never valid
    // JSON-RPC responses; they must be failed attempts (transient), never
    // reaching the status<400 success branch — the allowlist only vetted the
    // initial upstream, so a redirect target is unvetted.
    ["http 301", { status: 301 }, "transient"],
    ["http 302", { status: 302 }, "transient"],
    ["http 307", { status: 307 }, "transient"],
    ["http 399", { status: 399 }, "transient"],
    ["opaqueredirect (status 0)", { status: 0 }, "transient"],
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
    test(name, () =>
      assert.equal(
        classifyUpstreamAttempt(
          input as unknown as Parameters<typeof classifyUpstreamAttempt>[0],
        ),
        expected,
      ),
    );
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
    assert.equal(unsafeEndpoint!.id, "u");
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

describe("circuit breaker", () => {
  test("ejects after 3 consecutive failures, half-opens after cooldown", () => {
    const map = new Map();
    recordRpcFailure(map, "a", 1000);
    recordRpcFailure(map, "a", 1000);
    assert.equal(isRpcEndpointEjected(map, "a", 1000), false);
    recordRpcFailure(map, "a", 1000);
    assert.equal(isRpcEndpointEjected(map, "a", 1000), true);
    assert.equal(isRpcEndpointEjected(map, "a", 1000 + 31_000), false);
  });

  test("failures during ejection do not extend the cooldown", () => {
    const map = new Map();
    for (let i = 0; i < 3; i += 1) recordRpcFailure(map, "a", 0);
    assert.equal(isRpcEndpointEjected(map, "a", 0), true);
    recordRpcFailure(map, "a", 1000);
    assert.equal(isRpcEndpointEjected(map, "a", 31_000), false);
  });

  test("success clears breaker state", () => {
    const map = new Map();
    for (let i = 0; i < 3; i += 1) recordRpcFailure(map, "a", 0);
    assert.equal(isRpcEndpointEjected(map, "a", 0), true);
    recordRpcSuccess(map, "a");
    assert.equal(isRpcEndpointEjected(map, "a", 0), false);
  });

  test("ordering deprioritises an ejected endpoint to the back", () => {
    const map = new Map();
    for (let i = 0; i < 3; i += 1) recordRpcFailure(map, "a", 0);
    const { endpoints } = orderSafeRpcEndpoints(
      { endpoints: [ep("a", SAFE_A), ep("b", SAFE_B)] },
      () => 0,
      { healthMap: map, now: 0 },
    );
    assert.deepEqual(
      endpoints.map((e) => e.id),
      ["b", "a"],
    );
  });

  test("a fully-ejected pool still returns all endpoints (half-open)", () => {
    const map = new Map();
    for (const id of ["a", "b"])
      for (let i = 0; i < 3; i += 1) recordRpcFailure(map, id, 0);
    const { endpoints } = orderSafeRpcEndpoints(
      { endpoints: [ep("a", SAFE_A), ep("b", SAFE_B)] },
      () => 0,
      { healthMap: map, now: 0 },
    );
    assert.equal(endpoints.length, 2);
  });
});

describe("proxyWithFailover", () => {
  const base = { bodyText: "{}", poolId: "finney-rpc", healthMap: new Map() };

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

  test("treats an upstream 3xx as a failed attempt and never follows the redirect", async () => {
    // A trusted upstream replies 302 with a Location to an off-allowlist host.
    // With redirect:"manual" the fetch surfaces the 3xx itself; the proxy must
    // NOT accept or follow it — it fails over to the next allowlisted endpoint
    // and never re-POSTs the caller's body to the redirect target.
    const fetchFn = scriptedFetch(
      { status: 302, headers: new Headers({ location: UNSAFE }), body: null },
      jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
    assert.equal(res.headers.get("x-metagraph-rpc-attempts"), "2");
    // Only the two allowlisted endpoints were contacted — never the redirect
    // target (the deepEqual is exact, so it proves UNSAFE was not fetched; an
    // `.includes(UNSAFE)` substring check would trip CodeQL's
    // incomplete-url-substring-sanitization rule and is redundant here).
    assert.deepEqual(fetchFn.calls, [SAFE_A, SAFE_B]);
    // The security property itself: the upstream fetch pins redirect:"manual" so
    // the platform never auto-follows a 3xx (without this, the body would be
    // re-POSTed to the off-allowlist Location). Guards against the option being
    // dropped in a future refactor.
    assert.equal(fetchFn.inits[0]?.redirect, "manual");
  });

  test("treats an opaqueredirect (status 0) as a failed attempt", async () => {
    const fetchFn = scriptedFetch(
      { status: 0, body: null }, // opaqueredirect sentinel from redirect:"manual"
      jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
    assert.deepEqual(fetchFn.calls, [SAFE_A, SAFE_B]);
  });

  test("returns 502 when every upstream redirects (body never re-POSTed off-allowlist)", async () => {
    const fetchFn = scriptedFetch(
      { status: 302, headers: new Headers({ location: UNSAFE }), body: null },
      { status: 0, body: null },
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 502);
    // Both allowlisted endpoints tried; neither redirect was followed (the
    // exact deepEqual proves UNSAFE was not fetched without a URL-substring
    // check).
    assert.deepEqual(fetchFn.calls, [SAFE_A, SAFE_B]);
  });

  test("fails over on HTTP 5xx without reading its response body", async () => {
    let reads = 0;
    let canceled = false;
    const transientBody = new ReadableStream({
      pull(controller: ReadableStreamDefaultController) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode("large upstream error"));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchFn = scriptedFetch(
      new Response(transientBody, { status: 503 }),
      jsonResponse(200, { result: 1 }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
    assert.ok(reads <= 1);
    assert.equal(canceled, true);
  });

  test("fails over when a 2xx upstream body errors during inspection", async () => {
    const healthMap = new Map();
    const brokenBody = new ReadableStream({
      pull(controller: ReadableStreamDefaultController) {
        controller.error(new Error("upstream reset"));
      },
    });
    const fetchFn = scriptedFetch(
      new Response(brokenBody, { status: 200 }),
      jsonResponse(200, { result: 1 }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      ...base,
      fetchFn,
      healthMap,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
    assert.equal(res.headers.get("x-metagraph-rpc-attempts"), "2");
    assert.equal(healthMap.get("a").fails, 1);
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

  test("streams oversized successful responses instead of buffering them", async () => {
    const chunk = new TextEncoder().encode("x".repeat(70 * 1024));
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller: ReadableStreamDefaultController) {
        pulls += 1;
        if (pulls <= 2) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
    });
    const fetchFn = scriptedFetch(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await proxyWithFailover([ep("a", SAFE_A)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "a");
    assert.equal((await res.arrayBuffer()).byteLength, chunk.byteLength * 2);
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
    assert.equal(((await res.json()) as Row).error.code, -32601);
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
    const body = (await res.json()) as Row;
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
