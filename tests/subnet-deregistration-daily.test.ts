// The daily deregistration-input series (#10296), executed on real Postgres.
//
// The upsert here carries an out-of-order guard in SQL -- a late tick reading an
// older pinned block must not overwrite a fresher row -- and a guard expressed
// as `WHERE COALESCE(EXCLUDED.pinned_block, -1) >= COALESCE(t.pinned_block, -1)`
// is a claim about what an ENGINE does with NULLs on a conflicting insert. That
// is not checkable by reading the string, and it is exactly the class the
// retired SQLite double used to answer wrongly, so these run the real
// migration on pglite and read the rows back.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, test } from "vitest";
import {
  DEREGISTRATION_DAILY_COVERAGE_FLOOR,
  deregistrationDailyBinds,
  deregistrationDailyRows,
  deregistrationDailyUpsertSql,
  runSubnetDeregistrationDailyLane,
  snapshotDateFor,
  SUBNET_DEREGISTRATION_DAILY_LANE,
} from "../src/subnet-deregistration-daily.ts";

const MIGRATIONS = ["migrations/neon/0015_subnet_deregistration_daily.sql"].map(
  (f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"),
);

const T = 1_786_300_000_000;
const DATE = snapshotDateFor(T);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
});

beforeEach(async () => {
  // Re-apply rather than only TRUNCATE: one instance serves the file and a test
  // below drops the table on purpose. The migration is IF NOT EXISTS.
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec("TRUNCATE subnet_deregistration_daily");
});

/** The `unsafe(text, values)` seam the lane writes through. */
const sql = {
  unsafe: async (text: string, values?: unknown[]) =>
    (await db.query(text, (values ?? []) as never[])).rows,
};

/** An economics blob that projects: chain_state plus `count` subnets. */
function blob(count: number, block = 8_808_300, immunity = 50_000) {
  return {
    chain_state: { block, network_immunity_period: immunity },
    subnets: Array.from({ length: count }, (_, i) => ({
      netuid: i + 1,
      moving_price_pinned: 0.5 + i / 1000,
      registered_at_block: 1_000_000 + i,
      subnet_mechanism: 1,
    })),
  };
}

const rowsFor = (netuid: number) =>
  db
    .query("SELECT * FROM subnet_deregistration_daily WHERE netuid = $1", [
      netuid,
    ] as never[])
    .then((r) => r.rows as Record<string, unknown>[]);

describe("extracting the measured inputs", () => {
  test("a blob that does not project yields null, NOT an empty day", () => {
    // The distinction this test exists for. `[]` would be written as "a day on
    // which no subnet existed"; null is "we could not read". Collapsing them is
    // how a broken economics sweep reads as a quiet network.
    for (const bad of [
      null,
      undefined,
      {},
      { subnets: [] },
      // chain_state present but unusable: no block to judge immunity at.
      {
        chain_state: { network_immunity_period: 50_000 },
        subnets: [{ netuid: 1 }],
      },
      // …and no immunity period, which the projector also refuses.
      { chain_state: { block: 100 }, subnets: [{ netuid: 1 }] },
    ]) {
      assert.equal(
        deregistrationDailyRows(bad, DATE, T),
        null,
        JSON.stringify(bad),
      );
    }
  });

  test("every row carries the block and immunity period it was judged at", () => {
    const rows = deregistrationDailyRows(blob(3), DATE, T)!;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.pinned_block, 8_808_300);
      assert.equal(row.network_immunity_period, 50_000);
      assert.equal(row.snapshot_date, DATE);
      assert.equal(row.captured_at, T);
    }
  });

  test("a missing price is null, never zero", () => {
    // A subnet with no price is not a subnet priced at zero, and the ranking
    // treats the two differently -- 0 sorts first, null is excluded.
    const rows = deregistrationDailyRows(
      {
        chain_state: { block: 10, network_immunity_period: 5 },
        subnets: [{ netuid: 1 }, { netuid: 2, moving_price_pinned: 0 }],
      },
      DATE,
      T,
    )!;
    assert.equal(rows[0]!.moving_price, null);
    assert.equal(rows[1]!.moving_price, 0);
  });

  test("a non-integer netuid is skipped rather than coerced", () => {
    const rows = deregistrationDailyRows(
      {
        chain_state: { block: 10, network_immunity_period: 5 },
        subnets: [{ netuid: 1 }, { netuid: "2" }, { netuid: 3.5 }, {}],
      },
      DATE,
      T,
    )!;
    assert.deepEqual(
      rows.map((r) => r.netuid),
      [1],
    );
  });
});

