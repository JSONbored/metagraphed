// The neurons lane's Neon mirror (src/neurons-neon-write.ts, infra#336).
//
// What these pin, and why each one is here rather than being obvious:
//
//   * OFF BY DEFAULT. The pilot broke because a store was used before it was
//     ready; a mirror that ran on the deploy introducing it would repeat that.
//   * NEVER THROWS. During dual-write, D1 is the store every route reads, so a
//     Neon failure must cost a mirror and a lane verdict -- not the pass.
//   * A VERDICT ON EVERY ATTEMPT, including the misconfiguration. A store with
//     no lane is invisible to #9698's reader, which is exactly how a frozen
//     Neon served the public API for two days.
//   * THE CONFLICT KEYS MATCH NEON'S REAL PRIMARY KEYS. An ON CONFLICT naming
//     columns with no unique index behind them is a runtime error.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  mirrorNeuronSnapshotToNeon,
  NEURON_MIRROR_PLANS,
  NEURONS_NEON_LANE,
} from "../src/neurons-neon-write.ts";

const NOW = 1_785_800_000_000;

function fakeSql(failOnTable: string | null = null) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async unsafe(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (failOnTable && text.includes(`INTO ${failOnTable} `)) {
        throw new Error("relation does not exist");
      }
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

const input = {
  rows: [{ netuid: 1, uid: 0, captured_at: 5 }],
  dailyRows: [{ netuid: 1, uid: 0, snapshot_date: "2026-08-07" }],
  positionRows: [{ account: "5A", netuid: 1, snapshot_date: "2026-08-07" }],
};

const ctx = { waitUntil() {} };

describe("NEURON_MIRROR_PLANS", () => {
  test("conflict keys match the primary keys read off the live database", () => {
    // Verified 2026-08-07 against pg_index on green-dawn-75468244:
    //   neurons_pkey                (netuid, uid)
    //   account_position_daily_pkey (account, netuid, snapshot_date)
    assert.deepEqual(NEURON_MIRROR_PLANS.neurons.conflict, ["netuid", "uid"]);
    assert.deepEqual(NEURON_MIRROR_PLANS.account_position_daily.conflict, [
      "account",
      "netuid",
      "snapshot_date",
    ]);
  });

  test("only `neurons` carries the out-of-order guard", () => {
    // It is the one table a retried chunk can regress: the daily tables are
    // keyed by snapshot_date, so a late arrival lands on its own day rather
    // than overwriting a newer one.
    assert.match(
      String(NEURON_MIRROR_PLANS.neurons.guard),
      /captured_at < EXCLUDED\.captured_at/,
    );
    assert.equal(NEURON_MIRROR_PLANS.neuron_daily.guard, undefined);
    assert.equal(NEURON_MIRROR_PLANS.account_position_daily.guard, undefined);
  });
});

describe("mirrorNeuronSnapshotToNeon", () => {
  test("does nothing at all unless the lane is named", async () => {
    const sql = fakeSql();
    const spy = laneSpy();
    for (const env of [
      undefined,
      null,
      {},
      { NEON_DUAL_WRITE_LANES: "other" },
    ]) {
      const out = await mirrorNeuronSnapshotToNeon(env, ctx, input, {
        sql,
        laneHealthDb: spy.db,
      });
      assert.deepEqual(out, { attempted: false, results: {} });
    }
    assert.equal(sql.calls.length, 0);
    assert.equal(
      spy.rows.length,
      0,
      "a lane that did not run writes no verdict",
    );
  });

  test("writes all three tables in order, neurons first", async () => {
    // `neurons` is the table a read would move to first, so a failure below it
    // still leaves the most important one current.
    const sql = fakeSql();
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon(
      { NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE },
      ctx,
      input,
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.attempted, true);
    assert.deepEqual(
      sql.calls.map((c) => c.text.match(/INTO (\w+)/)?.[1]),
      ["neurons", "neuron_daily", "account_position_daily"],
    );
    assert.equal(out.results.neurons.rows, 1);
    assert.equal(out.results.account_position_daily.rows, 1);
  });

  test("records one verdict per table, namespaced by store", async () => {
    const spy = laneSpy();
    await mirrorNeuronSnapshotToNeon(
      { NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE },
      ctx,
      input,
      { sql: fakeSql(), laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(
      spy.rows.map((r) => r.lane),
      ["neon:neurons", "neon:neuron_daily", "neon:account_position_daily"],
    );
    assert.ok(spy.rows.every((r) => r.verdict === "ok"));
  });

  test("a failing table is reported and does not stop the others", async () => {
    // The mirror is best-effort per table. A missing `neuron_daily` must not
    // cost `account_position_daily` its refresh, and each gets its own verdict
    // so the reader names the table rather than the lane.
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon(
      { NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE },
      ctx,
      input,
      { sql: fakeSql("neuron_daily"), laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.results.neurons.ok, true);
    assert.equal(out.results.neuron_daily.ok, false);
    assert.equal(out.results.account_position_daily.ok, true);
    const verdicts = Object.fromEntries(
      spy.rows.map((r) => [r.lane, r.verdict]),
    );
    assert.equal(verdicts["neon:neuron_daily"], "stale");
    assert.equal(verdicts["neon:account_position_daily"], "ok");
  });

  test("enabled with no binding is a MISCONFIGURATION, and says so", async () => {
    // Not a quiet no-op. Somebody named the lane and the binding is missing;
    // silence there is how a store nobody writes to goes unnoticed.
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon(
      { NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE },
      ctx,
      input,
      { sql: null, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out, { attempted: true, results: {} });
    assert.equal(spy.rows.length, 1);
    assert.equal(spy.rows[0].lane, "neon:neurons");
    assert.equal(spy.rows[0].verdict, "stale");
    assert.match(String(spy.rows[0].detail), /hyperdrive unbound/);
  });

  test("a bound Hyperdrive with no ctx is also unbound, not a crash", async () => {
    // createPgSql parks its teardown on ctx.waitUntil. Without one there is
    // nowhere to return the connection, so this declines rather than leaking.
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon(
      {
        NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE,
        HYPERDRIVE: { connectionString: "postgres://x" },
      },
      null,
      input,
      { laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.attempted, true);
    assert.match(String(spy.rows[0].detail), /hyperdrive unbound/);
  });

  test("builds a real runner from a bound Hyperdrive, and reports its failure", async () => {
    // The wiring the Worker actually uses: no injected sql, a real binding, a
    // real ctx. The connection string is deliberately unreachable, so this also
    // pins that a Neon that will not accept writes becomes a lane verdict
    // rather than an exception escaping into the sync handler.
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon(
      {
        NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE,
        HYPERDRIVE: { connectionString: "postgresql://u:p@127.0.0.1:1/none" },
        METAGRAPH_HEALTH_DB: spy.db,
      },
      ctx,
      input,
    );
    assert.equal(out.attempted, true);
    assert.equal(out.results.neurons.ok, false, "an unreachable origin fails");
    // Recorded through env.METAGRAPH_HEALTH_DB, with no injected sink and no
    // injected clock -- the defaults the cron path relies on.
    assert.equal(spy.rows.length, 3);
    assert.ok(spy.rows.every((r) => r.verdict === "stale"));
  });

  test("an empty snapshot is a clean no-op per table", async () => {
    const sql = fakeSql();
    const out = await mirrorNeuronSnapshotToNeon(
      { NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE },
      ctx,
      { rows: [], dailyRows: [], positionRows: [] },
      { sql, laneHealthDb: laneSpy().db, now: () => NOW },
    );
    assert.equal(sql.calls.length, 0);
    assert.ok(Object.values(out.results).every((r) => r.ok && r.rows === 0));
  });

  test("survives a lane sink that cannot be written to", async () => {
    // D1 migrations here are applied by hand, so "no such table: lane_health"
    // is a state this must survive on the day the migration lands late.
    const out = await mirrorNeuronSnapshotToNeon(
      { NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE },
      ctx,
      input,
      {
        sql: fakeSql(),
        laneHealthDb: {
          prepare() {
            throw new Error("no such table: lane_health");
          },
        } as never,
        now: () => NOW,
      },
    );
    assert.equal(out.attempted, true);
    assert.equal(out.results.neurons.ok, true);
  });
});
