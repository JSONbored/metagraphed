import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildTopHoldersList,
  TOP_HOLDERS_SORTS,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
} from "../src/top-holders.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const ctx = { waitUntil: (p) => p };

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
    const data = buildTopHoldersList([ROW]);
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
    ]);
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
    ]);
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
    ]);
    assert.deepEqual(
      data.accounts.map((a) => a.ss58),
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
    );
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
    );
    assert.equal(data.accounts[0].ss58, "5HighDelegated");
  });

  test("falls back to the default sort for an unrecognized value", () => {
    const data = buildTopHoldersList([ROW], { sort: "bogus" });
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
    });
    assert.equal(over.limit, TOP_HOLDERS_LIMIT_MAX);
    const fractional = buildTopHoldersList(many, { limit: 2.9 });
    assert.equal(fractional.limit, 2);
    assert.equal(fractional.accounts.length, 2);
  });

  test("limit=0 returns an empty page, not the default", () => {
    const data = buildTopHoldersList([ROW], { limit: 0 });
    assert.equal(data.limit, 0);
    assert.equal(data.accounts.length, 0);
    assert.equal(data.account_count, 1); // account_count is the full match count, not the page size
  });

  test("a non-finite limit falls back to the default", () => {
    const data = buildTopHoldersList([ROW], { limit: "not-a-number" });
    assert.equal(data.limit, TOP_HOLDERS_LIMIT_DEFAULT);
  });

  test("captured_at is the latest across all rows", () => {
    const data = buildTopHoldersList([
      { ss58: "5A", free_tao: 1, delegated_tao: 0, captured_at: 100 },
      { ss58: "5B", free_tao: 1, delegated_tao: 0, captured_at: 200 },
    ]);
    assert.equal(data.captured_at, new Date(200).toISOString());
  });

  test("skips a row with no ss58", () => {
    const data = buildTopHoldersList([{ free_tao: 1, delegated_tao: 0 }]);
    assert.equal(data.account_count, 0);
  });

  test("a cold/empty store yields a schema-stable empty leaderboard", () => {
    const data = buildTopHoldersList([]);
    assert.equal(data.account_count, 0);
    assert.deepEqual(data.accounts, []);
    assert.equal(data.captured_at, null);
  });

  test("a non-array input degrades to an empty leaderboard", () => {
    const data = buildTopHoldersList(null);
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
    ]);
    assert.equal(data.accounts[0].free_tao, 0);
    assert.equal(data.accounts[0].delegated_tao, 0);
    assert.equal(data.accounts[0].total_tao, 0);
  });

  test("captured_at of 0 or negative degrades to a null last_updated, distinct from a missing captured_at", () => {
    const data = buildTopHoldersList([
      { ss58: "5Zero", free_tao: 1, delegated_tao: 0, captured_at: 0 },
    ]);
    assert.equal(data.accounts[0].last_updated, null);
    assert.equal(data.captured_at, null);
  });

  test("a finite but out-of-Date-range captured_at degrades to a null last_updated", () => {
    const data = buildTopHoldersList([
      { ss58: "5Huge", free_tao: 1, delegated_tao: 0, captured_at: 1e20 },
    ]);
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

  test("net_flow_7d/30d/90d default to 0 when the flow rollup has no row for this account", () => {
    const data = buildTopHoldersList([ROW]);
    assert.equal(data.accounts[0].net_flow_7d, 0);
    assert.equal(data.accounts[0].net_flow_30d, 0);
    assert.equal(data.accounts[0].net_flow_90d, 0);
  });

  test("a negative net flow (net outflow) is preserved, not clamped to 0", () => {
    const data = buildTopHoldersList([
      { ...ROW, net_flow_7d: -500.25, net_flow_30d: -1000, net_flow_90d: -1 },
    ]);
    assert.equal(data.accounts[0].net_flow_7d, -500.25);
    assert.equal(data.accounts[0].net_flow_30d, -1000);
    assert.equal(data.accounts[0].net_flow_90d, -1);
  });

  test("a non-finite net flow value falls back to 0", () => {
    const data = buildTopHoldersList([
      { ...ROW, net_flow_30d: "not-a-number" },
    ]);
    assert.equal(data.accounts[0].net_flow_30d, 0);
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
    );
    assert.equal(data.accounts[0].ss58, "5BigInflow");
    assert.equal(data.accounts[1].ss58, "5Outflow");
  });
});

describe("GET /api/v1/accounts/top-holders via the Worker", () => {
  test("is schema-stable when the Postgres tier is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts/top-holders"),
      createLocalArtifactEnv(),
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
      createLocalArtifactEnv(),
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
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unrecognized query param with 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/top-holders?bogus=1",
      ),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("is dispatched before the generic /api/v1/accounts/{ss58} route (never mistaken for an address)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/accounts/top-holders"),
      createLocalArtifactEnv(),
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
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 2);
    // net_flow_7d (-50) gets a leading `'` -- the formula-injection guard for
    // CSV cells starting with -/+/=/@ (workers/csv.mjs), same as any other
    // negative-leading cell in this codebase's CSV exports.
    assert.match(lines[1], /^5Whale1,1000\.5,250\.25,1250\.75,'-50,200,900,/);
  });

  test("testnet has no variant (mainnet-only leaderboard)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/accounts/top-holders",
      ),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
