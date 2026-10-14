// The live net_flow_* leg of /api/v1/accounts/top-holders (#9469).
//
// THE BUG THIS FILE EXISTS FOR is not "the field was null" -- it is that the
// route answered `?sort=net_flow_30d` in LEXICOGRAPHIC ss58 order while
// echoing `"sort": "net_flow_30d"` back to the caller. Verified live on
// 2026-08-05: 5C4jr9g..., 5C4stSN..., 5C4zv89..., 5C523K1... Every row's flow
// cell was null, so compareTopHoldersSort put them all in the non-number
// bucket and fell through to its ss58 tie-break. So the assertions below check
// the ORDER, not merely that a number came back -- a non-null field with the
// wrong ranking is the exact failure that shipped.
import assert from "node:assert/strict";
import * as nativeFlow from "../src/top-holders-native-flow.ts";
const nativeFlowReader = vi.spyOn(nativeFlow, "loadNativeTopHoldersFlow");
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// One store since #10179: the HOLDINGS leg reaches it through a selector that
// builds `new Client(...)` itself, and `computeTopHoldersFlow(env, network)`
// cannot be handed a binding. See tests/helpers/pg-mock.ts for why the seam is
// a module mock and why the controller is built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  buildTopHoldersFlowRows,
  computeTopHoldersFlow,
  topHoldersFlowRows,
  topHoldersFlowSql,
  TOP_HOLDERS_FLOW_LANE,
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
  TOP_HOLDERS_FLOW_SORTS,
  TOP_HOLDERS_FLOW_WINDOW_DAYS,
  TOP_HOLDERS_LIVE_SORTS,
  topHoldersArtifactSorts,
  loadTopHoldersFlowTier,
} from "../src/top-holders-flow-tier.ts";

const GENERATED_AT = Date.parse("2026-08-05T01:34:00.000Z");
/** The holdings leg's vintage, deliberately a DIFFERENT instant from the flow
 * lane's stamp -- that difference is the whole subject of #9632, and equal
 * fixtures would let a row carrying one stamp pass an assertion about the
 * other. */
const HOLDINGS_CAPTURED_AT = Date.parse("2026-08-05T00:50:48.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** An aggregate row as the lakehouse hands it back. */
function aggregate(
  coldkey: string,
  flows: Partial<Record<string, number | null>>,
) {
  return { coldkey, ...flows };
}

/**
 * A holdings leg in the shape topHoldersHoldings returns.
 *
 * `sorts` defaults to whichever holdings columns the given cells actually
 * carry, which is the invariant the real leg maintains -- a leg that declared a
 * sort no row can rank would recreate the ss58-order defect this tier removes.
 */
function holdings(
  cells: Record<string, Record<string, number>>,
  sorts?: string[],
  /** The complete balance pass's vintage, distinct from GENERATED_AT. */
  capturedAt: number = HOLDINGS_CAPTURED_AT,
) {
  const entries = Object.entries(cells);
  return {
    capturedAt,
    cells: new Map(entries),
    sorts:
      sorts ??
      ["free_tao"].filter((key) =>
        entries.some(([, cell]) => typeof cell[key] === "number"),
      ),
  };
}

/** The store behind the free leg: a complete-pass probe and a ranking read.
 * Dispatch on recorded query text keeps the production store selector and pg
 * result envelope in the path. Passing null simulates no completed pass. */
function d1With(
  rows: unknown[] | null,
  opts: {
    throws?: boolean;
    pass?: Record<string, unknown> | null;
  } = {},
) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const pass =
    opts.pass === undefined
      ? {
          captured_at: 1_785_900_000_000,
          expected_rows: 364_266,
          received_rows: 364_266,
        }
      : opts.pass;
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = ({ text, values }) => {
    seen.push({ sql: text, params: values });
    pg.control.failNext = null;
    if (text.includes("_passes")) {
      pg.control.rows = pass === null ? [] : [pass];
      return;
    }
    if (opts.throws) {
      pg.control.failNext = new Error("no such table");
      return;
    }
    pg.control.rows = rows === null ? ("not-an-array" as never) : rows;
  };
  return { seen, env: { ...pgMockEnv() } as unknown as Env };
}

