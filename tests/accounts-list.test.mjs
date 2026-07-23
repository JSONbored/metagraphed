import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountsList,
  loadAccountsList,
  ACCOUNTS_LIST_SORTS,
  DEFAULT_ACCOUNTS_LIST_SORT,
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
} from "../src/accounts-list.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// An ACCOUNTS_LIST read-columns-shaped row (netuid, uid, hotkey, coldkey,
// validator_permit, emission_tao, stake_tao, block_number, captured_at).
const ROW = {
  netuid: 1,
  uid: 0,
  hotkey: "5Hk1",
  coldkey: "5Co1",
  validator_permit: 1,
  emission_tao: 22.1,
  stake_tao: 1000.5,
  block_number: 8454388,
  captured_at: 1750000000000,
};

const ctx = { waitUntil: (p) => p };

describe("buildAccountsList", () => {
  test("groups accounts across subnets, including non-validator (miner) rows", () => {
    const data = buildAccountsList(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 2,
          hotkey: "hk-a",
          coldkey: "ck-a",
          validator_permit: 1,
          stake_tao: "100.1234567891",
          emission_tao: 5,
          block_number: "10",
          captured_at: 1750000000000,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 1,
          hotkey: "hk-a",
          coldkey: "ck-a2",
          validator_permit: 0,
          stake_tao: 50,
          emission_tao: 9,
          block_number: 11,
          captured_at: 1750000001000,
        },
        {
          ...ROW,
          netuid: 5,
          uid: 3,
          hotkey: "hk-a",
          coldkey: "ck-a",
          validator_permit: 1,
          stake_tao: 1,
          emission_tao: 2,
          block_number: 12,
          captured_at: 1750000001000,
        },
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-b",
          coldkey: "ck-b",
          validator_permit: 0,
          stake_tao: 500,
          emission_tao: 1,
          block_number: 9,
          captured_at: 1740000000000,
        },
        { ...ROW, netuid: 4, uid: 0, hotkey: null },
      ],
      { sort: "subnet_count", limit: 1 },
    );

    assert.equal(data.sort, "subnet_count");
    assert.equal(data.limit, 1);
    assert.equal(data.account_count, 2);
    assert.equal(data.accounts.length, 1);
    assert.equal(data.captured_at, new Date(1750000001000).toISOString());
    assert.equal(data.block_number, 12);
    const top = data.accounts[0];
    assert.equal(top.hotkey, "hk-a");
    assert.equal(top.coldkey, "ck-a");
    assert.equal(top.coldkey_count, 2);
    assert.equal(top.subnet_count, 3);
    assert.equal(top.uid_count, 3);
    assert.equal(top.validator_count, 2);
    assert.equal(top.miner_count, 1);
    assert.equal(top.total_stake_tao, 151.123456789);
    assert.equal(top.total_emission_tao, 16);
    assert.equal(top.latest_captured_at, new Date(1750000001000).toISOString());
    assert.equal(top.latest_block_number, 12);
    assert.deepEqual(
      top.subnets.map((s) => [s.netuid, s.uid]),
      [
        [1, 2],
        [2, 1],
        [5, 3],
      ],
    );
  });

  test("is cold-safe and normalizes direct-call options", () => {
    const empty = buildAccountsList(null, { sort: "bogus", limit: "bogus" });
    assert.equal(empty.sort, DEFAULT_ACCOUNTS_LIST_SORT);
    assert.equal(empty.limit, ACCOUNTS_LIST_LIMIT_DEFAULT);
    assert.equal(empty.account_count, 0);
    assert.deepEqual(empty.accounts, []);
    assert.equal(empty.captured_at, null);
    assert.equal(empty.block_number, null);

    // An explicit limit of 0 yields an EMPTY leaderboard (not bumped up to
    // one row) — mirrors buildGlobalValidators' floor-at-0 clamp.
    const clamped = buildAccountsList(
      [{ ...ROW, netuid: 7, uid: 0, hotkey: "hk-a" }],
      { limit: 0 },
    );
    assert.equal(clamped.limit, 0);
    assert.equal(clamped.account_count, 1);
    assert.equal(clamped.accounts.length, 0);

    // limit above the max clamps down to the max.
    const overMax = buildAccountsList(
      [{ ...ROW, netuid: 7, uid: 0, hotkey: "hk-a" }],
      { limit: 1000 },
    );
    assert.equal(overMax.limit, ACCOUNTS_LIST_LIMIT_MAX);
  });

  test("an unsupported sort falls back to the default", () => {
    const data = buildAccountsList([ROW], { sort: "not-a-real-sort" });
    assert.equal(data.sort, DEFAULT_ACCOUNTS_LIST_SORT);
  });

  test("skips malformed rows (missing hotkey/netuid/uid), not a throw", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: null },
      { ...ROW, hotkey: "" },
      { ...ROW, netuid: null },
      { ...ROW, uid: null },
      { ...ROW, netuid: -1 },
    ]);
    assert.equal(data.account_count, 0);
  });

  test("rolls up stake/emission totals and stake dominance across accounts", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: "hk-a", netuid: 1, uid: 0, stake_tao: 300 },
      { ...ROW, hotkey: "hk-b", netuid: 1, uid: 1, stake_tao: 100 },
    ]);
    const a = data.accounts.find((e) => e.hotkey === "hk-a");
    const b = data.accounts.find((e) => e.hotkey === "hk-b");
    assert.equal(a.stake_dominance, 0.75);
    assert.equal(b.stake_dominance, 0.25);
  });

  test("nulls stake dominance when network stake is zero", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: "hk-a", stake_tao: 0 },
      { ...ROW, hotkey: "hk-b", netuid: 2, stake_tao: 0 },
    ]);
    for (const entry of data.accounts) {
      assert.equal(entry.stake_dominance, null);
    }
  });

  test("caps the per-account subnets[] slice at ten, ranked by membership stake", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      ...ROW,
      hotkey: "hk-a",
      netuid: i,
      uid: 0,
      stake_tao: 15 - i,
    }));
    const data = buildAccountsList(rows);
    assert.equal(data.accounts[0].subnet_count, 15);
    assert.equal(data.accounts[0].subnets.length, 10);
    // Highest-stake memberships first.
    assert.equal(data.accounts[0].subnets[0].netuid, 0);
  });

  test("reports a null block_number as null, not a fabricated 0", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: "hk-a", block_number: null },
    ]);
    assert.equal(data.accounts[0].latest_block_number, null);
  });

  test("a missing/blank/negative netuid or uid is skipped, not coerced to 0", () => {
    for (const overrides of [
      { netuid: "" },
      { netuid: "bad" },
      { uid: "" },
      { uid: -1 },
    ]) {
      const data = buildAccountsList([
        { ...ROW, hotkey: "hk-a", ...overrides },
      ]);
      assert.equal(data.account_count, 0, JSON.stringify(overrides));
    }
  });

  test("a row with no coldkey (null/non-string) still aggregates, with coldkey null", () => {
    const data = buildAccountsList([{ ...ROW, hotkey: "hk-a", coldkey: null }]);
    assert.equal(data.accounts[0].coldkey, null);
    assert.equal(data.accounts[0].coldkey_count, 0);
  });

  test("an invalid captured_at (null, 0, negative, non-finite) never sets latest timestamps", () => {
    for (const captured_at of [null, 0, -5, "not-a-number"]) {
      const data = buildAccountsList([{ ...ROW, hotkey: "hk-a", captured_at }]);
      assert.equal(
        data.accounts[0].latest_captured_at,
        null,
        JSON.stringify(captured_at),
      );
      assert.equal(data.captured_at, null, JSON.stringify(captured_at));
    }
  });

  test("a captured_at outside the Date-representable range degrades to null", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: "hk-a", captured_at: 8.7e15 },
    ]);
    assert.equal(data.accounts[0].latest_captured_at, null);
    assert.equal(data.captured_at, null);
  });

  test("a null/negative/non-numeric stake or emission cell degrades to 0, not NaN", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: "hk-a", stake_tao: -5, emission_tao: "not-a-number" },
    ]);
    assert.equal(data.accounts[0].total_stake_tao, 0);
    assert.equal(data.accounts[0].total_emission_tao, 0);
  });

  test("the primary coldkey ties break alphabetically", () => {
    const data = buildAccountsList([
      { ...ROW, hotkey: "hk-a", netuid: 1, uid: 0, coldkey: "ck-z" },
      { ...ROW, hotkey: "hk-a", netuid: 2, uid: 0, coldkey: "ck-a" },
    ]);
    assert.equal(data.accounts[0].coldkey, "ck-a");
    assert.equal(data.accounts[0].coldkey_count, 2);
  });

  test("sorting by stake_dominance when every account is null-dominance is stable", () => {
    // Zero network stake -> every entry's stake_dominance is null, exercising
    // accountSortValue's non-numeric fallback (sorts by hotkey only).
    const data = buildAccountsList(
      [
        { ...ROW, hotkey: "hk-z", stake_tao: 0 },
        { ...ROW, hotkey: "hk-a", netuid: 2, stake_tao: 0 },
      ],
      { sort: "stake_dominance" },
    );
    assert.deepEqual(
      data.accounts.map((e) => e.hotkey),
      ["hk-a", "hk-z"],
    );
  });

  test("uses deterministic hotkey tie-breakers when sort values are equal", () => {
    const data = buildAccountsList(
      [
        { ...ROW, hotkey: "hk-z", netuid: 1, uid: 0, stake_tao: 100 },
        { ...ROW, hotkey: "hk-a", netuid: 2, uid: 0, stake_tao: 100 },
      ],
      { sort: "total_stake" },
    );
    assert.deepEqual(
      data.accounts.map((e) => e.hotkey),
      ["hk-a", "hk-z"],
    );
  });

  test("caps subnets[] and tie-breaks equal stake by emission, then netuid, then uid", () => {
    // Deliberately ascending input order for the stake_tao=1 row (lowest
    // stake, listed first) so the comparator's b.stake_tao - a.stake_tao
    // exercises BOTH a positive and a negative outcome, not just one
    // direction of an already-descending input.
    const data = buildAccountsList([
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 5,
        uid: 0,
        stake_tao: 1,
        emission_tao: 1,
      },
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 1,
        uid: 0,
        stake_tao: 5,
        emission_tao: 1,
      },
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 2,
        uid: 0,
        stake_tao: 5,
        emission_tao: 2,
      },
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 4,
        uid: 1,
        stake_tao: 5,
        emission_tao: 2,
      },
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 3,
        uid: 0,
        stake_tao: 5,
        emission_tao: 2,
      },
    ]);
    assert.deepEqual(
      data.accounts[0].subnets.map((s) => [s.netuid, s.uid]),
      [
        [2, 0],
        [3, 0],
        [4, 1],
        [1, 0],
        [5, 0],
      ],
    );
  });

  test("falls all the way through to the uid tie-break when stake, emission, and netuid all tie", () => {
    const data = buildAccountsList([
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 9,
        uid: 3,
        stake_tao: 5,
        emission_tao: 1,
      },
      {
        ...ROW,
        hotkey: "hk-a",
        netuid: 9,
        uid: 1,
        stake_tao: 5,
        emission_tao: 1,
      },
    ]);
    assert.deepEqual(
      data.accounts[0].subnets.map((s) => s.uid),
      [1, 3],
    );
  });

  test("every documented sort key is a valid, applicable sort", () => {
    for (const sort of ACCOUNTS_LIST_SORTS) {
      const data = buildAccountsList(
        [
          { ...ROW, hotkey: "hk-a", stake_tao: 10, emission_tao: 1 },
          { ...ROW, hotkey: "hk-b", netuid: 2, stake_tao: 5, emission_tao: 5 },
        ],
        { sort },
      );
      assert.equal(data.sort, sort, sort);
      assert.equal(data.accounts.length, 2, sort);
    }
  });
});

