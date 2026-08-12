// Executes the read loaders in src/analytics-live.ts against a REAL POSTGRES,
// on the schema production actually has (#10227).
//
// ## Why this replaced the SQLite suite rather than joining it
//
// The predecessor built a SQLite database from a hand-kept fixture and ran
// these loaders against it. That caught what a mock cannot -- the rank CTE, the
// gap-island window functions, the HAVING-bound `min_samples` floor only fail
// at execution -- but it proved those constructs run on an engine NOTHING
// SERVES FROM. `src/graphql.ts` and `src/mcp-server.ts` reach these loaders
// through `observationsReadDb`, which is Neon, and with D1 deleted there is no
// second store for a SQLite pass to be evidence about. A Postgres-only failure
// -- a type that resolves differently, a window frame Postgres rejects, an
// aggregate over a `bigint` -- passed there and failed in production.
//
// `tests/no-sqlite-only-sql.test.ts` still guards the other direction, and it
// is static: it reads SQL text for SQLite-only spellings. Neither it nor a mock
// executes anything on Postgres. This does.
//
// ## Three seams, all of them the production ones
//
//   1. THE SCHEMA IS migrations/neon/*.sql, EXEC'D VERBATIM -- not a fixture
//      transliterated from it. A hand-kept copy is a second schema to maintain,
//      and the failure it hides is silent: a column production dropped still
//      exists here, so the query that reads it passes. `surface_checks.ok` is
//      the standing example -- INTEGER in the retired SQLite fixture, BOOLEAN
//      here, and six spellings compared it to a number before #10086.
//   2. THE ADAPTER IS `pgObservationsReadDb`, the one src/graphql.ts gets.
//      Two adapters in this tree present Postgres as a D1-shaped reader and
//      they once disagreed about the result envelope; a bespoke test double
//      would be a third opinion.
//   3. THE PLACEHOLDERS GO THROUGH `toPositionalPlaceholders`, because the
//      loaders bind `?` and Postgres only accepts `$n`. That rewrite is
//      `createPgSql.unsafe`'s, reused rather than reimplemented so this cannot
//      pass on a conversion production does not perform.
//
// ## What pglite is and is not
//
// It is real Postgres compiled to wasm -- the same parser, planner and executor
// -- in-process, so this needs no service and no credential. It is NOT the Neon
// deployment: it cannot show a Hyperdrive behaviour, a connection-pool
// interaction, or a plan chosen against production statistics. Those need a
// throwaway branch (#10227 option 2) and are a different question from "does
// this SQL execute on Postgres at all", which is the one that was unanswered.
//
// One detail worth naming because it looks like luck: BIGINT arrives as a JS
// number here, and production agrees -- but only because src/pg-sql.ts sets an
// int8 type parser to make it so (node-postgres returns int8 as a STRING by
// default). The agreement is configured, not inherent.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, test } from "vitest";
import {
  loadGlobalIncidentRows,
  loadGlobalIncidents,
  loadSubnetHealthTrends,
  loadSubnetIncidents,
  loadSubnetPercentiles,
  loadSubnetTrajectory,
  loadSubnetUptime,
  loadLeaderboardStoreRows,
  loadRegistryLeaderboards,
  loadCompareSubnets,
  type ObservationsReadDb,
} from "../src/analytics-live.ts";
import { loadEconomicsTrends } from "../src/economics-trends.ts";
import { pgObservationsReadDb } from "../src/observations-read-runner.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

/**
 * The migrations that create every table these loaders read.
 *
 * Applied whole rather than sliced to the four tables: a slice is a judgement
 * about which statements matter, and the constraints outside the CREATE TABLE
 * -- surface_status's partial unique index, surface_uptime_daily's NOT NULL
 * primary key -- are exactly what a seed can violate.
 */
const MIGRATIONS = [
  "migrations/neon/0001_side_tables.sql",
  "migrations/neon/0002_probe_observations.sql",
].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));

/** The tables a test may write, emptied between tests. Named rather than
 * discovered, so a table added to the migrations without a seed here is a
 * visible omission rather than a silently-shared row. */
const SEEDED_TABLES = [
  "surface_checks",
  "surface_status",
  "surface_uptime_daily",
  "subnet_snapshots",
];

let pg: PGlite;

