// A route that declares filters must reject a parameter it does not declare.
//
// The bug this exists to stop (#9149): `/api/v1/chain-events` declared eight
// query parameters and silently accepted anything else, so a typo'd filter name
// returned the UNFILTERED feed as a 200.
//
//   ?pallet=Balances                -> pallets: ["Balances"]
//   ?palet=Balances                 -> pallets: ["System","TransactionPayment"]
//   ?pallet=Balances&methd=Transfer -> every Balances event, not just Transfers
//
// The third is the dangerous one: one filter lands and the other is dropped, so
// the response looks filtered. Same silent-wrong-answer class as #9118's
// client-side truncation -- no error, no empty result, just a plausible answer
// to a question nobody asked.
//
// 136 routes already rejected unknown params; two did not. This makes the rule
// uniform and derived, so route 137 cannot land without it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  declaredQueryParams,
  validateDeclaredQueryParams,
} from "../workers/request-handlers/analytics.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";

/**
 * Path-parameter fixtures, so a template can be resolved the way a real
 * pathname is. `compileRoutePattern`'s character classes are strict -- an ss58
 * will not match a `{netuid}` slot -- so these have to be the real shapes.
 */
const PATH_FIXTURES: Record<string, string> = {
  "{netuid}": "1",
  "{ss58}": "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  "{hotkey}": "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  "{ref}": "1000000",
  "{uid}": "0",
  "{slug}": "academia",
  "{date}": "2026-08-01",
  "{tag}": "inference",
  "{surface_id}": "sn-1-apex-healthcheck",
  "{hash}": `0x${"0".repeat(64)}`,
  "{h160}": `0x${"0".repeat(40)}`,
  "{id}": "00000000-0000-0000-0000-000000000000",
  "{crowdloan_id}": "0",
};

function urlFor(path: string, search = ""): URL {
  return new URL(`https://api.metagraph.sh${path}${search}`);
}

