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
  FEED_PAGINATION,
  MAX_OFFSET,
  MIN_LIMIT,
} from "../workers/request-params.mjs";
import { handleAccountHistory } from "../workers/request-handlers/entities.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

// #4909 D1 retirement: this suite used to cover 9 routes, but 8 of them
// (accounts/{ss58}/events, extrinsics, transfers; subnets/{netuid}/events;
// blocks/{ref}/events, blocks/{ref}/extrinsics; blocks; extrinsics) had their
// D1 write path retired (#4772) and the underlying tables dropped in
// production. account_events_daily (the source behind /accounts/{ss58}/history)
// has since (2026-07-17) had its D1 copy fully eliminated too -- the route now
// reads the METAGRAPH_ACCOUNT_EVENTS_SOURCE Postgres tier only, via
// tryPostgresTier, and D1 is never queried at all. clampLimit/clampOffset still
// run BEFORE the tier check though (parsePagination happens ahead of
// tryPostgresTier in handleAccountHistory), and the clamped values thread
// straight through to the schema-stable payload on a tier miss
// (buildAccountHistory([], ss58, { limit, offset, ... })) -- so reading
// data.limit/data.offset off the plain JSON response (no env flag, no D1/
// DATA_API mock needed) is enough to observe the bound clamp, no SQL capture
// required.
const ROUTES = [
  {
    name: "GET /accounts/{ss58}/history",
    profile: FEED_PAGINATION,
    invoke: (qs) =>
      handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        {},
        SS58,
        url(`/api/v1/accounts/${SS58}/history?${qs}`),
      ),
  },
];

async function pageFor(route, qs) {
  const res = await route.invoke(qs);
  const body = await res.json();
  return { limit: body.data.limit, offset: body.data.offset };
}

for (const route of ROUTES) {
  describe(`pagination parity — ${route.name}`, () => {
    test("clamps an over-cap limit down to the profile maximum", async () => {
      const { limit } = await pageFor(route, "limit=99999");
      assert.equal(limit, route.profile.maxLimit);
    });

    test("clamps a zero limit up to MIN_LIMIT", async () => {
      const { limit } = await pageFor(route, "limit=0");
      assert.equal(limit, MIN_LIMIT);
    });

    test("falls back to the profile default when limit is absent", async () => {
      const { limit } = await pageFor(route, "offset=0");
      assert.equal(limit, route.profile.defaultLimit);
    });

    test("clamps an over-cap offset down to MAX_OFFSET", async () => {
      const { offset } = await pageFor(route, "offset=99999999");
      assert.equal(offset, MAX_OFFSET);
    });
  });
}
