// Cross-route pagination parity for the centralized request-params parser.
//
// The refactor's contract is that every paginated entity/feed route clamps
// limit/offset through the SAME shared parser with the SAME per-route profile, so
// a fix in one route can no longer drift from the others. These tests drive every
// refactored handler with the identical edge inputs (over-cap, below-min, absent,
// over-cap offset) and assert the bound limit/offset matches the route's profile —
// the regression that a wrong-profile wiring would introduce, which line coverage
// alone cannot catch.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  MAX_OFFSET,
  MIN_LIMIT,
} from "../workers/request-params.ts";
import { handleRequest } from "../workers/api.ts";
import {
  handleAccountEvents,
  handleAccountExtrinsics,
  handleAccountHistory,
  handleAccountIdentityHistory,
  handleAccountTransfers,
  handleBlockEvents,
  handleBlockExtrinsics,
  handleGovernanceConfigChanges,
  handleSubnetEvents,
  handleSubnetHyperparamsHistory,
  handleSubnetIdentityHistory,
  handleSudo,
} from "../workers/request-handlers/entities.ts";
import type { Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

// #4909 D1 retirement: this suite used to cover 9 routes, but 8 of them
// (accounts/{ss58}/events, extrinsics, transfers; subnets/{netuid}/events;
// blocks/{ref}/events, blocks/{ref}/extrinsics; blocks; extrinsics) had their
// D1 write path retired (#4772) and the underlying tables dropped in
// production. account_events_daily (the source behind /accounts/{ss58}/history)
// has since (2026-07-17) had its D1 copy fully eliminated too -- the route now
// reads the METAGRAPH_ACCOUNT_EVENTS_SOURCE Postgres tier only, via
// tryDataApiTier, and the store is never queried at all. clampLimit/clampOffset still
// run BEFORE the tier check though (parsePagination happens ahead of
// tryDataApiTier in handleAccountHistory), and the clamped values thread
// straight through to the schema-stable payload on a tier miss
// (buildAccountHistory([], ss58, { limit, offset, ... })) -- so reading
// data.limit/data.offset off the plain JSON response (no env flag, no D1/
// DATA_API mock needed) is enough to observe the bound clamp, no SQL capture
// required.
// The full set is back for the REJECTION assertions (#9916). The D1-retirement
// note above is why only /history can still be driven for its resolved
// limit/offset -- but an out-of-range `limit` is now rejected in
// parsePagination, BEFORE any tier or artifact work, so every one of these can
// be driven with an empty env and no mock. That is what makes "one rule for the
// whole surface" assertable rather than asserted on one route and assumed for
// the rest.
const ENV = {} as unknown as Env;
const BLOCK_REF = "1";

const ROUTES = [
  {
    name: "GET /accounts/{ss58}/history",
    profile: FEED_PAGINATION,
    resolvesPage: true,
    invoke: (qs: string) =>
      handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        ENV,
        SS58,
        url(`/api/v1/accounts/${SS58}/history?${qs}`),
      ),
  },
  {
    name: "GET /accounts/{ss58}/events",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleAccountEvents(
        req(`/api/v1/accounts/${SS58}/events`),
        ENV,
        SS58,
        url(`/api/v1/accounts/${SS58}/events?${qs}`),
      ),
  },
  {
    name: "GET /accounts/{ss58}/extrinsics",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleAccountExtrinsics(
        req(`/api/v1/accounts/${SS58}/extrinsics`),
        ENV,
        SS58,
        url(`/api/v1/accounts/${SS58}/extrinsics?${qs}`),
      ),
  },
  {
    name: "GET /accounts/{ss58}/transfers",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        ENV,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers?${qs}`),
      ),
  },
  {
    name: "GET /accounts/{ss58}/identity-history",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleAccountIdentityHistory(
        req(`/api/v1/accounts/${SS58}/identity-history`),
        ENV,
        SS58,
        url(`/api/v1/accounts/${SS58}/identity-history?${qs}`),
      ),
  },
  {
    name: "GET /subnets/{netuid}/events",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleSubnetEvents(
        req("/api/v1/subnets/1/events"),
        ENV,
        1,
        url(`/api/v1/subnets/1/events?${qs}`),
      ),
  },
  {
    name: "GET /subnets/{netuid}/hyperparameters/history",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleSubnetHyperparamsHistory(
        req("/api/v1/subnets/1/hyperparameters/history"),
        ENV,
        1,
        url(`/api/v1/subnets/1/hyperparameters/history?${qs}`),
      ),
  },
  {
    name: "GET /subnets/{netuid}/identity-history",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleSubnetIdentityHistory(
        req("/api/v1/subnets/1/identity-history"),
        ENV,
        1,
        url(`/api/v1/subnets/1/identity-history?${qs}`),
      ),
  },
  {
    // FEED_PAGINATION, unlike its /extrinsics sibling -- the published contract
    // declares maximum 1000 here and 100 there, so code and contract agree and
    // this is a real per-route difference, not drift.
    name: "GET /blocks/{ref}/events",
    profile: FEED_PAGINATION,
    invoke: (qs: string) =>
      handleBlockEvents(
        req(`/api/v1/blocks/${BLOCK_REF}/events`),
        ENV,
        BLOCK_REF,
        url(`/api/v1/blocks/${BLOCK_REF}/events?${qs}`),
      ),
  },
  {
    name: "GET /blocks/{ref}/extrinsics",
    profile: BLOCK_PAGINATION,
    invoke: (qs: string) =>
      handleBlockExtrinsics(
        req(`/api/v1/blocks/${BLOCK_REF}/extrinsics`),
        ENV,
        BLOCK_REF,
        url(`/api/v1/blocks/${BLOCK_REF}/extrinsics?${qs}`),
      ),
  },
  {
    name: "GET /sudo",
    profile: BLOCK_PAGINATION,
    invoke: (qs: string) =>
      handleSudo(req("/api/v1/sudo"), ENV, url(`/api/v1/sudo?${qs}`)),
  },
  {
    name: "GET /governance/config-changes",
    profile: BLOCK_PAGINATION,
    invoke: (qs: string) =>
      handleGovernanceConfigChanges(
        req("/api/v1/governance/config-changes"),
        ENV,
        url(`/api/v1/governance/config-changes?${qs}`),
      ),
  },
];

async function pageFor(route: (typeof ROUTES)[number], qs: string) {
  const res = await route.invoke(qs);
  const body = (await res.json()) as Row;
  return { limit: body.data.limit, offset: body.data.offset };
}

/**
 * Drive the route the way a request arrives.
 *
 * The REJECTION half of this file moved to the router with #10218: `limit` is
 * checked once, against the route's own published schema, before dispatch --
 * so a handler called directly no longer refuses an over-cap page size, and
 * asserting that it does would be asserting a property the surface does not
 * have. What a CALLER gets is unchanged, and that is what these now drive.
 */
function dispatch(route: (typeof ROUTES)[number], qs: string) {
  // The route's own name IS its template; the same fixtures the direct calls
  // above use fill it, so there is no second list of paths to keep in step.
  let path = route.name.replace("GET ", "");
  for (const [token, value] of Object.entries({
    "{ss58}": SS58,
    "{netuid}": "1",
    "{ref}": BLOCK_REF,
  })) {
    path = path.split(token).join(value);
  }
  return handleRequest(
    new Request(`https://api.metagraph.sh/api/v1${path}?${qs}`),
    ENV,
    {} as never,
  );
}