describe("the upsert, on real Postgres", () => {
  test("writes a day and reads it back with the types the schema declares", async () => {
    const rows = deregistrationDailyRows(blob(2), DATE, T)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(rows.length),
      deregistrationDailyBinds(rows),
    );
    const [row] = await rowsFor(1);
    assert.equal(Number(row!.netuid), 1);
    assert.equal(row!.snapshot_date, DATE);
    assert.equal(Number(row!.moving_price), 0.5);
    assert.equal(Number(row!.pinned_block), 8_808_300);
  });

  test("a second tick on the same date REPLACES rather than duplicating", async () => {
    const first = deregistrationDailyRows(blob(2, 100), DATE, T)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(first.length),
      deregistrationDailyBinds(first),
    );
    const second = deregistrationDailyRows(blob(2, 200), DATE, T + 60_000)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(second.length),
      deregistrationDailyBinds(second),
    );
    const got = await rowsFor(1);
    assert.equal(got.length, 1, "the primary key must collapse the two ticks");
    assert.equal(Number(got[0]!.pinned_block), 200);
  });

  test("a LATE tick at an OLDER block does not overwrite the fresher row", async () => {
    // The guard. Ticks are not ordered -- a retry can land after a newer pass
    // has already written -- and the wall clock says when we looked while the
    // block says what we saw, which is why the WHERE compares pinned_block.
    const fresh = deregistrationDailyRows(blob(1, 900), DATE, T)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(1),
      deregistrationDailyBinds(fresh),
    );
    const stale = deregistrationDailyRows(blob(1, 100), DATE, T + 60_000)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(1),
      deregistrationDailyBinds(stale),
    );
    const [row] = await rowsFor(1);
    assert.equal(Number(row!.pinned_block), 900, "the older block won");
    assert.equal(
      Number(row!.captured_at),
      T,
      "and it did not smuggle its stamp in",
    );
  });

  test("a real block beats a stored NULL block", async () => {
    // COALESCE(existing, -1): a row written before a block was readable must
    // not become permanently unwritable.
    await sql.unsafe(
      "INSERT INTO subnet_deregistration_daily (netuid, snapshot_date, pinned_block, captured_at) VALUES ($1,$2,$3,$4)",
      [1, DATE, null, T],
    );
    const rows = deregistrationDailyRows(blob(1, 500), DATE, T + 1000)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(1),
      deregistrationDailyBinds(rows),
    );
    const [row] = await rowsFor(1);
    assert.equal(Number(row!.pinned_block), 500);
  });

  test("the epoch-millis CHECK rejects a seconds-valued stamp", async () => {
    // #9782: a stamp missing three digits produced a row dated 1970 that no
    // later pass could revise. The constraint is the only thing that catches it.
    await assert.rejects(
      sql.unsafe(
        "INSERT INTO subnet_deregistration_daily (netuid, snapshot_date, captured_at) VALUES ($1,$2,$3)",
        [1, DATE, 1_786_300_000],
      ),
      /captured_at_is_millis|violates check constraint/i,
    );
  });

  test("two dates for one subnet are two rows -- the series accrues", async () => {
    const day1 = deregistrationDailyRows(blob(1, 100), "2026-08-01", T)!;
    const day2 = deregistrationDailyRows(blob(1, 200), "2026-08-02", T)!;
    await sql.unsafe(
      deregistrationDailyUpsertSql(1),
      deregistrationDailyBinds(day1),
    );
    await sql.unsafe(
      deregistrationDailyUpsertSql(1),
      deregistrationDailyBinds(day2),
    );
    const got = await rowsFor(1);
    assert.equal(got.length, 2);
  });
});

