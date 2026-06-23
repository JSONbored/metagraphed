import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatPercentiles,
  formatIncidents,
  formatLeaderboards,
  formatTrajectory,
  LEADERBOARD_BOARDS,
} from "../src/health-serving.mjs";
import { writeSubnetSnapshot } from "../src/health-prober.mjs";
import { handleRequest, handleScheduled } from "../workers/api.mjs";
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// --- Pure format helpers ----------------------------------------------------

describe("formatPercentiles", () => {
  test("maps surface rows to rounded latency percentiles, sorted", () => {
    const out = formatPercentiles({
      netuid: 7,
      window: "7d",
      observedAt: "2026-06-10T00:00:00Z",
      rows: [
        {
          surface_id: "b",
          samples: 100,
          p50: 120.4,
          p95: 410.9,
          p99: 800,
          avg_latency_ms: 150.6,
          min_latency_ms: 40,
          max_latency_ms: 900,
        },
        {
          surface_id: "a",
          samples: 50,
          p50: 90,
          p95: 200,
          p99: null,
          avg_latency_ms: 110,
          min_latency_ms: 30,
          max_latency_ms: 500,
        },
      ],
    });
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, 7);
    assert.equal(out.surfaces[0].surface_id, "a");
    assert.equal(out.surfaces[1].latency_ms.p50, 120);
    assert.equal(out.surfaces[1].latency_ms.avg, 151);
    assert.equal(out.surfaces[0].latency_ms.p99, null);
  });
  test("handles empty rows (cold D1)", () => {
    const out = formatPercentiles({
      netuid: 1,
      window: "7d",
      observedAt: null,
      rows: [],
    });
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.observed_at, null);
  });
});

describe("formatIncidents", () => {
  test("maps SQL-grouped incident rows and computes SLA + downtime", () => {
    const t = 1_000_000_000_000;
    const out = formatIncidents({
      netuid: 7,
      window: "7d",
      observedAt: null,
      slaRows: [{ surface_id: "x", total: 100, ok_count: 96 }],
      // One row per incident (gap-island grouped in SQL).
      incidentRows: [
        {
          surface_id: "x",
          started_at: t,
          ended_at: t + 240000,
          failed_samples: 3,
        },
        {
          surface_id: "x",
          started_at: t + 12 * 60000,
          ended_at: t + 14 * 60000,
          failed_samples: 2,
        },
      ],
    });
    const surface = out.surfaces[0];
    assert.equal(surface.uptime_ratio, 0.96);
    assert.equal(surface.incident_count, 2);
    assert.equal(surface.incidents[0].failed_samples, 3);
    assert.equal(surface.incidents[0].duration_ms, 240000);
    assert.equal(surface.downtime_ms, 240000 + 120000);
  });
  test("surface with no incidents has zero incidents", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "y", total: 10, ok_count: 10 }],
      incidentRows: [],
    });
    assert.equal(out.surfaces[0].incident_count, 0);
    assert.equal(out.surfaces[0].uptime_ratio, 1);
  });
  test("zero-sample surface yields null uptime", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "z", total: 0, ok_count: 0 }],
      incidentRows: [],
    });
    assert.equal(out.surfaces[0].uptime_ratio, null);
  });
  test("caps materialized incidents when requested by the API", () => {
    const t = 1_000_000_000_000;
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "x", total: 10, ok_count: 5 }],
      incidentRows: Array.from({ length: 3 }, (_, i) => ({
        surface_id: "x",
        started_at: t + i * 60000,
        ended_at: t + i * 60000,
        failed_samples: 1,
      })),
      maxIncidents: 2,
    });
    assert.equal(out.surfaces[0].incident_count, 2);
    assert.equal(out.surfaces[0].incidents.length, 2);
  });
});

