// The cross-subnet alpha-ownership ranking (src/chain-holders.ts, #9607).
//
// Two properties carry the weight, and neither is about the happy path.
//
// ALPHA IS NEVER SUMMED ACROSS SUBNETS. Each subnet's alpha is a different
// token, so a network total has no unit -- #8803 shipped exactly that sum and
// production reported an account at 71% of TAO's hard cap. The rollup is
// asserted to carry counts and a median of within-subnet ratios and NOTHING
// additive, because the absence is the contract rather than an omission.
//
// AND A SUBNET THAT COULD NOT BE MEASURED MUST NOT READ AS THE LEAST
// CONCENTRATED ONE. A null share sorting to the top of an ascending list would
// present "we don't know" as a finding, on the route whose whole purpose is to
// say which subnets are captured.
//
// The SQL runs against REAL SQLite through the real migrations: it leans on a
// window function that the per-subnet twin deliberately avoids, so "does D1
// support this" is a question only a database answers.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
  CHAIN_HOLDERS_SORTS,
  DEFAULT_CHAIN_HOLDERS_SORT,
  MAJORITY_SHARE,
  buildChainHolders,
  chainHoldersSql,
  loadChainHolders,
  type ChainHoldersRead,
} from "../src/chain-holders.ts";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const MIGRATIONS = [
  "0011_nominator_positions.sql",
  "0019_hotkey_alpha.sql",
  "0021_hotkey_alpha_passes.sql",
  "0022_nominator_positions_hotkey_netuid.sql",
  "0023_nominator_positions_netuid.sql",
].map((f) =>
  fs.readFileSync(path.join(process.cwd(), "migrations/d1", f), "utf8"),
);

const PASS = 1_785_900_000_000;
const POSITIONS_AT = 1_785_953_674_407;
const ck = (n: number) => `5Coldkey${String(n).padStart(40, "0")}`;
const hk = (n: number) => `5Hotkey0${String(n).padStart(40, "0")}`;

let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      const run = (values: unknown[]) => ({
        async all() {
          return { results: db.prepare(text).all(...(values as never[])) };
        },
        async first() {
          return db.prepare(text).get(...(values as never[])) ?? null;
        },
      });
      return { bind: (...v: unknown[]) => run(v), ...run([]) };
    },
  };
}

const env = () => ({ METAGRAPH_HEALTH_DB: d1() }) as unknown as Env;

function completePass(capturedAt = PASS) {
  db.prepare(
    `INSERT INTO hotkey_alpha_passes (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(capturedAt, 1, 1, capturedAt + 1000);
}
function pool(hotkey: string, netuid: number, total: number, at = PASS) {
  db.prepare(
    `INSERT INTO hotkey_alpha (hotkey, netuid, total_alpha, captured_at) VALUES (?, ?, ?, ?)`,
  ).run(hotkey, netuid, total, at);
}
function position(
  coldkey: string,
  hotkey: string,
  netuid: number,
  frac: number,
) {
  db.prepare(
    `INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(coldkey, hotkey, netuid, frac, POSITIONS_AT);
}

/**
 * Three subnets with deliberately different shapes:
 *   netuid 1 — one holder owning everything (top1 = 1.0)
 *   netuid 2 — two holders, 60/40 (a majority holder, but not sole)
 *   netuid 3 — four holders at 25% each (no majority holder)
 */
function threeSubnets() {
  completePass();
  pool(hk(1), 1, 1000);
  position(ck(1), hk(1), 1, 1.0);

  pool(hk(2), 2, 1000);
  position(ck(2), hk(2), 2, 0.6);
  position(ck(3), hk(2), 2, 0.4);

  pool(hk(3), 3, 1000);
  for (const c of [4, 5, 6, 7]) position(ck(c), hk(3), 3, 0.25);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const s of MIGRATIONS) db.exec(s);
});