describe("topHoldersFlowSql", () => {
  test("scans ONE window -- the widest -- and derives the rest from it", () => {
    const sql = topHoldersFlowSql(GENERATED_AT);
    const widest = GENERATED_AT - 90 * DAY_MS;
    // Exactly one lower bound on the scan itself: three separate window
    // queries would re-scan the same 1.65 GB of files three times over.
    assert.equal(
      (sql.match(/WHERE observed_at >= \d+/g) ?? []).length,
      1,
      "one scan predicate",
    );
    assert.ok(sql.includes(`WHERE observed_at >= ${widest}`));
    for (const key of TOP_HOLDERS_FLOW_SORTS) {
      const cutoff = GENERATED_AT - TOP_HOLDERS_FLOW_WINDOW_DAYS[key]! * DAY_MS;
      assert.ok(sql.includes(`AS ${key}`), `${key} projected`);
      assert.ok(
        sql.includes(`observed_at >= ${cutoff}`),
        `${key} narrows to its own cutoff`,
      );
    }
    assert.ok(sql.includes("GROUP BY coldkey"));
    // Not COUNT(DISTINCT ...): that is the aggregate R2 SQL refuses with
    // 40015, and avoiding it is why this runs at all.
    assert.ok(!/COUNT\s*\(\s*DISTINCT/i.test(sql));
  });

  test("interpolates only integers -- R2 SQL has no bound parameters", () => {
    const sql = topHoldersFlowSql(GENERATED_AT);
    // Every quoted literal is a module constant (the two event kinds), never
    // anything derived from a caller.
    assert.deepEqual(
      [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort(),
      [
        // one pair per window, plus the scan's own IN list
        ...TOP_HOLDERS_FLOW_SORTS.flatMap(() => ["StakeAdded", "StakeRemoved"]),
        "StakeAdded",
        "StakeRemoved",
      ].sort(),
    );
  });

  test("scopes to the requested chain's namespace", () => {
    assert.ok(topHoldersFlowSql(GENERATED_AT).includes("chain.account_events"));
    assert.ok(
      !topHoldersFlowSql(GENERATED_AT, "testnet").includes(
        " chain.account_events",
      ),
    );
  });
});

describe("buildTopHoldersFlowRows", () => {
  test("keeps the top N per sort key, as a union across keys", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5Top7", {
          net_flow_7d: 100,
          net_flow_30d: 1,
          net_flow_90d: 1,
        }),
        aggregate("5Top30", {
          net_flow_7d: 1,
          net_flow_30d: 100,
          net_flow_90d: 1,
        }),
        aggregate("5Top90", {
          net_flow_7d: 1,
          net_flow_30d: 1,
          net_flow_90d: 100,
        }),
        aggregate("5Never", {
          net_flow_7d: 0,
          net_flow_30d: 0,
          net_flow_90d: 0,
        }),
      ],
      GENERATED_AT,
      1,
    );
    // One row per key, unioned -- not one row total, and not all four.
    assert.deepEqual(rows.map((r) => r.ss58).sort(), [
      "5Top30",
      "5Top7",
      "5Top90",
    ]);
  });

  test("a coldkey whose every window is unreadable is dropped", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5Real", { net_flow_7d: 5 }),
        aggregate("5Junk", {
          net_flow_7d: null,
          net_flow_30d: Number.NaN,
          net_flow_90d: "",
        } as never),
      ],
      GENERATED_AT,
    );
    assert.deepEqual(
      rows.map((r) => r.ss58),
      ["5Real"],
    );
  });

  test("keeps a negative net flow -- an outflow is a measurement", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5Out", { net_flow_30d: -4_812.5 })],
      GENERATED_AT,
    );
    assert.equal(row!.net_flow_30d, -4_812.5);
  });

  test("carries no holdings columns, so the reader reports them as null", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5A", { net_flow_7d: 1 })],
      GENERATED_AT,
    );
    assert.equal("free_tao" in row!, false);
    assert.equal("delegated_tao" in row!, false);
    assert.equal(row!.captured_at, GENERATED_AT, "the LANE's stamp");
  });

  test("skips rows with no usable coldkey and tolerates a non-array input", () => {
    assert.deepEqual(buildTopHoldersFlowRows(null, GENERATED_AT), []);
    assert.deepEqual(
      buildTopHoldersFlowRows(
        [
          { coldkey: "", net_flow_7d: 1 },
          { coldkey: 7, net_flow_7d: 1 },
          {},
        ] as never,
        GENERATED_AT,
      ),
      [],
    );
  });

  test("is address-ordered, so two runs over the same accounts are byte-stable", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5C", { net_flow_7d: 1 }),
        aggregate("5A", { net_flow_7d: 3 }),
        aggregate("5B", { net_flow_7d: 2 }),
      ],
      GENERATED_AT,
    );
    assert.deepEqual(
      rows.map((r) => r.ss58),
      ["5A", "5B", "5C"],
    );
  });

  // The free_tao and net_flow populations are DISJOINT in production -- the
  // top free-balance accounts hold 5.4M TAO and delegate nothing -- so the
  // union has to keep both, not intersect them.
  test("unions the balance leaderboard with the flow one", () => {
    const rows = buildTopHoldersFlowRows(
      [aggregate("5Staker", { net_flow_7d: 500 })],
      GENERATED_AT,
      1,
      holdings({ "5Exchange": { free_tao: 5_448_995.869289362 } }),
    );
    assert.deepEqual(rows.map((r) => r.ss58).sort(), ["5Exchange", "5Staker"]);
    const exchange = rows.find((r) => r.ss58 === "5Exchange")!;
    assert.equal(exchange.free_tao, 5_448_995.869289362);
    // An account ranked only by balance has no flow figures, and says so with
    // absence rather than a zero.
    assert.equal("net_flow_7d" in exchange, false);
  });

  test("merges both legs onto one row when an account appears in each", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5Both", { net_flow_30d: -12 })],
      GENERATED_AT,
      10,
      holdings({ "5Both": { free_tao: 42 } }),
    );
    assert.equal(row!.free_tao, 42);
    assert.equal("delegated_tao" in row!, false);
    assert.equal("total_tao" in row!, false);
    assert.equal(row!.net_flow_30d, -12);
    assert.equal(row!.captured_at, GENERATED_AT);
  });

  test("ranks the independent measured-free population without inventing financial sorts", () => {
    const rows = buildTopHoldersFlowRows(
      [aggregate("5Flow", { net_flow_7d: 1 })],
      GENERATED_AT,
      1,
      holdings({ "5Exchange": { free_tao: 81_185 }, "5Tiny": { free_tao: 1 } }),
    );
    assert.deepEqual(
      rows.map((row) => row.ss58),
      ["5Exchange", "5Flow"],
    );
    assert.equal(rows[0]!.free_tao, 81_185);
    assert.equal(rows[0]!.holdings_captured_at, HOLDINGS_CAPTURED_AT);
    assert.equal(JSON.stringify(rows).includes("delegated_tao"), false);
    assert.equal(JSON.stringify(rows).includes("total_tao"), false);
  });

  test("financial guesses on aggregate rows cannot ride along with observed flows", () => {
    const [row] = buildTopHoldersFlowRows(
      [
        {
          coldkey: "5Legacy",
          delegated_tao: 25_000_000,
          total_tao: 25_000_010,
          net_flow_7d: -5,
          net_flow_30d: 0,
          net_flow_90d: 9,
        },
      ],
      GENERATED_AT,
    );
    assert.deepEqual(row, {
      ss58: "5Legacy",
      net_flow_7d: -5,
      net_flow_30d: 0,
      net_flow_90d: 9,
      captured_at: GENERATED_AT,
    });
  });

  test("a null holdings leg leaves every holdings column out entirely", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5A", { net_flow_7d: 1 })],
      GENERATED_AT,
      10,
      null,
    );
    assert.equal("free_tao" in row!, false);
    assert.equal("delegated_tao" in row!, false);
    assert.equal("total_tao" in row!, false);
  });

  test("ties inside a capped key break on ss58, not on insertion order", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5B", { net_flow_7d: 9 }),
        aggregate("5A", { net_flow_7d: 9 }),
      ],
      GENERATED_AT,
      1,
    );
    assert.deepEqual(
      rows.map((r) => r.ss58),
      ["5A"],
    );
  });
});

