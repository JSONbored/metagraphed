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
import { beforeEach, describe, test, vi } from "vitest";

// One test below runs the DEFAULT wiring -- no injected runner, no injected
// lane sink -- and both of those now reach Postgres through `new Client(...)`
// (createPgSql for the mirror, lane-health-store for the verdicts). Mocking the
// `pg` module is the seam; see tests/helpers/pg-mock.ts for why it is a module
// mock and why the controller has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  mirrorNeuronSnapshotToNeon,
  NEURONS_NEON_LANE,
  pruneNeuronsToCapture,
} from "../src/neurons-neon-write.ts";
import { resetNeonWriteVerdictMemo } from "../src/neon-write.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";

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

beforeEach(() => {
  pg.control.queries.length = 0;
  pg.control.onQuery = null;
  pg.control.failNext = null;
  pg.control.rows = null;
  // Every test here drives a mirror run on the SAME frozen millisecond, which
  // an isolate never sees in production. Without this, the second run's
  // unchanged `ok` coalesces and reads as a verdict that was never written.
  resetNeonWriteVerdictMemo();
});

describe("NEURON_MIRROR_PLANS", () => {
  // The off-arm test lived here until #10051: with D1 deleted the write is
  // unconditional, and the behaviour it pinned is gone.

  test("writes all three tables in order, neurons first", async () => {
    // `neurons` is the table a read would move to first, so a failure below it
    // still leaves the most important one current.
    const sql = fakeSql();
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon({}, ctx, input, {
      sql,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
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
    await mirrorNeuronSnapshotToNeon({}, ctx, input, {
      sql: fakeSql(),
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.deepEqual(
      spy.rows.map((r) => r.lane),
      ["neon:neurons", "neon:neuron_daily", "neon:account_position_daily"],
    );
    assert.ok(spy.rows.every((r) => r.verdict === "ok"));
  });

  test("buffered: the derived tables record at enqueue; the base lane waits for the flush", async () => {
    // #10888. Every statement here rides under the ONE lane tag the runner
    // was built with (NEURONS_NEON_LANE), so the flush's per-lane tally can
    // only ever name `neon:neurons` -- the derived tables' suppressed
    // successes could be recorded by nothing at all, and the moment the
    // buffer came on (#10758) both lanes went silent while the tables held
    // that day's snapshot. This is #10826's sub-lane shape exactly, so their
    // verdicts must land at enqueue time; the base lane's suppression stays,
    // because its statements DO carry its name and the flush's verdict for it
    // is the honest one.
    const spy = laneSpy();
    const sent: unknown[] = [];
    const ns = {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch(request: Request) {
          sent.push(await request.json());
          return new Response("{}", { status: 200 });
        },
      }),
    };
    const out = await mirrorNeuronSnapshotToNeon(
      {
        NEON_DUAL_WRITE_LANES: NEURONS_NEON_LANE,
        NEON_WRITE_BUFFER_LANES: NEURONS_NEON_LANE,
        NEON_WRITE_BUFFER: ns,
        HYPERDRIVE: { connectionString: "postgresql://x" },
      },
      ctx,
      input,
      { laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.attempted, true);
    assert.ok(sent.length >= 3, "statements must enqueue, not connect");
    assert.deepEqual(
      spy.rows.map((r) => r.lane),
      ["neon:neuron_daily", "neon:account_position_daily"],
      "the sub-lanes record; the flush-attributed base lane does not",
    );
    assert.ok(spy.rows.every((r) => r.verdict === "ok"));
  });

  test("a failing table is reported and does not stop the others", async () => {
    // The mirror is best-effort per table. A missing `neuron_daily` must not
    // cost `account_position_daily` its refresh, and each gets its own verdict
    // so the reader names the table rather than the lane.
    const spy = laneSpy();
    const out = await mirrorNeuronSnapshotToNeon({}, ctx, input, {
      sql: fakeSql("neuron_daily"),
      laneHealthDb: spy.db,
      now: () => NOW,
    });
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
    const out = await mirrorNeuronSnapshotToNeon({}, ctx, input, {
      sql: null,
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(out.attempted, true);
    // The miss is IN-BAND since #10051: empty results let a sync route ack a
    // write nothing held, so every table reports the unbound failure.
    assert.ok(Object.keys(out.results).length > 0, "the miss must be in-band");
    for (const r of Object.values(out.results)) {
      assert.deepEqual(r, {
        ok: false,
        rows: 0,
        statements: 0,
        reason: "hyperdrive unbound",
      });
    }
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
    // The wiring the Worker actually uses: no injected sql, no injected sink,
    // no injected clock, a real binding and a real ctx. Every mirror statement
    // is rejected, so this pins that a Neon that will not accept writes becomes
    // a lane verdict rather than an exception escaping into the sync handler.
    //
    // The mirror's writes fail and the LANE SINK's do not, which is the whole
    // point of the test and the reason the failure is per statement rather than
    // an unreachable connection string: the two now share one store, so an
    // origin that refuses everything would take the verdicts down with the
    // writes they are supposed to report. `onQuery` fires before the double
    // consults `failNext`, which is what makes arming it per statement work.
    const verdicts: Record<string, unknown>[] = [];
    pg.control.onQuery = (query) => {
      if (/INSERT\s+INTO\s+lane_health/i.test(query.text)) {
        verdicts.push({
          lane: query.values[0],
          verdict: query.values[1],
          detail: query.values[3],
        });
        return;
      }
      pg.control.failNext = new Error("could not connect to server");
    };
    const out = await mirrorNeuronSnapshotToNeon(pgMockEnv(), ctx, input);
    assert.equal(out.attempted, true);
    assert.equal(out.results.neurons.ok, false, "a rejected write fails");
    assert.equal(verdicts.length, 3);
    assert.ok(verdicts.every((r) => r.verdict === "stale"));
  });

  test("an empty snapshot is a clean no-op per table", async () => {
    const sql = fakeSql();
    const out = await mirrorNeuronSnapshotToNeon(
      {},
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
    const out = await mirrorNeuronSnapshotToNeon({}, ctx, input, {
      sql: fakeSql(),
      laneHealthDb: {
        prepare() {
          throw new Error("no such table: lane_health");
        },
      } as never,
      now: () => NOW,
    });
    assert.equal(out.attempted, true);
    assert.equal(out.results.neurons.ok, true);
  });
});

// THE DEREGISTRATION PRUNE (#10184). D1's writer deleted each netuid's rows
// beneath that netuid's newest capture, and the Neon mirror never did -- so a
// UID that leaves a subnet stayed in `neurons` forever.
//
// Benign at the time it was restored: every pass rewrites every UID under one
// shared captured_at, so Neon held 0 stale rows (verified against production
// 2026-08-08). It stops being benign the first time a subnet shrinks its UID
// count or is deregistered, and by then D1 is gone and there is no second copy
// to notice against.
describe("pruneNeuronsToCapture", () => {
  test("one statement for the whole map, with the pairs as parallel arrays", async () => {
    // NOT one statement per netuid: a full pass covers ~129 subnets, and 129
    // round trips on a Hyperdrive connection is how a prune becomes a timeout.
    // The parameter count stays 2 no matter how many netuids there are, and
    // nothing is interpolated into the text.
    const sql = fakeSql();
    const result = await pruneNeuronsToCapture(
      sql,
      new Map([
        [1, 1_786_000_000_000],
        [64, 1_786_000_000_500],
      ]),
    );
    assert.deepEqual(result, { ok: true, rows: 0, statements: 1 });
    assert.equal(sql.calls.length, 1);
    assert.match(sql.calls[0]!.text, /DELETE FROM neurons n USING unnest/);
    assert.match(sql.calls[0]!.text, /n\.captured_at < cutoff\.captured_at/);
    assert.deepEqual(sql.calls[0]!.values, [
      [1, 64],
      [1_786_000_000_000, 1_786_000_000_500],
    ]);
  });

  test("PER NETUID, so one subnet's later capture cannot delete another's fresh rows", async () => {
    // The failure a single batch-wide cutoff produces: netuid 64's newer
    // capture would satisfy `captured_at < max` for netuid 1's rows, which this
    // same write just landed. The pairing is what prevents it, so the pairing
    // is what is asserted.
    const sql = fakeSql();
    await pruneNeuronsToCapture(
      sql,
      new Map([
        [1, 1_000],
        [64, 9_999],
      ]),
    );
    const [netuids, cutoffs] = sql.calls[0]!.values as [number[], number[]];
    assert.equal(netuids.indexOf(1), cutoffs.indexOf(1_000));
    assert.equal(netuids.indexOf(64), cutoffs.indexOf(9_999));
  });

  test("an unusable netuid or cutoff is SKIPPED, never widened to everything", async () => {
    // A NaN cutoff in the statement would delete every row for that netuid --
    // the one outcome this function must not have. Skipping the pair leaves
    // that subnet unpruned for a tick, which the next pass fixes.
    const sql = fakeSql();
    await pruneNeuronsToCapture(
      sql,
      new Map([
        [1, Number.NaN],
        [Number.NaN, 1_000],
        [64, 1_786_000_000_500],
      ]),
    );
    assert.deepEqual(sql.calls[0]!.values, [[64], [1_786_000_000_500]]);
  });

  test("an empty map issues no statement at all", async () => {
    const sql = fakeSql();
    const result = await pruneNeuronsToCapture(sql, new Map());
    assert.deepEqual(result, { ok: true, rows: 0, statements: 0 });
    assert.equal(sql.calls.length, 0);
  });

  test("a failure is reported, never thrown", async () => {
    // A failed prune must not fail a pass whose rows landed: the rows are the
    // valuable half, and stale UIDs cost one tick.
    const sql = {
      async unsafe() {
        throw new Error("deadlock detected");
      },
    };
    const result = await pruneNeuronsToCapture(sql, new Map([[1, 1_000]]));
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /deadlock detected/);
  });
});

describe("the mirror's prune ordering", () => {
  test("prunes AFTER the upserts, and only when every table landed", async () => {
    const sql = fakeSql();
    const spy = laneSpy();
    await mirrorNeuronSnapshotToNeon(
      { ...pgMockEnv() },
      { waitUntil: () => undefined },
      {
        rows: [{ netuid: 1, uid: 0, captured_at: 1_000 }],
        dailyRows: [],
        positionRows: [],
        netuidMaxCapturedAt: new Map([[1, 1_000]]),
      },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    const texts = sql.calls.map((c) => c.text);
    const upsert = texts.findIndex((t) => t.includes("INTO neurons "));
    const prune = texts.findIndex((t) => t.includes("DELETE FROM neurons"));
    assert.ok(upsert >= 0, "no upsert was issued");
    assert.ok(prune > upsert, "the prune ran before the rows it deletes under");
  });

  test("a failed upsert withholds the prune", async () => {
    // A prune on top of a failed upsert deletes the old rows without the new
    // ones replacing them -- it turns a retryable write failure into missing
    // data.
    const sql = fakeSql("neurons");
    const spy = laneSpy();
    await mirrorNeuronSnapshotToNeon(
      { ...pgMockEnv() },
      { waitUntil: () => undefined },
      {
        rows: [{ netuid: 1, uid: 0, captured_at: 1_000 }],
        dailyRows: [],
        positionRows: [],
        netuidMaxCapturedAt: new Map([[1, 1_000]]),
      },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(
      sql.calls.some((c) => c.text.includes("DELETE FROM neurons")),
      false,
      "pruned on top of a failed upsert",
    );
  });

  test("a failed prune does NOT fail the pass", async () => {
    // THE BUG THIS PINS, caught by tests/data-api-neurons-d1 rather than by
    // review: the prune result was first reported INSIDE `results`, and every
    // caller folds over `results` to decide whether the request failed. A
    // transient prune failure would therefore 502 a pass whose rows all landed,
    // and the producer would re-send a snapshot that is already stored.
    //
    // The rows are the valuable half. Stale UIDs cost one tick; a rejected pass
    // costs the pass.
    const sql = {
      calls: [] as { text: string }[],
      async unsafe(text: string) {
        sql.calls.push({ text });
        if (text.startsWith("DELETE")) throw new Error("deadlock detected");
        return [];
      },
    };
    const spy = laneSpy();
    const outcome = await mirrorNeuronSnapshotToNeon(
      { ...pgMockEnv() },
      { waitUntil: () => undefined },
      {
        rows: [{ netuid: 1, uid: 0, captured_at: 1_000 }],
        dailyRows: [],
        positionRows: [],
        netuidMaxCapturedAt: new Map([[1, 1_000]]),
      },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(
      Object.values(outcome.results).every((r) => r.ok),
      true,
      "the failed prune leaked into results and would fail the request",
    );
    // Still visible, on its own: reported beside results and recorded as its
    // own lane verdict, so it cannot fail silently either.
    assert.equal(outcome.prune?.ok, false);
    assert.ok(
      spy.rows.some(
        (r) =>
          r.lane === `neon:${NEURONS_NEON_LANE}-prune` && r.verdict !== "ok",
      ),
      "no lane verdict recorded for the failed prune",
    );
  });

  test("no cutoffs means no prune -- the backfill route passes none", async () => {
    // handleNeuronDailyBackfill walks PAST snapshot_dates and must never touch
    // `neurons`. Absent cutoffs must read as "do not prune", never as "prune
    // everything".
    const sql = fakeSql();
    const spy = laneSpy();
    await mirrorNeuronSnapshotToNeon(
      { ...pgMockEnv() },
      { waitUntil: () => undefined },
      {
        rows: [],
        dailyRows: [{ netuid: 1, uid: 0, snapshot_date: "2026-01-01" }],
        positionRows: [],
      },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(
      sql.calls.some((c) => c.text.includes("DELETE FROM neurons")),
      false,
      "a backfill pruned the latest-only table",
    );
  });
});
