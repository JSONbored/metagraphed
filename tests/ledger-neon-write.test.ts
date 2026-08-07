// The three flat ledgers' Neon mirror (src/ledger-neon-write.ts, infra#336).
//
// These tables are the simple case -- a natural key, a few values, a
// captured_at, no prune -- so the tests are about the things that stay
// dangerous when the write itself is easy: the conflict key matching a real
// primary key, the out-of-order guard, and a typo'd lane name costing nothing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  LEDGER_MIRROR_PLANS,
  mirrorLedgerToNeon,
} from "../src/ledger-neon-write.ts";

const NOW = 1_785_800_000_000;

function fakeSql(fail = false) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async unsafe(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (fail) throw new Error("relation does not exist");
      return [];
    },
  };
}

function laneSpy() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    db: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT")) {
                  rows.push({
                    lane: values[0],
                    verdict: values[1],
                    detail: values[3],
                  });
                }
              },
            };
          },
        };
      },
    },
  };
}

const ctx = { waitUntil() {} };

describe("LEDGER_MIRROR_PLANS", () => {
  test("conflict keys match each table's PRIMARY KEY in Neon", () => {
    // Created 2026-08-07 from D1's own DDL:
    //   account_balances            PRIMARY KEY (ss58)
    //   hotkey_alpha                PRIMARY KEY (hotkey, netuid)
    //   validator_nominator_counts  PRIMARY KEY (hotkey)
    assert.deepEqual(LEDGER_MIRROR_PLANS["account-balances"].conflict, [
      "ss58",
    ]);
    assert.deepEqual(LEDGER_MIRROR_PLANS["hotkey-alpha"].conflict, [
      "hotkey",
      "netuid",
    ]);
    assert.deepEqual(
      LEDGER_MIRROR_PLANS["validator-nominator-counts"].conflict,
      ["hotkey"],
    );
  });

  test("every plan's conflict columns are a subset of its own columns", () => {
    // A conflict naming a column the INSERT does not carry is a runtime error
    // that only shows up under real traffic.
    for (const [lane, plan] of Object.entries(LEDGER_MIRROR_PLANS)) {
      for (const key of plan.conflict) {
        assert.ok(
          plan.columns.includes(key),
          `${lane}: ${key} is not in its own column list`,
        );
      }
    }
  });
});