describe("topHoldersArtifactSorts", () => {
  // A body written by the flow-only lane (#9492) has no `sorts`. Reading it as
  // flow-only is what keeps a deploy landing before the next 01:34 tick
  // answering exactly what it answered yesterday.
  test("a body with no `sorts` is read as flow-only", () => {
    assert.deepEqual(topHoldersArtifactSorts({}), TOP_HOLDERS_FLOW_SORTS);
    assert.deepEqual(topHoldersArtifactSorts(null), TOP_HOLDERS_FLOW_SORTS);
  });

  test("a declared list is honoured, and unrecognised entries are dropped", () => {
    assert.deepEqual(
      topHoldersArtifactSorts({ sorts: ["free_tao", "net_flow_7d"] }),
      ["free_tao", "net_flow_7d"],
    );
    // A legacy artifact may still declare financial sorts. The read path
    // must filter them even when its cells contain plausible numbers.
    assert.deepEqual(
      topHoldersArtifactSorts({ sorts: ["reserved_tao", 7, null] }),
      [],
    );
    assert.deepEqual(
      topHoldersArtifactSorts({
        sorts: ["total_tao", "delegated_tao", "made_up"],
      }),
      [],
    );
  });
});

describe("computeTopHoldersFlow", () => {
  beforeEach(() => {
    nativeFlowReader.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw Error("HTTP forbidden");
      }),
    );
  });
  test("missing or invalid native facts preserve the previous ranking", async () => {
    for (const value of [null, undefined]) {
      nativeFlowReader.mockResolvedValue(value);
      assert.equal(await computeTopHoldersFlow({} as Env), null);
    }
  });
  test("shapes verified native flows into the published artifact with its actual source timestamp", async () => {
    nativeFlowReader.mockResolvedValue({
      generatedAt: 1700000000000,
      rows: [
        { coldkey: "5A", net_flow_7d: 2, net_flow_30d: 5, net_flow_90d: 9 },
      ],
    });
    const body = await computeTopHoldersFlow({} as Env);
    assert.ok(body);
    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 1);
    assert.ok(topHoldersFlowRows(body));
    assert.equal(body.generated_at, new Date(1700000000000).toISOString());
  });
  test("declares only rankings backed by their own complete legs", async () => {
    nativeFlowReader.mockResolvedValue({
      generatedAt: Date.now(),
      rows: [
        { coldkey: "5A", net_flow_7d: 1, net_flow_30d: 1, net_flow_90d: 1 },
      ],
    });
    const without = await computeTopHoldersFlow({} as Env);
    assert.deepEqual(without?.sorts, TOP_HOLDERS_FLOW_SORTS);
    const withHoldings = await computeTopHoldersFlow(
      d1With([
        {
          ss58: "5Exchange",
          free_tao: 900,
          delegated_tao: 100,
          total_tao: 1000,
        },
      ]).env as Env,
    );
    assert.deepEqual(withHoldings?.sorts, TOP_HOLDERS_LIVE_SORTS);
    assert.equal(withHoldings?.row_count, 2);
    const account = (withHoldings?.rows as Record<string, unknown>[]).find(
      (row) => row.ss58 === "5Exchange",
    )!;
    assert.equal(account.free_tao, 900);
    assert.equal("delegated_tao" in account, false);
    assert.equal("total_tao" in account, false);
    const partial = await computeTopHoldersFlow(
      d1With([{ ss58: "5Exchange", free_tao: 900 }]).env as Env,
    );
    assert.deepEqual(partial?.sorts, [...TOP_HOLDERS_FLOW_SORTS, "free_tao"]);
  });
  test("an incomplete balance pass leaves native flow observations and their ranking intact", async () => {
    nativeFlowReader.mockResolvedValue({
      generatedAt: GENERATED_AT,
      rows: [
        { coldkey: "5Flow", net_flow_7d: -5, net_flow_30d: 0, net_flow_90d: 9 },
      ],
    });
    const { env, seen } = d1With([{ ss58: "5Exchange", free_tao: 900 }], {
      pass: null,
    });
    const body = await computeTopHoldersFlow(env);
    assert.deepEqual(body?.sorts, TOP_HOLDERS_FLOW_SORTS);
    assert.deepEqual(body?.rows, [
      {
        ss58: "5Flow",
        net_flow_7d: -5,
        net_flow_30d: 0,
        net_flow_90d: 9,
        captured_at: GENERATED_AT,
      },
    ]);
    assert.equal(
      seen.length,
      1,
      "an incomplete pass must prevent the balance ranking read",
    );
  });

  test("a failed or malformed balance read cannot suppress qualified native flows", async () => {
    nativeFlowReader.mockResolvedValue({
      generatedAt: GENERATED_AT,
      rows: [
        { coldkey: "5Flow", net_flow_7d: -5, net_flow_30d: 0, net_flow_90d: 9 },
      ],
    });
    for (const setup of [
      () => d1With([], { throws: true }),
      () => d1With(null),
    ]) {
      const { env } = setup();
      const body = await computeTopHoldersFlow(env);
      assert.deepEqual(body?.sorts, TOP_HOLDERS_FLOW_SORTS);
      assert.equal(body?.generated_at, new Date(GENERATED_AT).toISOString());
      assert.deepEqual(body?.rows, [
        {
          ss58: "5Flow",
          net_flow_7d: -5,
          net_flow_30d: 0,
          net_flow_90d: 9,
          captured_at: GENERATED_AT,
        },
      ]);
    }
  });

  test("testnet never consults the mainnet balance ledger", async () => {
    nativeFlowReader.mockResolvedValue({
      generatedAt: Date.now(),
      rows: [
        { coldkey: "5A", net_flow_7d: 1, net_flow_30d: 1, net_flow_90d: 1 },
      ],
    });
    const { env, seen } = d1With([{ ss58: "5Exchange", free_tao: 900 }]);
    const body = await computeTopHoldersFlow(env as Env, "testnet");
    assert.deepEqual(body?.sorts, TOP_HOLDERS_FLOW_SORTS);
    assert.deepEqual(seen, []);
  });
  test("the lane declares the reader's artifact and compute", () => {
    assert.equal(
      TOP_HOLDERS_FLOW_LANE.artifactKey,
      TOP_HOLDERS_FLOW_PROJECTION_KEY,
    );
    assert.equal(TOP_HOLDERS_FLOW_LANE.compute, computeTopHoldersFlow);
  });
});