describe("formatLeaderboards", () => {
  const meta = new Map([
    [1, { slug: "one", name: "One" }],
    [2, { slug: "two", name: "Two" }],
  ]);
  const inputs = {
    observedAt: "2026-06-10T00:00:00Z",
    subnetMeta: meta,
    healthRows: [
      { netuid: 1, total: 4, ok_count: 4, avg_latency_ms: 100 },
      { netuid: 2, total: 4, ok_count: 2, avg_latency_ms: 50 },
      { netuid: 3, total: 0, ok_count: 0, avg_latency_ms: null },
    ],
    rpcRows: [
      { netuid: 1, min_latency_ms: 300 },
      { netuid: 2, min_latency_ms: 120 },
    ],
    mostComplete: [
      {
        netuid: 1,
        slug: "one",
        name: "One",
        completeness_score: 80,
        surface_count: 12,
        operational_interface_count: 4,
      },
      {
        netuid: 2,
        slug: "two",
        name: "Two",
        completeness_score: 95,
        surface_count: 6,
        operational_interface_count: 1,
      },
    ],
    growthRows: [
      { netuid: 1, delta: 5 },
      { netuid: 2, delta: -2 },
      { netuid: 3, delta: 0 },
    ],
  };

  test("assembles all boards when no board filter", () => {
    const out = formatLeaderboards({ ...inputs, board: null, limit: 10 });
    assert.deepEqual(
      Object.keys(out.boards).sort(),
      [...LEADERBOARD_BOARDS].sort(),
    );
    assert.equal(out.boards.healthiest[0].netuid, 1); // 100% uptime
    assert.equal(out.boards.healthiest[0].name, "One");
    assert.equal(out.boards["fastest-rpc"][0].netuid, 2); // lowest latency
    assert.equal(out.boards["most-complete"][0].netuid, 2); // 95
    assert.equal(out.boards["most-enriched"][0].netuid, 1); // 12 surfaces > 6
    assert.equal(out.boards["most-enriched"][0].surface_count, 12);
    assert.equal(out.boards["fastest-growing"][0].netuid, 1); // +5 only positive
    assert.equal(out.boards["fastest-growing"].length, 1);
  });
  test("most-enriched excludes zero-surface subnets", () => {
    const out = formatLeaderboards({
      ...inputs,
      mostComplete: [
        { netuid: 1, slug: "one", name: "One", surface_count: 3 },
        { netuid: 9, slug: "nine", name: "Nine", surface_count: 0 },
      ],
      board: "most-enriched",
    });
    assert.equal(out.boards["most-enriched"].length, 1);
    assert.equal(out.boards["most-enriched"][0].netuid, 1);
  });
  test("filters to a single board and respects limit cap", () => {
    const out = formatLeaderboards({
      ...inputs,
      board: "healthiest",
      limit: 1,
    });
    assert.deepEqual(Object.keys(out.boards), ["healthiest"]);
    assert.equal(out.boards.healthiest.length, 1);
    assert.equal(out.board, "healthiest");
  });
  test("excludes zero-surface subnets from healthiest", () => {
    const out = formatLeaderboards({ ...inputs, board: "healthiest" });
    assert.equal(
      out.boards.healthiest.some((e) => e.netuid === 3),
      false,
    );
  });

  // Economic opportunity boards. Rows mirror the live economics tier.
  const economicsRows = [
    {
      netuid: 10,
      slug: "ten",
      name: "Ten",
      open_slots: 200,
      max_uids: 256,
      registration_cost_tao: 1,
      registration_allowed: true,
      emission_share: 0.1,
      total_stake_tao: 5000,
      validator_count: 10,
      miner_count: 46,
      max_validators: 64,
    },
    {
      netuid: 11,
      slug: "eleven",
      name: "Eleven",
      open_slots: 50,
      max_uids: 128,
      registration_cost_tao: 0.5,
      registration_allowed: true,
      emission_share: 0.3,
      total_stake_tao: 9000,
      validator_count: 60,
      miner_count: 18,
      max_validators: 64,
    },
    {
      // Full + registration closed + zero validator headroom → excluded from
      // open-slots, cheapest-registration, and validator-headroom (but still has
      // emission, so it shows on highest-emission).
      netuid: 12,
      slug: "twelve",
      name: "Twelve",
      open_slots: 0,
      max_uids: 64,
      registration_cost_tao: 100,
      registration_allowed: false,
      emission_share: 0.05,
      total_stake_tao: 1000,
      validator_count: 64,
      miner_count: 0,
      max_validators: 64,
    },
    {
      // No economics: every metric is null/missing → excluded from all boards.
      netuid: 13,
      slug: "thirteen",
      name: "Thirteen",
      open_slots: null,
      registration_cost_tao: null,
      registration_allowed: true,
      emission_share: null,
      total_stake_tao: null,
      validator_count: null,
      miner_count: null,
      max_validators: null,
    },
  ];

  test("ranks the four economic boards from the economics tier", () => {
    const out = formatLeaderboards({
      ...inputs,
      economicsRows,
      board: null,
      limit: 10,
    });
    // open-slots: most room first; full + unknown excluded.
    assert.deepEqual(
      out.boards["open-slots"].map((e) => e.netuid),
      [10, 11],
    );
    assert.equal(out.boards["open-slots"][0].open_slots, 200);
    assert.equal(out.boards["open-slots"][0].name, "Ten");
    // cheapest-registration: lowest cost first; closed + unknown-cost excluded.
    assert.deepEqual(
      out.boards["cheapest-registration"].map((e) => e.netuid),
      [11, 10],
    );
    assert.equal(
      out.boards["cheapest-registration"][0].registration_cost_tao,
      0.5,
    );
    // highest-emission: largest share first; only null-emission excluded.
    assert.deepEqual(
      out.boards["highest-emission"].map((e) => e.netuid),
      [11, 10, 12],
    );
    // validator-headroom: max_validators - validator_count, desc; zero excluded.
    assert.deepEqual(
      out.boards["validator-headroom"].map((e) => e.netuid),
      [10, 11],
    );
    assert.equal(out.boards["validator-headroom"][0].validator_headroom, 54);
  });

  test("economic boards are null-safe when the economics tier is cold", () => {
    const out = formatLeaderboards({ ...inputs, board: null, limit: 10 });
    for (const key of [
      "open-slots",
      "cheapest-registration",
      "highest-emission",
      "validator-headroom",
    ]) {
      assert.deepEqual(out.boards[key], [], `${key} must be empty, not absent`);
    }
    // The operational boards are unaffected by the absent economics tier.
    assert.ok(out.boards.healthiest.length > 0);
  });

  test("a single economic board honours the limit cap", () => {
    const out = formatLeaderboards({
      ...inputs,
      economicsRows,
      board: "highest-emission",
      limit: 1,
    });
    assert.deepEqual(Object.keys(out.boards), ["highest-emission"]);
    assert.equal(out.boards["highest-emission"].length, 1);
    assert.equal(out.boards["highest-emission"][0].netuid, 11);
  });

  test("economic boards break metric ties by tiebreak then netuid, nulls last", () => {
    const ranked = (board, rows) =>
      formatLeaderboards({
        ...inputs,
        board,
        limit: 10,
        economicsRows: rows,
      }).boards[board].map((entry) => entry.netuid);

    // open-slots all tie at 100: cheaper cost first, equal cost breaks on netuid,
    // unknown cost (Infinity) ranks last. netuid 2 is in subnetMeta, so its
    // identity resolves from the map rather than the row.
    const openSlots = formatLeaderboards({
      ...inputs,
      board: "open-slots",
      limit: 10,
      economicsRows: [
        {
          netuid: 30,
          open_slots: 100,
          registration_cost_tao: 5,
          registration_allowed: true,
        },
        {
          netuid: 2,
          open_slots: 100,
          registration_cost_tao: 5,
          registration_allowed: true,
        },
        {
          netuid: 31,
          open_slots: 100,
          registration_cost_tao: null,
          registration_allowed: true,
        },
        {
          netuid: 32,
          open_slots: 100,
          registration_cost_tao: 1,
          registration_allowed: true,
        },
      ],
    }).boards["open-slots"];
    assert.deepEqual(
      openSlots.map((e) => e.netuid),
      [32, 2, 30, 31],
    );
    assert.equal(openSlots.find((e) => e.netuid === 2).name, "Two");

    // cheapest-registration tie at cost 2: more open slots first, unknown last.
    assert.deepEqual(
      ranked("cheapest-registration", [
        {
          netuid: 30,
          registration_cost_tao: 2,
          registration_allowed: true,
          open_slots: 10,
        },
        {
          netuid: 31,
          registration_cost_tao: 2,
          registration_allowed: true,
          open_slots: null,
        },
        {
          netuid: 32,
          registration_cost_tao: 2,
          registration_allowed: true,
          open_slots: 99,
        },
      ]),
      [32, 30, 31],
    );

    // highest-emission tie at 0.2: higher stake first, unknown last.
    assert.deepEqual(
      ranked("highest-emission", [
        { netuid: 30, emission_share: 0.2, total_stake_tao: 100 },
        { netuid: 31, emission_share: 0.2, total_stake_tao: null },
        { netuid: 32, emission_share: 0.2, total_stake_tao: 999 },
      ]),
      [32, 30, 31],
    );

    // validator-headroom tie at 10: higher emission first, unknown last.
    assert.deepEqual(
      ranked("validator-headroom", [
        {
          netuid: 30,
          max_validators: 20,
          validator_count: 10,
          emission_share: 0.1,
        },
        {
          netuid: 31,
          max_validators: 30,
          validator_count: 20,
          emission_share: null,
        },
        {
          netuid: 32,
          max_validators: 15,
          validator_count: 5,
          emission_share: 0.5,
        },
      ]),
      [32, 30, 31],
    );
  });
});