// ONE instance for the file, TRUNCATE between tests. Booting pglite is ~470ms
// and the schema never varies, so a fresh instance per test spent 9 of this
// file's 10 seconds re-applying identical DDL. Isolation is unchanged: every
// table a test can write is emptied below, and nothing here alters the schema.
beforeAll(async () => {
  pg = new PGlite();
  for (const sql of MIGRATIONS) await pg.exec(sql);
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE ${SEEDED_TABLES.join(", ")}`);
});

/** The production adapter over pglite, `?` rewritten the way production does. */
function readDb(): ObservationsReadDb {
  return pgObservationsReadDb({
    unsafe: async (text: string, values: unknown[] = []) =>
      (await pg.query(toPositionalPlaceholders(text), values as never[])).rows,
  });
}

/**
 * The same runner presenting rows as a BARE ARRAY rather than `{ results }`.
 *
 * `storeAll` accepts both and the loaders reach it through a structural type, so
 * the unwrap branch is not covered by the shape production happens to send.
 * The predecessor covered it, and dropping it while changing engines would
 * confuse "no longer tested" with "no longer true".
 */
function readDbBareArray(): ObservationsReadDb {
  return {
    prepare(text: string) {
      const all = async (values: unknown[]) =>
        (await pg.query(toPositionalPlaceholders(text), values as never[]))
          .rows as unknown;
      return { bind: (...v: unknown[]) => ({ all: () => all(v) }) };
    },
  };
}

const exec = (sql: string, values: unknown[]) =>
  pg.query(sql, values as never[]);

// --- seeds -------------------------------------------------------------------
// `ok` binds a BOOLEAN, not 1/0. That is the difference the SQLite fixture
// could not represent, and the one #10086 fixed six query spellings for.

async function seedCheck(over: Record<string, unknown> = {}) {
  const row = {
    surface_id: "sn8-docs",
    surface_key: "8|docs|https://example.com/docs",
    netuid: 8,
    kind: "docs",
    status: "ok",
    classification: null,
    latency_ms: 120,
    status_code: 200,
    ok: true,
    checked_at: Date.now() - 60_000,
    ...over,
  };
  await exec(
    `INSERT INTO surface_checks
     (surface_id, surface_key, netuid, kind, status, classification, latency_ms, status_code, ok, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.surface_id,
      row.surface_key,
      row.netuid,
      row.kind,
      row.status,
      row.classification,
      row.latency_ms,
      row.status_code,
      row.ok,
      row.checked_at,
    ],
  );
}

async function seedUptimeDay(over: Record<string, unknown> = {}) {
  const row = {
    surface_id: "sn8-docs",
    surface_key: "8|docs|https://example.com/docs",
    netuid: 8,
    day: new Date().toISOString().slice(0, 10),
    samples: 96,
    ok_count: 96,
    uptime_ratio: 1.0,
    avg_latency_ms: 100,
    status: "ok",
    latency_samples: 96,
    p50_latency_ms: 90,
    p95_latency_ms: 200,
    p99_latency_ms: 250,
    updated_at: Date.now(),
    ...over,
  };
  await exec(
    `INSERT INTO surface_uptime_daily
     (surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio, avg_latency_ms, status, latency_samples, p50_latency_ms, p95_latency_ms, p99_latency_ms, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.surface_id,
      row.surface_key,
      row.netuid,
      row.day,
      row.samples,
      row.ok_count,
      row.uptime_ratio,
      row.avg_latency_ms,
      row.status,
      row.latency_samples,
      row.p50_latency_ms,
      row.p95_latency_ms,
      row.p99_latency_ms,
      row.updated_at,
    ],
  );
}

async function seedSnapshot(over: Record<string, unknown> = {}) {
  const row = {
    netuid: 8,
    // Pinned ON PURPOSE: loadSubnetTrajectory asserts this exact string back
    // out and reads every snapshot rather than a recent window. The one caller
    // that IS window-scoped overrides it -- see TODAY below.
    snapshot_date: "2026-08-01",
    completeness_score: 70,
    surface_count: 5,
    endpoint_count: 2,
    validator_count: 64,
    miner_count: 192,
    total_stake_tao: 1234.5,
    alpha_price_tao: 0.021,
    emission_share: 0.0125,
    tao_in_pool_tao: 400.5,
    alpha_in_pool: 19000,
    alpha_out_pool: 81000,
    subnet_volume_tao: 55.25,
    ...over,
  };
  await exec(
    `INSERT INTO subnet_snapshots
     (netuid, snapshot_date, completeness_score, surface_count, endpoint_count, validator_count, miner_count, total_stake_tao, alpha_price_tao, emission_share, tao_in_pool_tao, alpha_in_pool, alpha_out_pool, subnet_volume_tao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.netuid,
      row.snapshot_date,
      row.completeness_score,
      row.surface_count,
      row.endpoint_count,
      row.validator_count,
      row.miner_count,
      row.total_stake_tao,
      row.alpha_price_tao,
      row.emission_share,
      row.tao_in_pool_tao,
      row.alpha_in_pool,
      row.alpha_out_pool,
      row.subnet_volume_tao,
    ],
  );
}

