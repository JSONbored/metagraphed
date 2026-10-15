// Free holdings come from complete System::Account balance passes. Pool totals,
// dimensionless nominator shares and spot prices cannot prove portfolio wealth.
// Execute ranking SQL against a real SQLite ledger behind the pg module seam;
// keep legacy tables populated to prove they cannot affect the free leaderboard.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// One store since #10179: this module reaches it through a selector that builds
// `new Client(...)` itself, and its only parameters are `(env, cap)` -- so
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

/** The real store selector discovers the pg connection without a ctx.
 * The double answers the complete-pass probe and the ranking query from the
 * same engine, retaining production query text for failure assertions. */
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

function balance(ss58: string, freeTao: number, capturedAt = BAL_AT) {
  db.prepare(
    "INSERT INTO account_balances (ss58, free_tao, reserved_tao, captured_at)" +
      " VALUES (?, ?, 0, ?)",
  ).run(ss58, freeTao, capturedAt);
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
  // legacy price columns used by these fixtures matter, so it is declared here rather than
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
  test("ranks exact free balances across the full ledger without financial joins", () => {
    for (let n = 0; n < 200; n++) {
      balance(`account-${n}`, n + 0.125);
      position(`account-${n}`, "delegate", 1, (200 - n) / 20_100);
    }
    pool("delegate", 1, 20_100);
    price(1, 100);
    const sql = topHoldersHoldingsSql({ free: true, delegated: false }, 3);
    const rows = db.prepare(sql).all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { ss58: "account-199", free_tao: 199.125 },
        { ss58: "account-198", free_tao: 198.125 },
        { ss58: "account-197", free_tao: 197.125 },
      ],
    );
    for (const legacy of [
      "delegated_tao",
      "total_tao",
      "nominator_positions",
      "hotkey_alpha",
      "subnet_snapshots",
    ])
      assert.equal(sql.includes(legacy), false, legacy);
  });

  test("refuses every delegated or unproven free configuration", () => {
    for (const opts of [
      { free: true, delegated: true, alphaCapturedAt: ALPHA_AT },
      { free: false, delegated: true, alphaCapturedAt: ALPHA_AT },
      { free: false, delegated: false },
    ])
      assert.throws(() => topHoldersHoldingsSql(opts), /unqualified/i);
  });

  test("interpolates only a bounded integer page size", () => {
    const sql = topHoldersHoldingsSql({ free: true, delegated: false }, 250);
    assert.match(sql, /ORDER BY free_tao DESC,ss58 ASC LIMIT 250$/);
    assert.equal(sql.includes("?"), false);
    assert.equal(sql.includes("'"), false);
    assert.equal(TOP_HOLDERS_HOLDINGS_ROW_CAP, 1_000);
    for (const cap of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      1_001,
      "1; DROP TABLE account_balances",
    ])
      assert.throws(
        () =>
          topHoldersHoldingsSql({ free: true, delegated: false }, cap as never),
        /bounded holdings page/i,
      );
    assert.match(
      topHoldersHoldingsSql({ free: true, delegated: false }),
      /LIMIT 1000$/,
    );
  });

  test("ties break on address before the cap, independently of insertion order", () => {
    balance("5B", 10);
    balance("5A", 10);
    balance("5Zero", 0);
    const rows = db
      .prepare(topHoldersHoldingsSql({ free: true, delegated: false }, 1))
      .all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ ss58: "5A", free_tao: 10 }],
    );
  });
});

describe("topHoldersHoldings supports proven free TAO only", () => {
  test("complete pools, shares and spot prices never establish a delegated balance", async () => {
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    position("5Holder", "5Hot", 7, 0.25);
    pool("5Hot", 7, 1_000);
    price(7, 0.08);
    position("5Holder", "5Hot", 9, 0.5);
    pool("5Hot", 9, 400);
    price(9, 0.05);
    assert.equal(await holdings(runner()), null);
    assert.equal(
      pg.control.queries.some(({ text }) =>
        /hotkey_alpha|nominator_positions|subnet_snapshots/.test(text),
      ),
      false,
    );
  });

  test("legacy valuation inputs cannot change the free ranking or add position-only accounts", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    price(7, 1);
    balance("5Free", 100);
    balance("5Both", 60);
    position("5Both", "5Hot", 7, 0.55);
    pool("5Hot", 7, 100);
    position("5Deleg", "5HotB", 7, 0.9);
    pool("5HotB", 7, 100);
    const leg = await holdings(runner(), 1);
    assert.deepEqual(leg?.sorts, ["free_tao"]);
    assert.deepEqual([...leg!.cells], [["5Free", { free_tao: 100 }]]);
  });

  test("keeps exact free TAO values from the balance scan", async () => {
    pass("account_balances_passes", BAL_AT, true);
    balance("5Exchange", 5_448_995.869289362);
    balance("5Other", 737_821.125);
    const leg = await holdings(runner());
    assert.deepEqual(
      [...leg!.cells],
      [
        ["5Exchange", { free_tao: 5_448_995.869289362 }],
        ["5Other", { free_tao: 737_821.125 }],
      ],
    );
    assert.deepEqual(leg?.sorts, ["free_tao"]);
    assert.equal(leg?.capturedAt, BAL_AT);
  });

  test("the full ledger contributes its own bounded top-N", async () => {
    pass("account_balances_passes", BAL_AT, true);
    for (let n = 0; n < TOP_HOLDERS_HOLDINGS_ROW_CAP + 2; n++)
      balance(`5Account${n}`, n + 1);
    const leg = await holdings(runner());
    assert.equal(leg?.cells.size, TOP_HOLDERS_HOLDINGS_ROW_CAP);
    assert.equal(leg?.cells.has("5Account0"), false);
    assert.equal(leg?.cells.has("5Account1"), false);
    assert.equal(leg?.cells.get("5Account1001")?.free_tao, 1002);
  });
});

