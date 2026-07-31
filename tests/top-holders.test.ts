import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildTopHoldersList,
  compareTopHoldersSort,
  TOP_HOLDERS_SORTS,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
} from "../src/top-holders.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const ctx = { waitUntil: (p: Promise<unknown>) => p };

// A row from the FULL OUTER JOIN query (ss58, free_tao, delegated_tao,
// captured_at) -- free_tao/delegated_tao are already COALESCEd to 0 by the
// SQL, never null.
const ROW = {
  ss58: "5Whale1",
  free_tao: 1000.5,
  delegated_tao: 250.25,
  captured_at: 1750000000000,
};

describe("buildTopHoldersList", () => {
  test("computes total_tao as free + delegated", () => {
    const data = buildTopHoldersList([ROW]) as Row;
    assert.equal(data.accounts[0].total_tao, 1250.75);
  });

  test("an account present from account_balances alone still appears (delegated_tao 0)", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5FreeOnly",
        free_tao: 500,
        delegated_tao: 0,
        captured_at: 1750000000000,
      },
    ]) as Row;
    assert.equal(data.account_count, 1);
    assert.equal(data.accounts[0].delegated_tao, 0);
    assert.equal(data.accounts[0].total_tao, 500);
  });

  test("an account present from nominator_positions alone still appears (free_tao 0)", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5DelegatedOnly",
        free_tao: 0,
        delegated_tao: 300,
        captured_at: null,
      },
    ]) as Row;
    assert.equal(data.account_count, 1);
    assert.equal(data.accounts[0].free_tao, 0);
    assert.equal(data.accounts[0].total_tao, 300);
    assert.equal(data.accounts[0].last_updated, null);
  });

  test("sorts by total_tao (default), descending, tie-broken by ss58", () => {
    const data = buildTopHoldersList([
      { ss58: "5B", free_tao: 100, delegated_tao: 0, captured_at: 1 },
      { ss58: "5A", free_tao: 100, delegated_tao: 0, captured_at: 1 },
      { ss58: "5C", free_tao: 500, delegated_tao: 0, captured_at: 1 },
    ]) as Row;
    assert.deepEqual(
      (data.accounts as Row[]).map((a: Row) => a.ss58),
      ["5C", "5A", "5B"],
    );
  });

  test("sorts by free_tao when requested", () => {
    const data = buildTopHoldersList(
      [
        {
          ss58: "5LowFree-HighDelegated",
          free_tao: 10,
          delegated_tao: 1000,
          captured_at: 1,
        },
        { ss58: "5HighFree", free_tao: 500, delegated_tao: 0, captured_at: 1 },
      ],
      { sort: "free_tao" },
    ) as Row;
    assert.equal(data.accounts[0].ss58, "5HighFree");
  });

  test("sorts by delegated_tao when requested", () => {
    const data = buildTopHoldersList(
      [
        { ss58: "5HighFree", free_tao: 500, delegated_tao: 0, captured_at: 1 },
        {
          ss58: "5HighDelegated",
          free_tao: 10,
          delegated_tao: 1000,
          captured_at: 1,
        },
      ],
      { sort: "delegated_tao" },
    ) as Row;
    assert.equal(data.accounts[0].ss58, "5HighDelegated");
  });

  test("falls back to the default sort for an unrecognized value", () => {
    const data = buildTopHoldersList([ROW], { sort: "bogus" }) as Row;
    assert.equal(data.sort, DEFAULT_TOP_HOLDERS_SORT);
  });

  test("clamps limit to the max, and floors a fractional limit", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ss58: `5Acct${i}`,
      free_tao: i,
      delegated_tao: 0,
      captured_at: 1,
    }));
    const over = buildTopHoldersList(many, {
      limit: TOP_HOLDERS_LIMIT_MAX + 500,
    }) as Row;
    assert.equal(over.limit, TOP_HOLDERS_LIMIT_MAX);
    const fractional = buildTopHoldersList(many, { limit: 2.9 }) as Row;
    assert.equal(fractional.limit, 2);
    assert.equal(fractional.accounts.length, 2);
  });

  test("limit=0 returns an empty page, not the default", () => {
    const data = buildTopHoldersList([ROW], { limit: 0 }) as Row;
    assert.equal(data.limit, 0);
    assert.equal(data.accounts.length, 0);
    assert.equal(data.account_count, 1); // account_count is the full match count, not the page size
  });

  test("a non-finite limit falls back to the default", () => {
    const data = buildTopHoldersList([ROW], { limit: "not-a-number" }) as Row;
    assert.equal(data.limit, TOP_HOLDERS_LIMIT_DEFAULT);
  });

  test("captured_at is the latest across all rows", () => {
    const data = buildTopHoldersList([
      { ss58: "5A", free_tao: 1, delegated_tao: 0, captured_at: 100 },
      { ss58: "5B", free_tao: 1, delegated_tao: 0, captured_at: 200 },
    ]) as Row;
    assert.equal(data.captured_at, new Date(200).toISOString());
  });

  test("skips a row with no ss58", () => {
    const data = buildTopHoldersList([
      { free_tao: 1, delegated_tao: 0 },
    ]) as Row;
    assert.equal(data.account_count, 0);
  });

  test("a cold/empty store yields a schema-stable empty leaderboard", () => {
    const data = buildTopHoldersList([]) as Row;
    assert.equal(data.account_count, 0);
    assert.deepEqual(data.accounts, []);
    assert.equal(data.captured_at, null);
  });

  test("a non-array input degrades to an empty leaderboard", () => {
    const data = buildTopHoldersList(null) as Row;
    assert.equal(data.account_count, 0);
  });

  test("a negative or non-finite balance value falls back to 0 (defensive against a malformed row)", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5Bad",
        free_tao: -50,
        delegated_tao: "not-a-number",
        captured_at: 1,
      },
    ]) as Row;
    assert.equal(data.accounts[0].free_tao, 0);
    assert.equal(data.accounts[0].delegated_tao, 0);
    assert.equal(data.accounts[0].total_tao, 0);
  });

  test("captured_at of 0 or negative degrades to a null last_updated, distinct from a missing captured_at", () => {
    const data = buildTopHoldersList([
      { ss58: "5Zero", free_tao: 1, delegated_tao: 0, captured_at: 0 },
    ]) as Row;
    assert.equal(data.accounts[0].last_updated, null);
    assert.equal(data.captured_at, null);
  });

  test("a finite but out-of-Date-range captured_at degrades to a null last_updated", () => {
    const data = buildTopHoldersList([
      { ss58: "5Huge", free_tao: 1, delegated_tao: 0, captured_at: 1e20 },
    ]) as Row;
    assert.equal(data.accounts[0].last_updated, null);
  });

  test("TOP_HOLDERS_SORTS matches the six real sort keys", () => {
    assert.deepEqual(TOP_HOLDERS_SORTS, [
      "total_tao",
      "free_tao",
      "delegated_tao",
      "net_flow_7d",
      "net_flow_30d",
      "net_flow_90d",
    ]);
  });

  test("net_flow_7d/30d/90d are null when the flow rollup has no row for this account (#8807)", () => {
    const data = buildTopHoldersList([ROW]) as Row;
    assert.equal(data.accounts[0].net_flow_7d, null);
    assert.equal(data.accounts[0].net_flow_30d, null);
    assert.equal(data.accounts[0].net_flow_90d, null);
  });

  test("a genuine zero net_flow_7d is preserved when the account has flow rows but none in the last 7 days (#8807)", () => {
    const data = buildTopHoldersList([
      {
        ...ROW,
        net_flow_7d: 0,
        net_flow_30d: 12.5,
        net_flow_90d: 40,
      },
    ]) as Row;
    assert.equal(data.accounts[0].net_flow_7d, 0);
    assert.equal(data.accounts[0].net_flow_30d, 12.5);
    assert.equal(data.accounts[0].net_flow_90d, 40);
  });

  test("a negative net flow (net outflow) is preserved, not clamped to 0", () => {
    const data = buildTopHoldersList([
      { ...ROW, net_flow_7d: -500.25, net_flow_30d: -1000, net_flow_90d: -1 },
    ]) as Row;
    assert.equal(data.accounts[0].net_flow_7d, -500.25);
    assert.equal(data.accounts[0].net_flow_30d, -1000);
    assert.equal(data.accounts[0].net_flow_90d, -1);
  });

  test("a non-finite net flow value becomes null, not 0 (#8807)", () => {
    const data = buildTopHoldersList([
      { ...ROW, net_flow_30d: "not-a-number" },
    ]) as Row;
    assert.equal(data.accounts[0].net_flow_30d, null);
  });

  test("sorts by net_flow_30d when requested, biggest net inflow first", () => {
    const data = buildTopHoldersList(
      [
        { ss58: "5Outflow", free_tao: 0, delegated_tao: 0, net_flow_30d: -500 },
        {
          ss58: "5BigInflow",
          free_tao: 0,
          delegated_tao: 0,
          net_flow_30d: 500,
        },
      ],
      { sort: "net_flow_30d" },
    ) as Row;
    assert.equal(data.accounts[0].ss58, "5BigInflow");
    assert.equal(data.accounts[1].ss58, "5Outflow");
  });

  test("null net_flow_7d sorts after a real negative outflow (#8807)", () => {
    const data = buildTopHoldersList(
      [
        { ss58: "5Unknown", free_tao: 0, delegated_tao: 0 },
        { ss58: "5Outflow", free_tao: 0, delegated_tao: 0, net_flow_7d: -5 },
      ],
      { sort: "net_flow_7d" },
    ) as Row;
    assert.deepEqual(
      (data.accounts as Row[]).map((a: Row) => a.ss58),
      ["5Outflow", "5Unknown"],
    );
  });

  test("two null net_flow_7d rows tiebreak by ss58 (#8807)", () => {
    const data = buildTopHoldersList(
      [
        { ss58: "5B", free_tao: 0, delegated_tao: 0 },
        { ss58: "5A", free_tao: 0, delegated_tao: 0 },
      ],
      { sort: "net_flow_7d" },
    ) as Row;
    assert.deepEqual(
      (data.accounts as Row[]).map((a: Row) => a.ss58),
      ["5A", "5B"],
    );
  });

  test("equal net_flow_7d values tiebreak by ss58 (#8807 coverage)", () => {
    const data = buildTopHoldersList(
      [
        { ss58: "5B", free_tao: 0, delegated_tao: 0, net_flow_7d: 10 },
        { ss58: "5A", free_tao: 0, delegated_tao: 0, net_flow_7d: 10 },
        { ss58: "5C", free_tao: 0, delegated_tao: 0, net_flow_7d: 20 },
      ],
      { sort: "net_flow_7d" },
    ) as Row;
    assert.deepEqual(
      (data.accounts as Row[]).map((a: Row) => a.ss58),
      ["5C", "5A", "5B"],
    );
  });

  test("undefined net_flow is null, distinct from a genuine zero (#8807)", () => {
    const data = buildTopHoldersList([
      { ...ROW, net_flow_7d: undefined, net_flow_30d: 0 },
    ]) as Row;
    assert.equal(data.accounts[0].net_flow_7d, null);
    assert.equal(data.accounts[0].net_flow_30d, 0);
  });
});

