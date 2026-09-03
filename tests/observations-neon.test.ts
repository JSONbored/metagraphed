// The observation family against Postgres (#10069).
//
// The assertions that matter here are the three things that do not survive a
// naive port, because each one fails in a way a passing test suite would not
// notice: a rounded percentile, a boolean bound as 0/1, and a rollup that reads
// the store its probes stopped going to.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  OBSERVATION_TABLES,
  neonOwnsObservations,
  persistProbesToNeon,
  pruneChecksNeon,
  rollupFailureReasonsToNeon,
  rollupUptimeDailyToNeon,
  upsertSubnetSnapshotsToNeon,
} from "../src/observations-neon.ts";

function recordingSql(fail?: string) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    texts: () => calls.map((c) => c.text),
    sql: {
      unsafe: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (fail) throw new Error(fail);
        return [];
      },
    },
  };
}

const DAYS = [{ date: "2026-08-08", start: 1000, end: 2000 }];

describe("neonOwnsObservations is all-or-nothing", () => {
  const bound = { HYPERDRIVE: { connectionString: "postgresql://x" } };

  // The per-table ownership tests retired with the injected predicate
  // (#10051): Neon is the only store, so the family cannot be pinned to a
  // deleted D1 by a half-listed group any more. What remains decidable is
  // the binding.
  test("bound Hyperdrive answers yes", () => {
    assert.equal(neonOwnsObservations(bound), true);
  });

  test("owned but no Hyperdrive stays on D1", () => {
    // Skipping the D1 write with nowhere to put the rows drops a probe sweep,
    // and a probe not stored is gone -- there is no chain to replay it from.
    assert.equal(neonOwnsObservations({}), false);
  });

  test("the declared group is exactly what this module writes", () => {
    assert.deepEqual([...OBSERVATION_TABLES].sort(), [
      "subnet_snapshots",
      "surface_checks",
      "surface_failure_daily",
      "surface_status",
      "surface_uptime_daily",
    ]);
  });
});

describe("persistProbesToNeon", () => {
  const probe = {
    surface_id: "s1",
    surface_key: "k1",
    netuid: 7,
    status: "ok",
    latency_ms: 12,
    checked_at_ms: 500,
    last_ok_ms: 500,
    consecutive_failures: 0,
  };

  test("ok binds as a BOOLEAN, not 0/1", async () => {
    // surface_checks.ok is INTEGER in D1 and BOOLEAN in Neon. Asserted by TYPE:
    // 0 == false loosely, so a value check would pass on the exact bug.
    const { sql, calls } = recordingSql();
    await persistProbesToNeon(
      sql,
      [probe, { ...probe, status: "failed" }],
      900,
    );
    const checks = calls.filter((c) =>
      c.text.includes("INSERT INTO surface_checks"),
    );
    assert.equal(typeof checks[0]!.values[8], "boolean");
    assert.equal(checks[0]!.values[8], true);
    assert.equal(checks[1]!.values[8], false, "a non-ok probe was not false");
  });

  test("an empty sweep writes nothing and says why", async () => {
    const { sql, calls } = recordingSql();
    const out = await persistProbesToNeon(sql, [], 900);
    assert.deepEqual(out, { ok: false, reason: "no_rows" });
    assert.equal(calls.length, 0);
  });

  test("a failure is reported, never thrown", async () => {
    // A failed history write must not take the probe sweep down with it.
    const { sql } = recordingSql("connection reset");
    const out = await persistProbesToNeon(sql, [probe], 900);
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /connection reset/);
  });
});