describe("topHoldersHoldings completeness and freshness", () => {
  test("the balance pass alone determines freshness, even when alpha is older", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pass("hotkey_alpha_passes", BAL_AT - 86_400_000, true);
    balance("5Whale", 900_000);
    const leg = await holdings(runner());
    assert.deepEqual(leg?.sorts, ["free_tao"]);
    assert.equal(leg?.capturedAt, BAL_AT);
    assert.equal(
      pg.control.queries.some(({ text }) => text.includes("hotkey_alpha")),
      false,
    );
  });

  test("an in-flight alpha pass cannot suppress proven free balances", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pass("hotkey_alpha_passes", ALPHA_AT, false);
    balance("5Whale", 900_000);
    const leg = await holdings(runner());
    assert.deepEqual([...leg!.cells], [["5Whale", { free_tao: 900_000 }]]);
    assert.equal(leg?.capturedAt, BAL_AT);
  });

  test("without any completed balance pass even a populated ledger declines", async () => {
    pass("account_balances_passes", BAL_AT, false);
    pass("hotkey_alpha_passes", ALPHA_AT, true);
    balance("5Whale", 900_000);
    assert.equal(await holdings(runner()), null);
    assert.equal(pg.control.queries.length, 1, "do not rank a partial ledger");
  });

  test("a newer partial pass cannot advance the complete-pass stamp or discard retained accounts", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pass("account_balances_passes", BAL_AT + 3_600_000, false);
    balance("5Retained", 737_821.125);
    balance("5Refreshed", 900_001, BAL_AT + 3_600_000);
    const leg = await holdings(runner());
    assert.equal(leg?.capturedAt, BAL_AT);
    assert.deepEqual(
      [...leg!.cells],
      [
        ["5Refreshed", { free_tao: 900_001 }],
        ["5Retained", { free_tao: 737_821.125 }],
      ],
    );
  });

  test("the newest completed balance pass supplies the stamp", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pass("account_balances_passes", BAL_AT + 3_600_000, true);
    balance("5Whale", 900_000, BAL_AT + 3_600_000);
    assert.equal((await holdings(runner()))?.capturedAt, BAL_AT + 3_600_000);
  });

  test("a replayed complete pass remains rankable when received exceeds expected", async () => {
    pass("account_balances_passes", BAL_AT, true);
    db.prepare(
      "UPDATE account_balances_passes SET received_rows = 20 WHERE captured_at = ?",
    ).run(BAL_AT);
    balance("5Whale", 900_000);
    assert.equal(
      (await holdings(runner()))?.cells.get("5Whale")?.free_tao,
      900_000,
    );
  });
});

describe("topHoldersHoldings declines missing and malformed reads", () => {
  test("declines an unbound store and an unreadable balance pass", async () => {
    assert.equal(await holdings(null), null);
    assert.equal(await holdings({} as never), null);
    pg.control.onQuery = () => {
      pg.control.failNext = new Error("missing account_balances_passes");
    };
    assert.equal(await holdings(runner()), null);
  });

  test("declines when the ranking read fails after completeness succeeds", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pg.control.onQuery = ({ text }) => {
      if (text.includes("SELECT ss58,free_tao"))
        pg.control.failNext = new Error("missing account_balances");
    };
    assert.equal(await holdings(runner()), null);
  });

  test("declines an empty completed ledger or a non-array ranking result", async () => {
    pass("account_balances_passes", BAL_AT, true);
    assert.equal(await holdings(runner()), null);
    pg.control.answers = [
      { match: "SELECT ss58,free_tao", rows: "not-an-array" as never },
    ];
    assert.equal(await holdings(runner()), null);
  });

  test("keeps measured zero and numeric strings while skipping missing, negative and non-finite cells", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pg.control.answers = [
      {
        match: "SELECT ss58,free_tao",
        rows: [
          {
            ss58: "5Ok",
            free_tao: "7.125",
            delegated_tao: 999,
            total_tao: 1006.125,
          },
          { ss58: "5Zero", free_tao: "0" },
          { ss58: "5Empty", free_tao: "" },
          { ss58: "5Whitespace", free_tao: "  \t" },
          { ss58: "5Neg", free_tao: -1 },
          { ss58: "5NaN", free_tao: "nope" },
          { ss58: "5Inf", free_tao: Infinity },
          { ss58: "5Null", free_tao: null },
          { ss58: "5Missing" },
          { ss58: 42, free_tao: 9 },
          { ss58: "", free_tao: 9 },
        ],
      },
    ];
    const leg = await holdings(runner());
    assert.deepEqual(
      [...leg!.cells],
      [
        ["5Ok", { free_tao: 7.125 }],
        ["5Zero", { free_tao: 0 }],
      ],
    );
    assert.deepEqual(leg?.sorts, ["free_tao"]);
  });

  test("declines when every ranking cell is unusable", async () => {
    pass("account_balances_passes", BAL_AT, true);
    pg.control.answers = [
      { match: "SELECT ss58,free_tao", rows: [{ ss58: "5Neg", free_tao: -1 }] },
    ];
    assert.equal(await holdings(runner()), null);
  });

  test("invalid page caps decline instead of issuing unbounded ranking SQL", async () => {
    pass("account_balances_passes", BAL_AT, true);
    balance("5Whale", 900_000);
    for (const cap of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      TOP_HOLDERS_HOLDINGS_ROW_CAP + 1,
    ]) {
      pg.control.queries.length = 0;
      assert.equal(await holdings(runner(), cap), null);
      assert.equal(
        pg.control.queries.length,
        1,
        "only the completeness probe ran",
      );
    }
  });
});