describe("declared query parameters are the allow-list (#9149)", () => {
  test("the allow-list is read from the contract, not written out", () => {
    // Derivation is the point: a parameter added to API_ROUTES is accepted the
    // day it lands, so there is no second copy to drift the way #9127's
    // ceiling did.
    const declared = declaredQueryParams("/api/v1/chain-events");
    assert.ok(declared, "chain-events declares query params");
    for (const name of ["pallet", "method", "block", "cursor", "limit"]) {
      assert.ok(
        declared.includes(name),
        `${name} is declared in the contract but missing from the allow-list`,
      );
    }
  });

  test("a typo'd filter name is rejected, naming the parameter", () => {
    const error = validateDeclaredQueryParams(
      urlFor("/api/v1/chain-events", "?palet=Balances"),
    );
    assert.ok(error, "an unknown parameter must be rejected, not ignored");
    assert.equal(error.parameter, "palet");
    assert.match(error.message, /not supported/i);
  });

  test("a partially-typo'd filter set is rejected too", () => {
    // The case that looks correct: `pallet` lands, `methd` is dropped, and the
    // caller sees Balances events and believes they are Transfers.
    const error = validateDeclaredQueryParams(
      urlFor("/api/v1/chain-events", "?pallet=Balances&methd=Transfer"),
    );
    assert.ok(error, "a dropped second filter must not pass silently");
    assert.equal(error.parameter, "methd");
  });

  test("every declared parameter still passes", () => {
    // The other direction. A validator that rejected real parameters would
    // break the route far more visibly than the bug it replaced -- and a
    // too-strict validator is worse than a too-loose one.
    const declared = declaredQueryParams("/api/v1/chain-events") ?? [];
    for (const name of declared) {
      const error = validateDeclaredQueryParams(
        urlFor("/api/v1/chain-events", `?${name}=1`),
      );
      assert.equal(
        error,
        null,
        `${name} is declared in the contract but the validator rejected it`,
      );
    }
  });

  test("format is accepted even where a route does not declare it", () => {
    // /api/v1/chain-events/stats is an aggregate with no row array, so
    // ?format=csv deliberately falls through to the JSON envelope rather than
    // producing a bogus export -- tested in worker-runtime.test.ts. Rejecting
    // it would break a documented contract to guard against a typo that cannot
    // silently change a result; the harm this file exists for is a dropped
    // FILTER, and format is not one.
    assert.equal(
      validateDeclaredQueryParams(
        urlFor("/api/v1/chain-events/stats", "?blocks=500&format=csv"),
      ),
      null,
      "format must stay accepted where its no-op is deliberate",
    );
    // But the exemption is exactly one parameter wide -- a typo next to it is
    // still caught.
    const error = validateDeclaredQueryParams(
      urlFor("/api/v1/chain-events/stats", "?blocks=500&format=csv&blcks=9"),
    );
    assert.ok(error, "the exemption must not disable checking of other params");
    assert.equal(error.parameter, "blcks");
  });

  test("a route that declares nothing accepts nothing but format", () => {
    // This flipped with #10065. `declaredQueryParams` used to answer `null`
    // for a param-less route -- "no opinion" -- so the check passed anything.
    // "This route takes no query parameters" is a statement the contract
    // makes, and 15 handlers were separately enforcing it with a hand-written
    // `validateQueryParams(url, [])`. Deriving it means the two cannot
    // disagree; `null` is now reserved for a path that matches no route.
    const paramless = (
      API_ROUTES as unknown as {
        path: string;
        method: string;
        query_parameters?: unknown[];
      }[]
    ).find(
      (route) =>
        route.method === "GET" &&
        !(route.query_parameters ?? []).length &&
        !route.path.includes("{"),
    );
    assert.ok(paramless, "expected at least one param-less GET route");
    assert.deepEqual(declaredQueryParams(paramless.path), []);
    const rejected = validateDeclaredQueryParams(
      urlFor(paramless.path, "?anything=1"),
    );
    assert.ok(rejected, `${paramless.path} must reject an undeclared param`);
    assert.equal(rejected.parameter, "anything");
    // `format` stays accepted API-wide -- see GLOBALLY_ACCEPTED_PARAMS.
    assert.equal(
      validateDeclaredQueryParams(urlFor(paramless.path, "?format=csv")),
      null,
    );
  });

  test("an unrouted path is not silently treated as allow-nothing", () => {
    // Guards the guard. If the lookup missed (a renamed path, a trailing
    // slash), returning "no declared params" is the safe answer -- but it must
    // be reached by the route genuinely having none, not by a failed match
    // that would quietly disable validation everywhere.
    assert.equal(declaredQueryParams("/api/v1/does-not-exist"), null);
    assert.equal(
      validateDeclaredQueryParams(urlFor("/api/v1/does-not-exist", "?x=1")),
      null,
    );
    const declared = declaredQueryParams("/api/v1/chain-events");
    assert.ok(
      declared && declared.length >= 8,
      "the real route must resolve, or every lookup is failing open",
    );
  });

  test("every GET route rejects an undeclared parameter", () => {
    // #9149 built the derived check and wired it at ONE call site; 119
    // handlers went on passing hand-written arrays, and this test said so in
    // its own comment -- "it does NOT prove each route calls it". #10065
    // deleted the arrays and moved the check into handleRequest, so the
    // wiring is a property of the router rather than of 119 opt-ins, and this
    // can assert the real thing: a CONCRETE pathname, resolved the way a
    // request is, for every route.
    const unprotected: string[] = [];
    let checked = 0;
    for (const route of API_ROUTES as unknown as {
      path: string;
      method: string;
    }[]) {
      if (route.method !== "GET") continue;
      let path = route.path;
      for (const [token, value] of Object.entries(PATH_FIXTURES)) {
        path = path.split(token).join(value);
      }
      if (/\{[a-z_0-9]+\}/.test(path)) {
        unprotected.push(`${route.path} (no fixture for its path parameter)`);
        continue;
      }
      checked += 1;
      const error = validateDeclaredQueryParams(
        urlFor(path, "?__definitely_not_a_param=1"),
      );
      if (!error) unprotected.push(route.path);
    }
    assert.deepEqual(
      unprotected,
      [],
      "these would accept an unknown parameter, so a typo returns unfiltered " +
        `data: ${unprotected.join(", ")}`,
    );
    assert.ok(checked > 195, `only ${checked} routes were reachable`);
  });

  test("every GET route rejects an undeclared parameter THROUGH THE ROUTER", async () => {
    // The check above proves the derived rule; this proves the WIRING, which
    // is the half #9149 could not assert and said so. A full dispatch through
    // `handleRequest` + `createLocalArtifactEnv()` -- the same in-process seam
    // the CSV-parity gate uses -- so a route reaches its 400 the way a real
    // request would, not because a helper was called in a unit test.
    //
    // This replaces 55 per-handler "rejects an unsupported query param" tests.
    // They asserted the same property one handler at a time while the rule
    // lived in 119 hand-written arrays; with one enforcement point, asserting
    // it once for every route is both stronger and honest about where it
    // lives.
    const env = await createLocalArtifactEnv();
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const accepted: string[] = [];
    let dispatched = 0;
    for (const route of API_ROUTES as unknown as {
      path: string;
      method: string;
    }[]) {
      if (route.method !== "GET") continue;
      let path = route.path;
      for (const [token, value] of Object.entries(PATH_FIXTURES)) {
        path = path.split(token).join(value);
      }
      if (/\{[a-z_0-9]+\}/.test(path)) continue;
      dispatched += 1;
      const response = await handleRequest(
        new Request(
          `https://api.metagraph.sh${path}?__definitely_not_a_param=1`,
        ),
        env as never,
        ctx as never,
      );
      if (response.status !== 400)
        accepted.push(`${route.path} -> ${response.status}`);
    }
    assert.deepEqual(
      accepted,
      [],
      `these accepted an undeclared parameter: ${accepted.join(", ")}`,
    );
    assert.ok(dispatched > 195, `only ${dispatched} routes dispatched`);
  }, 120_000);
});
