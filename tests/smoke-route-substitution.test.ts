import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { API_ROUTES } from "../src/contracts.ts";
import {
  apiRouteUrl,
  assertX402Challenge,
  fixtureSurfaceIdFromIndex,
  isTimeout,
  liveSmokeApiRoutes,
  liveSmokePaymentRoutes,
  timeoutMs,
} from "../scripts/smoke-live-api.ts";
import { QUERY_TIMEOUT_MS } from "../src/r2-sql.ts";

// PR-time guard for the recurring #1682 class: the live smoke substitutes path
// placeholders ({netuid}/{slug}/{date}/{uid}/{hash}/{ref}/{ss58}) before
// fetching. A route that grows a new placeholder without a matching
// substitution would otherwise only blow up at publish time. Assert that
// apiRouteUrl yields a fully-substituted URL for every registered route.
describe("smoke route substitution", () => {
  const sampleDate = "2026-06-24";

  for (const route of API_ROUTES) {
    test(`${route.path} has no leftover placeholder`, () => {
      const url = apiRouteUrl(route.path, sampleDate);
      assert.ok(
        !url.includes("{"),
        `${route.path}: apiRouteUrl left an unsubstituted placeholder (${url})`,
      );
    });
  }

  // REGRESSION: /api/v1/compare/validators requires `hotkeys` -- a bare GET is
  // a 400 invalid_query, not a route failure (same #1682 class as
  // /api/v1/compare's `netuids` and stake-quote's `amount`, confirmed live
  // against production: the smoke step failed with "hotkeys is required" until
  // this special-case was added).
  test("/api/v1/compare/validators URL includes a hotkeys query param", () => {
    const url = new URL(apiRouteUrl("/api/v1/compare/validators", sampleDate));
    assert.ok(
      url.searchParams.get("hotkeys"),
      "expected apiRouteUrl to set a hotkeys query param for /api/v1/compare/validators",
    );
  });

  test("fixture detail live smoke is included when a surface id is available", () => {
    assert.equal(
      liveSmokeApiRoutes(null).some((route) => route.id === "fixture-detail"),
      false,
    );
    assert.equal(
      liveSmokeApiRoutes("7:subnet-api:new_v2").some(
        (route) => route.id === "fixture-detail",
      ),
      true,
    );
  });

  test("fixture detail URL uses the discovered surface id", () => {
    const url = apiRouteUrl("/api/v1/fixtures/{surface_id}", sampleDate, {
      surfaceId: "91:subnet-api:live_v1",
    });
    assert.equal(
      new URL(url).pathname,
      "/api/v1/fixtures/91:subnet-api:live_v1",
    );
  });

  test("fixture detail live smoke can derive a surface id from the fixture index", () => {
    assert.equal(
      fixtureSurfaceIdFromIndex({
        data: {
          fixtures: [{ surface_id: "7:subnet-api:new_v2" }],
        },
      }),
      "7:subnet-api:new_v2",
    );
    assert.equal(fixtureSurfaceIdFromIndex({ data: { fixtures: [] } }), null);
  });
});

describe("the live smoke set is GET-only (#9650)", () => {
  test("no route with a body is smoked", () => {
    // Every check in the runner asserts a CACHEABLE READ CONTRACT -- 200, CORS,
    // an ETag, a contract-version header -- so a route with a request body has
    // nothing the assertions are about. The runner fetches with a plain GET, so
    // including one draws 405 and fails the whole publish lane.
    //
    // This is not hypothetical. Until #9101 registered /api/v1/ask as POST,
    // every route in the contract was a GET, so "all routes" and "the read
    // surface" were the same set. Publishing broke on 2026-08-02 and stayed
    // broken for four days, taking `webhooks:dispatch` -- later in the same
    // job -- with it.
    for (const route of liveSmokeApiRoutes("7:subnet-api:new_v2")) {
      assert.equal(
        route.method ?? "GET",
        "GET",
        `${route.path} is ${route.method}; the smoke runner only issues GET`,
      );
    }
  });

  test("and the contract does still carry a non-GET route, or this proves nothing", () => {
    // A filter with nothing to filter passes forever. Assert the input set
    // really does contain the case being excluded.
    assert.equal(
      API_ROUTES.some((route) => (route.method ?? "GET") !== "GET"),
      true,
      "no non-GET route in the contract -- this guard is now vacuous",
    );
    assert.equal(
      liveSmokeApiRoutes("7:subnet-api:new_v2").length < API_ROUTES.length,
      true,
      "the smoke set must be strictly smaller than the contract",
    );
  });
});