describe("formatTrajectory", () => {
  test("computes week-over-week deltas from daily snapshots", () => {
    const rows = [];
    for (let d = 1; d <= 14; d += 1) {
      rows.push({
        snapshot_date: `2026-06-${String(d).padStart(2, "0")}`,
        completeness_score: 50 + d,
        surface_count: 10 + d,
        endpoint_count: 20 + d,
      });
    }
    const out = formatTrajectory({ netuid: 7, rows });
    assert.equal(out.point_count, 14);
    assert.equal(out.deltas["7d"].completeness_score, 7);
    assert.equal(out.deltas["7d"].from_date, "2026-06-07");
    assert.equal(out.deltas["7d"].to_date, "2026-06-14");
    assert.equal(out.deltas["30d"], null); // not enough history
  });
  test("empty rows yield a cold-but-valid shape", () => {
    const out = formatTrajectory({ netuid: 1, rows: [] });
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
    assert.equal(out.deltas["7d"], null);
  });
});

// --- writeSubnetSnapshot ----------------------------------------------------

function fakeBatchDb() {
  const calls = { batched: [] };
  const stmt = {
    bind: (...params) => ({ __params: params }),
  };
  return {
    calls,
    prepare: () => stmt,
    batch: (statements) => {
      calls.batched.push(statements);
      return Promise.resolve(statements.map(() => ({})));
    },
  };
}

