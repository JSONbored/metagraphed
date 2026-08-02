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
      "/api/v1/chain-events",
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
      "/api/v1/chain-events",
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
        "/api/v1/chain-events",
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
        "/api/v1/chain-events/stats",
      ),
      null,
      "format must stay accepted where its no-op is deliberate",
    );
    // But the exemption is exactly one parameter wide -- a typo next to it is
    // still caught.
    const error = validateDeclaredQueryParams(
      urlFor("/api/v1/chain-events/stats", "?blocks=500&format=csv&blcks=9"),
      "/api/v1/chain-events/stats",
    );
    assert.ok(error, "the exemption must not disable checking of other params");
    assert.equal(error.parameter, "blcks");
  });

  test("a route declaring no query params is left alone", () => {
    // 44 param-less detail routes accept unknown params today. Treating
    // "declares nothing" as "allows nothing" would start 400ing cache-busting
    // params on all of them for no gain -- there is no filter to typo.
    const paramless = (
      API_ROUTES as unknown as {
        path: string;
        method: string;
        query_parameters?: unknown[];
      }[]
    ).find(
      (route) =>
        route.method === "GET" && !(route.query_parameters ?? []).length,
    );
    assert.ok(paramless, "expected at least one param-less GET route");
    assert.equal(declaredQueryParams(paramless.path), null);
    assert.equal(
      validateDeclaredQueryParams(
        urlFor(paramless.path, "?anything=1"),
        paramless.path,
      ),
      null,
    );
  });

  test("an unrouted path is not silently treated as allow-nothing", () => {
    // Guards the guard. If the lookup missed (a renamed path, a trailing
    // slash), returning "no declared params" is the safe answer -- but it must
    // be reached by the route genuinely having none, not by a failed match
    // that would quietly disable validation everywhere.
    assert.equal(declaredQueryParams("/api/v1/does-not-exist"), null);
    const declared = declaredQueryParams("/api/v1/chain-events");
    assert.ok(
      declared && declared.length >= 8,
      "the real route must resolve, or every lookup is failing open",
    );
  });

  test("the derived allow-list resolves for every route that declares params", () => {
    // Scope, stated honestly: this proves the SHARED validator would reject an
    // unknown parameter for every declaring route -- i.e. the derivation
    // resolves and is not failing open on any path shape. It does NOT prove
    // each route calls it: 136 routes reach the same rule through
    // validateEntityQuery's hand-written arrays, and only the chain-events
    // proxy calls validateDeclaredQueryParams. Proving the wiring per route
    // needs a live dispatch with bindings; the empirical check is the probe in
    // #9149 (136 of 138 rejected before this change, 138 after).
    //
    // Still worth asserting: a path shape the lookup cannot resolve -- a
    // template, a trailing slash -- would silently disable validation, and
    // that is the failure this catches for route 137.
    const unprotected: string[] = [];
    for (const route of API_ROUTES as unknown as {
      path: string;
      method: string;
      query_parameters?: { name: string }[];
    }[]) {
      if (route.method !== "GET") continue;
      if (!(route.query_parameters ?? []).length) continue;
      const error = validateDeclaredQueryParams(
        urlFor(route.path, "?__definitely_not_a_param=1"),
        route.path,
      );
      if (!error) unprotected.push(route.path);
    }
    assert.deepEqual(
      unprotected,
      [],
      "these declare filters but would accept an unknown parameter, so a " +
        `typo returns unfiltered data: ${unprotected.join(", ")}`,
    );
  });
});
