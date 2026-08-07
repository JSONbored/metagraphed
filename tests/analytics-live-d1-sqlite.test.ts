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
  loadLeaderboardD1Rows,
  loadRegistryLeaderboards,
  loadCompareSubnets,
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
    // Pinned ON PURPOSE: loadSubnetTrajectory's test asserts this exact string
    // back out, and it reads every snapshot rather than a recent window. The
    // one caller that IS window-scoped overrides it — see TODAY below.
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

// --- Registry leaderboards + compare, resurrected 2026-08-03 -----------------
// These four reads were deleted in #6455 and skipped by #9061's resurrection,
// so they had never been executed against a real database. Running them here
// is the point: surfaceStatusAvgLatencySql and dailyLatencyColumns interpolate
// SQL fragments, and a fragment that no longer parses only fails at execution.

function seedStatus(over: Record<string, unknown> = {}) {
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
  db.prepare(
    `INSERT INTO surface_status
     (surface_id, surface_key, netuid, kind, url, provider, status, classification,
      latency_ms, status_code, last_checked, last_ok, consecutive_failures, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
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
    ] as never[]),
  );
}

test("loadLeaderboardD1Rows executes all four reads against a real database", async () => {
  seedStatus({ surface_id: "a", netuid: 3, status: "ok", latency_ms: 40 });
  seedStatus({ surface_id: "b", netuid: 3, status: "failed", latency_ms: 900 });
  seedStatus({
    surface_id: "c",
    netuid: 3,
    kind: "subtensor-rpc",
    status: "ok",
    latency_ms: 25,
  });
  // TODAY, not the pinned default. loadLeaderboardD1Rows reads growth with
  // `WHERE snapshot_date >= sevenDaysAgo`, computed from the real clock — so a
  // fixed date only satisfies it until it ages past seven days. The default
  // "2026-08-01" was already 6 days old when #9689 found this: the
  // growthSamples assertion below had one day left before it started failing
  // every run, for a reason nothing in the diff would have explained.
  seedSnapshot({
    netuid: 3,
    completeness_score: 50,
    snapshot_date: new Date().toISOString().slice(0, 10),
  });
  seedUptimeDay({ surface_id: "u1", netuid: 3, samples: 10, ok_count: 9 });

  const out = await loadLeaderboardD1Rows(readDb());

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

test("loadLeaderboardD1Rows returns empty sets without a binding", async () => {
  const out = await loadLeaderboardD1Rows(null);
  assert.deepEqual(out.healthRows, []);
  assert.deepEqual(out.rpcRows, []);
  assert.deepEqual(out.growthSamples, []);
  assert.deepEqual(out.reliabilityRows, []);
});

test("loadRegistryLeaderboards ranks the healthiest board from D1", async () => {
  seedStatus({ surface_id: "a", netuid: 3, status: "ok" });
  seedStatus({ surface_id: "b", netuid: 7, status: "failed" });
  const data = (await loadRegistryLeaderboards({
    board: "healthiest",
    db: readDbD1Shaped(),
  })) as { boards: Record<string, Array<Record<string, unknown>>> };
  assert.deepEqual(
    data.boards.healthiest.map((entry) => entry.netuid),
    [3, 7],
  );
});

test("loadCompareSubnets filters surface_status in memory, binding no parameters", async () => {
  seedStatus({ surface_id: "a", netuid: 3, status: "ok" });
  seedStatus({ surface_id: "b", netuid: 7, status: "ok" });
  seedStatus({ surface_id: "c", netuid: 9, status: "ok" });
  const bound: unknown[][] = [];
  const spy: ObservationsReadDb = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          bound.push(values);
          return { all: async () => db.prepare(sql).all() as unknown };
        },
      };
    },
  };
  const data = (await loadCompareSubnets({
    netuids: [3, 9],
    dimensions: ["health"],
    db: spy,
  })) as { subnets?: Array<Record<string, unknown>> };

  // No bound parameters at all: /api/v1/compare accepts up to 128 netuids and
  // D1's Workers binding caps a statement at 100, so the netuid list must
  // never become `IN (?, ?, ...)`.
  assert.deepEqual(bound, [[]]);
  const netuids = (data.subnets ?? [])
    .map((s) => Number(s.netuid))
    .filter((n) => Number.isFinite(n));
  assert.deepEqual(netuids.sort(), [3, 9]);
});

test("loadCompareSubnets skips the D1 read when health is not requested", async () => {
  let prepared = 0;
  const spy: ObservationsReadDb = {
    prepare(sql: string) {
      prepared += 1;
      return {
        bind() {
          return { all: async () => db.prepare(sql).all() as unknown };
        },
      };
    },
  };
  await loadCompareSubnets({
    netuids: [3],
    dimensions: ["economics"],
    db: spy,
  });
  assert.equal(prepared, 0);
});
