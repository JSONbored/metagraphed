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
import { z } from "zod";
import { API_ROUTES } from "../src/contracts.ts";
import {
  canonicalAccountsListCachePath,
  canonicalGlobalValidatorsCachePath,
  canonicalTopHoldersCachePath,
} from "../workers/request-handlers/entities.ts";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
} from "../workers/request-params.ts";
import {
  ACCOUNTS_LIST_LIMIT_MAX,
  BULK_HEALTH_TRENDS_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_TURNOVER_LIMIT_MAX,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  MOVERS_LIMIT_MAX,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  TOP_HOLDERS_LIMIT_MAX,
} from "../src/route-limits.ts";
import { TOP_HOLDERS_SORTS } from "../src/top-holders.ts";
import {
  BulkHealthTrendsQuerySchema,
  HEALTH_TREND_WINDOW_VALUES,
} from "../schemas-src/routes/health-surfaces.ts";
import { HEALTH_TREND_WINDOWS } from "../workers/config.ts";

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
  // #9128: the PROFILE-backed feed routes. These have no per-route constant --
  // they take a shared pagination profile -- which is exactly why they were
  // missed here and why the drift went unnoticed: the account feeds declared
  // 1000 while the upstream Postgres tier silently served 200, so a client
  // paginating on the declared ceiling skipped 800 rows per page with a 200 OK
  // every time. That tier is gone and the ceilings agree again; these entries
  // are what keeps them agreeing.
  //
  // Listed with the profile's own maxLimit rather than a literal, so changing
  // FEED_PAGINATION re-points the assertion instead of silently passing.
  "/api/v1/accounts/{ss58}/extrinsics": FEED_PAGINATION.maxLimit,
  "/api/v1/accounts/{ss58}/transfers": FEED_PAGINATION.maxLimit,
  "/api/v1/extrinsics": BLOCK_PAGINATION.maxLimit,
  "/api/v1/blocks": BLOCK_PAGINATION.maxLimit,
  // #10089: this one did not merely publish the WRONG ceiling, it published
  // no ceiling at all -- `limit` and `offset` were `{"type":"string"}` while
  // handleBulkHealthTrends has always run parseLimitParam/
  // parseNonNegativeIntParam over them. `declaredMaximum` returns undefined
  // for a string schema, so this entry alone would have caught it.
  "/api/v1/health/trends": BULK_HEALTH_TRENDS_LIMIT_MAX,
};

interface ParameterSchema {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

interface Route {
  path: string;
  method: string;
  description?: string;
  query_parameters?: { name: string; schema?: ParameterSchema }[];
}

function route(path: string): Route {
  const found = (API_ROUTES as unknown as Route[]).find(
    (r) => r.path === path && r.method === "GET",
  );
  assert.ok(found, `no GET route ${path} in API_ROUTES`);
  return found;
}

function declaredParameter(
  path: string,
  name: string,
): ParameterSchema | undefined {
  return (route(path).query_parameters ?? []).find((q) => q.name === name)
    ?.schema;
}

function declaredMaximum(path: string): number | undefined {
  return declaredParameter(path, "limit")?.maximum;
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

// ── The same defect, on the parameter's TYPE and its enum (#10089) ──────────
//
// The block above is about one number. These are the other two ways a
// published parameter can contradict the handler, and both were live:
//
//   TYPE   /api/v1/health/trends published `limit`/`offset` as
//          `{"type":"string"}`. `?limit=abc` has always been a 400.
//   ENUM   /api/v1/accounts/top-holders published three of the six values in
//          TOP_HOLDERS_SORTS. The route's own 400 names all six, and the three
//          it omitted are the LIVE tier -- so a generated client could reach
//          only the rankings that may be serving a fixed 2026-08-02
//          materialization, and not the ones recomputed daily.
//
// Both are read from the owning module rather than restated here, for the
// reason the file exists: a third copy is how the first two drifted.

describe("a route's published parameter TYPE is the one it parses (#10089)", () => {
  test("/api/v1/health/trends publishes bounded integers, not strings", () => {
    const limit = declaredParameter("/api/v1/health/trends", "limit");
    const offset = declaredParameter("/api/v1/health/trends", "offset");
    assert.equal(
      limit?.type,
      "integer",
      "handleBulkHealthTrends runs parseLimitParam over `limit`, so a " +
        'published `{"type":"string"}` documents a request the route rejects',
    );
    assert.equal(limit?.minimum, 1);
    assert.equal(limit?.maximum, BULK_HEALTH_TRENDS_LIMIT_MAX);
    assert.equal(offset?.type, "integer");
    assert.equal(offset?.minimum, 0);
    // No ceiling on purpose: parseNonNegativeIntParam enforces none, and
    // publishing one we do not apply is this file's whole subject inverted.
    assert.equal(offset?.maximum, undefined);
  });

  test("the schemas-src query schema agrees with the enforced ceiling", () => {
    // BulkHealthTrendsQuerySchema is the one route query schema runtime code
    // imports (src/bulk-health-trends.ts). schemas-src is a leaf and cannot
    // import route-limits.ts, so this is where the two meet.
    const emitted = z.toJSONSchema(BulkHealthTrendsQuerySchema, {
      target: "draft-2020-12",
      io: "input",
    }) as { properties: Record<string, ParameterSchema> };
    assert.equal(
      emitted.properties.limit.maximum,
      BULK_HEALTH_TRENDS_LIMIT_MAX,
    );
    assert.equal(emitted.properties.limit.minimum, 1);
    assert.equal(emitted.properties.offset.minimum, 0);
  });

  test("the published window vocabulary is the runtime's", () => {
    // The cross-check schemas-src/routes/health-surfaces.ts has claimed since
    // #9981 and that did not exist until #10089. The two agreed by luck.
    assert.deepEqual(
      [...HEALTH_TREND_WINDOW_VALUES].sort(),
      Object.keys(HEALTH_TREND_WINDOWS).sort(),
      "the published window labels and workers/config.ts's day-count map name " +
        "different windows, so one of them describes a route that does not exist",
    );
  });
});

describe("a route's published enum is the one it accepts (#10089)", () => {
  test("/api/v1/accounts/top-holders publishes every sort it serves", () => {
    assert.deepEqual(
      declaredParameter("/api/v1/accounts/top-holders", "sort")?.enum,
      TOP_HOLDERS_SORTS,
      "the published enum must BE TOP_HOLDERS_SORTS -- it listed only the " +
        "three holdings sorts, hiding net_flow_7d/30d/90d, which are the " +
        "ones that cannot go stale",
    );
  });

  test("the three flow sorts are specifically reachable", () => {
    // Named rather than left to the deepEqual: these are the ones that were
    // missing, and #9469 makes them the only sorts guaranteed to be live.
    const published = declaredParameter(
      "/api/v1/accounts/top-holders",
      "sort",
    )?.enum;
    for (const sort of ["net_flow_7d", "net_flow_30d", "net_flow_90d"]) {
      assert.ok(
        published?.includes(sort),
        `${sort} is served but unpublished, so a client generated from ` +
          "openapi.json cannot reach the live tier",
      );
    }
  });
});