describe("loadChainHolders against real SQLite", () => {
  test("ranks every subnet in one statement, window function and all", async () => {
    threeSubnets();
    const read = await loadChainHolders(d1());
    assert.equal(read.decline, null);
    assert.equal(read.capturedAt, PASS);
    const byNetuid = Object.fromEntries(
      read.rows.map((r) => [r.netuid, r]),
    ) as Record<string, Row>;
    assert.equal(byNetuid["1"].holder_count, 1);
    assert.equal(byNetuid["1"].top1_alpha, 1000);
    assert.equal(byNetuid["2"].holder_count, 2);
    assert.equal(byNetuid["2"].top1_alpha, 600);
    assert.equal(byNetuid["3"].holder_count, 4);
    // top5 over four holders is all of them -- the prefix saturates rather than
    // erroring, which is what makes a small subnet comparable to a large one.
    assert.equal(byNetuid["3"].top5_alpha, 1000);
    assert.equal(byNetuid["1"].top_holder, ck(1));
  });

  test("scopes to the proven pass, ignoring a newer unproven one", async () => {
    completePass();
    pool(hk(1), 1, 1000);
    pool(hk(2), 2, 500, PASS + 5000);
    position(ck(1), hk(1), 1, 1.0);
    position(ck(2), hk(2), 2, 1.0);
    const read = await loadChainHolders(d1());
    assert.deepEqual(
      read.rows.map((r) => r.netuid),
      [1],
    );
  });
});

describe("loadChainHolders declines", () => {
  test("no binding is unavailable", async () => {
    assert.equal((await loadChainHolders(null)).decline, "unavailable");
    assert.equal((await loadChainHolders({} as never)).decline, "unavailable");
  });

  test("no complete pass declines rather than ranking a partial ledger", async () => {
    pool(hk(1), 1, 1000);
    position(ck(1), hk(1), 1, 1.0);
    assert.equal(
      (await loadChainHolders(d1())).decline,
      "pool_totals_unproven",
    );
  });

  test("a missing passes table is unavailable", async () => {
    db.exec("DROP TABLE hotkey_alpha_passes");
    assert.equal((await loadChainHolders(d1())).decline, "unavailable");
  });

  test("a failed read declines rather than throwing", async () => {
    completePass();
    db.exec("DROP TABLE nominator_positions");
    assert.equal((await loadChainHolders(d1())).decline, "unavailable");
  });

  test("a non-array result declines", async () => {
    completePass();
    const broken = {
      prepare(text: string) {
        const real = d1().prepare(text);
        return {
          all: async () => ({ results: undefined }),
          first: real.first,
          bind: (...v: unknown[]) => real.bind(...v),
        };
      },
    };
    assert.equal(
      (await loadChainHolders(broken as never)).decline,
      "unavailable",
    );
  });
});

describe("the SQL states its own contract", () => {
  test("partitions per subnet and scopes to the pass", () => {
    const sql = chainHoldersSql(PASS);
    assert.match(
      sql,
      /ROW_NUMBER\(\) OVER \(PARTITION BY netuid ORDER BY alpha DESC\)/,
    );
    assert.match(sql, new RegExp(`ha\\.captured_at = ${PASS}`));
    for (const n of [1, 5, 10, 20]) {
      assert.match(sql, new RegExp(`rn <= ${n} THEN alpha`));
    }
  });
});