describe("loadAccountsList", () => {
  test("reads every hotkey (no validator_permit filter) and shapes it", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [
        { ...ROW, hotkey: "hk-a", validator_permit: 0 },
        { ...ROW, hotkey: "hk-b", netuid: 2, validator_permit: 1 },
      ];
    };
    const data = await loadAccountsList(d1, { sort: "total_stake" });
    assert.match(captured.sql, /FROM neurons/);
    assert.doesNotMatch(captured.sql, /validator_permit = 1/);
    assert.match(captured.sql, /WHERE hotkey IS NOT NULL/);
    assert.deepEqual(captured.params, []);
    assert.equal(data.account_count, 2);
  });

  test("a cold store yields a schema-stable empty leaderboard", async () => {
    const data = await loadAccountsList(async () => []);
    assert.equal(data.account_count, 0);
    assert.deepEqual(data.accounts, []);
  });

  test("a non-array D1 result degrades to an empty leaderboard", async () => {
    const data = await loadAccountsList(async () => null);
    assert.equal(data.account_count, 0);
  });
});

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the SQL.
function accountsListEnv(rows, captured = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        captured.sql = sql;
        return {
          bind(...params) {
            captured.params = params;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

describe("GET /api/v1/accounts via the Worker", () => {
  test("is schema-stable when D1 is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts"),
      accountsListEnv([]),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.account_count, 0);
  });

  test("rejects an unsupported ?sort with 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts?sort=bogus"),
      accountsListEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "sort");
  });

  test("rejects a ?limit above the max with 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts?limit=1000"),
      accountsListEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unrecognized query param with 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts?bogus=1"),
      accountsListEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("?format=csv exports the leaderboard rows via the Postgres tier", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            sort: "total_stake",
            limit: 20,
            account_count: 1,
            captured_at: new Date(1750000000000).toISOString(),
            block_number: 8454388,
            accounts: [
              {
                hotkey: "hk-a",
                coldkey: "ck-a",
                coldkey_count: 1,
                subnet_count: 1,
                uid_count: 1,
                validator_count: 1,
                miner_count: 0,
                total_stake_tao: 1000.5,
                total_emission_tao: 22.1,
                stake_dominance: 1,
                latest_captured_at: new Date(1750000000000).toISOString(),
                latest_block_number: 8454388,
                subnets: [{ netuid: 1, uid: 0 }],
              },
            ],
          }),
      },
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts?format=csv"),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^hk-a,ck-a,/);
  });

  test("testnet has no variant (mainnet-only neurons-derived leaderboard)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/accounts"),
      accountsListEnv([]),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