describe("mirrorLedgerToNeon", () => {
  const rows = [{ ss58: "5A", free_tao: 1, reserved_tao: 0, captured_at: 9 }];

  test("upserts on the plan's key, guarded against an out-of-order retry", async () => {
    const sql = fakeSql();
    const spy = laneSpy();
    const out = await mirrorLedgerToNeon(
      { NEON_DUAL_WRITE_LANES: "account-balances" },
      ctx,
      "account-balances",
      rows,
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.result?.ok, true);
    assert.match(sql.calls[0].text, /INSERT INTO account_balances/);
    assert.match(sql.calls[0].text, /ON CONFLICT \(ss58\) DO UPDATE/);
    assert.match(
      sql.calls[0].text,
      /WHERE account_balances\.captured_at < EXCLUDED\.captured_at/,
    );
    assert.deepEqual(spy.rows, [
      {
        lane: "neon:account-balances",
        verdict: "ok",
        detail: "1 row(s) in 1 statement(s)",
      },
    ]);
  });

  test("a lane the flag does not name writes nothing", async () => {
    const sql = fakeSql();
    assert.deepEqual(
      await mirrorLedgerToNeon(
        { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
        ctx,
        "account-balances",
        rows,
        { sql },
      ),
      { attempted: false },
    );
    assert.equal(sql.calls.length, 0);
  });

  test("an UNKNOWN lane is a no-op, not a throw", async () => {
    // The flag is a free-text list. A typo must not take down the D1 write this
    // runs behind.
    const sql = fakeSql();
    assert.deepEqual(
      await mirrorLedgerToNeon(
        { NEON_DUAL_WRITE_LANES: "acount-balances" },
        ctx,
        "acount-balances",
        rows,
        { sql },
      ),
      { attempted: false },
    );
    assert.equal(sql.calls.length, 0);
  });

  test("a failing write is reported, never thrown", async () => {
    const spy = laneSpy();
    const out = await mirrorLedgerToNeon(
      { NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      ctx,
      "hotkey-alpha",
      [{ hotkey: "5H", netuid: 1, total_alpha: 2, captured_at: 9 }],
      { sql: fakeSql(true), laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.result?.ok, false);
    assert.equal(spy.rows[0].verdict, "stale");
  });

  test("enabled with no binding records the misconfiguration", async () => {
    const spy = laneSpy();
    const out = await mirrorLedgerToNeon(
      { NEON_DUAL_WRITE_LANES: "validator-nominator-counts" },
      ctx,
      "validator-nominator-counts",
      [{ hotkey: "5H", nominator_count: 3, captured_at: 9 }],
      { sql: null, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out, { attempted: true });
    assert.equal(spy.rows[0].lane, "neon:validator-nominator-counts");
    assert.match(String(spy.rows[0].detail), /hyperdrive unbound/);
  });

  test("builds its own runner from the binding, and reports a dead origin", async () => {
    const spy = laneSpy();
    const out = await mirrorLedgerToNeon(
      {
        NEON_DUAL_WRITE_LANES: "account-balances",
        HYPERDRIVE: { connectionString: "postgresql://u:p@127.0.0.1:1/none" },
        METAGRAPH_HEALTH_DB: spy.db,
      },
      ctx,
      "account-balances",
      rows,
    );
    assert.equal(out.attempted, true);
    assert.equal(out.result?.ok, false);
  });

  test("a bound Hyperdrive with no ctx declines rather than leaking", async () => {
    const spy = laneSpy();
    const out = await mirrorLedgerToNeon(
      {
        NEON_DUAL_WRITE_LANES: "account-balances",
        HYPERDRIVE: { connectionString: "postgres://x" },
      },
      null,
      "account-balances",
      rows,
      { laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out, { attempted: true });
    assert.match(String(spy.rows[0].detail), /hyperdrive unbound/);
  });
});

describe("the hotkey-alpha filter (#9832)", () => {
  test("only hotkey-alpha carries a filter, and it matches D1's", () => {
    // D1 filters this lane and only this lane (REFERENCED_BY_A_POSITION,
    // #9558). A mirror that stores MORE than its source is a mirror in name
    // only -- Neon held 47,320 rows against D1's 17,867 until this landed.
    const filtered = Object.entries(LEDGER_MIRROR_PLANS).filter(
      ([, p]) => p.filter,
    );
    assert.deepEqual(
      filtered.map(([lane]) => lane),
      ["hotkey-alpha"],
    );
    const [, plan] = filtered[0]!;
    assert.match(plan.filter!, /EXISTS \(SELECT 1 FROM nominator_positions/);
    // Both key columns, or the predicate would match on hotkey alone and let
    // every netuid for a referenced hotkey through.
    assert.match(plan.filter!, /np\.hotkey = src\.hotkey/);
    assert.match(plan.filter!, /np\.netuid = src\.netuid/);
  });

  test("every non-text src column in the predicate is CAST", () => {
    // The bug this exists to stop, which it did not stop the first time. A
    // bare parameter inside a `VALUES` list has no type context, so Postgres
    // resolves EVERY column of `src` to text. `np.hotkey = src.hotkey` is
    // text = text and passes; `np.netuid = src.netuid` is `integer = text`,
    // for which there is no operator, and the whole statement throws before a
    // single row is written.
    //
    // Measured against production 2026-08-07: lane_health had
    // `neon:hotkey-alpha` reporting `0 row(s) written before failure:
    // operator does not exist: integer = text` on every pass since the filter
    // shipped. The lane did not degrade, it STOPPED -- and neon-parity read
    // the resulting divergence as the known one this filter was added to fix,
    // which is why it looked like progress.
    //
    // Confirmed both directions against real Postgres: the predicate without
    // `::int` raises exactly that error, and with it returns the row.
    const plan = LEDGER_MIRROR_PLANS["hotkey-alpha"]!;
    // `netuid` is INTEGER on both sides everywhere in this schema.
    assert.match(
      plan.filter!,
      /src\.netuid::int/,
      "src.netuid is compared to an integer column and must be cast; " +
        "without it the statement throws and the lane writes nothing",
    );
    // Cast on the SRC side, never the column side: `np.netuid::text` also
    // typechecks and silently discards the index on nominator_positions.
    assert.doesNotMatch(plan.filter!, /np\.\w+::/);
  });

  test("the predicate names only columns the plan actually sends", () => {
    // `src` is the VALUES alias, so a predicate referring to a column outside
    // the plan's list is a runtime error on every write.
    const plan = LEDGER_MIRROR_PLANS["hotkey-alpha"]!;
    for (const col of [...plan.filter!.matchAll(/src\.(\w+)/g)].map(
      (m) => m[1]!,
    )) {
      assert.ok(
        plan.columns.includes(col),
        `filter reads src.${col}, which the plan does not send`,
      );
    }
  });
});
