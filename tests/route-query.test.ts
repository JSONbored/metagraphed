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
import { readFileSync } from "node:fs";
import type { Row } from "./row-type.ts";
import { parseFieldsParam } from "../src/field-projection.ts";
import { describe, test } from "vitest";
import { parseRouteQuery, validateRouteArgs } from "../src/route-query.ts";
import {
  API_ROUTES,
  CHAIN_STREAM_OPENAPI_PATH,
  routeQuerySchemasForPathname,
} from "../src/contracts.ts";
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

/** The first violation the router would answer with, or null. */
function queryError(url: URL) {
  const parsed = parseRouteQuery(url);
  return "error" in parsed ? parsed.error : null;
}

/** The parameter names a route declares, read off its own schema. */
function declaredQueryParams(routePath: string): string[] | null {
  const schemas = routeQuerySchemasForPathname(routePath);
  return schemas ? Object.keys(schemas.plain.shape) : null;
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
    const error = queryError(urlFor("/api/v1/chain-events", "?palet=Balances"));
    assert.ok(error, "an unknown parameter must be rejected, not ignored");
    assert.equal(error.parameter, "palet");
    assert.match(error.message, /not supported/i);
  });

  test("a partially-typo'd filter set is rejected too", () => {
    // The case that looks correct: `pallet` lands, `methd` is dropped, and the
    // caller sees Balances events and believes they are Transfers.
    const error = queryError(
      urlFor("/api/v1/chain-events", "?pallet=Balances&methd=Transfer"),
    );
    assert.ok(error, "a dropped second filter must not pass silently");
    assert.equal(error.parameter, "methd");
  });

  test("no declared parameter is rejected as UNDECLARED", () => {
    // The other direction. A check that refused real parameters would break
    // the route far more visibly than the bug it replaced.
    //
    // Only the name half is asserted here: `?cursor=1` is a legitimate 400 on
    // this route because its cursor is a `block.index` pair, and conflating
    // "this parameter does not exist" with "that value is out of range" is
    // exactly the distinction the two halves of the check exist to keep apart.
    const declared = declaredQueryParams("/api/v1/chain-events") ?? [];
    for (const name of declared) {
      const error = queryError(urlFor("/api/v1/chain-events", `?${name}=1`));
      assert.ok(
        !error?.message.includes("not supported"),
        `${name} is declared in the contract but was rejected as undeclared`,
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
      queryError(
        urlFor("/api/v1/chain-events/stats", "?blocks=500&format=csv"),
      ),
      null,
      "format must stay accepted where its no-op is deliberate",
    );
    // But the exemption is exactly one parameter wide -- a typo next to it is
    // still caught.
    const error = queryError(
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
    const rejected = queryError(urlFor(paramless.path, "?anything=1"));
    assert.ok(rejected, `${paramless.path} must reject an undeclared param`);
    assert.equal(rejected.parameter, "anything");
    // `format` stays accepted API-wide -- see GLOBALLY_ACCEPTED_PARAMS.
    assert.equal(queryError(urlFor(paramless.path, "?format=csv")), null);
  });

  test("an unrouted path is not silently treated as allow-nothing", () => {
    // Guards the guard. If the lookup missed (a renamed path, a trailing
    // slash), returning "no declared params" is the safe answer -- but it must
    // be reached by the route genuinely having none, not by a failed match
    // that would quietly disable validation everywhere.
    assert.equal(declaredQueryParams("/api/v1/does-not-exist"), null);
    assert.equal(queryError(urlFor("/api/v1/does-not-exist", "?x=1")), null);
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
      const error = queryError(urlFor(path, "?__definitely_not_a_param=1"));
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

// The VALUE half, added by #10218. Until then the router checked a parameter's
// NAME and left its value to whichever of five hand-rolled parsers the handler
// happened to call -- so `?offset=notanumber` answered 200 from row 0 on ten
// routes while `?limit=notanumber` on the same request 400'd.
//
// Every assertion below names the bound the route's own Zod schema publishes;
// none of them restates a number independently. That is the property: an
// expectation written here could only disagree with the contract by disagreeing
// with what a caller reads in openapi.json.
describe("declared query parameter VALUES are checked against the schema (#10218)", () => {
  test("a non-numeric offset is a 400, like a non-numeric limit", () => {
    // The headline defect. `offset` was clamped where `limit` was rejected, so
    // one request could have its page size refused and its starting row
    // silently moved to 0 -- and the response echoed `offset: 0` as though
    // that were what was asked for.
    const bad = queryError(
      urlFor("/api/v1/health/trends", "?offset=notanumber"),
    );
    assert.equal(bad?.parameter, "offset");
    assert.equal(
      bad?.message,
      'offset must be a non-negative integer. Received: "notanumber".',
    );
    assert.equal(
      queryError(urlFor("/api/v1/health/trends", "?offset=25")),
      null,
    );
  });

  test("an over-cap limit is refused, and the message carries the route's own ceiling", () => {
    const bad = queryError(urlFor("/api/v1/blocks", "?limit=5000"));
    assert.equal(bad?.parameter, "limit");
    assert.equal(
      bad?.message,
      'limit must be an integer between 1 and 100. Received: "5000".',
    );
    // A DIFFERENT route with a different ceiling gets its own sentence, from
    // its own schema -- the two cannot drift onto one hard-coded number.
    assert.match(
      queryError(urlFor("/api/v1/validators", "?limit=5000"))?.message ?? "",
      /between 1 and 2000\. Received: "5000"\.$/,
    );
  });

  test("limit=0 is refused rather than guessed at", () => {
    assert.equal(
      queryError(urlFor("/api/v1/blocks", "?limit=0"))?.parameter,
      "limit",
    );
  });

  test("an empty value means the parameter was not supplied, never zero", () => {
    // `Number("")` is 0, so a naive coercion turns `?netuid=` into subnet 0 --
    // a real subnet -- and `?offset=` into row 0. Both must read as absent.
    assert.equal(queryError(urlFor("/api/v1/blocks", "?limit=")), null);
    const parsed = parseRouteQuery(urlFor("/api/v1/health/trends", "?offset="));
    assert.ok(!("error" in parsed));
    // Absent, not zero -- and absent the same way an omitted key is, so a
    // reader cannot tell "sent blank" from "not sent".
    assert.equal("offset" in parsed.query, false);
  });

  test("a netuid past the u16 ceiling is a 400, not an empty result", () => {
    // 70000 names no subnet that could ever exist; answering 200 with an empty
    // list is indistinguishable from "that subnet matches nothing".
    const bad = queryError(urlFor("/api/v1/subnets", "?netuid=70000"));
    assert.equal(bad?.parameter, "netuid");
    assert.equal(
      bad?.message,
      'netuid must be an integer between 0 and 65535. Received: "70000".',
    );
    assert.equal(queryError(urlFor("/api/v1/subnets", "?netuid=65535")), null);
    assert.equal(
      queryError(urlFor("/api/v1/subnets", "?netuid=-1"))?.parameter,
      "netuid",
    );
  });

  test("an unsupported format value is refused where the route declares format", () => {
    const bad = queryError(urlFor("/api/v1/subnets", "?format=xml"));
    assert.equal(bad?.parameter, "format");
    assert.equal(
      bad?.message,
      'format must be one of: json, csv. Received: "xml".',
    );
  });

  test("a sort key the route does not offer is refused, and the message lists the ones it does", () => {
    const bad = queryError(urlFor("/api/v1/health", "?sort=kind"));
    assert.equal(bad?.parameter, "sort");
    assert.match(bad?.message ?? "", /^sort must be one of: /);
  });

  test("an enum matches case-insensitively, as the MCP tool for the same route does", () => {
    // #2073. `?status=Active` is not the mistake this boundary exists to catch,
    // and rejecting it would make REST stricter than MCP for a value both
    // understand. A genuinely invalid value still fails.
    const parsed = parseRouteQuery(urlFor("/api/v1/subnets", "?status=Active"));
    assert.ok(!("error" in parsed), JSON.stringify(parsed));
    assert.equal(parsed.query.status, "active");
    assert.equal(
      queryError(urlFor("/api/v1/subnets", "?status=Actives"))?.parameter,
      "status",
    );
  });

  test("a repeated parameter is refused rather than silently taking one of them", () => {
    const bad = queryError(urlFor("/api/v1/blocks", "?limit=5&limit=10"));
    assert.equal(bad?.parameter, "limit");
    assert.equal(bad?.message, "limit may only be provided once.");
  });

  test("the parsed value carries the DECLARED type, not the wire string", () => {
    const parsed = parseRouteQuery(urlFor("/api/v1/blocks", "?limit=25"));
    assert.ok(!("error" in parsed));
    assert.equal(parsed.query.limit, 25);
    assert.equal(typeof parsed.query.limit, "number");
  });

  test("the violation reported is the first one the CALLER wrote", () => {
    // URL order, not schema order: a message naming a parameter further along
    // the query string than the first mistake reads as though the earlier one
    // was accepted.
    assert.equal(
      queryError(urlFor("/api/v1/subnets", "?netuid=70000&limit=99999"))
        ?.parameter,
      "netuid",
    );
    assert.equal(
      queryError(urlFor("/api/v1/subnets", "?limit=99999&netuid=70000"))
        ?.parameter,
      "limit",
    );
  });
});

// The typed-JSON boundary: GraphQL resolvers hand real numbers and strings to
// the SAME schema, without the URL decoding step.
describe("GraphQL arguments are checked against the mirrored route's schema", () => {
  test("a window the route does not compute is rejected, though the SDL types it as a String", () => {
    // 90d is a real window elsewhere on the surface. The SDL cannot express
    // "this field's route only computes 7d and 30d"; the route's schema can.
    const error = validateRouteArgs("/api/v1/chain/activity", {
      window: "90d",
    });
    assert.equal(error?.parameter, "window");
    assert.equal(
      error?.message,
      'window must be one of: 7d, 30d. Received: "90d".',
    );
    assert.equal(
      validateRouteArgs("/api/v1/chain/activity", { window: "30d" }),
      null,
    );
  });

  test("an absent argument arrives as null and means 'not given'", () => {
    assert.equal(
      validateRouteArgs("/api/v1/chain/activity", { window: null }),
      null,
    );
  });

  test("no coercion: a typed surface keeps rejecting the string form of a number", () => {
    // The REST boundary accepts `?limit=20` because a URL cannot carry a
    // number. GraphQL can, so `limit: "20"` is the type error it looks like --
    // which is why the coercion is the BOUNDARY's and not the schema's.
    assert.equal(
      validateRouteArgs("/api/v1/registry/leaderboards", { limit: "20" })
        ?.parameter,
      "limit",
    );
    assert.equal(
      validateRouteArgs("/api/v1/registry/leaderboards", { limit: 20 }),
      null,
    );
  });

  test("a ceiling the SDL prints as a bare Int is still enforced", () => {
    assert.match(
      validateRouteArgs("/api/v1/registry/leaderboards", { limit: 5000 })
        ?.message ?? "",
      /^limit must be an integer between 1 and 100\. Received: "5000"\.$/,
    );
  });
});

// THE gate: every constraint the contract publishes is one the boundary
// enforces.
//
// Written this way round on purpose. The tests above pin behaviours a reader
// chose; this one is derived from `openapi.json` itself, so a parameter added
// tomorrow is covered tonight and a bound that stops being enforced fails here
// rather than being discovered by a caller.
//
// It found two while it was being written:
//
//   from / to      published `format: date` and enforced nothing -- the
//                  handler's own DAY_PATTERN check was the enforcement, and it
//                  went with the hand-rolled parsers
//   validator_permit  published `enum: ["true"]` for a filter the route has
//                  always answered `false` for
//
// Neither is a defect this change introduced; both are what a published
// constraint with no enforcement looks like from the outside, and the reason
// one source has to be the source.
describe("every published constraint is enforced (#10218)", () => {
  /** A value the parameter's own published schema forbids, or null. */
  function violating(schema: Row): string | null {
    const s = (schema.anyOf?.[0] ?? schema) as Row;
    if (Array.isArray(s.enum)) return "__not_a_declared_value__";
    if (s.type === "integer" || s.type === "number") {
      if (
        typeof s.maximum === "number" &&
        s.maximum !== Number.MAX_SAFE_INTEGER
      )
        return String(s.maximum + 1);
      if (typeof s.minimum === "number") return String(s.minimum - 1);
      return "__not_a_number__";
    }
    if (s.type === "boolean") return "__not_a_boolean__";
    if (typeof s.maxLength === "number") return "a".repeat(s.maxLength + 1);
    if (typeof s.pattern === "string") return "__not_the_declared_shape__";
    if (typeof s.format === "string") return "__not_the_declared_format__";
    return null;
  }

  /**
   * The one parameter the boundary does not check, and why.
   *
   * `fields` is enforced by `src/field-projection.ts` against the ROUTE'S OWN
   * ROWS -- it knows the thing the published pattern cannot, whether the field
   * exists, and names it. A value that violates the pattern also fails that
   * check, so nothing is unenforced; putting the syntax check in front of it
   * would only replace the better sentence with a regex. Proven below rather
   * than taken on trust, and the set must SHRINK: an entry that no longer
   * names a live exemption fails.
   */
  const CHECKED_AGAINST_THE_ROWS = new Set(["fields"]);

  /** Query parameters OUTSIDE the feed family that publish no constraint at
   * all. A ceiling, not a target: it may only ever come down. */
  const NON_FEED_UNCONSTRAINED_CEILING = 23;

  test("the one exempt parameter is enforced where it says it is", () => {
    // The SHAPE, which the published pattern also states...
    const malformed = parseFieldsParam(
      new URLSearchParams("fields=9 not a field"),
      () => [],
      "subnets",
    );
    assert.equal(malformed.error?.parameter, "fields");
    assert.match(malformed.error?.message ?? "", /comma-separated list/);

    // ...and the part the pattern CANNOT state, which is why the check lives
    // there: whether the field exists on this route's rows.
    const unknown = parseFieldsParam(
      new URLSearchParams("fields=not_a_column"),
      () => ["not_a_column"],
      "subnets",
    );
    assert.equal(unknown.error?.parameter, "fields");
  });

  test("a value each published bound forbids is rejected, on every GET route", async () => {
    const openapi = JSON.parse(
      readFileSync("public/metagraph/openapi.json", "utf8"),
    ) as Row;
    const unenforced: string[] = [];
    let checked = 0;
    let unconstrained = 0;
    // The feed family's two instants are counted separately -- see the
    // assertion below for why a lump sum cannot tell a new feed from a new gap.
    let feedInstants = 0;
    const feedPaths = new Set<string>();

    for (const [routePath, item] of Object.entries(openapi.paths as Row)) {
      const op = (item as Row).get;
      if (!op || routePath.includes("{network}")) continue;
      // #11045: the firehose's filters are deliberately NON-REJECTING -- a 400
      // permanently kills `EventSource` reconnection (the same spec behavior
      // chainFirehoseReconnect exists for), so the hub FILTERS instead of
      // erroring: unrecognized topics are dropped (all-unrecognized matches
      // nothing), a malformed netuid degrades to no filter. That enforcement
      // lives in workers/chain-firehose-hub.ts, not the route-query boundary
      // this sweep probes, and is pinned by tests/chain-firehose-hub.test.ts
      // ("drops unknown table names silently", "an all-unrecognized list
      // yields an empty Set", "absent, blank, non-integer, and negative all
      // read as unfiltered"). The published schema states the vocabulary and
      // the prose states the degrade semantics.
      if (routePath === CHAIN_STREAM_OPENAPI_PATH) continue;
      let path = routePath;
      for (const [token, value] of Object.entries(PATH_FIXTURES)) {
        path = path.split(token).join(value);
      }
      if (/\{[a-z_0-9]+\}/.test(path)) continue;
      for (const parameter of (op.parameters ?? []) as Row[]) {
        if (parameter.in !== "query") continue;
        if (CHECKED_AGAINST_THE_ROWS.has(parameter.name as string)) continue;
        const bad = violating((parameter.schema ?? {}) as Row);
        if (bad === null) {
          unconstrained += 1;
          if (
            routePath.includes("/feeds/") &&
            (parameter.name === "since" || parameter.name === "until")
          ) {
            feedInstants += 1;
            feedPaths.add(routePath);
          }
          continue;
        }
        checked += 1;
        const error = queryError(
          urlFor(path, `?${parameter.name}=${encodeURIComponent(bad)}`),
        );
        if (!error) {
          unenforced.push(
            `${routePath} ${parameter.name} accepted ${JSON.stringify(bad)}`,
          );
        }
      }
    }

    assert.ok(
      checked > 500,
      `expected to probe real bounds, checked ${checked}`,
    );
    assert.deepEqual(
      unenforced,
      [],
      "these publish a constraint the server does not enforce, so a caller " +
        "reading the contract is told a value is invalid and gets a 200 for " +
        `it:\n  ${unenforced.join("\n  ")}`,
    );
    // A parameter the contract makes no claim about cannot be checked against
    // it. The count is split in two, because a lump sum cannot tell a new FEED
    // from a new GAP -- and those are opposite events.
    //
    // `since`/`until` on the feed paths carry no pattern DELIBERATELY (#10219):
    // `src/feeds.ts` accepts a whole UTC day OR an offset-bearing date-time and
    // says which was wrong, and a published regex would make the router's
    // derived message preempt that better one on every feed path. A new feed
    // inherits that decision rather than making a new one, so it may not count
    // as a regression -- but it may not hide one either. Hence exact equality:
    // every feed path publishes exactly these two unconstrained and nothing
    // else, so a feed that grows a third unbounded parameter fails here even
    // though the total merely went up.
    assert.equal(
      feedInstants,
      feedPaths.size * 2,
      "a feed path publishes `since` and `until` unbounded and nothing else -- " +
        `${feedInstants} unconstrained across ${feedPaths.size} path(s) means ` +
        "one of them grew a third",
    );
    // Everything else may only SHRINK. 70 -> 71 in #10316, and the extra one
    // was a CORRECTION rather than a regression: `/api/v1/chain-events`
    // published `^\d+\.\d+$` for a cursor its own tier decodes as three
    // parts, so the route rejected the `next_cursor` it had just handed out --
    // verified live, a 400. It now publishes the same opaque token its twelve
    // sibling feeds do, which makes no claim at all. Saying nothing is worse
    // than saying something true and better than saying something false.
    const nonFeed = unconstrained - feedInstants;
    assert.ok(
      nonFeed <= NON_FEED_UNCONSTRAINED_CEILING,
      `${nonFeed} non-feed query parameters publish no constraint at all, up ` +
        `from ${NON_FEED_UNCONSTRAINED_CEILING} -- declare a bound, or the ` +
        "contract says nothing a caller can rely on",
    );
  });
});

describe("a REQUIRED query parameter (#10401)", () => {
  // `stake-quote.amount` is the first and only required query parameter on the
  // API. It was declared `.optional()` while the handler rejected every request
  // without it, so the contract published a possibility that could not be
  // exercised -- found by #10214's generator comparing the route against
  // GraphQL's honest `amount: Float!`, not by any gate.
  //
  // Being the first REQUIRED one is the part with teeth: firstViolation picked
  // the failing parameter by walking the keys the caller SUPPLIED, which is
  // exhaustive only while every field is optional. A required field that is
  // absent has no key to walk, and that path was marked `v8 ignore` as
  // unreachable.
  const quote = (query: string) =>
    parseRouteQuery(
      new URL(`https://api.metagraph.sh/api/v1/subnets/1/stake-quote?${query}`),
    );

  test("a missing required parameter is REPORTED, not skipped", () => {
    const parsed = quote("");
    assert.ok("error" in parsed, "a missing amount must be a violation");
    // Named, so the caller is told WHICH parameter — the fallback that fires
    // here used to be dead code and had never returned a real parameter.
    assert.equal(parsed.error.parameter, "amount");
  });

  /** The violation message, or a marker so a passing parse fails the assertion. */
  const message = (query: string): string => {
    const parsed = quote(query);
    return "error" in parsed ? parsed.error.message : "(no violation)";
  };

  test("the message states the BOUND, not just the type", () => {
    // `z.number().gt(0)` publishes `exclusiveMinimum`, and boundFor only read
    // the inclusive keywords -- so this said "amount must be a number", which
    // is false about `0` and useless about an absent value.
    assert.match(message(""), /greater than 0/);
    assert.match(message("amount=0"), /greater than 0/);
    assert.match(message("amount=-3"), /greater than 0/);
  });

  test("a missing value does NOT get a `Received:` clause", () => {
    // There is nothing to echo. "Received: null" would describe a value the
    // caller never sent.
    assert.ok(!message("").includes("Received"));
    assert.ok(message("amount=0").includes('Received: "0"'));
  });

  test("a valid amount still parses, and keeps its type", () => {
    const parsed = quote("amount=5");
    assert.ok(!("error" in parsed));
    assert.equal(parsed.query.amount, 5);
  });

  test("a SUPPLIED parameter's violation still wins over the absent one", () => {
    // Two mistakes at once: `direction` is wrong AND `amount` is missing. The
    // caller is told about the one they actually wrote, because a message about
    // a parameter absent from their request is the harder one to act on.
    const parsed = quote("direction=sideways");
    assert.ok("error" in parsed);
    assert.equal(parsed.error.parameter, "direction");
  });
});