describe("the lane", () => {
  // Statement TEXT, not a call count. recordLaneVerdict issues two statements
  // per verdict -- the INSERT and a retention DELETE -- so counting calls
  // asserts an implementation detail of lane-health and breaks the day it
  // gains or drops one. What this file cares about is that a verdict row was
  // written on every path.
  const statements: string[] = [];
  const laneHealthDb = {
    prepare: (text: string) => ({
      bind: () => ({
        run: async () => {
          statements.push(text);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as never;
  const verdicts = () =>
    statements.filter((text) => /INSERT INTO lane_health/i.test(text));
  const env = {} as Record<string, unknown>;

  beforeEach(() => {
    statements.length = 0;
  });

  test("writes the day and reports ok", async () => {
    const out = await runSubnetDeregistrationDailyLane(env, {
      readEconomics: async () => blob(DEREGISTRATION_DAILY_COVERAGE_FLOOR),
      sql,
      laneHealthDb,
      now: () => T,
    });
    assert.equal(out.ok, true);
    assert.equal(out.captured, DEREGISTRATION_DAILY_COVERAGE_FLOOR);
    const written = await db.query(
      "SELECT count(*)::int AS n FROM subnet_deregistration_daily",
    );
    assert.equal(
      (written.rows[0] as { n: number }).n,
      DEREGISTRATION_DAILY_COVERAGE_FLOOR,
    );
  });

  test("a SHORT pass writes NOTHING and says so", async () => {
    // A third of the network is not a small day, it is a broken read. Writing
    // it would look like a successful tick forever after.
    const out = await runSubnetDeregistrationDailyLane(env, {
      readEconomics: async () => blob(DEREGISTRATION_DAILY_COVERAGE_FLOOR - 1),
      sql,
      laneHealthDb,
      now: () => T,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "partial_coverage");
    const written = await db.query(
      "SELECT count(*)::int AS n FROM subnet_deregistration_daily",
    );
    assert.equal(
      (written.rows[0] as { n: number }).n,
      0,
      "nothing may be written",
    );
  });

  test("an unreadable blob is stale, not a quiet ok", async () => {
    const out = await runSubnetDeregistrationDailyLane(env, {
      readEconomics: async () => ({}),
      sql,
      laneHealthDb,
      now: () => T,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "economics_unavailable");
  });

  test("a failing write is reported, never swallowed", async () => {
    await db.exec("DROP TABLE subnet_deregistration_daily");
    const out = await runSubnetDeregistrationDailyLane(env, {
      readEconomics: async () => blob(DEREGISTRATION_DAILY_COVERAGE_FLOOR),
      sql,
      laneHealthDb,
      now: () => T,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "write_failed");
  });

  test("every path records a verdict, including the failures", async () => {
    // The lane returns rather than throwing, so the verdict is the ONLY thing
    // a watchdog can see. A path that returns quietly is a silent lane.
    for (const readEconomics of [
      async () => blob(DEREGISTRATION_DAILY_COVERAGE_FLOOR),
      async () => blob(1),
      async () => ({}),
    ]) {
      statements.length = 0;
      await runSubnetDeregistrationDailyLane(env, {
        readEconomics,
        sql,
        laneHealthDb,
        now: () => T,
      });
      assert.equal(verdicts().length, 1);
    }
    statements.length = 0;
    await runSubnetDeregistrationDailyLane(env, {
      readEconomics: async () => blob(200),
      sql: null,
      laneHealthDb,
      now: () => T,
    });
    assert.equal(verdicts().length, 1, "an unbound store must still report");
  });

  test("the lane name is stable", () => {
    assert.equal(
      SUBNET_DEREGISTRATION_DAILY_LANE,
      "subnet-deregistration-daily",
    );
  });
});

describe("the published artifact cannot feed this lane", () => {
  // MEASURED against https://api.metagraph.sh/metagraph/economics.json on
  // 2026-08-10. The artifact carries `moving_price_pinned` and NONE of the
  // other three inputs a ranking needs:
  //
  //   chain_state keys: block, block_hash, emission_bar_quantile,
  //                     emission_gate_bar, emission_gate_exponent,
  //                     total_issuance_tao      <- no network_immunity_period
  //   subnets[].registered_at_block  null
  //   subnets[].subnet_mechanism     null
  //
  // Only the live KV blob (meta.source: live-cron-prober) has them, which is
  // why /api/v1/chain/deregistration-ranking answers 112 ranked / 16 immune
  // from it while the artifact would answer nothing.
  //
  // The lane is therefore wired to KV with NO artifact fallback: a fallback
  // that provably cannot succeed would give `economics_unavailable` two
  // possible causes and make an operator rule one out. This test is here so
  // that re-adding the fallback -- which looks like an obvious robustness
  // improvement -- fails rather than quietly doing nothing.
  const publishedArtifactShape = {
    chain_state: {
      block: 8_805_503,
      block_hash: "0x5280512b",
      emission_bar_quantile: 0.75,
      emission_gate_bar: 0.007511840648689622,
      emission_gate_exponent: null,
      total_issuance_tao: 1,
    },
    subnets: Array.from({ length: 129 }, (_, i) => ({
      netuid: i,
      moving_price_pinned: 0.08837078302167356,
      registered_at_block: null,
      subnet_mechanism: null,
    })),
  };

  test("yields null -- there is no ranking to store", () => {
    assert.equal(
      deregistrationDailyRows(publishedArtifactShape, DATE, T),
      null,
      "the artifact must not be treated as a usable source",
    );
  });

  test("and the one missing field alone is enough to refuse", () => {
    // Adding the two per-subnet fields is still not sufficient: without
    // network_immunity_period the ordering is a DIFFERENT ordering that looks
    // identical, which is the #10285 argument for refusing rather than
    // approximating.
    const withSubnetFields = {
      ...publishedArtifactShape,
      subnets: publishedArtifactShape.subnets.map((s) => ({
        ...s,
        registered_at_block: 1_000_000,
        subnet_mechanism: 1,
      })),
    };
    assert.equal(deregistrationDailyRows(withSubnetFields, DATE, T), null);
  });

  test("the KV blob's shape DOES work, which is the contrast", () => {
    const live = {
      chain_state: {
        block: 8_805_503,
        network_immunity_period: 864_000,
      },
      subnets: publishedArtifactShape.subnets.map((s) => ({
        ...s,
        registered_at_block: 1_000_000,
        subnet_mechanism: 1,
      })),
    };
    const rows = deregistrationDailyRows(live, DATE, T);
    assert.ok(rows, "the live blob must project");
    assert.equal(rows.length, 129);
    assert.equal(rows[0]!.network_immunity_period, 864_000);
  });
});