describe("writeSubnetSnapshot", () => {
  const profiles = {
    ok: true,
    data: {
      profiles: [
        {
          netuid: 0,
          completeness_score: 100,
          surface_count: 17,
          endpoint_count: 17,
          monitored_endpoint_count: 17,
          candidate_count: 5,
        },
        {
          netuid: 7,
          completeness_score: 97,
          surface_count: 13,
          endpoint_count: 20,
        },
        { netuid: null, completeness_score: 1 }, // skipped (no integer netuid)
      ],
    },
  };
  const reader = (data) => () => Promise.resolve(data);

  test("returns unavailable without a db or reader", async () => {
    assert.equal((await writeSubnetSnapshot({}, {})).reason, "unavailable");
    assert.equal(
      (await writeSubnetSnapshot({}, { db: fakeBatchDb() })).reason,
      "unavailable",
    );
  });
  test("reports when profiles are unavailable", async () => {
    const r = await writeSubnetSnapshot(
      {},
      { db: fakeBatchDb(), readArtifact: reader({ ok: false }) },
    );
    assert.equal(r.reason, "profiles_unavailable");
  });
  test("reports when there are no profiles", async () => {
    const r = await writeSubnetSnapshot(
      {},
      {
        db: fakeBatchDb(),
        readArtifact: reader({ ok: true, data: { profiles: [] } }),
      },
    );
    assert.equal(r.reason, "no_profiles");
  });
  test("batches one row per integer-netuid profile", async () => {
    const db = fakeBatchDb();
    const r = await writeSubnetSnapshot(
      {},
      { db, readArtifact: reader(profiles), now: () => Date.UTC(2026, 5, 10) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.rows, 2); // null-netuid profile skipped
    assert.equal(r.date, "2026-06-10");
    assert.equal(db.calls.batched[0].length, 2);
  });
  test("chunks large subnet snapshot writes into bounded D1 batches", async () => {
    const db = fakeBatchDb();
    const manyProfiles = {
      ok: true,
      data: {
        profiles: Array.from({ length: 55 }, (_, netuid) => ({
          netuid,
          completeness_score: 90,
          surface_count: 1,
          endpoint_count: 1,
          monitored_endpoint_count: 1,
          candidate_count: 0,
        })),
      },
    };
    const r = await writeSubnetSnapshot(
      {},
      {
        db,
        readArtifact: reader(manyProfiles),
        now: () => Date.UTC(2026, 5, 10),
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.rows, 55);
    assert.equal(db.calls.batched.length, 2);
    assert.equal(db.calls.batched[0].length, 50);
    assert.equal(db.calls.batched[1].length, 5);
  });
  test("still writes structural rows when optional economics read throws", async () => {
    const db = fakeBatchDb();
    const r = await writeSubnetSnapshot(
      {},
      {
        db,
        readArtifact: (_env, path) => {
          if (path === "/metagraph/economics.json") {
            throw new Error("malformed economics artifact");
          }
          return Promise.resolve(profiles);
        },
        now: () => Date.UTC(2026, 5, 10),
      },
    );

    assert.equal(r.ok, true);
    assert.equal(r.rows, 2);
    assert.equal(db.calls.batched[0].length, 2);
    assert.equal(db.calls.batched[0][0].__params[7], null);
    assert.equal(db.calls.batched[0][0].__params[11], null);
  });
  test("returns write_failed when the batch throws", async () => {
    const db = {
      prepare: () => ({ bind: () => ({}) }),
      batch: () => Promise.reject(new Error("boom")),
    };
    const r = await writeSubnetSnapshot(
      {},
      { db, readArtifact: reader(profiles) },
    );
    assert.equal(r.reason, "write_failed");
  });
  test("backfills NULL economics via COALESCE DO UPDATE, not DO NOTHING", async () => {
    let captured = "";
    const db = {
      prepare(sql) {
        captured = sql;
        return { bind: () => ({}) };
      },
      batch: (s) => Promise.resolve(s.map(() => ({}))),
    };
    await writeSubnetSnapshot(
      {},
      { db, readArtifact: reader(profiles), now: () => Date.UTC(2026, 5, 10) },
    );
    // A later same-day fire backfills economics rather than freezing the row.
    assert.match(
      captured,
      /ON CONFLICT \(netuid, snapshot_date\) DO UPDATE SET/,
    );
    assert.doesNotMatch(captured, /DO NOTHING/);
    // Each economics column is COALESCE(existing, excluded): fills a NULL, but a
    // later NULL can never wipe an earlier fire's good value.
    for (const col of [
      "validator_count",
      "miner_count",
      "total_stake_tao",
      "alpha_price_tao",
      "emission_share",
    ]) {
      assert.match(
        captured,
        new RegExp(
          `${col} = COALESCE\\(subnet_snapshots\\.${col}, excluded\\.${col}\\)`,
        ),
      );
    }
    // Structural columns + captured_at stay owned by the first fire (not in SET).
    for (const col of ["completeness_score", "surface_count", "captured_at"]) {
      assert.doesNotMatch(captured, new RegExp(`${col}\\s*=`));
    }
  });
});

// --- Worker dispatch (cold D1 -> empty-valid; fake D1 -> with data) ----------

function analyticsD1() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            all: () => Promise.resolve({ results: rowsForSql(sql) }),
            run: () => Promise.resolve({ meta: {} }),
          };
        },
      };
    },
  };
}
function captureD1Env(queries) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            queries.push({ sql, params });
            return {
              all: () => Promise.resolve({ results: rowsForSql(sql) }),
            };
          },
        };
      },
    },
  };
}
function rowsForSql(sql) {
  if (sql.includes("WITH ranked")) {
    // Shared ok-latency CTE backs BOTH the percentiles and the trends routes, so
    // the fixture row carries uptime (total/ok_count) AND the latency stats.
    return [
      {
        surface_id: "s1",
        total: 100,
        ok_count: 98,
        latency_samples: 96,
        samples: 100,
        p50: 120,
        p95: 400,
        p99: 800,
        avg_latency_ms: 150,
        min_latency_ms: 40,
        max_latency_ms: 900,
      },
    ];
  }
  if (sql.includes("SUM(ok) AS ok_count")) {
    return [{ surface_id: "s1", total: 100, ok_count: 98 }];
  }
  if (sql.includes("WITH checks") || sql.includes("checks AS")) {
    return [
      {
        netuid: 7,
        surface_id: "s1",
        started_at: 1_000_000_000_000,
        ended_at: 1_000_000_120_000,
        failed_samples: 2,
      },
    ];
  }
  if (sql.includes("ORDER BY snapshot_date DESC")) {
    return [
      {
        snapshot_date: "2026-06-01",
        completeness_score: 90,
        surface_count: 10,
        endpoint_count: 12,
      },
      {
        snapshot_date: "2026-06-10",
        completeness_score: 97,
        surface_count: 13,
        endpoint_count: 15,
      },
    ];
  }
  if (sql.includes("FROM surface_status\n       GROUP BY netuid")) {
    return [{ netuid: 7, total: 4, ok_count: 4, avg_latency_ms: 100 }];
  }
  if (sql.includes("kind IN ('subtensor-rpc'")) {
    return [{ netuid: 0, min_latency_ms: 150 }];
  }
  if (sql.includes("FROM subnet_snapshots\n       WHERE snapshot_date")) {
    return [
      { netuid: 7, snapshot_date: "2026-06-03", completeness_score: 90 },
      { netuid: 7, snapshot_date: "2026-06-10", completeness_score: 97 },
    ];
  }
  return [];
}

