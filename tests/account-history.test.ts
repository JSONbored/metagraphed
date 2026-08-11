import assert from "node:assert/strict";
import { lakehouse, LAKEHOUSE_ENV } from "./helpers/cold-tier-env.ts";
import { afterEach, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { buildAccountHistory } from "../src/account-events.ts";
import type { Row } from "./row-type.ts";

// SQL-capturing D1 mock variant: records each bound (sql, params) so a test can
// assert the query shape (keyset seek vs offset).
function dbCapture(days: Row[] = []) {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  return {
    captured,
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind(...params: unknown[]) {
              captured.push({ sql, params });
              return {
                async all() {
                  return {
                    results: /FROM account_events_daily/.test(sql) ? days : [],
                  };
                },
              };
            },
          };
        },
      },
    },
  };
}

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

const DAY = {
  day: "2026-06-24",
  netuid: 7,
  event_count: 12,
  event_kinds: "StakeAdded,WeightsSet,WeightsSet",
  first_block: 4_000_100,
  last_block: 4_000_900,
};

// #10190: METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in wrangler.jsonc and
// is absent from DATA_API_FORWARD_FLAGS, so the tier this used to double was
// never asked -- handleAccountHistory reads the lakehouse rollup
// (loadAccountHistoryColdTier, #9315). Doubled at the same transport, and given
// the SAME day rows: the reader feeds them through buildAccountHistory exactly
// as this helper used to, so the assertions below are unchanged.
let lake: ReturnType<typeof lakehouse> | undefined;
afterEach(() => {
  lake?.restore();
  lake = undefined;
});

function coldTierEnv({ days }: { days?: Row[] } = {}) {
  // TWO reads, not one: R2 SQL rejects `string_agg(DISTINCT ...)`, so the kinds
  // are grouped to (day, netuid, event_kind) in a query of their own. Answering
  // both with the same rows is what an undifferentiated double would do, and it
  // silently yields empty kinds -- so the double routes on the SQL.
  const rows = days || [];
  lake = lakehouse((sql) =>
    sql.includes("event_kind")
      ? rows.flatMap((row) =>
          String(row.event_kinds ?? "")
            .split(",")
            .filter(Boolean)
            // GROUP BY event_kind, so a kind appears at most once per day+netuid.
            .filter((kind, i, all) => all.indexOf(kind) === i)
            .map((event_kind) => ({
              day: row.day,
              netuid: row.netuid,
              event_kind,
            })),
        )
      : rows,
  );
  return { ...LAKEHOUSE_ENV };
}

test("GET /accounts/{ss58}/history returns the per-day series (#1854)", async () => {
  const env = coldTierEnv({ days: [DAY] });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.day_count, 1);
  assert.equal(body.data.days[0].day, "2026-06-24");
  assert.equal(body.data.days[0].netuid, 7);
  // The lakehouse read GROUPs BY event_kind, so a kind cannot repeat within a
  // (day, netuid) -- the retired tier's payload could carry duplicates because
  // nothing grouped them on the way out.
  assert.deepEqual(body.data.days[0].event_kinds, ["StakeAdded", "WeightsSet"]);
  assert.ok(res.headers.get("etag"));
});

test("GET /accounts/{ss58}/history rejects malformed ?from / ?to", async () => {
  const bad = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?from=June`),
    {} as unknown as Env,
    {},
  );
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_query");
  assert.equal(body.meta.parameter, "from");
});

test("GET /accounts/{ss58}/history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?bogus=1`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/history is schema-stable when cold (never 404)", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.day_count, 0);
  assert.equal(Array.isArray(body.data.days), true);
});

test("GET /accounts/{ss58}/history exposes x-metagraph-artifact-source on both the normal and inverted-range short-circuit paths (#2618)", async () => {
  // The normal path stamps meta.source and exposes the CORS header; the inverted
  // from>to short-circuit stamps the same meta.source, so it must expose the
  // header too — it must not be dropped just because the range is empty.
  const normal = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history`),
    coldTierEnv({ days: [DAY] }) as unknown as Env,
    {},
  );
  assert.equal(
    normal.headers.get("x-metagraph-artifact-source"),
    "chain-events",
  );

  const { env, captured } = dbCapture([DAY]);
  const inverted = await handleRequest(
    req(`/api/v1/accounts/${SS58}/history?from=2026-06-30&to=2026-06-01`),
    env as unknown as Env,
    {},
  );
  assert.equal(inverted.status, 200);
  assert.equal((await inverted.json()).data.day_count, 0);
  // Short-circuited before D1 — no account_events_daily scan.
  assert.ok(!captured.some((q) => /FROM account_events_daily/.test(q.sql)));
  assert.equal(
    inverted.headers.get("x-metagraph-artifact-source"),
    "chain-events",
  );
});
