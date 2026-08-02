// Executes the resurrected D1 read loaders in src/analytics-live.ts against a
// REAL SQLite database built from migrations/d1/0002_observations.sql — same
// rationale as tests/observations-d1-sqlite.test.ts (the write half): a fake
// records SQL but never parses it, and the riskiest constructs here (the rank
// CTE, the gap-island window functions, the HAVING-bound min_samples floor)
// only fail at execution. node:sqlite keeps this dependency-free.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import {
  loadGlobalIncidentRows,
  loadGlobalIncidents,
  loadSubnetHealthTrends,
  loadSubnetIncidents,
  loadSubnetPercentiles,
  loadSubnetTrajectory,
  loadSubnetUptime,
  type ObservationsReadDb,
} from "../src/analytics-live.ts";
import { loadEconomicsTrends } from "../src/economics-trends.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0002_observations.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

// The read-slice fake: prepare().bind().all() returns the row array directly
// (the node:sqlite shape d1All explicitly accepts alongside D1's { results }).
function readDb(): ObservationsReadDb {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all: async () =>
              db.prepare(sql).all(...(values as never[])) as unknown,
          };
        },
      };
    },
  };
}

// A D1-shaped fake for the same database, so the { results } unwrap branch is
// executed against real rows too.
function readDbD1Shaped(): ObservationsReadDb {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all: async () => ({
              results: db.prepare(sql).all(...(values as never[])),
            }),
          };
        },
      };
    },
  };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

function seedCheck(over: Record<string, unknown> = {}) {
  const row = {
    surface_id: "sn8-docs",
    surface_key: "8|docs|https://example.com/docs",
    netuid: 8,
    kind: "docs",
    status: "ok",
    classification: null,
    latency_ms: 120,
    status_code: 200,
    ok: 1,
    checked_at: Date.now() - 60_000,
    ...over,
  };
  db.prepare(
    `INSERT INTO surface_checks
     (surface_id, surface_key, netuid, kind, status, classification, latency_ms, status_code, ok, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
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
    ] as never[]),
  );
}

function seedUptimeDay(over: Record<string, unknown> = {}) {
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
  db.prepare(
    `INSERT INTO surface_uptime_daily
     (surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio, avg_latency_ms, status, latency_samples, p50_latency_ms, p95_latency_ms, p99_latency_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
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
    ] as never[]),
  );
}

test("loadSubnetUptime reads day rows from D1 and formats them", async () => {
  seedUptimeDay();
  seedUptimeDay({
    day: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
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

test("loadSubnetUptime min_samples floor drops low-sample days (HAVING branch)", async () => {
  seedUptimeDay();
  seedUptimeDay({
    day: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
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

test("loadSubnetUptime without a binding keeps the schema-stable empty shape", async () => {
  seedUptimeDay();
  const data = (await loadSubnetUptime(8, {})) as { surfaces: unknown[] };
  assert.deepEqual(data.surfaces, []);
});

test("loadSubnetHealthTrends aggregates checks per window from D1", async () => {
  seedCheck();
  seedCheck({ ok: 0, status: "failed", checked_at: Date.now() - 120_000 });
  const data = (await loadSubnetHealthTrends(8, {
    db: readDbD1Shaped(),
  })) as {
    windows: Record<string, { samples: number; surfaces: unknown[] }>;
  };
  const w7 = data.windows["7d"]!;
  assert.equal(w7.surfaces.length, 1);
  assert.equal(w7.samples, 2);
});

test("loadSubnetPercentiles computes latency stats from D1", async () => {
  for (const latency of [100, 200, 300, 400]) {
    seedCheck({ latency_ms: latency, checked_at: Date.now() - latency * 60 });
  }
  const data = (await loadSubnetPercentiles(8, { db: readDb() })) as {
    surfaces: { samples?: unknown }[];
  };
  assert.equal(data.surfaces.length, 1);
});

test("loadSubnetIncidents reconstructs a failure island from D1", async () => {
  const base = Date.now() - 60 * 60 * 1000;
  // Three consecutive failures within the incident gap = one incident.
  for (let i = 0; i < 3; i += 1) {
    seedCheck({ ok: 0, status: "failed", checked_at: base + i * 60_000 });
  }
  seedCheck({ checked_at: base + 10 * 60_000 });
  const data = (await loadSubnetIncidents(8, { db: readDb() })) as {
    surfaces: { incidents: unknown[] }[];
  };
  assert.equal(data.surfaces.length, 1);
  assert.equal(data.surfaces[0]!.incidents.length, 1);
});

test("loadGlobalIncidents surfaces cross-subnet incidents from D1", async () => {
  const base = Date.now() - 30 * 60 * 1000;
  for (let i = 0; i < 2; i += 1) {
    seedCheck({
      netuid: 21,
      surface_id: "sn21-api",
      surface_key: "21|api|https://api.example.com",
      ok: 0,
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

test("a throwing or absent db degrades every loader to the empty shape", async () => {
  const exploding: ObservationsReadDb = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error("d1 down");
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
  const rows = await loadGlobalIncidentRows(null, 7);
  assert.deepEqual(rows, []);
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

function seedSnapshot(over: Record<string, unknown> = {}) {
  const row = {
    netuid: 8,
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
  db.prepare(
    `INSERT INTO subnet_snapshots
     (netuid, snapshot_date, completeness_score, surface_count, endpoint_count, validator_count, miner_count, total_stake_tao, alpha_price_tao, emission_share, tao_in_pool_tao, alpha_in_pool, alpha_out_pool, subnet_volume_tao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
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
    ] as never[]),
  );
}

test("loadSubnetTrajectory reads snapshot rows from D1 and formats them", async () => {
  seedSnapshot();
  seedSnapshot({ snapshot_date: "2026-08-02", completeness_score: 72 });
  const data = (await loadSubnetTrajectory(8, { db: readDb() })) as {
    netuid: unknown;
    point_count: number;
    points: { date: string }[];
  };
  assert.equal(data.point_count, 2);
  assert.equal(data.points[0]!.date, "2026-08-01");
});

test("loadSubnetTrajectory without a binding keeps the empty trajectory", async () => {
  seedSnapshot();
  const data = (await loadSubnetTrajectory(8, {})) as { point_count: number };
  assert.equal(data.point_count, 0);
});

test("loadEconomicsTrends aggregates snapshots per day, windowed and unwindowed", async () => {
  seedSnapshot();
  seedSnapshot({ netuid: 21, total_stake_tao: 100 });
  seedSnapshot({ snapshot_date: "2026-07-01" });
  const all = await loadEconomicsTrends({ windowLabel: "all", db: readDb() });
  assert.equal((all.data.days as unknown[]).length, 2, "both days aggregated");
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