async function getJson(url, env) {
  const res = await handleRequest(new Request(url), env, {});
  return { status: res.status, body: await res.json() };
}

describe("analytics routes (cold local D1)", () => {
  const env = createLocalArtifactEnv();
  test("percentiles returns an empty-but-valid envelope", async () => {
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.netuid, 7);
    assert.deepEqual(body.data.surfaces, []);
  });
  test("incidents returns empty-but-valid", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/incidents",
      env,
    );
    assert.deepEqual(body.data.surfaces, []);
  });
  test("D1 analytics routes reject non-canonical query strings before D1", async () => {
    const cases = [
      ["/api/v1/subnets/7/health/percentiles?window=bogus", "window"],
      ["/api/v1/subnets/7/health/incidents?window=7d&cacheBust=x", "cacheBust"],
      ["/api/v1/subnets/7/health/incidents?window=7d&window=7d", "window"],
      ["/api/v1/subnets/7/trajectory?x=random", "x"],
      ["/api/v1/subnets/7/health/trends?bogus=x", "bogus"],
      ["/api/v1/registry/leaderboards?limit=10&x=random", "x"],
      ["/api/v1/registry/leaderboards?limit=10&limit=10", "limit"],
    ];
    for (const [path, parameter] of cases) {
      const { status, body } = await getJson(
        `https://api.metagraph.sh${path}`,
        env,
      );
      assert.equal(status, 400, path);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, parameter);
    }
  });
  test("invalid window value names the bad value and valid options in the error", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=90d",
      env,
    );
    assert.ok(body.error.message.includes("90d"), body.error.message);
    assert.ok(body.error.message.includes("7d"), body.error.message);
    assert.ok(body.error.message.includes("30d"), body.error.message);
  });

  test("trajectory returns empty-but-valid", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/trajectory",
      env,
    );
    assert.equal(body.data.point_count, 0);
  });
  test("a hung D1 query times out and degrades to empty (never blocks the isolate)", async () => {
    // METAGRAPH_HEALTH_DB whose .all() never resolves + a 50ms D1 timeout: each
    // route must still return its normal cold/empty envelope. Without the
    // withTimeout wrap this test would hang until the test runner kills it.
    const hangingDb = {
      prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}) }) }),
    };
    const hungEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: hangingDb,
      METAGRAPH_D1_TIMEOUT_MS: "50",
    };
    // percentiles → d1All (shared helper); trends → handleHealthTrends (inline query)
    const pct = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles",
      hungEnv,
    );
    assert.equal(pct.status, 200);
    assert.deepEqual(pct.body.data.surfaces, []);
    const trends = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/trends",
      hungEnv,
    );
    assert.equal(trends.status, 200);
    const bulkTrends = await getJson(
      "https://api.metagraph.sh/api/v1/health/trends",
      hungEnv,
    );
    assert.equal(bulkTrends.status, 200);
    assert.deepEqual(bulkTrends.body.data.windows["7d"].subnets, []);
  });
  test("leaderboards returns most-complete from profiles even with cold D1", async () => {
    const profileEnv = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        get: async () => ({
          json: async () => ({
            profiles: [
              {
                netuid: 7,
                slug: "sn-7",
                name: "Subnet 7",
                completeness_score: 88,
              },
            ],
          }),
        }),
      },
    });
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards",
      profileEnv,
    );
    assert.equal(typeof body.data.boards, "object");
    assert.ok(body.data.boards["most-complete"].length > 0);
    assert.deepEqual(body.data.boards.healthiest, []);
  });
  test("leaderboards surfaces economic boards from the committed economics tier", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards",
      env,
    );
    // open-slots / cheapest-registration / highest-emission / validator-headroom
    // project from the R2 economics.json fallback in this cold-D1 env.
    for (const key of [
      "open-slots",
      "cheapest-registration",
      "highest-emission",
      "validator-headroom",
    ]) {
      assert.ok(Array.isArray(body.data.boards[key]), key);
    }
    const openSlots = body.data.boards["open-slots"];
    assert.ok(
      openSlots.length > 0,
      "committed economics yields open-slot subnets",
    );
    // Descending by open_slots; each entry carries the miner decision fields.
    assert.ok(openSlots[0].open_slots >= (openSlots[1]?.open_slots ?? 0));
    assert.equal(typeof openSlots[0].netuid, "number");
    assert.ok("registration_cost_tao" in openSlots[0]);
  });
  test("leaderboards filters to a single economic board", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards?board=highest-emission&limit=5",
      env,
    );
    assert.deepEqual(Object.keys(body.data.boards), ["highest-emission"]);
    assert.ok(body.data.boards["highest-emission"].length <= 5);
  });
  test("leaderboards economic boards prefer the live economics KV blob", async () => {
    // A fresh, on-contract, integrity-valid blob makes resolveLiveEconomics win,
    // so the boards project from KV rather than the committed R2 economics.json.
    const liveEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key) {
          if (key !== "economics:current") return null;
          return {
            schema_version: 1,
            contract_version: CONTRACT_VERSION,
            captured_at: new Date(Date.now() - 60_000).toISOString(),
            summary: { with_economics_count: 1 },
            subnets: [
              {
                netuid: 777,
                slug: "live",
                name: "Live",
                open_slots: 5,
                registration_cost_tao: 1,
                registration_allowed: true,
                emission_share: 1,
              },
            ],
          };
        },
      },
    };
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards?board=open-slots",
      liveEnv,
    );
    assert.deepEqual(
      body.data.boards["open-slots"].map((e) => e.netuid),
      [777],
    );
  });
  test("leaderboards rejects an unknown board", async () => {
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards?board=bogus",
      env,
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_query");
  });
});

