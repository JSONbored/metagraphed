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
  const owns =
    (owned: string[]) =>
    (_e: unknown, table: string): boolean =>
      owned.includes(table);
  const bound = { HYPERDRIVE: { connectionString: "postgresql://x" } };

  test("every table owned and Hyperdrive bound", () => {
    assert.equal(
      neonOwnsObservations(bound, owns([...OBSERVATION_TABLES])),
      true,
    );
  });

  test("ONE table left out keeps the whole family on D1", () => {
    // Two of these writes are INSERT ... SELECT FROM surface_checks. A
    // half-listed group would leave a rollup aggregating a D1 that no longer
    // receives probes -- and that is a schema-stable empty, not an error, so
    // the daily series would just quietly go to zero.
    for (const missing of OBSERVATION_TABLES) {
      const partial = OBSERVATION_TABLES.filter((t) => t !== missing);
      assert.equal(
        neonOwnsObservations(bound, owns([...partial])),
        false,
        `${missing} missing should pin the family to D1`,
      );
    }
  });

  test("owned but no Hyperdrive stays on D1", () => {
    // Skipping the D1 write with nowhere to put the rows drops a probe sweep,
    // and a probe not stored is gone -- there is no chain to replay it from.
    assert.equal(
      neonOwnsObservations({}, owns([...OBSERVATION_TABLES])),
      false,
    );
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

  test("the rename is resolved BEFORE the upsert", async () => {
    // Postgres allows exactly one ON CONFLICT clause, and surface_status needs
    // two arbiters (surface_key for a display-id rename, surface_id for keyless
    // rows). Adopting the new id onto the key's row first leaves a single
    // arbiter with nothing to collide on. Order is the whole mechanism: run the
    // upsert first and it inserts a second row, then the UPDATE hits the unique
    // index.
    const { sql, texts } = recordingSql();
    await persistProbesToNeon(sql, [probe], 900);
    const t = texts();
    const updateAt = t.findIndex((x) => x.includes("UPDATE surface_status"));
    const upsertAt = t.findIndex((x) =>
      x.includes("INSERT INTO surface_status"),
    );
    assert.ok(updateAt >= 0, "no rename resolution was issued");
    assert.ok(upsertAt >= 0, "no status upsert was issued");
    assert.ok(updateAt < upsertAt, "the upsert ran before the rename resolved");
  });

  test("a keyless row skips the rename step entirely", async () => {
    const { sql, texts } = recordingSql();
    await persistProbesToNeon(sql, [{ ...probe, surface_key: null }], 900);
    assert.equal(
      texts().some((t) => t.includes("UPDATE surface_status")),
      false,
    );
  });

  test("last_ok is COALESCEd, so a run that saw nothing cannot clear it", async () => {
    // #9634: last_ok is a high-water mark. readLiveSurfaceStatus degrades to an
    // empty array on a transport failure, and a bare last_ok=excluded.last_ok
    // turned that read-side degrade into permanent write-side data loss.
    const { sql, texts } = recordingSql();
    await persistProbesToNeon(sql, [probe], 900);
    const upsert = texts().find((t) =>
      t.includes("INSERT INTO surface_status"),
    )!;
    assert.ok(
      upsert.includes(
        "last_ok=COALESCE(excluded.last_ok, surface_status.last_ok)",
      ),
    );
  });

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