describe("compareTopHoldersSort", () => {
  const num = {
    ss58: "5Num",
    free_tao: 0,
    delegated_tao: 0,
    total_tao: 0,
    net_flow_7d: -5,
    net_flow_30d: null,
    net_flow_90d: null,
    last_updated: null,
  };
  const missing = {
    ss58: "5Null",
    free_tao: 0,
    delegated_tao: 0,
    total_tao: 0,
    net_flow_7d: null,
    net_flow_30d: null,
    net_flow_90d: null,
    last_updated: null,
  };

  test("number vs null and null vs number both place null last (#8807)", () => {
    assert.equal(compareTopHoldersSort(num, missing, "net_flow_7d"), -1);
    assert.equal(compareTopHoldersSort(missing, num, "net_flow_7d"), 1);
  });
});

describe("GET /api/v1/accounts/top-holders via the Worker", () => {
  test("is schema-stable when the Postgres tier is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts/top-holders"),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.account_count, 0);
  });

  test("rejects an unsupported ?sort with 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/top-holders?sort=bogus",
      ),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "sort");
  });

  test("rejects a ?limit above the max with 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/top-holders?limit=1000",
      ),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unrecognized query param with 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/top-holders?bogus=1",
      ),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("is dispatched before the generic /api/v1/accounts/{ss58} route (never mistaken for an address)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts/top-holders"),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    const body = await res.json();
    // The generic {ss58} route's response shape has no `accounts` array --
    // if dispatch were wrong this would 200 with a single-account shape instead.
    assert.equal(Array.isArray(body.data.accounts), true);
  });

  test("?format=csv exports the leaderboard rows via the Postgres tier", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_TOP_HOLDERS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            sort: "total_tao",
            limit: 20,
            account_count: 1,
            captured_at: new Date(1750000000000).toISOString(),
            accounts: [
              {
                ss58: "5Whale1",
                free_tao: 1000.5,
                delegated_tao: 250.25,
                total_tao: 1250.75,
                net_flow_7d: -50,
                net_flow_30d: 200,
                net_flow_90d: 900,
                last_updated: new Date(1750000000000).toISOString(),
              },
            ],
          }),
      },
    };
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/top-holders?format=csv",
      ),
      env as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 2);
    // net_flow_7d (-50) gets a leading `'` -- the formula-injection guard for
    // CSV cells starting with -/+/=/@ (workers/csv.ts), same as any other
    // negative-leading cell in this codebase's CSV exports.
    assert.match(lines[1], /^5Whale1,1000\.5,250\.25,1250\.75,'-50,200,900,/);
  });

  test("testnet has no variant (mainnet-only leaderboard)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/accounts/top-holders",
      ),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });
});