for (const route of ROUTES) {
  describe(`pagination parity — ${route.name}`, () => {
    test("REJECTS an over-cap limit instead of clamping it (#9916)", async () => {
      // This used to clamp to the profile maximum and answer 200. A caller
      // asking for 99999 and receiving maxLimit rows reads that as "the result
      // set is exhausted" and stops paginating -- truncation presented as a
      // complete answer, and the only signal was the echoed `limit`.
      const res = await dispatch(route, "limit=99999");
      assert.equal(res.status, 400);
      const body = (await res.json()) as Row;
      assert.equal(body.error.code, "invalid_query");
      assert.match(
        body.error.message,
        new RegExp(`between ${MIN_LIMIT} and ${route.profile.maxLimit}\\.`),
      );
    });

    test("REJECTS limit=0 rather than reinterpreting it (#9916)", async () => {
      // Routes used to answer this three different ways -- 1 row, the route
      // default, or a 400 -- and none of them is "zero rows".
      const res = await dispatch(route, "limit=0");
      assert.equal(res.status, 400);
      const body = (await res.json()) as Row;
      assert.equal(body.error.code, "invalid_query");
    });

    test.skipIf(!route.resolvesPage)(
      "falls back to the profile default when limit is absent",
      async () => {
        const { limit } = await pageFor(route, "offset=0");
        assert.equal(limit, route.profile.defaultLimit);
      },
    );

    test("REJECTS an over-cap offset instead of clamping it (#10218)", async () => {
      // This used to clamp to MAX_OFFSET and answer 200 -- rows from position
      // 1,000,000 for a caller who asked for 99,999,999, echoed back as though
      // that were the page they requested. `offset` publishes the same ceiling
      // `limit` does, and the two are now refused the same way.
      const res = await dispatch(route, `offset=${MAX_OFFSET + 1}`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as Row;
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "offset");
    });
  });
}
