// What a route publishes as its `limit` ceiling must be what it enforces.
//
// The bug this exists to stop (#9127): /api/v1/validators enforced a maximum of
// 2000 and its OpenAPI declared 100. #8251 raised the runtime ceiling so the
// validators directory could fetch the full set in one request, and moved only
// the constant. Nothing failed -- the number was stated in three places (the
// enforcement constant, the contract's schema `maximum`, and the "(default N,
// max M)" prose) with nothing tying them together, so two of the three went
// stale in silence. The result was a published spec under which our OWN site's
// SSR fetch (`?limit=2000`) was invalid: a client generated from openapi.json
// rejected it at build time.
//
// ── Derived, with a declared pairing ────────────────────────────────────────
//
// Both VALUES are read from source -- the constant from route-limits.ts, the
// maximum off the live contract -- so neither side can be edited alone. Which
// constant backs which route cannot be derived (it is a judgement about what a
// route is for), so the pairing is declared here and proven in both directions:
// a route that loses its declaration fails, and so does a constant that stops
// being reachable from its route.
//
// Same split as the field-provenance and UI-filter-parity guards: derive the
// facts, declare the judgements, let the test hold them together.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { API_ROUTES } from "../src/contracts.ts";
import {
  canonicalAccountsListCachePath,
  canonicalGlobalValidatorsCachePath,
  canonicalTopHoldersCachePath,
} from "../workers/request-handlers/entities.ts";
import {
  ACCOUNTS_LIST_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_TURNOVER_LIMIT_MAX,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  MOVERS_LIMIT_MAX,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  TOP_HOLDERS_LIMIT_MAX,
} from "../src/route-limits.ts";

/** Route path -> the constant its handler enforces as the `limit` ceiling. */
const CONSTANT_BACKED: Record<string, number> = {
  "/api/v1/validators": GLOBAL_VALIDATOR_LIMIT_MAX,
  "/api/v1/subnets/movers": MOVERS_LIMIT_MAX,
  "/api/v1/chain/turnover": CHAIN_TURNOVER_LIMIT_MAX,
  "/api/v1/accounts/top-holders": TOP_HOLDERS_LIMIT_MAX,
  "/api/v1/accounts": ACCOUNTS_LIST_LIMIT_MAX,
  "/api/v1/subnets/{netuid}/event-summary":
    SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  "/api/v1/chain/identity-history": CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
};

interface Route {
  path: string;
  method: string;
  description?: string;
  query_parameters?: { name: string; schema?: { maximum?: number } }[];
}

function route(path: string): Route {
  const found = (API_ROUTES as unknown as Route[]).find(
    (r) => r.path === path && r.method === "GET",
  );
  assert.ok(found, `no GET route ${path} in API_ROUTES`);
  return found;
}

function declaredMaximum(path: string): number | undefined {
  return (route(path).query_parameters ?? []).find((q) => q.name === "limit")
    ?.schema?.maximum;
}