describe("the rollups", () => {
  test("percentiles use ceil(), never SQLite's CAST-plus-carry", async () => {
    // THE SILENT ONE. CAST(x AS INTEGER) truncates in SQLite and ROUNDS in
    // Postgres -- CAST(2.5) is 2 there and 3 here -- so the ported expression
    // would pick the wrong rank without erroring. (Its other half, adding a
    // boolean to an integer, WOULD error. Relying on that is luck.)
    const { sql, texts } = recordingSql();
    await rollupUptimeDailyToNeon(sql, DAYS, 900);
    const stmt = texts()[0]!;
    for (const q of ["0.5", "0.95", "0.99"]) {
      assert.ok(
        stmt.includes(`ceil(${q} * lat_cnt)::int`),
        `p${q} does not use ceil`,
      );
    }
    assert.equal(/CAST\(.*AS INTEGER\)/.test(stmt), false);
  });

  test("ok is counted with FILTER, never SUM(ok)", async () => {
    // SUM of a boolean is a type error in Postgres.
    const { sql, texts } = recordingSql();
    await rollupUptimeDailyToNeon(sql, DAYS, 900);
    const stmt = texts()[0]!;
    assert.ok(stmt.includes("COUNT(*) FILTER (WHERE ok)"));
    assert.equal(/SUM\(ok\)/.test(stmt), false);
    assert.equal(/ok = 1/.test(stmt), false);
  });

  test("the uptime ratio is clamped below 1.0 unless every sample was ok", async () => {
    // One failure in ten thousand must not round to a clean 100%.
    const { sql, texts } = recordingSql();
    await rollupUptimeDailyToNeon(sql, DAYS, 900);
    const stmt = texts()[0]!;
    assert.ok(stmt.includes("THEN 0.9999"));
    assert.ok(stmt.includes("::numeric"), "ROUND(x, 4) needs numeric in PG");
  });

  test("the failure rollup conflicts on plain columns, not ifnull()", async () => {
    // Neon's ux_surface_failure_daily_key is NULLS NOT DISTINCT, which is the
    // native form of the expression index D1 needed because SQLite treats
    // NULLs as distinct in a unique constraint.
    const { sql, texts } = recordingSql();
    await rollupFailureReasonsToNeon(sql, DAYS, 900);
    const stmt = texts()[0]!;
    assert.ok(stmt.includes("ON CONFLICT (day, netuid, kind, classification)"));
    assert.equal(/ifnull/i.test(stmt), false);
  });

  test("one statement per day, both rollups", async () => {
    const two = [...DAYS, { date: "2026-08-07", start: 0, end: 1000 }];
    const a = recordingSql();
    await rollupUptimeDailyToNeon(a.sql, two, 900);
    assert.equal(a.calls.length, 2);
    const b = recordingSql();
    await rollupFailureReasonsToNeon(b.sql, two, 900);
    assert.equal(b.calls.length, 2);
  });
});

describe("subnet_snapshots and the prune", () => {
  test("the two flags bind as BOOLEANS", async () => {
    const { sql, calls } = recordingSql();
    await upsertSubnetSnapshotsToNeon(sql, [
      {
        netuid: 1,
        snapshot_date: "2026-08-08",
        emission_enabled: 1,
        subtoken_enabled: 0,
      },
    ]);
    const v = calls[0]!.values;
    assert.equal(typeof v[22], "boolean");
    assert.equal(typeof v[23], "boolean");
    assert.equal(v[22], true);
    assert.equal(v[23], false);
  });

  test("a null flag stays null rather than becoming false", async () => {
    // null means "not observed"; false means "observed and off". Collapsing
    // them would publish a claim the chain never made.
    const { sql, calls } = recordingSql();
    await upsertSubnetSnapshotsToNeon(sql, [
      { netuid: 1, snapshot_date: "2026-08-08", emission_enabled: null },
    ]);
    assert.equal(calls[0]!.values[22], null);
  });

  test("the prune deletes by the cutoff it was given", async () => {
    const { sql, calls } = recordingSql();
    await pruneChecksNeon(sql, 12345);
    assert.ok(calls[0]!.text.includes("DELETE FROM surface_checks"));
    assert.deepEqual(calls[0]!.values, [12345]);
  });
});
