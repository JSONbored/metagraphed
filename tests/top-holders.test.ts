import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildTopHoldersList,
  compareTopHoldersSort,
  topHoldersStampKey,
  TOP_HOLDERS_SORTS,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
} from "../src/top-holders.ts";
import { handleRequest } from "../workers/api.ts";
import { TopHoldersArtifactSchema } from "../schemas-src/routes/top-holders.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const ctx = { waitUntil: (p: Promise<unknown>) => p };

// A stored row with a measured free balance and legacy financial guesses.
// The formatter must preserve free TAO while suppressing unsupported wealth.
const ROW = {
  ss58: "5Whale1",
  free_tao: 1000.5,
  delegated_tao: 250.25,
  total_tao: 1250.75,
  captured_at: 1750000000000,
};

describe("buildTopHoldersList", () => {
  test("publishes measured free TAO in version 2 and suppresses legacy wealth", () => {
    const data = buildTopHoldersList([ROW]) as Row;
    assert.equal(data.schema_version, 2);
    assert.equal(data.sort, "free_tao");
    assert.equal(data.accounts[0].free_tao, 1000.5);
    assert.equal(data.accounts[0].delegated_tao, null);
    assert.equal(data.accounts[0].total_tao, null);
  });

  test("the public quantity contract accepts version 2 and rejects a legacy financial envelope", () => {
    const current = buildTopHoldersList([ROW]);
    assert.equal(TopHoldersArtifactSchema.safeParse(current).success, true);
    assert.equal(
      TopHoldersArtifactSchema.safeParse({
        ...current,
        schema_version: 1,
        sort: "total_tao",
        accounts: [{ ...ROW, total_tao: 1250.75 }],
      }).success,
      false,
    );
    assert.equal(
      TopHoldersArtifactSchema.safeParse({ ...current, schema_version: 1 })
        .success,
      false,
    );
  });

  test("an account present from account_balances alone retains free TAO without invented wealth", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5FreeOnly",
        free_tao: 500,
        delegated_tao: 0,
        captured_at: 1750000000000,
      },
    ]) as Row;
    assert.equal(data.account_count, 1);
    assert.equal(data.accounts[0].free_tao, 500);
    assert.equal(data.accounts[0].delegated_tao, null);
    assert.equal(data.accounts[0].total_tao, null);
  });

  test("a legacy delegated-only row cannot manufacture free TAO or total wealth", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5DelegatedOnly",
        delegated_tao: 300,
        captured_at: null,
      },
    ]) as Row;
    assert.equal(data.account_count, 1);
    assert.equal(data.accounts[0].free_tao, null);
    assert.equal(data.accounts[0].delegated_tao, null);
    assert.equal(data.accounts[0].total_tao, null);
    assert.equal(data.accounts[0].last_updated, null);
  });

  test("sorts by measured free_tao by default, descending, tie-broken by ss58", () => {
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

  test("unsupported financial sort values fall back to free TAO without ranking on guesses", () => {
    for (const sort of ["delegated_tao", "total_tao"]) {
      const data = buildTopHoldersList(
        [
          {
            ss58: "5HighFree",
            free_tao: 500,
            delegated_tao: 0,
            total_tao: 500,
          },
          {
            ss58: "5HighGuess",
            free_tao: 10,
            delegated_tao: 1000,
            total_tao: 1010,
          },
        ],
        { sort },
      ) as Row;
      assert.equal(data.sort, "free_tao");
      assert.deepEqual(
        (data.accounts as Row[]).map((row) => row.ss58),
        ["5HighFree", "5HighGuess"],
      );
      for (const row of data.accounts as Row[]) {
        assert.equal(row.delegated_tao, null);
        assert.equal(row.total_tao, null);
      }
    }
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

  // #9632. ONE ROW, TWO VINTAGES, since the holdings columns got their own
  // three-hourly producer: `net_flow_*` is as old as the daily lakehouse scan
  // and the holdings cells as old as their last store refresh. Reporting one
  // number for both would have to be wrong about one of them, and the number a
  // caller wants is the age of the column they ranked by.
  describe("two vintages, one artifact", () => {
    const FLOW_AT = 1_786_800_000_000;
    const HOLDINGS_AT = 1_786_818_000_000;
    const rows = [
      {
        ss58: "5A",
        free_tao: 10,
        delegated_tao: 1,
        net_flow_30d: 5,
        captured_at: FLOW_AT,
        holdings_captured_at: HOLDINGS_AT,
      },
    ];

    test("a holdings-sorted page reports the holdings vintage", () => {
      for (const sort of ["free_tao"]) {
        const data = buildTopHoldersList(rows, { sort }) as Row;
        assert.equal(
          data.captured_at,
          new Date(HOLDINGS_AT).toISOString(),
          sort,
        );
        assert.equal(
          (data.accounts as Row[])[0]!.last_updated,
          new Date(HOLDINGS_AT).toISOString(),
          sort,
        );
      }
    });

    test("a flow-sorted page reports the flow vintage", () => {
      for (const sort of ["net_flow_7d", "net_flow_30d", "net_flow_90d"]) {
        const data = buildTopHoldersList(rows, { sort }) as Row;
        assert.equal(data.captured_at, new Date(FLOW_AT).toISOString(), sort);
      }
    });

    // A body written before the split carries no `holdings_captured_at` at
    // all. Falling back to `captured_at` is what keeps such an artifact
    // answering exactly as it did, rather than reporting a null vintage for
    // the supported free sort the moment this deploys.
    test("a pre-split row falls back to its one stamp", () => {
      const data = buildTopHoldersList(
        [{ ss58: "5A", free_tao: 10, delegated_tao: 1, captured_at: FLOW_AT }],
        { sort: "free_tao" },
      ) as Row;
      assert.equal(data.captured_at, new Date(FLOW_AT).toISOString());
    });

    // The mapping itself, stated once so it cannot be re-derived from a
    // string prefix somewhere else.
    test("every sort maps to exactly one stamp", () => {
      assert.deepEqual(
        Object.fromEntries(
          TOP_HOLDERS_SORTS.map((s) => [s, topHoldersStampKey(s)]),
        ),
        {
          free_tao: "holdings_captured_at",
          net_flow_7d: "captured_at",
          net_flow_30d: "captured_at",
          net_flow_90d: "captured_at",
        },
      );
    });

    // The envelope's stamp is a MAX over the rows it actually served, so a
    // page mixing a refreshed row with a flow-only one reports the freshest
    // holdings figure rather than being dragged back by a row that has none.
    test("a flow-only row does not drag a holdings page's vintage back", () => {
      const data = buildTopHoldersList(
        [...rows, { ss58: "5B", net_flow_30d: 9, captured_at: FLOW_AT }],
        { sort: "free_tao" },
      ) as Row;
      assert.equal(data.captured_at, new Date(HOLDINGS_AT).toISOString());
      // ...and that row still reports its own age, which is all it has.
      const b = (data.accounts as Row[]).find((a) => a.ss58 === "5B");
      assert.equal(b!.last_updated, new Date(FLOW_AT).toISOString());
    });
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

  // #9469 changed this from 0 to null, and the change is the point: a row the
  // answering tier cannot read is not a row worth 0 TAO. A zero ranks and
  // ranks; a null ranks last and cannot become a measured balance.
  test("a negative or non-finite balance value degrades to null, not 0", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5Bad",
        free_tao: -50,
        delegated_tao: "not-a-number",
        captured_at: 1,
      },
    ]) as Row;
    assert.equal(data.accounts[0].free_tao, null);
    assert.equal(data.accounts[0].delegated_tao, null);
    assert.equal(data.accounts[0].total_tao, null);
  });

  // The distinction the null exists for: a MEASURED zero still behaves like a
  // number everywhere a null does not.
  test("a measured free 0 stays 0 while unsupported financial zeros become null", () => {
    const data = buildTopHoldersList([
      { ss58: "5Zeroed", free_tao: 0, delegated_tao: 0, captured_at: 1 },
    ]) as Row;
    assert.equal(data.accounts[0].free_tao, 0);
    assert.equal(data.accounts[0].delegated_tao, null);
    assert.equal(data.accounts[0].total_tao, null);
  });

  // A flow-lane row carries no holdings columns at all. total_tao must not
  // quietly become "the half we happen to know".
  test("a known free balance cannot become an unsupported partial total", () => {
    const data = buildTopHoldersList([
      { ss58: "5FlowOnly", net_flow_7d: 12.5, captured_at: 1 },
      { ss58: "5HalfKnown", free_tao: 500, captured_at: 1 },
    ]) as Row;
    const byKey = Object.fromEntries(
      (data.accounts as { ss58: string }[]).map((a) => [a.ss58, a]),
    ) as Record<string, Row>;
    assert.equal(byKey["5FlowOnly"]!.total_tao, null);
    assert.equal(byKey["5FlowOnly"]!.net_flow_7d, 12.5);
    assert.equal(byKey["5HalfKnown"]!.free_tao, 500);
    assert.equal(byKey["5HalfKnown"]!.total_tao, null);
  });

  // Number("") is 0, so a blank cell is exactly the coercion that would
  // manufacture a confident zero balance out of nothing.
  test("a blank-string balance cell is absent, not zero", () => {
    const data = buildTopHoldersList([
      { ss58: "5Blank", free_tao: "  ", delegated_tao: "", captured_at: 1 },
    ]) as Row;
    assert.equal(data.accounts[0].free_tao, null);
    assert.equal(data.accounts[0].delegated_tao, null);
  });

  test("missing and blank flow cells stay null while numeric zero and signed strings remain observations", () => {
    for (const missing of [
      null,
      undefined,
      "",
      "  ",
      "\t",
      NaN,
      Infinity,
      "not-a-number",
    ]) {
      const data = buildTopHoldersList([
        {
          ss58: "5Missing",
          net_flow_7d: missing,
          net_flow_30d: missing,
          net_flow_90d: missing,
        },
      ]) as Row;
      for (const key of ["net_flow_7d", "net_flow_30d", "net_flow_90d"])
        assert.equal(data.accounts[0][key], null, `${key}: ${String(missing)}`);
    }
    const data = buildTopHoldersList([
      {
        ss58: "5Measured",
        free_tao: "0",
        net_flow_7d: "0",
        net_flow_30d: "-5.125",
        net_flow_90d: "9.25",
      },
    ]) as Row;
    assert.equal(data.accounts[0].free_tao, 0);
    assert.equal(data.accounts[0].net_flow_7d, 0);
    assert.equal(data.accounts[0].net_flow_30d, -5.125);
    assert.equal(data.accounts[0].net_flow_90d, 9.25);
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

  test("TOP_HOLDERS_SORTS contains only free TAO and the three observed flows", () => {
    assert.deepEqual(TOP_HOLDERS_SORTS, [
      "free_tao",
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
    delegated_tao: null,
    total_tao: null,
    net_flow_7d: -5,
    net_flow_30d: null,
    net_flow_90d: null,
    last_updated: null,
  };
  const missing = {
    ss58: "5Null",
    free_tao: 0,
    delegated_tao: null,
    total_tao: null,
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
    assert.equal(body.data.schema_version, 2);
    assert.equal(body.data.sort, "free_tao");
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

  test("rejects deprecated financial rankings rather than silently serving a guessed order", async () => {
    for (const sort of ["delegated_tao", "total_tao"]) {
      const res = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/accounts/top-holders?sort=${sort}`,
        ),
        createLocalArtifactEnv() as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 400, sort);
      const body = await res.json();
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "sort");
    }
  });

  test("a stored version 1 projection serves version 2 free and flow pages with wealth guesses suppressed", async () => {
    const flowAt = 1_750_000_000_000;
    const holdingsAt = flowAt + 3_600_000;
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            json: async () => ({
              schema_version: 1,
              generated_at: new Date(flowAt).toISOString(),
              sorts: ["free_tao", "delegated_tao", "total_tao", "net_flow_30d"],
              rows: [
                {
                  ss58: "5HighFree",
                  free_tao: 500.125,
                  delegated_tao: 1,
                  total_tao: 501.125,
                  net_flow_30d: -5,
                  captured_at: flowAt,
                  holdings_captured_at: holdingsAt,
                },
                {
                  ss58: "5HighGuess",
                  free_tao: 10,
                  delegated_tao: 25_000_000,
                  total_tao: 25_000_010,
                  net_flow_30d: 9,
                  captured_at: flowAt,
                  holdings_captured_at: holdingsAt,
                },
              ],
            }),
          };
        },
      },
    };
    for (const [sort, ids, stamp] of [
      ["free_tao", ["5HighFree", "5HighGuess"], holdingsAt],
      ["net_flow_30d", ["5HighGuess", "5HighFree"], flowAt],
    ] as const) {
      const res = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/accounts/top-holders?sort=${sort}`,
        ),
        env as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 200);
      const { data } = await res.json();
      assert.equal(data.schema_version, 2);
      assert.equal(data.sort, sort);
      assert.deepEqual(
        data.accounts.map((row: Row) => row.ss58),
        ids,
      );
      assert.equal(data.captured_at, new Date(stamp).toISOString());
      for (const account of data.accounts as Row[]) {
        assert.equal(account.delegated_tao, null);
        assert.equal(account.total_tao, null);
      }
      const highFree = (data.accounts as Row[]).find(
        (row) => row.ss58 === "5HighFree",
      )!;
      assert.equal(highFree.free_tao, 500.125);
      assert.equal(highFree.net_flow_30d, -5);
    }
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

  // RE-POINTED AT THE LIVE TIER (#10190). This drove the CSV export through
  // `METAGRAPH_TOP_HOLDERS_SOURCE: "postgres"` and a DATA_API stub -- a
  // configuration no deployment has: the flag reads "retired" everywhere and is
  // absent from FORWARDABLE_TIER_FLAGS, so the arm it exercised declined on every
  // real request. The CSV formatter and its formula-injection guard are worth
  // proving, so the setup moves to the flow tier that actually answers
  // (src/top-holders-flow-tier.ts, an R2 projection) rather than the test being
  // deleted along with its coverage.
  test("?format=csv exports the leaderboard rows via the live flow tier", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            json: async () => ({
              schema_version: 1,
              generated_at: new Date(1750000000000).toISOString(),
              row_count: 1,
              sorts: ["net_flow_7d", "net_flow_30d", "net_flow_90d"],
              rows: [
                {
                  ss58: "5Whale1",
                  free_tao: 1000.5,
                  delegated_tao: 250.25,
                  total_tao: 1250.75,
                  net_flow_7d: -50,
                  net_flow_30d: 200,
                  net_flow_90d: 900,
                  captured_at: 1750000000000,
                },
              ],
            }),
          };
        },
      },
    };
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/top-holders?format=csv&sort=net_flow_7d",
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
    assert.match(lines[1], /^5Whale1,1000\.5,,,'-50,200,900,/);
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

// Native portfolio valuation is not established by multiplying pool weights or
// dimensionless shares by a spot price. Even numerically plausible legacy cells
// must stay null; suppression cannot depend on whether the guess exceeds supply.
describe("legacy financial cells are suppressed", () => {
  const guesses = [
    {
      ss58: "5RawAlpha",
      free_tao: 10,
      delegated_tao: 25_000_000,
      total_tao: 25_000_010,
    },
    {
      ss58: "5SpotPrice",
      free_tao: 20,
      delegated_tao: 50_000,
      total_tao: 50_020,
    },
    { ss58: "5Shares", free_tao: 30, delegated_tao: 0.55 * 100, total_tao: 85 },
    { ss58: "5ZeroGuess", free_tao: 0, delegated_tao: 0, total_tao: 0 },
  ];

  test("raw alpha, spot-price guesses, share guesses and guessed zero are all null", () => {
    const data = buildTopHoldersList(guesses) as Row;
    assert.deepEqual(
      (data.accounts as Row[]).map((row) => row.ss58),
      ["5Shares", "5SpotPrice", "5RawAlpha", "5ZeroGuess"],
    );
    for (const account of data.accounts as Row[]) {
      assert.equal(account.delegated_tao, null, account.ss58);
      assert.equal(account.total_tao, null, account.ss58);
      assert.equal(
        account.free_tao,
        guesses.find((row) => row.ss58 === account.ss58)!.free_tao,
      );
    }
  });

  test("numeric-string financial guesses are suppressed while numeric-string free TAO remains measured", () => {
    const data = buildTopHoldersList([
      {
        ss58: "5Stored",
        free_tao: "42.125",
        delegated_tao: "8",
        total_tao: "50.125",
      },
    ]) as Row;
    assert.equal(data.accounts[0].free_tao, 42.125);
    assert.equal(data.accounts[0].delegated_tao, null);
    assert.equal(data.accounts[0].total_tao, null);
  });

  test("legacy wealth cannot reorder a page ranked by an observed flow", () => {
    const data = buildTopHoldersList(
      [
        { ...guesses[0], net_flow_30d: -5 },
        { ...guesses[1], net_flow_30d: 0 },
        { ...guesses[2], net_flow_30d: 3 },
      ],
      { sort: "net_flow_30d" },
    ) as Row;
    assert.deepEqual(
      (data.accounts as Row[]).map((row) => row.ss58),
      ["5Shares", "5SpotPrice", "5RawAlpha"],
    );
    assert.deepEqual(
      (data.accounts as Row[]).map((row) => row.net_flow_30d),
      [3, 0, -5],
    );
  });
});