describe("buildChainHolders", () => {
  const read = (over: Partial<ChainHoldersRead> = {}): ChainHoldersRead => ({
    rows: [],
    capturedAt: PASS,
    decline: null,
    ...over,
  });
  const row = (netuid: number, total: number, tops: number[], holders = 4) => ({
    netuid,
    holder_count: holders,
    total_alpha: total,
    top1_alpha: tops[0],
    top5_alpha: tops[1],
    top10_alpha: tops[2],
    top20_alpha: tops[3],
    top_holder: ck(netuid),
    positions_captured_at: POSITIONS_AT,
  });

  test("computes shares per subnet and never a cross-subnet total", () => {
    const card = buildChainHolders(
      read({ rows: [row(1, 1000, [500, 800, 900, 1000])] }),
      { limit: 20 },
    );
    const s = (card.subnets as Row[])[0];
    assert.equal(s.top1_share, 0.5);
    assert.equal(s.top20_share, 1);
    assert.equal(s.total_alpha, 1000);
    // THE ASSERTION THIS FILE EXISTS FOR: no additive network figure.
    const network = card.network as Row;
    assert.equal("total_alpha" in network, false);
    assert.deepEqual(Object.keys(network).sort(), [
      "median_top1_share",
      "subnets_measured",
      "subnets_with_majority_holder",
      "subnets_with_single_holder",
    ]);
  });

  test("counts majority and single-holder subnets", () => {
    const card = buildChainHolders(
      read({
        rows: [
          row(1, 1000, [1000, 1000, 1000, 1000], 1), // sole holder
          row(2, 1000, [600, 1000, 1000, 1000], 2), // majority, not sole
          row(3, 1000, [250, 1000, 1000, 1000], 4), // neither
        ],
      }),
    );
    const n = card.network as Row;
    assert.equal(n.subnets_measured, 3);
    assert.equal(n.subnets_with_majority_holder, 2);
    assert.equal(n.subnets_with_single_holder, 1);
    // Median of [0.25, 0.6, 1.0] -- and it must be the median of the SORTED
    // values, not the middle of whatever order the caller's sort produced.
    assert.equal(n.median_top1_share, 0.6);
  });

  test("the median is taken over sorted shares whatever the sort", () => {
    // Four subnets so the median averages the middle pair: [0.1,0.2,0.8,0.9]
    // -> 0.5. Requested by holder_count, which orders them 0.9,0.8,0.2,0.1 --
    // an unsorted median would read 0.8 here.
    const rows = [
      row(1, 1000, [100, 100, 100, 100], 40),
      row(2, 1000, [200, 200, 200, 200], 30),
      row(3, 1000, [800, 800, 800, 800], 20),
      row(4, 1000, [900, 900, 900, 900], 10),
    ];
    const card = buildChainHolders(read({ rows }), { sort: "holder_count" });
    assert.equal((card.network as Row).median_top1_share, 0.5);
  });

  test.each([...CHAIN_HOLDERS_SORTS])("sorts descending by %s", (sort) => {
    const card = buildChainHolders(
      read({
        rows: [
          row(1, 100, [10, 20, 30, 40], 1),
          row(2, 900, [800, 850, 880, 900], 50),
          row(3, 500, [200, 300, 400, 500], 9),
        ],
      }),
      { sort },
    );
    const values = (card.subnets as Row[]).map((s) => s[sort] as number);
    assert.deepEqual(
      values,
      [...values].sort((a, b) => b - a),
    );
    assert.equal(card.sort, sort);
  });

  test("an unmeasurable subnet sorts LAST, never first", () => {
    // total_alpha 0 makes every share null. Ascending-by-accident would put it
    // at the top of a "least concentrated" read, presenting missing data as a
    // finding on the exact route people would cite.
    const card = buildChainHolders(
      read({
        rows: [
          row(1, 0, [0, 0, 0, 0], 0),
          row(2, 1000, [900, 950, 990, 1000], 5),
          row(3, 1000, [100, 200, 300, 400], 9),
        ],
      }),
    );
    const order = (card.subnets as Row[]).map((s) => s.netuid);
    assert.deepEqual(order, [2, 3, 1]);
    assert.equal((card.subnets as Row[])[2].top1_share, null);
  });

  test("an unreadable row keeps its netuid and nulls everything else", () => {
    // The netuid is what makes the row addressable, so a row whose figures are
    // junk is still published as "this subnet, unmeasured" rather than dropped
    // -- dropping it would silently shrink subnet_count.
    const card = buildChainHolders(
      read({
        rows: [
          {
            netuid: 5,
            holder_count: -3,
            total_alpha: null,
            top1_alpha: "junk",
            top5_alpha: null,
            top10_alpha: null,
            top20_alpha: null,
            top_holder: 42,
            positions_captured_at: null,
          },
        ],
      }),
    );
    const s = (card.subnets as Row[])[0];
    assert.equal(s.netuid, 5);
    assert.equal(s.total_alpha, null);
    // A negative count is a broken read, not a measurement.
    assert.equal(s.holder_count, null);
    // A non-string coldkey is dropped rather than stringified into a fake address.
    assert.equal(s.top_holder, null);
    assert.equal(s.top1_share, null);
    assert.equal(card.subnet_count, 1);
  });

  test("two unmeasurable subnets order by netuid between themselves", () => {
    // Both sort keys null: without the tie-break they would keep whatever order
    // the database happened to return, and the page would shuffle between calls.
    const card = buildChainHolders(
      read({
        rows: [
          row(9, 0, [0, 0, 0, 0], 0),
          row(2, 0, [0, 0, 0, 0], 0),
          row(4, 1000, [500, 500, 500, 500]),
        ],
      }),
    );
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [4, 2, 9],
    );
  });

  test("a measurable subnet outranks an unmeasurable one from either side", () => {
    // The comparator sees its pair in whichever order the sort chooses, so both
    // null arms have to demote. Measurable subnets interleaved with nulls is
    // what exercises the arm the previous case does not.
    const card = buildChainHolders(
      read({
        rows: [
          row(1, 1000, [100, 100, 100, 100]),
          row(2, 0, [0, 0, 0, 0], 0),
          row(3, 1000, [900, 900, 900, 900]),
          row(4, 0, [0, 0, 0, 0], 0),
          row(5, 1000, [500, 500, 500, 500]),
        ],
      }),
    );
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [3, 5, 1, 2, 4],
    );
  });

  test("a non-integer or negative netuid is dropped, not coerced", () => {
    // A netuid is a u16 index. Rounding 1.5 to a subnet, or admitting -1, would
    // publish a row about a subnet that does not exist.
    const card = buildChainHolders(
      read({
        rows: [
          { ...row(1, 1000, [1, 1, 1, 1]), netuid: 1.5 },
          { ...row(2, 1000, [1, 1, 1, 1]), netuid: -1 },
          row(3, 1000, [1, 1, 1, 1]),
        ],
      }),
    );
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [3],
    );
  });

  test("ties break on netuid so the order is stable", () => {
    const card = buildChainHolders(
      read({
        rows: [
          row(7, 1000, [500, 500, 500, 500]),
          row(3, 1000, [500, 500, 500, 500]),
        ],
      }),
    );
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [3, 7],
    );
  });

  test("limit slices the page without moving subnet_count", () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      row(n, 1000, [n * 100, n * 100, n * 100, n * 100]),
    );
    const card = buildChainHolders(read({ rows }), { limit: 2 });
    assert.equal((card.subnets as Row[]).length, 2);
    assert.equal(card.subnet_count, 5);
    assert.equal((card.network as Row).subnets_measured, 5);
  });

  test("an absent limit returns every subnet", () => {
    const rows = [1, 2, 3].map((n) => row(n, 1000, [500, 600, 700, 800]));
    const card = buildChainHolders(read({ rows }));
    assert.equal((card.subnets as Row[]).length, 3);
    assert.equal(card.limit, null);
  });

  test("a row with no netuid is dropped rather than served as subnet 0", () => {
    const card = buildChainHolders(
      read({
        rows: [
          { ...row(1, 1000, [500, 500, 500, 500]), netuid: null },
          row(2, 1000, [500, 500, 500, 500]),
        ],
      }),
    );
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [2],
    );
  });

  test("carries the NEWEST positions stamp across subnets", () => {
    const card = buildChainHolders(
      read({
        rows: [
          {
            ...row(1, 1000, [1, 1, 1, 1]),
            positions_captured_at: POSITIONS_AT,
          },
          {
            ...row(2, 1000, [1, 1, 1, 1]),
            positions_captured_at: POSITIONS_AT + 9000,
          },
          { ...row(3, 1000, [1, 1, 1, 1]), positions_captured_at: null },
        ],
      }),
    );
    assert.equal(
      card.positions_captured_at,
      new Date(POSITIONS_AT + 9000).toISOString(),
    );
  });

  test("no usable stamps leaves positions_captured_at null", () => {
    const card = buildChainHolders(
      read({
        rows: [{ ...row(1, 1000, [1, 1, 1, 1]), positions_captured_at: 0 }],
        capturedAt: null,
      }),
    );
    assert.equal(card.positions_captured_at, null);
    assert.equal(card.captured_at, null);
  });

  test("an out-of-range stamp is null, not a thrown RangeError", () => {
    const card = buildChainHolders(read({ rows: [], capturedAt: 1e300 }));
    assert.equal(card.captured_at, null);
  });

  test("an unknown sort falls back to the default rather than erroring", () => {
    // The handler rejects an unsupported sort; the pure builder is separately
    // callable and must not order by a key that does not exist.
    const card = buildChainHolders(
      read({
        rows: [
          row(1, 1000, [100, 100, 100, 100]),
          row(2, 1000, [900, 900, 900, 900]),
        ],
      }),
      { sort: "nonsense" },
    );
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [2, 1],
    );
  });

  test.each(["pool_totals_unproven", "unavailable"] as const)(
    "a %s decline nulls every count",
    (reason) => {
      const card = buildChainHolders(read({ decline: reason }), { limit: 20 });
      assert.deepEqual(card.subnets, []);
      assert.deepEqual(card.degraded, { reason });
      assert.equal(card.subnet_count, null);
      assert.equal(card.captured_at, null);
      assert.deepEqual(card.network, {
        subnets_measured: null,
        subnets_with_majority_holder: null,
        subnets_with_single_holder: null,
        median_top1_share: null,
      });
    },
  );

  test("an empty but proven read is a measured zero, not a decline", () => {
    const card = buildChainHolders(read({ rows: [] }));
    assert.equal(card.degraded, undefined);
    assert.equal(card.subnet_count, 0);
    assert.equal((card.network as Row).median_top1_share, null);
  });

  test("MAJORITY_SHARE is the half it claims to be", () => {
    assert.equal(MAJORITY_SHARE, 0.5);
    assert.equal(CHAIN_HOLDERS_LIMIT_DEFAULT, 20);
    assert.equal(DEFAULT_CHAIN_HOLDERS_SORT, "top1_share");
  });
});

