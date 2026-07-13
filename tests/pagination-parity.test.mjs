// Cross-route pagination parity for the centralized request-params parser.
//
// The refactor's contract is that every paginated entity/feed route clamps
// limit/offset through the SAME shared parser with the SAME per-route profile, so
// a fix in one route can no longer drift from the others. These tests drive every
// refactored handler with the identical edge inputs (over-cap, below-min, absent,
// over-cap offset) and assert the bound LIMIT/OFFSET matches the route's profile —
// the regression that a wrong-profile wiring would introduce, which line coverage
// alone cannot catch. The handlers are null-safe, so a capturing D1 stub that
// returns empty rows is enough to read back the bound clamp values.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  FEED_PAGINATION,
  MAX_OFFSET,
  MIN_LIMIT,
} from "../workers/request-params.mjs";
import { handleAccountHistory } from "../workers/request-handlers/entities.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const BLOCK_NUM = 1234;

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

// A capturing D1 stub: records every (sql, params) and returns empty rows, except
// the block-ref resolution lookup, which must return a row so the block
// sub-resource feed query actually runs.
function capturingEnv() {
  const calls = [];
  return {
    calls,
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              calls.push({ sql, params });
              return {
                async all() {
                  if (
                    /SELECT block_number FROM blocks WHERE block_number = \? LIMIT 1/.test(
                      sql,
                    )
                  ) {
                    return { results: [{ block_number: BLOCK_NUM }] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    },
  };
}

// The feed query is the one carrying a bound `LIMIT ?` (the ref-resolution lookup
// uses a literal `LIMIT 1`, so it is excluded).
function feedCall(calls, feedPattern) {
  return calls.find((c) => feedPattern.test(c.sql) && /LIMIT \?/.test(c.sql));
}

// limit + offset are always the last bound params: `... LIMIT ?` (keyset) or
// `... LIMIT ? OFFSET ?` (offset fallback).
function boundPage(call) {
  assert.ok(call, "expected a feed query to run");
  const p = call.params;
  return /OFFSET \?\s*$/.test(call.sql)
    ? { limit: p[p.length - 2], offset: p[p.length - 1] }
    : { limit: p[p.length - 1], offset: null };
}

// #4909 D1 retirement: this suite used to cover 9 routes, but 8 of them
// (accounts/{ss58}/events, extrinsics, transfers; subnets/{netuid}/events;
// blocks/{ref}/events, blocks/{ref}/extrinsics; blocks; extrinsics) had their
// D1 write path retired (#4772) and the underlying tables dropped in
// production, so entities.mjs no longer runs a D1 query for them at all --
// there is nothing left for a "the bound LIMIT/OFFSET matches the profile"
// D1-capture assertion to observe. account_events_daily (the source behind
// /accounts/{ss58}/history) is NOT part of that retirement -- it has its own
// independent Postgres-side rollup and D1's copy is still a real,
// live-queried fallback tier -- so its parity coverage stays.
const ROUTES = [
  {
    name: "GET /accounts/{ss58}/history",
    profile: FEED_PAGINATION,
    feed: /FROM account_events_daily/,
    invoke: (env, qs) =>
      handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/history?${qs}`),
      ),
  },
];

async function pageFor(route, qs) {
  const { env, calls } = capturingEnv();
  await route.invoke(env, qs);
  return boundPage(feedCall(calls, route.feed));
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
