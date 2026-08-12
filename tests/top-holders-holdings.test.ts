// The holdings leg of /api/v1/accounts/top-holders (#9502), against a REAL
// SQLite database built from the migrations it reads.
//
// The query is the contract here, so it is executed rather than string-matched:
// the pricing, the exclude-rather-than-zero rule for an unpriceable netuid, the
// scoping to one pool pass, and the ranking of total_tao across the full tables
// are all facts about what SQLite returns, not about what the builder emits.
//
// THE FAILURE THIS GUARDS is never a crash. It is a leaderboard that is
// well-formed, plausible and wrong: a pool total that never arrived prices the
// positions naming it against nothing, so delegated_tao comes out merely too
// LOW and no cell says so.
//
// THE STORE SELECTOR THIS MODULE USES, and why it is `readStore` and not
// `observationsReadDb` (#10179). Removing D1 exposed three independent ways the
// latter could not answer here, each of which turns a proven leg into a silent
// decline -- and a null leg drops free_tao / delegated_tao / total_tao from the
// published artifact entirely, which reads as "these sorts are unavailable"
// rather than as a broken read:
//
//   1. `observationsReadDb(env, ctx)` needs a usable ctx to reach Neon, and
//      src/top-holders-flow-tier.ts calls `topHoldersHoldings(env)` with none,
//      because ProjectionLane.compute is `(env, network)` and has no ctx to
//      give. Threading one was never the fix; readStore needs none.
//   2. `pgObservationsReadDb` exposes `prepare(text) -> { bind, all }` and NO
//      `first()`, so both completeness probes (hotkey-alpha and
//      account-balances) would throw, be caught, and report `unavailable` --
//      nothing could ever be proven, so nothing could ever be priced.
//   3. its `all()` resolves to a BARE ARRAY, while this module does
//      `if (!Array.isArray(res?.results)) throw`. `res.results` on an array is
//      undefined, so even a successful read lands in the decline branch.
//
// readStore's handle has `first()` and the `{ results }` envelope, which is why
// every readStore-based reader in the tree was unaffected by the same change.
//
// src/read-store.ts's handle has `first()` and returns `{ results }`, which is
// why every readStore-based reader in this repo is unaffected. Weakening these
// assertions would publish a top-holders leaderboard that has silently lost
// three of its six sorts, which is the exact class of failure the file opens by
// describing.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// One store since #10179: this module reaches it through a selector that builds
// `new Client(...)` itself, and its only parameters are `(env, cap, ctx)` -- so
// the `pg` module is the seam. See tests/helpers/pg-mock.ts for why it is a
// module mock, and why the controller is built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  topHoldersHoldings,
  topHoldersHoldingsSql,
  TOP_HOLDERS_HOLDINGS_ROW_CAP,
} from "../src/top-holders-holdings.ts";

const MIGRATIONS = [
  "0011_nominator_positions.sql",
  "0017_account_balances.sql",
  "0019_hotkey_alpha.sql",
  "0020_account_balances_passes.sql",
  "0021_hotkey_alpha_passes.sql",
];

const ALPHA_AT = 1_785_910_000_000;
const BAL_AT = 1_785_909_000_000;

let db: InstanceType<typeof DatabaseSync>;

/** The env this module's store selector reads: a connection string to find,
 * every table declared Neon's, and the in-memory engine answering behind the
 * `pg` double. Both call shapes still have to work -- prepare().first() for the
 * two completeness probes, prepare().all() for the ranking query, which binds
 * nothing because every value in it is a constant or a number this module read
 * out of the store itself. */
function runner() {
  return { ...pgMockEnv() } as unknown as Env;
}

/** The module under test, called exactly as production calls it -- no ctx,
 * because src/top-holders-flow-tier.ts has none to pass. */
function holdings(env: Env | null | undefined, cap?: number) {
  return topHoldersHoldings(env, cap);
}