describe("payment-required routes stay in the live smoke (#11736)", () => {
  const fixture = "7:subnet-api:new_v2";
  const exportPath = "/api/v1/export/chain-events";

  test("required-payment GETs are separated from the free 200 sweep", () => {
    const publicRoutes = liveSmokeApiRoutes(fixture);
    const paymentRoutes = liveSmokePaymentRoutes(fixture);
    assert.equal(
      publicRoutes.some((route) => route.path === exportPath),
      false,
    );
    assert.equal(
      paymentRoutes.some((route) => route.path === exportPath),
      true,
    );

    const expected = API_ROUTES.filter(
      (route) =>
        (route.method ?? "GET") === "GET" &&
        !["webhook-subscription", "alert-trigger"].includes(route.id),
    )
      .map((route) => route.id)
      .sort();
    const actual = [...publicRoutes, ...paymentRoutes]
      .map((route) => route.id)
      .sort();
    assert.deepEqual(
      actual,
      expected,
      "a GET route disappeared while the smoke set was partitioned",
    );
  });

  test("accepts a complete production-shaped x402 challenge", () => {
    const url = `https://api.metagraph.sh${exportPath}`;
    const body = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url,
        description: "metagraphed export call",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "24000",
          asset: "0xasset",
          payTo: "0xrecipient",
          maxTimeoutSeconds: 60,
        },
      ],
      extensions: {},
    };
    const headers = new Headers({
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    });

    assert.doesNotThrow(() =>
      assertX402Challenge(exportPath, url, { body, headers, status: 402 }),
    );
  });

  test("rejects a missing or malformed payment challenge", () => {
    const url = `https://api.metagraph.sh${exportPath}`;
    const body = {
      x402Version: 2,
      resource: { url, mimeType: "application/json" },
      accepts: [],
    };
    const headers = new Headers({
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });

    assert.throws(
      () =>
        assertX402Challenge(exportPath, url, { body, headers, status: 402 }),
      /missing payment-required challenge header/,
    );

    headers.set(
      "payment-required",
      Buffer.from(JSON.stringify(body)).toString("base64"),
    );
    assert.throws(
      () =>
        assertX402Challenge(exportPath, url, { body, headers, status: 402 }),
      /at least one payment leg/,
    );
  });
});

describe("the live smoke supplies every required query param (#9663)", () => {
  // Routes whose bare GET is a correct 400. The smoke iterates the whole
  // contract, so each one has to be given what it requires or the publish lane
  // fails on a route that is working exactly as designed.
  //
  // The contract does not declare requiredness, so this list cannot be derived
  // -- which is why it is asserted here instead: each entry was found by a
  // failing production publish, one per run, and this is what stops the next
  // one being found the same way.
  const REQUIRES = [
    ["/api/v1/compare", "netuids"],
    ["/api/v1/compare/validators", "hotkeys"],
    ["/api/v1/subnets/{netuid}/stake-quote", "amount"],
    ["/api/v1/search/semantic", "q"],
  ] as const;

  test("each known required param is present in the built URL", () => {
    for (const [routePath, param] of REQUIRES) {
      const url = new URL(apiRouteUrl(routePath, "2026-08-06"));
      assert.ok(
        url.searchParams.get(param),
        `${routePath} needs ?${param}= or it answers 400`,
      );
    }
  });

  test("every route in the smoke set is one the contract still has", () => {
    // A required-param entry for a route that no longer exists is a guard that
    // silently stops guarding.
    const paths = new Set(API_ROUTES.map((route) => route.path));
    for (const [routePath] of REQUIRES) {
      assert.ok(paths.has(routePath), `${routePath} is no longer a route`);
    }
  });
});