describe("GET /api/v1/chain/holders", () => {
  const get = (p: string, e?: Env) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${p}`),
      e ?? env(),
      {} as unknown as ExecutionContext,
    );
  const body = async (res: Response) => {
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    return ((await res.json()) as Row).data as Row;
  };

  test("serves the ranking", async () => {
    threeSubnets();
    const data = await body(await get("/api/v1/chain/holders"));
    assert.equal(data.subnet_count, 3);
    assert.equal((data.subnets as Row[])[0].netuid, 1);
    assert.equal((data.network as Row).subnets_with_single_holder, 1);
  });

  test("?limit= slices without moving subnet_count", async () => {
    threeSubnets();
    const data = await body(await get("/api/v1/chain/holders?limit=1"));
    assert.equal((data.subnets as Row[]).length, 1);
    assert.equal(data.subnet_count, 3);
  });

  test("a decline is a 200 with a stated reason", async () => {
    const data = await body(await get("/api/v1/chain/holders"));
    assert.deepEqual(data.degraded, { reason: "pool_totals_unproven" });
    assert.equal(data.subnet_count, null);
  });

  test("an unsupported sort is a 400", async () => {
    assert.equal((await get("/api/v1/chain/holders?sort=nope")).status, 400);
  });

  test("an over-ceiling limit is rejected, not clamped", async () => {
    const res = await get(
      `/api/v1/chain/holders?limit=${CHAIN_HOLDERS_LIMIT_MAX + 1}`,
    );
    assert.equal(res.status, 400);
  });

  test("an unknown query parameter is rejected", async () => {
    assert.equal((await get("/api/v1/chain/holders?netuid=1")).status, 400);
  });

  test("no D1 binding declines rather than 500ing", async () => {
    const data = await body(await get("/api/v1/chain/holders", {} as Env));
    assert.deepEqual(data.degraded, { reason: "unavailable" });
  });

  test("the exact-path match does not swallow a neighbouring path", async () => {
    // Matched on `===`, so a longer path must fall THROUGH to the rest of the
    // router rather than being answered here. A `startsWith` would quietly
    // capture every /chain/holders* path this route knows nothing about.
    const res = await get("/api/v1/chain/holders-extra");
    assert.notEqual(res.status, 200);
  });
});

describe("chain_holders over GraphQL and MCP", () => {
  test("GraphQL returns the same card REST does", async () => {
    threeSubnets();
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ chain_holders(limit: 2) { sort limit subnet_count
            network { subnets_measured subnets_with_single_holder median_top1_share }
            subnets { netuid holder_count total_alpha top1_share top_holder }
            degraded { reason } } }`,
        }),
      }),
      env(),
    );
    const card = (((await res.json()) as Row).data as Row).chain_holders as Row;
    assert.equal(card.subnet_count, 3);
    assert.equal((card.subnets as Row[]).length, 2);
    assert.equal((card.network as Row).subnets_with_single_holder, 1);
    assert.equal(card.degraded, null);
  });

  test("GraphQL validates sort and limit rather than clamping", async () => {
    const bad = async (q: string) => {
      const res = await handleGraphQLRequest(
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        }),
        env(),
      );
      return ((await res.json()) as Row).errors as Row[];
    };
    const sortErr = await bad(`{ chain_holders(sort: "nope") { sort } }`);
    assert.match(String(sortErr[0].message), /sort must be one of/);
    assert.equal((sortErr[0].extensions as Row)?.code, "BAD_USER_INPUT");
    const limitErr = await bad(
      `{ chain_holders(limit: ${CHAIN_HOLDERS_LIMIT_MAX + 1}) { limit } }`,
    );
    assert.match(String(limitErr[0].message), /limit must be an integer/);
  });

  test("GraphQL declines as a card, not a query-killing error", async () => {
    // The field is non-null, so a decline returning null would take the whole
    // query down with it.
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ chain_holders { subnet_count degraded { reason } } }`,
        }),
      }),
      env(),
    );
    const body_ = (await res.json()) as Row;
    assert.equal(body_.errors, undefined);
    const card = (body_.data as Row).chain_holders as Row;
    assert.deepEqual(card.degraded, { reason: "pool_totals_unproven" });
    assert.equal(card.subnet_count, null);
  });

  test("the MCP tool returns the same card and clamps its limit", async () => {
    threeSubnets();
    const tool = MCP_TOOLS.find((t) => t.name === "get_chain_holders");
    assert.ok(tool, "get_chain_holders is not registered");
    const card = (await tool.handler(
      { limit: CHAIN_HOLDERS_LIMIT_MAX + 50 } as never,
      { env: env() } as never,
    )) as Row;
    // MCP clamps where REST rejects -- the established split in this codebase.
    assert.equal(card.limit, CHAIN_HOLDERS_LIMIT_MAX);
    assert.equal(card.subnet_count, 3);
    assert.match(tool.description, /degraded\.reason/);
  });

  test("the MCP tool defaults its sort and limit", async () => {
    threeSubnets();
    const tool = MCP_TOOLS.find((t) => t.name === "get_chain_holders");
    const card = (await tool!.handler(
      {} as never,
      { env: env() } as never,
    )) as Row;
    assert.equal(card.sort, DEFAULT_CHAIN_HOLDERS_SORT);
    assert.equal(card.limit, CHAIN_HOLDERS_LIMIT_DEFAULT);
  });
});