// #8803: delegated_tao used to be a raw cross-subnet SUM of alpha, added to
// genuine System::Account free_tao. Production's top row reported 14,984,421
// "TAO" -- 71% of a supply hard-capped at 21,000,000 -- and the top five rows
// summed to 1.57x max supply. The conversion itself lives in the SQL
// aggregate (tests/data-api.test.ts asserts that query's shape); these tests
// pin the two consequences that made the bug matter: the leaderboard ORDER
// was wrong, and the headline number was not a quantity that exists.
describe("delegated_tao is TAO, not cross-subnet alpha (#8803)", () => {
  const TAO_MAX_SUPPLY = 21_000_000;

  // Two accounts, each with 1,000,000 alpha of delegated stake, but on
  // subnets whose alpha prices differ by 150x -- the real spread (~0.002 to
  // ~0.3 TAO) that makes the overstatement non-uniform rather than a scaling
  // error a reader could mentally correct for.
  const CHEAP_ALPHA_PRICE = 0.002;
  const RICH_ALPHA_PRICE = 0.3;
  const positions = [
    // 5CheapWhale holds MORE alpha, all of it on the cheap subnet. 25M is a
    // deliberately unremarkable alpha balance and an IMPOSSIBLE TAO one --
    // one subnet's alpha supply is a different token, not bounded by TAO's
    // 21M cap, which is exactly why summing alpha as TAO breaks the cap.
    {
      ss58: "5CheapWhale",
      netuid: 12,
      alpha: 25_000_000,
      price: CHEAP_ALPHA_PRICE,
    },
    // 5RichHolder holds LESS alpha, on the expensive subnet -- and is worth
    // ~29x more in real TAO.
    { ss58: "5RichHolder", netuid: 4, alpha: 200_000, price: RICH_ALPHA_PRICE },
  ];

  // What the query produced BEFORE the fix: alpha summed raw, no price.
  const unconvertedRows = positions.map((p) => ({
    ss58: p.ss58,
    free_tao: 0,
    delegated_tao: p.alpha,
    captured_at: 1750000000000,
  }));
  // What it produces AFTER: each position valued at its own netuid's price.
  const convertedRows = positions.map((p) => ({
    ss58: p.ss58,
    free_tao: 0,
    delegated_tao: p.alpha * p.price,
    captured_at: 1750000000000,
  }));

  test("the price-weighted sum is not the raw sum", () => {
    const converted = buildTopHoldersList(convertedRows) as Row;
    const byId = new Map(
      (converted.accounts as Row[]).map((a: Row) => [a.ss58, a]),
    );
    assert.equal(byId.get("5CheapWhale")?.delegated_tao, 50000);
    assert.equal(byId.get("5RichHolder")?.delegated_tao, 60000);
    // The raw sums the old query returned, for contrast.
    assert.equal(unconvertedRows[0].delegated_tao, 25_000_000);
    assert.equal(unconvertedRows[1].delegated_tao, 200_000);
  });

  test("the default total_tao ordering FLIPS versus the unconverted sum", () => {
    // Before: whoever holds the most alpha tokens wins, regardless of value.
    const before = buildTopHoldersList(unconvertedRows) as Row;
    assert.deepEqual(
      (before.accounts as Row[]).map((a: Row) => a.ss58),
      ["5CheapWhale", "5RichHolder"],
    );
    // After: whoever holds the most TAO wins. This flip -- not the magnitude
    // -- is why a flat multiplier would not have fixed anything.
    const after = buildTopHoldersList(convertedRows) as Row;
    assert.deepEqual(
      (after.accounts as Row[]).map((a: Row) => a.ss58),
      ["5RichHolder", "5CheapWhale"],
    );
  });

  test("a netuid with no usable alpha price is excluded, never counted as 0", () => {
    // The SQL's WHERE drops that netuid's rows from the aggregate, so the
    // account still appears with the value of its PRICED positions -- it is
    // not zeroed, and it is not silently credited with unpriced alpha.
    const withUnpricedNetuid = [
      {
        ss58: "5PartlyPriced",
        free_tao: 10,
        // Only the priced netuid contributes: 200_000 * 0.3. The unpriced
        // netuid's 5,000,000 alpha is absent from the sum entirely.
        delegated_tao: 200_000 * RICH_ALPHA_PRICE,
        captured_at: 1750000000000,
      },
    ];
    const data = buildTopHoldersList(withUnpricedNetuid) as Row;
    assert.equal(data.accounts[0].delegated_tao, 60000);
    assert.equal(data.accounts[0].total_tao, 60010);
    // A silent 0 for the unpriced netuid would look identical to a real
    // zero-value position; exclusion keeps the priced part honest.
    assert.notEqual(data.accounts[0].delegated_tao, 0);
  });

  test("no account reports more TAO than can exist", () => {
    // A hard assertion, deliberately NOT a runtime clamp: a clamp would round
    // a future regression away instead of failing CI. Every account in the
    // converted leaderboard must sit under the 21M hard cap; the unconverted
    // one blows straight through it, which is exactly what production did.
    const after = buildTopHoldersList(convertedRows) as Row;
    for (const account of after.accounts as Row[]) {
      assert.ok(
        (account.total_tao as number) <= TAO_MAX_SUPPLY,
        `${account.ss58} reports ${account.total_tao} TAO, above the ${TAO_MAX_SUPPLY} hard cap`,
      );
    }
    // Sanity: the same fixture through the OLD raw-alpha aggregate really
    // does break the cap, so the bound above is a live check and not a
    // vacuous one. Production's five top rows summed to 33,036,023 this way.
    const before = buildTopHoldersList(unconvertedRows) as Row;
    assert.ok(
      (before.accounts[0].total_tao as number) > TAO_MAX_SUPPLY,
      "sanity: the unconverted sum really is impossible",
    );
  });
});