async function seedStatus(over: Record<string, unknown> = {}) {
  const row = {
    surface_id: `sn${String(over.netuid ?? 8)}-${String(over.kind ?? "docs")}`,
    surface_key: null,
    netuid: 8,
    kind: "docs",
    url: "https://example.com/docs",
    provider: null,
    status: "ok",
    classification: null,
    latency_ms: 120,
    status_code: 200,
    last_checked: Date.now(),
    last_ok: Date.now(),
    consecutive_failures: 0,
    updated_at: Date.now(),
    ...over,
  };
  await exec(
    `INSERT INTO surface_status
     (surface_id, surface_key, netuid, kind, url, provider, status, classification,
      latency_ms, status_code, last_checked, last_ok, consecutive_failures, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.surface_id,
      row.surface_key,
      row.netuid,
      row.kind,
      row.url,
      row.provider,
      row.status,
      row.classification,
      row.latency_ms,
      row.status_code,
      row.last_checked,
      row.last_ok,
      row.consecutive_failures,
      row.updated_at,
    ],
  );
}

// --- the loaders -------------------------------------------------------------

describe("uptime and trends", () => {
  test("loadSubnetUptime reads day rows and formats them", async () => {
    await seedUptimeDay();
    await seedUptimeDay({
      day: new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      ok_count: 48,
      uptime_ratio: 0.5,
      status: "degraded",
    });
    const data = (await loadSubnetUptime(8, { db: readDb() })) as {
      surfaces: { days: unknown[] }[];
    };
    assert.equal(data.surfaces.length, 1);
    assert.equal(data.surfaces[0]!.days.length, 2);
  });

  test("the min_samples floor drops low-sample days (HAVING branch)", async () => {
    await seedUptimeDay();
    await seedUptimeDay({
      day: new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      samples: 2,
      ok_count: 2,
    });
    const data = (await loadSubnetUptime(8, {
      minSamples: 10,
      db: readDb(),
    })) as { surfaces: { days: unknown[] }[] };
    assert.equal(data.surfaces.length, 1);
    assert.equal(data.surfaces[0]!.days.length, 1, "2-sample day filtered out");
  });

  test("without a binding the schema-stable empty shape survives", async () => {
    await seedUptimeDay();
    const data = (await loadSubnetUptime(8, {})) as { surfaces: unknown[] };
    assert.deepEqual(data.surfaces, []);
  });

  test("loadSubnetHealthTrends aggregates checks per window", async () => {
    await seedCheck();
    await seedCheck({
      ok: false,
      status: "failed",
      checked_at: Date.now() - 120_000,
    });
    const data = (await loadSubnetHealthTrends(8, { db: readDb() })) as {
      windows: Record<string, { samples: number; surfaces: unknown[] }>;
    };
    const w7 = data.windows["7d"]!;
    assert.equal(w7.surfaces.length, 1);
    assert.equal(w7.samples, 2);
  });

  test("loadSubnetPercentiles computes latency stats", async () => {
    for (const latency of [100, 200, 300, 400]) {
      await seedCheck({
        latency_ms: latency,
        checked_at: Date.now() - latency * 60,
      });
    }
    const data = (await loadSubnetPercentiles(8, { db: readDb() })) as {
      surfaces: { samples?: unknown }[];
    };
    assert.equal(data.surfaces.length, 1);
  });
});

describe("the gap-island window functions", () => {
  test("loadSubnetIncidents reconstructs a failure island", async () => {
    const base = Date.now() - 60 * 60 * 1000;
    // Three consecutive failures within the incident gap = one incident.
    for (let i = 0; i < 3; i += 1) {
      await seedCheck({
        ok: false,
        status: "failed",
        checked_at: base + i * 60_000,
      });
    }
    await seedCheck({ checked_at: base + 10 * 60_000 });
    const data = (await loadSubnetIncidents(8, { db: readDb() })) as {
      surfaces: { incidents: unknown[] }[];
    };
    assert.equal(data.surfaces.length, 1);
    assert.equal(data.surfaces[0]!.incidents.length, 1);
  });

  test("loadGlobalIncidents surfaces cross-subnet incidents", async () => {
    const base = Date.now() - 30 * 60 * 1000;
    for (let i = 0; i < 2; i += 1) {
      await seedCheck({
        netuid: 21,
        surface_id: "sn21-api",
        surface_key: "21|api|https://api.example.com",
        ok: false,
        status: "failed",
        checked_at: base + i * 60_000,
      });
    }
    const rows = await loadGlobalIncidentRows(readDb(), 7);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.netuid, 21);
    const data = (await loadGlobalIncidents({
      windowLabel: "7d",
      windowDays: 7,
      db: readDb(),
    })) as { surfaces: unknown[] };
    assert.equal(data.surfaces.length, 1);
  });
});

describe("declines", () => {
  test("a throwing or absent db degrades every loader to the empty shape", async () => {
    const exploding: ObservationsReadDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("neon down");
          },
        }),
      }),
    };
    const uptime = (await loadSubnetUptime(8, { db: exploding })) as {
      surfaces: unknown[];
    };
    assert.deepEqual(uptime.surfaces, []);
    const trends = (await loadSubnetHealthTrends(8, { db: exploding })) as {
      windows: Record<string, { surfaces: unknown[] }>;
    };
    assert.deepEqual(trends.windows["7d"]!.surfaces, []);
    assert.deepEqual(await loadGlobalIncidentRows(null, 7), []);
  });

  test("an all() result that is neither an array nor { results } yields zero rows", async () => {
    const weird: ObservationsReadDb = {
      prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
    };
    const data = (await loadSubnetUptime(8, { db: weird })) as {
      surfaces: unknown[];
    };
    assert.deepEqual(data.surfaces, []);
  });

  test("a bare-array envelope reads the same as { results }", async () => {
    await seedUptimeDay();
    const data = (await loadSubnetUptime(8, { db: readDbBareArray() })) as {
      surfaces: { days: unknown[] }[];
    };
    assert.equal(data.surfaces.length, 1);
    assert.equal(data.surfaces[0]!.days.length, 1);
  });
});

describe("trajectory and economics trends", () => {
  test("loadSubnetTrajectory reads snapshot rows and formats them", async () => {
    await seedSnapshot();
    await seedSnapshot({ snapshot_date: "2026-08-02", completeness_score: 72 });
    const data = (await loadSubnetTrajectory(8, { db: readDb() })) as {
      point_count: number;
      points: { date: string }[];
    };
    assert.equal(data.point_count, 2);
    assert.equal(data.points[0]!.date, "2026-08-01");
  });

  test("loadSubnetTrajectory without a binding keeps the empty trajectory", async () => {
    await seedSnapshot();
    const data = (await loadSubnetTrajectory(8, {})) as { point_count: number };
    assert.equal(data.point_count, 0);
  });

  test("loadEconomicsTrends aggregates per day, windowed and unwindowed", async () => {
    await seedSnapshot();
    await seedSnapshot({ netuid: 21, total_stake_tao: 100 });
    await seedSnapshot({ snapshot_date: "2026-07-01" });
    const all = await loadEconomicsTrends({ windowLabel: "all", db: readDb() });
    assert.equal((all.data.days as unknown[]).length, 2, "both days");
    const windowed = await loadEconomicsTrends({
      windowLabel: "30d",
      windowDays: 30,
      now: Date.parse("2026-08-02T00:00:00Z"),
      db: readDb(),
    });
    assert.equal(
      (windowed.data.days as unknown[]).length,
      1,
      "2026-07-01 sits outside the 30-day cutoff and is dropped",
    );
    const noDb = await loadEconomicsTrends({ windowLabel: "30d" });
    assert.deepEqual(noDb.rows, []);
  });
});

// --- Registry leaderboards + compare ----------------------------------------
// These four reads were deleted in #6455 and skipped by #9061's resurrection,
// so they had never been executed against a real database at all until the
// SQLite suite, and never against the engine that serves them until here.
// surfaceStatusAvgLatencySql and dailyLatencyColumns INTERPOLATE SQL fragments,
// and a fragment that no longer parses only fails at execution.

describe("registry leaderboards and compare", () => {
  test("loadLeaderboardStoreRows executes all four reads", async () => {
    await seedStatus({
      surface_id: "a",
      netuid: 3,
      status: "ok",
      latency_ms: 40,
    });
    await seedStatus({
      surface_id: "b",
      netuid: 3,
      status: "failed",
      latency_ms: 900,
    });
    await seedStatus({
      surface_id: "c",
      netuid: 3,
      kind: "subtensor-rpc",
      status: "ok",
      latency_ms: 25,
    });
    // TODAY, not the pinned default. The growth read is
    // `WHERE snapshot_date >= sevenDaysAgo` off the real clock, so a fixed date
    // only satisfies it until it ages past seven days -- #9689 found this with
    // one day to spare, and the failure would have named nothing in the diff.
    await seedSnapshot({
      netuid: 3,
      completeness_score: 50,
      snapshot_date: new Date().toISOString().slice(0, 10),
    });
    await seedUptimeDay({
      surface_id: "u1",
      netuid: 3,
      samples: 10,
      ok_count: 9,
    });

    const out = await loadLeaderboardStoreRows(readDb());

    const health = out.healthRows.find((r) => Number(r.netuid) === 3)!;
    assert.equal(Number(health.total), 3);
    assert.equal(Number(health.ok_count), 2);
    // Averages OK probes only -- the failed 900ms row must not drag the mean.
    assert.ok(Number(health.avg_latency_ms) < 100);

    // fastest-rpc reads only the rpc/wss kinds.
    assert.deepEqual(
      out.rpcRows.map((r) => [Number(r.netuid), Number(r.min_latency_ms)]),
      [[3, 25]],
    );
    assert.equal(out.growthSamples.length, 1);
    assert.equal(Number(out.reliabilityRows[0].ok_count), 9);
  });

  test("loadLeaderboardStoreRows returns empty sets without a binding", async () => {
    const out = await loadLeaderboardStoreRows(null);
    assert.deepEqual(out.healthRows, []);
    assert.deepEqual(out.rpcRows, []);
    assert.deepEqual(out.growthSamples, []);
    assert.deepEqual(out.reliabilityRows, []);
  });

  test("loadRegistryLeaderboards ranks the healthiest board", async () => {
    await seedStatus({ surface_id: "a", netuid: 3, status: "ok" });
    await seedStatus({ surface_id: "b", netuid: 7, status: "failed" });
    const data = (await loadRegistryLeaderboards({
      board: "healthiest",
      db: readDb(),
    })) as { boards: Record<string, Array<Record<string, unknown>>> };
    assert.deepEqual(
      data.boards.healthiest.map((entry) => entry.netuid),
      [3, 7],
    );
  });

  test("loadCompareSubnets filters in memory, binding no parameters", async () => {
    await seedStatus({ surface_id: "a", netuid: 3, status: "ok" });
    await seedStatus({ surface_id: "b", netuid: 7, status: "ok" });
    await seedStatus({ surface_id: "c", netuid: 9, status: "ok" });
    const bound: unknown[][] = [];
    const inner = readDb();
    const spy: ObservationsReadDb = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        return {
          bind(...values: unknown[]) {
            bound.push(values);
            return stmt.bind!(...values);
          },
        };
      },
    };
    const data = (await loadCompareSubnets({
      netuids: [3, 9],
      dimensions: ["health"],
      db: spy,
    })) as { subnets?: Array<Record<string, unknown>> };

    // No bound parameters at all. /api/v1/compare accepts up to 128 netuids
    // and the binding caps a statement at 100, so the netuid list must never
    // become `IN (?, ?, ...)`.
    assert.deepEqual(bound, [[]]);
    const netuids = (data.subnets ?? [])
      .map((s) => Number(s.netuid))
      .filter((n) => Number.isFinite(n));
    assert.deepEqual(netuids.sort(), [3, 9]);
  });

  test("loadCompareSubnets skips the read when health is not requested", async () => {
    let prepared = 0;
    const inner = readDb();
    const spy: ObservationsReadDb = {
      prepare(sql: string) {
        prepared += 1;
        return inner.prepare(sql);
      },
    };
    await loadCompareSubnets({
      netuids: [3],
      dimensions: ["economics"],
      db: spy,
    });
    assert.equal(prepared, 0);
  });
});