describe("a route's published limit ceiling is the one it enforces (#9127)", () => {
  test("every constant-backed route declares its constant as the maximum", () => {
    const mismatched = Object.entries(CONSTANT_BACKED)
      .map(([path, enforced]) => ({
        path,
        enforced,
        declared: declaredMaximum(path),
      }))
      .filter(({ enforced, declared }) => declared !== enforced);
    assert.deepEqual(
      mismatched,
      [],
      "these routes publish a limit ceiling they do not enforce, so a client " +
        "generated from openapi.json sends requests the API rejects -- or, " +
        "worse, refuses to send ones it would accept: " +
        mismatched
          .map(
            (m) => `${m.path} declares ${m.declared}, enforces ${m.enforced}`,
          )
          .join("; "),
    );
  });

  test("/api/v1/validators specifically declares the full-set ceiling", () => {
    // Named rather than left to the generic check: this is the one that broke,
    // and apps/ui's SSR path fetches ?limit=2000, so a revert to 100 makes the
    // validators directory's own request contract-invalid. A failure here
    // should say that, not just "a number differs".
    assert.equal(
      declaredMaximum("/api/v1/validators"),
      GLOBAL_VALIDATOR_LIMIT_MAX,
      "apps/ui fetches /api/v1/validators?limit=2000 on the SSR path (#8251); " +
        "declaring a lower maximum makes our own site's request invalid per " +
        "our own published spec",
    );
    assert.ok(
      GLOBAL_VALIDATOR_LIMIT_MAX >= 1035,
      "the ceiling must cover the live validator set for the directory's " +
        "single-request fetch",
    );
  });

  test("the prose repeats the ceiling rather than restating it", () => {
    // The third copy. A description saying "max 100" next to a schema saying
    // 2000 is what a model reads before deciding what to send, so it has to be
    // interpolated from the same constant -- not typed again.
    for (const [path, enforced] of Object.entries(CONSTANT_BACKED)) {
      const description = route(path).description ?? "";
      const stated = [...description.matchAll(/max (\d+)\)/g)].map((m) =>
        Number(m[1]),
      );
      for (const value of stated) {
        assert.equal(
          value,
          enforced,
          `${path}'s description says max ${value} but the route enforces ${enforced}`,
        );
      }
    }
  });

  // ── The other half: does the HANDLER enforce it? ─────────────────────────
  //
  // The checks above compare the contract to the constant, and since the
  // contract now imports that constant they move together -- true by
  // construction, which is the point of single-sourcing, but it means they can
  // only catch a maximum being hardcoded back in. They say nothing about the
  // handler. A parser that stopped consulting the constant and grew its own
  // literal would leave every check above green.
  //
  // So drive the real parsers. `canonical*CachePath` is the exported seam onto
  // them: it returns a cache path built from the PARSED values on success, and
  // an error `response` when the query is rejected -- so accepting the ceiling
  // and rejecting one past it is observable without a live Worker.
  const BEHAVIOURAL: [string, (url: URL) => unknown, number][] = [
    [
      "/api/v1/validators",
      canonicalGlobalValidatorsCachePath,
      GLOBAL_VALIDATOR_LIMIT_MAX,
    ],
    [
      "/api/v1/accounts",
      canonicalAccountsListCachePath,
      ACCOUNTS_LIST_LIMIT_MAX,
    ],
    [
      "/api/v1/accounts/top-holders",
      canonicalTopHoldersCachePath,
      TOP_HOLDERS_LIMIT_MAX,
    ],
  ];

  test("the handler accepts exactly the ceiling it publishes", () => {
    for (const [path, canonical, ceiling] of BEHAVIOURAL) {
      const result = canonical(
        new URL(`https://api.metagraph.sh${path}?limit=${ceiling}`),
      ) as { response?: unknown; cachePathAndSearch?: string };
      assert.equal(
        result.response,
        undefined,
        `${path} rejected limit=${ceiling}, the maximum it publishes`,
      );
      assert.match(
        String(result.cachePathAndSearch),
        new RegExp(`limit=${ceiling}\\b`),
        `${path} accepted limit=${ceiling} but did not parse it through -- ` +
          "a silently clamped page is the truncation this whole guard is about",
      );
    }
  });

  test("the handler rejects one past the ceiling", () => {
    for (const [path, canonical, ceiling] of BEHAVIOURAL) {
      const result = canonical(
        new URL(`https://api.metagraph.sh${path}?limit=${ceiling + 1}`),
      ) as { response?: unknown };
      assert.ok(
        result.response !== undefined,
        `${path} accepted limit=${ceiling + 1}, one past its published ` +
          "maximum -- the ceiling is documented but not enforced",
      );
    }
  });

  test("the pairing is not vacuous", () => {
    // Guards the guard. If a path in CONSTANT_BACKED were renamed away, or a
    // route stopped declaring `limit` at all, the checks above would quietly
    // compare `undefined` to nothing and keep passing.
    for (const path of Object.keys(CONSTANT_BACKED)) {
      assert.equal(
        typeof declaredMaximum(path),
        "number",
        `${path} declares no limit maximum, so its ceiling is unpublished`,
      );
    }
  });
});
