// Public pagination is a router contract: validate published bounds before
// dispatch, then preserve defaults and explicit values in the returned page.
// Exercise every route even when native sources are unavailable; that condition
// does not remove its pagination contract or prove its data is empty.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  MAX_OFFSET,
  MIN_LIMIT,
} from "../workers/request-params.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const ENV = {} as unknown as Env;
// Below the retained-history seam: an unconfigured source must not turn this
// pagination check into a claim that a recent, uncovered block was empty.
const BLOCK_REF = "1";

const ROUTES = [
  { name: "GET /accounts/{ss58}/history", profile: FEED_PAGINATION },
  { name: "GET /accounts/{ss58}/events", profile: FEED_PAGINATION },
  { name: "GET /accounts/{ss58}/extrinsics", profile: FEED_PAGINATION },
  { name: "GET /accounts/{ss58}/transfers", profile: FEED_PAGINATION },
  { name: "GET /accounts/{ss58}/identity-history", profile: FEED_PAGINATION },
  { name: "GET /subnets/{netuid}/events", profile: FEED_PAGINATION },
  {
    name: "GET /subnets/{netuid}/hyperparameters/history",
    profile: FEED_PAGINATION,
  },
  { name: "GET /subnets/{netuid}/identity-history", profile: FEED_PAGINATION },
  // The events route publishes a different profile from its extrinsics sibling.
  { name: "GET /blocks/{ref}/events", profile: FEED_PAGINATION },
  { name: "GET /blocks/{ref}/extrinsics", profile: BLOCK_PAGINATION },
  { name: "GET /sudo", profile: BLOCK_PAGINATION },
  { name: "GET /governance/config-changes", profile: BLOCK_PAGINATION },
];

function dispatch(route: (typeof ROUTES)[number], qs: string) {
  // One route list drives both accepted and rejected public requests.
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

async function pageFor(route: (typeof ROUTES)[number], qs: string) {
  const res = await dispatch(route, qs);
  const body = (await res.json()) as Row;
  assert.equal(res.status, 200, `${route.name}: ${JSON.stringify(body)}`);
  assert.ok(body.data, `${route.name}: missing page`);
  return { limit: body.data.limit, offset: body.data.offset };
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

    test("falls back to the profile default when limit is absent", async () => {
      assert.deepEqual(await pageFor(route, ""), {
        limit: route.profile.defaultLimit,
        offset: 0,
      });
    });

    test("preserves an explicit limit and offset in the returned page", async () => {
      assert.deepEqual(await pageFor(route, "limit=7&offset=3"), {
        limit: 7,
        offset: 3,
      });
    });

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