describe("stored projection compatibility", () => {
  test("internal version 1 rows remain readable and other stored versions decline", () => {
    const rows = [
      {
        ss58: "5A",
        free_tao: 42,
        delegated_tao: 8,
        total_tao: 50,
        net_flow_7d: -5,
      },
    ];
    assert.deepEqual(topHoldersFlowRows({ schema_version: 1, rows }), rows);
    for (const body of [
      null,
      {},
      { schema_version: 2, rows },
      { schema_version: 1, rows: "not-rows" },
    ])
      assert.equal(topHoldersFlowRows(body), null);
  });

  test("legacy declared financial sorts cannot answer and supported pages suppress their cells", async () => {
    const body = {
      schema_version: 1,
      sorts: ["free_tao", "delegated_tao", "total_tao", "net_flow_7d"],
      rows: [
        {
          ss58: "5A",
          free_tao: 42,
          delegated_tao: 8,
          total_tao: 50,
          net_flow_7d: -5,
          captured_at: GENERATED_AT,
          holdings_captured_at: HOLDINGS_CAPTURED_AT,
        },
      ],
    };
    const env = {
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return body;
            },
          };
        },
      },
    } as unknown as Env;
    for (const sort of ["delegated_tao", "total_tao"])
      assert.equal(await loadTopHoldersFlowTier(env, { sort }), null);
    for (const sort of ["free_tao", "net_flow_7d"]) {
      const page = await loadTopHoldersFlowTier(env, { sort });
      assert.equal(page?.schema_version, 2);
      const [account] = page!.accounts as Record<string, unknown>[];
      assert.equal(account!.free_tao, 42);
      assert.equal(account!.net_flow_7d, -5);
      assert.equal(account!.delegated_tao, null);
      assert.equal(account!.total_tao, null);
    }
  });
});