describe("analytics routes (fake D1 with data)", () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: analyticsD1(),
  };
  test("percentiles surfaces p95 from D1", async () => {
    const queries = [];
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles?window=30d",
      captureD1Env(queries),
    );
    assert.equal(body.data.surfaces[0].latency_ms.p95, 400);
    assert.match(
      queries[0].sql,
      /PARTITION BY COALESCE\(surface_key, surface_id\)/,
    );
    assert.match(queries[0].sql, /GROUP BY surface_key/);
    // Surfaces with no healthy-latency reading are excluded (no all-null rows).
    assert.match(queries[0].sql, /HAVING MAX\(lat_cnt\) > 0/);
  });
  test("incidents computes uptime + incidents from D1", async () => {
    const queries = [];
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/incidents",
      captureD1Env(queries),
    );
    assert.equal(body.data.surfaces[0].uptime_ratio, 0.98);
    assert.equal(body.data.surfaces[0].incident_count, 1);
    assert.match(
      queries[0].sql,
      /GROUP BY COALESCE\(surface_key, surface_id\)/,
    );
    assert.match(queries[1].sql, /PARTITION BY surface_key/);
    assert.doesNotMatch(
      queries[1].sql,
      /WHERE netuid = \? AND checked_at >= \? AND ok = 0/,
    );
    assert.match(
      queries[1].sql,
      /SUM\(CASE WHEN ok = 1 OR gap IS NULL OR gap > \?/,
    );
    assert.match(queries[1].sql, /FROM grouped\n {7}WHERE ok = 0/);
  });
  test("incidents SQL uses a hard incident row cap", async () => {
    const queries = [];
    const { status } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/incidents",
      captureD1Env(queries),
    );
    assert.equal(status, 200);
    const incidentQuery = queries.find((query) =>
      query.sql.includes("WITH checks"),
    );
    assert.ok(incidentQuery.sql.includes("LIMIT ?"));
    assert.equal(incidentQuery.params.at(-1), 1000);
    // Single-probe blips are excluded: an incident needs >= 2 consecutive fails.
    assert.ok(incidentQuery.sql.includes("HAVING COUNT(*) >= ?"));
    assert.equal(incidentQuery.params.at(-2), 2);
  });

  test("trends and uptime SQL group by stable surface key", async () => {
    const queries = [];
    const envWithCapture = captureD1Env(queries);
    await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/health/trends",
      envWithCapture,
    );
    await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/uptime",
      envWithCapture,
    );
    // Trends rolls raw checks through the shared ok-latency CTE, which coalesces
    // surface_key ?? surface_id once, then groups on that stable key.
    const trendsSql =
      queries.find((query) => query.sql.includes("FROM ranked"))?.sql || "";
    assert.match(
      trendsSql,
      /COALESCE\(surface_key, surface_id\) AS surface_key/,
    );
    assert.match(trendsSql, /GROUP BY surface_key/);
    assert.match(
      queries.find((query) => query.sql.includes("FROM surface_uptime_daily"))
        ?.sql || "",
      /GROUP BY COALESCE\(surface_key, surface_id\), day/,
    );
  });

  test("global incidents SQL bounds source rows before window grouping", async () => {
    const queries = [];
    const envWithCapture = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              queries.push({ sql, params });
              return {
                all: () => Promise.resolve({ results: rowsForSql(sql) }),
              };
            },
          };
        },
      },
    };
    const { status } = await getJson(
      "https://api.metagraph.sh/api/v1/incidents?window=30d",
      envWithCapture,
    );
    assert.equal(status, 200);
    const incidentQuery = queries.find((query) =>
      query.sql.includes("WITH recent_checks"),
    );
    assert.ok(incidentQuery.sql.includes("ORDER BY checked_at DESC"));
    assert.doesNotMatch(incidentQuery.sql, /WHERE checked_at >= \? AND ok = 0/);
    assert.match(
      incidentQuery.sql,
      /SUM\(CASE WHEN ok = 1 OR gap IS NULL OR gap > \?/,
    );
    assert.match(incidentQuery.sql, /FROM grouped\n {5}WHERE ok = 0/);
    assert.ok(incidentQuery.sql.includes("LIMIT ?"));
    assert.equal(incidentQuery.params[1], 5000);
    assert.equal(incidentQuery.params.at(-1), 1000);
    // Single-probe blips are excluded: an incident needs >= 2 consecutive fails.
    assert.ok(incidentQuery.sql.includes("HAVING COUNT(*) >= ?"));
    assert.equal(incidentQuery.params.at(-2), 2);
  });

  test("trajectory computes deltas from snapshots", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/trajectory",
      env,
    );
    assert.equal(body.data.point_count, 2);
    assert.equal(body.data.deltas["7d"].completeness_score, 7);
  });
  test("leaderboards combines D1 health with registry growth", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards?board=fastest-growing",
      env,
    );
    assert.equal(body.data.boards["fastest-growing"][0].netuid, 7);
    assert.equal(body.data.boards["fastest-growing"][0].completeness_delta, 7);
  });
});

