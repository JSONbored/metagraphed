import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// #5741: ?format=csv on GET /api/v1/accounts/{ss58}/history, mirroring the
// CSV-export convention of the sibling account-events/extrinsics/transfers feeds.
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const CSV_HEADER = "day,netuid,event_count,event_kinds,first_block,last_block";

function req(path: string, init?: RequestInit) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

test("GET /accounts/{ss58}/history?format=csv emits a header-only CSV when cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?format=csv`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), CSV_HEADER);
});

test("GET /accounts/{ss58}/history?format=csv exports the per-day rows via the Postgres tier", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          ss58: SS58,
          day_count: 1,
          limit: 1000,
          offset: 0,
          next_cursor: null,
          days: [
            {
              day: "2026-06-25",
              netuid: 1,
              event_count: 5,
              event_kinds: ["StakeAdded", "Transfer"],
              first_block: 8454300,
              last_block: 8454388,
            },
          ],
        }),
    },
  };
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?format=csv`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^2026-06-25,1,5,/);
  assert.match(lines[1], /8454388$/);
});

test("GET /accounts/{ss58}/history rejects an invalid ?format with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?format=xml`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});