function pass(table: string, capturedAt: number, complete: boolean) {
  db.prepare(
    `INSERT INTO ${table} (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(capturedAt, 10, complete ? 10 : 1, complete ? capturedAt + 1 : null);
}

function balance(ss58: string, freeTao: number) {
  db.prepare(
    "INSERT INTO account_balances (ss58, free_tao, reserved_tao, captured_at)" +
      " VALUES (?, ?, 0, ?)",
  ).run(ss58, freeTao, BAL_AT);
}

function position(
  coldkey: string,
  hotkey: string,
  netuid: number,
  share: number,
) {
  db.prepare(
    "INSERT INTO nominator_positions" +
      " (coldkey, hotkey, netuid, share_fraction, captured_at)" +
      " VALUES (?, ?, ?, ?, ?)",
  ).run(coldkey, hotkey, netuid, share, BAL_AT);
}

function pool(
  hotkey: string,
  netuid: number,
  totalAlpha: number,
  capturedAt = ALPHA_AT,
) {
  db.prepare(
    "INSERT INTO hotkey_alpha (hotkey, netuid, total_alpha, captured_at)" +
      " VALUES (?, ?, ?, ?)",
  ).run(hotkey, netuid, totalAlpha, capturedAt);
}

function price(
  netuid: number,
  alphaPriceTao: number | null,
  date = "2026-08-05",
) {
  db.prepare(
    "INSERT INTO subnet_snapshots (netuid, snapshot_date, alpha_price_tao)" +
      " VALUES (?, ?, ?)",
  ).run(netuid, date, alphaPriceTao);
}

beforeEach(() => {
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = null;
  db = new DatabaseSync(":memory:");
  pg.control.db = db;
  for (const file of MIGRATIONS) {
    db.exec(
      fs.readFileSync(
        path.join(process.cwd(), "tests/fixtures/sqlite-schema", file),
        "utf8",
      ),
    );
  }
  // subnet_snapshots lives in 0002 alongside a great deal else; only the three
  // columns this join touches matter, so it is declared here rather than
  // executing an unrelated migration for its side effects.
  db.exec(
    `CREATE TABLE IF NOT EXISTS subnet_snapshots (
       netuid INTEGER NOT NULL,
       snapshot_date TEXT NOT NULL,
       alpha_price_tao REAL,
       PRIMARY KEY (netuid, snapshot_date)
     )`,
  );
});

describe("topHoldersHoldingsSql", () => {
  test("selects only the proven columns, and total_tao only when both are", () => {
    const both = topHoldersHoldingsSql({
      free: true,
      delegated: true,
      alphaCapturedAt: ALPHA_AT,
    });
    for (const key of ["free_tao", "delegated_tao", "total_tao"]) {
      assert.ok(both.includes(`AS ${key}`), `${key} projected`);
    }
    const freeOnly = topHoldersHoldingsSql({ free: true, delegated: false });
    assert.ok(freeOnly.includes("AS free_tao"));
    // A sum over one proven and one unproven addend is not a total.
    assert.ok(!freeOnly.includes("total_tao"));
    assert.ok(!freeOnly.includes("hotkey_alpha"));

    const delegatedOnly = topHoldersHoldingsSql({
      free: false,
      delegated: true,
      alphaCapturedAt: ALPHA_AT,
    });
    assert.ok(delegatedOnly.includes("AS delegated_tao"));
    assert.ok(!delegatedOnly.includes("total_tao"));
    assert.ok(!delegatedOnly.includes("account_balances"));
  });

  test("scopes the pool read to the proven pass, and interpolates only numbers", () => {
    const sql = topHoldersHoldingsSql({
      free: true,
      delegated: true,
      alphaCapturedAt: ALPHA_AT,
    });
    assert.ok(sql.includes(`ha.captured_at = ${ALPHA_AT}`));
    // No bound parameters and no quoted literals at all: every interpolated
    // value is a constant or a number this module read out of D1 itself.
    assert.equal(sql.includes("?"), false);
    assert.equal([...sql.matchAll(/'/g)].length, 0);
  });

  test("refuses to build a query with nothing proven", () => {
    assert.throws(
      () => topHoldersHoldingsSql({ free: false, delegated: false }),
      /at least one leg/,
    );
  });

  test("takes a top-N per declared sort, unioned", () => {
    const sql = topHoldersHoldingsSql(
      { free: true, delegated: true, alphaCapturedAt: ALPHA_AT },
      250,
    );
    assert.equal(
      (sql.match(/ORDER BY \w+ DESC LIMIT 250/g) ?? []).length,
      3,
      "one selection per declared sort",
    );
    assert.equal(TOP_HOLDERS_HOLDINGS_ROW_CAP, 1_000);
  });
});

describe("topHoldersHoldings prices positions against the pool ledger", () => {
  test("values a position as share x pool x price, summed across netuids", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    // 0.25 of a 1,000-alpha pool at 0.08 TAO/alpha = 20 TAO
    // 0.50 of a   400-alpha pool at 0.05 TAO/alpha = 10 TAO
    position("5Holder", "5Hot", 7, 0.25);
    pool("5Hot", 7, 1_000);
    price(7, 0.08);
    position("5Holder", "5Hot", 9, 0.5);
    pool("5Hot", 9, 400);
    price(9, 0.05);

    const leg = await holdings(runner());
    assert.deepEqual(leg?.sorts, ["delegated_tao"]);
    assert.equal(leg?.cells.get("5Holder")?.delegated_tao, 30);
    // free_tao was never proven, so it is absent rather than zero.
    assert.equal("free_tao" in (leg?.cells.get("5Holder") ?? {}), false);
  });

  test("EXCLUDES an unpriceable netuid rather than counting it as zero", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    position("5Holder", "5Hot", 7, 1);
    pool("5Hot", 7, 1_000);
    price(7, 0.08); // 80 TAO
    // Same holder, a netuid whose newest snapshot carries no usable price.
    position("5Holder", "5Hot", 8, 1);
    pool("5Hot", 8, 5_000);
    price(8, null);

    const leg = await holdings(runner());
    // 80, not 80 + 0 dressed up as a complete total -- the row simply drops out
    // of the addition. The distinction only shows up as a NUMBER when the
    // excluded pool is large, which is why this one is 5,000 alpha.
    assert.equal(leg?.cells.get("5Holder")?.delegated_tao, 80);
  });

  test("prices against the newest snapshot per subnet, not a global newest date", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    position("5Holder", "5Hot", 7, 1);
    pool("5Hot", 7, 100);
    price(7, 0.01, "2026-08-01");
    price(7, 0.02, "2026-08-04");
    // Another subnet landed a day later. A global cutoff would drop netuid 7
    // entirely for the crime of not being the freshest row in the table.
    price(9, 0.5, "2026-08-05");

    const leg = await holdings(runner());
    assert.equal(leg?.cells.get("5Holder")?.delegated_tao, 2);
  });

  test("ignores pool totals from a pass other than the proven one", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    position("5Holder", "5Hot", 7, 1);
    price(7, 1);
    // The pool row belongs to an OLDER pass. Mixing stamps would value this
    // coldkey's positions against totals read at a different block.
    pool("5Hot", 7, 999, ALPHA_AT - 86_400_000);

    const leg = await holdings(runner());
    assert.equal(leg, null, "nothing priced, so no holdings leg at all");
  });
});

describe("topHoldersHoldings ranks total_tao across the full tables", () => {
  test("keeps an account that is in NEITHER addend's top-N but leads on the sum", async () => {
    // THE COUNTEREXAMPLE the design turns on. Composing total_tao from the
    // other two legs' capped rows -- the obvious shortcut -- drops 5Both
    // entirely, because it is outside the top-1 by free AND the top-1 by
    // delegated while being the largest holder on the network.
    pass("account_balances_passes", BAL_AT, true);
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    price(7, 1);

    balance("5Free", 100); // total 100
    balance("5Both", 60);
    position("5Both", "5Hot", 7, 0.55);
    pool("5Hot", 7, 100); // 55 delegated -> total 115
    position("5Deleg", "5HotB", 7, 0.9);
    pool("5HotB", 7, 100); // 90 delegated -> total 90

    const leg = await holdings(runner(), 1);
    assert.deepEqual(leg?.sorts, ["free_tao", "delegated_tao", "total_tao"]);
    const ids = [...leg!.cells.keys()].sort();
    assert.deepEqual(ids, ["5Both", "5Deleg", "5Free"]);
    assert.equal(leg?.cells.get("5Both")?.total_tao, 115);
    // And an account present in only one table still totals correctly: the
    // other addend is a measured zero, licensed by both passes being complete.
    assert.equal(leg?.cells.get("5Free")?.total_tao, 100);
    assert.equal(leg?.cells.get("5Deleg")?.total_tao, 90);
  });
});

describe("topHoldersHoldings declines rather than ranking on unproven inputs", () => {
  test("declines when neither pass has completed", async () => {
    balance("5Whale", 900_000);
    position("5Holder", "5Hot", 7, 1);
    pool("5Hot", 7, 100);
    price(7, 1);
    assert.equal(await holdings(runner()), null);
  });

  test("an in-flight balance pass leaves free_tao and total_tao out", async () => {
    // Production's exact state: 140,000 of 364,284 rows landed, every one
    // correct. Ranking over it returns the largest balances PRESENT.
    pass("account_balances_passes", BAL_AT, false);
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    balance("5Whale", 900_000);
    position("5Holder", "5Hot", 7, 1);
    pool("5Hot", 7, 100);
    price(7, 1);

    const leg = await holdings(runner());
    assert.deepEqual(leg?.sorts, ["delegated_tao"]);
    assert.equal(leg?.cells.has("5Whale"), false);
    assert.equal(leg?.cells.get("5Holder")?.delegated_tao, 100);
  });

  test("an in-flight pool pass leaves delegated_tao and total_tao out", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pass("hotkey_alpha_passes", ALPHA_AT, false);
    balance("5Whale", 900_000);
    position("5Holder", "5Hot", 7, 1);
    pool("5Hot", 7, 100);
    price(7, 1);

    const leg = await holdings(runner());
    assert.deepEqual(leg?.sorts, ["free_tao"]);
    assert.equal(leg?.cells.get("5Whale")?.free_tao, 900_000);
  });

  test("declines on an unbound DB and on an unreadable table", async () => {
    assert.equal(await holdings(null), null);
    assert.equal(await holdings({} as never), null);
    // The completeness probe still answers from the engine; the RANKING query
    // is the one that fails, which is the state a hand-applied migration that
    // has not reached this deployment actually produces.
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    pg.control.onQuery = ({ text }) => {
      if (text.includes("AS delegated_tao"))
        pg.control.failNext = new Error("no such table: hotkey_alpha");
    };
    assert.equal(await holdings(runner()), null);
  });

  test("declines when a proven pass yields no usable rows", async () => {
    // The pass completed but the ledger has nothing this query can rank.
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    assert.equal(await holdings(runner()), null);
  });

  test("a non-array result declines rather than being treated as empty", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    // A store handing back something that is not a row array. The guard is
    // cheap and the failure it prevents is not: `results.length` on a non-array
    // is a TypeError inside a lane whose whole job is to decline quietly.
    pg.control.answers = [
      { match: "AS delegated_tao", rows: "not-an-array" as never },
    ];
    assert.equal(await holdings(runner()), null);
  });

  test("skips unusable cells, and a negative holding is a broken read", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    const rows = [
      { ss58: "5Ok", delegated_tao: 7 },
      { ss58: "5Neg", delegated_tao: -1 },
      { ss58: "5NaN", delegated_tao: "nope" },
      { ss58: 42, delegated_tao: 9 },
    ];
    // Canned rather than engine-produced: SQLite cannot be made to return a
    // string in a REAL column or an integer where an ss58 belongs, and those
    // are exactly the shapes the coercion has to survive.
    pg.control.answers = [{ match: "AS delegated_tao", rows }];
    const leg = await holdings(runner());
    assert.deepEqual([...leg!.cells.keys()], ["5Ok"]);
  });

  test("declines when every row dropped, rather than declaring a sort it cannot rank", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    pg.control.answers = [
      {
        match: "AS delegated_tao",
        rows: [{ ss58: "5Neg", delegated_tao: -1 }],
      },
    ];
    assert.equal(await holdings(runner()), null);
  });
});