describe("leaderboards growth baseline handles a null window-start score", () => {
  // A subnet whose earliest in-window snapshot is unscored (null) must NOT
  // produce a spurious positive delta from a forward-shifted baseline.
  function growthD1(growthRows) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              all: () =>
                Promise.resolve({
                  results: sql.includes("WHERE snapshot_date >= ?")
                    ? growthRows
                    : [],
                }),
            };
          },
        };
      },
    };
  }
  test("excludes a subnet that was unscored at the window start", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: growthD1([
        { netuid: 9, snapshot_date: "2026-06-03", completeness_score: null },
        { netuid: 9, snapshot_date: "2026-06-06", completeness_score: 80 },
        { netuid: 9, snapshot_date: "2026-06-10", completeness_score: 85 },
      ]),
    };
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/registry/leaderboards?board=fastest-growing",
      env,
    );
    assert.equal(
      body.data.boards["fastest-growing"].some((e) => e.netuid === 9),
      false,
      "unscored-at-start subnet must not appear with a spurious delta",
    );
  });
});

describe("analytics routes tolerate a failing D1", () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare() {
        throw new Error("d1 unavailable");
      },
    },
  };
  test("percentiles/incidents/trajectory/leaderboards degrade to empty, not 500", async () => {
    for (const path of [
      "/api/v1/subnets/7/health/percentiles",
      "/api/v1/subnets/7/health/incidents",
      "/api/v1/subnets/7/trajectory",
      "/api/v1/registry/leaderboards",
    ]) {
      const { status, body } = await getJson(
        `https://api.metagraph.sh${path}`,
        env,
      );
      assert.equal(status, 200, `${path} should degrade gracefully`);
      assert.equal(body.ok, true);
    }
  });
});

describe("writeSubnetSnapshot no integer netuids", () => {
  test("returns no_rows when no profile has an integer netuid", async () => {
    const db = fakeBatchDb();
    const r = await writeSubnetSnapshot(
      {},
      {
        db,
        readArtifact: () =>
          Promise.resolve({ ok: true, data: { profiles: [{ netuid: "x" }] } }),
      },
    );
    assert.equal(r.reason, "no_rows");
  });
});

describe("hourly cron writes a daily snapshot", () => {
  test("handleScheduled hourly runs prune + snapshot", async () => {
    const captured = [];
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({
          bind: () => ({
            run: () => Promise.resolve({ meta: { changes: 0 } }),
          }),
        }),
        batch: (stmts) => {
          captured.push(stmts.length);
          return Promise.resolve([]);
        },
      },
    };
    const result = await handleScheduled({ cron: "0 * * * *" }, env, {});
    assert.equal(result.pruned, true);
    assert.ok(captured[0] > 0, "snapshot batch should write rows");
  });
});