describe("the entry point runs after every declaration", () => {
  // WHY THE 214 TESTS ABOVE CANNOT CATCH THIS. They all import
  // scripts/smoke-live-api.ts and call liveSmokeApiRoutes -- and importing a
  // module RUNS IT TO COMPLETION first, so by the time any of them calls
  // anything, every `const` is initialised. The hazard is the opposite order:
  // the script invokes runLiveSmoke at MODULE SCOPE, so it executes while
  // later declarations are still in their temporal dead zone.
  //
  // On 2026-08-08 that killed the production publish gate for two days.
  // `CALLER_OWNED_ROUTE_IDS` was declared at line 646 and read at 622, and the
  // run died with `ReferenceError: Cannot access ... before initialization` on
  // every attempt. These 214 tests were green throughout, and the retry wrapper
  // reported it as "edge cache may still be revalidating".
  //
  // MY FIRST ATTEMPT AT THIS TEST WAS VACUOUS and is worth recording. It
  // spawned the script against a closed port and asserted the output carried no
  // ReferenceError -- which passed on the BROKEN file, because the first thing
  // runLiveSmoke does is a network call, and pointing at a dead host makes it
  // throw long before it reaches the line that would have crashed. A subprocess
  // that reproduces the bug needs the network to WORK, which is not a unit test.
  //
  // So this asserts the STRUCTURE instead: the invocation must come after the
  // last top-level declaration. That is the invariant the fix established, it
  // is checkable without running anything, and it fails on the broken file.
  const source = readFileSync("scripts/smoke-live-api.ts", "utf8");

  test("the invocation is below every top-level const and let", () => {
    const call = source.indexOf("await runLiveSmoke()");
    assert.notEqual(call, -1, "the entry-point call was not found -- renamed?");

    const declarations = [...source.matchAll(/^(?:const|let) \w+/gm)];
    // Anchored on the one that actually broke, not only on a count. Four is
    // the real number today and a bare `>= 4` would survive the scan silently
    // matching something else; requiring CALLER_OWNED_ROUTE_IDS by name ties
    // this to the incident it exists for.
    assert.ok(
      declarations.some((d) => d[0].includes("CALLER_OWNED_ROUTE_IDS")),
      `the scan did not find CALLER_OWNED_ROUTE_IDS among ${declarations.length} ` +
        `top-level declarations -- it stopped working, so this assertion is ` +
        `passing on nothing`,
    );
    const last = declarations[declarations.length - 1]!;
    assert.ok(
      call > last.index,
      `\`await runLiveSmoke()\` is at ${call} but a top-level declaration ` +
        `(${last[0]}) is at ${last.index}. Everything below the call is in its ` +
        `temporal dead zone when it runs -- move the call to the foot of the ` +
        `file, not the declaration up.`,
    );
  });
});

describe("the smoke client outlasts the server it is waiting on (#11131)", () => {
  test("THE CLIENT BUDGET EXCEEDS THE SERVER'S OWN QUERY CEILING", () => {
    // The bug this pins: both were 15000. A request that hit the lakehouse
    // ceiling could never be seen answering -- the server needs its full
    // QUERY_TIMEOUT_MS plus response overhead to produce the degraded card, and
    // the client aborted at exactly that instant. 4 of the last 11 completed
    // production publishes failed that way, every one on a route already listed
    // in check-operation-latency's DECLARED register.
    assert.ok(
      timeoutMs > QUERY_TIMEOUT_MS,
      `smoke client ${timeoutMs}ms must outlast the r2-sql ceiling ${QUERY_TIMEOUT_MS}ms`,
    );
  });

  test("it is derived from the server constant, not restated", () => {
    // Equal-by-coincidence is what broke; a hand-copied larger number would
    // drift the same way the next time the server bound moves.
    assert.equal(timeoutMs, QUERY_TIMEOUT_MS * 2);
  });

  test("isTimeout matches an abort however the runtime words it", () => {
    for (const message of [
      "The operation was aborted due to timeout",
      "This operation was aborted",
      "TimeoutError: signal timed out",
    ]) {
      assert.equal(isTimeout(message), true, message);
    }
  });

  test("isTimeout does NOT swallow a wrong answer", () => {
    // The whole point of counting the two kinds separately: a schema failure
    // must not be reported as "the routes did not answer in time".
    for (const message of [
      "expected meta payload",
      "unexpected status 500",
      "expected 200, got 404",
    ]) {
      assert.equal(isTimeout(message), false, message);
    }
  });
});
