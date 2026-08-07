import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatPercentiles,
  formatIncidents,
  formatLeaderboards,
  formatTrajectory,
  LEADERBOARD_BOARDS,
  PROBE_CADENCE_MS,
  MIN_INCIDENT_SAMPLES,
} from "../src/health-serving.ts";
import { loadSubnetTrajectory } from "../src/analytics-live.ts";
import {
  writeSubnetSnapshotRows,
  writeSubnetSnapshot,
} from "../src/health-prober.ts";
import { handleRequest, handleScheduled } from "../workers/api.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { mockEnv, type Row } from "./row-type.ts";

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
    }) as Row;
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
    }) as Row;
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
    }) as Row;
    const surface = out.surfaces[0];
    assert.equal(surface.uptime_ratio, 0.96);
    assert.equal(surface.incident_count, 2);
    assert.equal(surface.incidents[0].failed_samples, 3);
    // #8824: duration_ms = observed span + PROBE_CADENCE_MS (A1).
    assert.equal(surface.incidents[0].duration_ms, 240000 + PROBE_CADENCE_MS);
    assert.equal(surface.downtime_ms, 240000 + 120000 + 2 * PROBE_CADENCE_MS);
    assert.equal(out.min_incident_samples, MIN_INCIDENT_SAMPLES);
    assert.equal(surface.transient_failure_count, 0);
    assert.equal(surface.transient_failed_samples, 0);
  });
  test("surface with no incidents has zero incidents", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "y", total: 10, ok_count: 10 }],
      incidentRows: [],
    }) as Row;
    assert.equal(out.surfaces[0].incident_count, 0);
    assert.equal(out.surfaces[0].uptime_ratio, 1);
  });
  test("zero-sample surface yields null uptime", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "z", total: 0, ok_count: 0 }],
      incidentRows: [],
    }) as Row;
    assert.equal(out.surfaces[0].uptime_ratio, null);
  });
  // #8824 requirement A: a 15-min-cadence, 3-failed-probe outage (12:00 ok /
  // 12:15,12:30,12:45 fail / 13:00 ok) must report duration_ms strictly
  // greater than 30 minutes (the old formula reported exactly 30 min --
  // 12:45 - 12:15 -- systematically excluding both edge intervals). Fails
  // before this change (30 * 60_000 is not > 30 * 60_000), passes after.
  test("a 3-failed-probe outage at 15-min cadence reports duration_ms strictly > 30 minutes", () => {
    const t1215 = Date.parse("2026-07-01T12:15:00.000Z");
    const t1245 = Date.parse("2026-07-01T12:45:00.000Z");
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "flaky", total: 5, ok_count: 2 }],
      incidentRows: [
        {
          surface_id: "flaky",
          started_at: t1215,
          ended_at: t1245,
          failed_samples: 3,
        },
      ],
    }) as Row;
    const incident = out.surfaces[0].incidents[0];
    assert.ok(incident.duration_ms > 30 * 60_000);
    assert.ok(incident.duration_ms >= t1245 - t1215);
    assert.equal(incident.duration_ms, t1245 - t1215 + PROBE_CADENCE_MS);
  });
  // #8824 requirement B: sub-MIN_INCIDENT_SAMPLES flaps never surface as a
  // qualifying incident, but must be visible + countable so incident_count: 0
  // next to uptime_ratio < 1 is explained rather than reading as a
  // contradiction.
  test("a surface with only single-probe failures reports transient_failure_count, not a phantom incident", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "flappy", total: 100, ok_count: 98 }],
      incidentRows: [
        {
          surface_id: "flappy",
          row_kind: "transient",
          failed_samples: 2,
          transient_islands: 2,
        },
      ],
    }) as Row;
    const surface = out.surfaces[0];
    assert.equal(surface.incident_count, 0);
    assert.equal(surface.downtime_ms, 0);
    assert.ok(surface.uptime_ratio < 1);
    assert.equal(surface.transient_failure_count, 2);
    assert.equal(surface.transient_failed_samples, 2);
  });
  test("a transient row with a missing island/sample count defaults to 0, not NaN", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "y", total: 10, ok_count: 10 }],
      incidentRows: [{ surface_id: "y", row_kind: "transient" }],
    }) as Row;
    assert.equal(out.surfaces[0].transient_failure_count, 0);
    assert.equal(out.surfaces[0].transient_failed_samples, 0);
  });
  // #8824 requirement 5: samples - round(uptime_ratio * samples) must equal
  // sum(incidents[].failed_samples) + transient_failed_samples exactly, on a
  // fixture mixing one qualifying incident with two single-probe flaps.
  test("reconciles samples/uptime_ratio against incidents + transient flaps", () => {
    const t = 1_000_000_000_000;
    const out = formatIncidents({
      netuid: 1,
      // 100 samples, 95 ok -> 5 failed: 3 in the qualifying incident, 2 as
      // single-probe transient flaps.
      slaRows: [{ surface_id: "mixed", total: 100, ok_count: 95 }],
      incidentRows: [
        {
          surface_id: "mixed",
          started_at: t,
          ended_at: t + 30 * 60_000,
          failed_samples: 3,
        },
        {
          surface_id: "mixed",
          row_kind: "transient",
          failed_samples: 2,
          transient_islands: 2,
        },
      ],
    }) as Row;
    const surface = out.surfaces[0];
    const failedFromRatio =
      surface.samples - Math.round(surface.uptime_ratio * surface.samples);
    const accountedFor =
      surface.incidents.reduce(
        (sum: number, i: Row) => sum + (i.failed_samples as number),
        0,
      ) + surface.transient_failed_samples;
    assert.equal(failedFromRatio, accountedFor);
    assert.equal(failedFromRatio, 5);
  });
  // #8824 requirement 8: every new field is emitted (never omitted) on the
  // cold/empty path, matching formatBulkTrends/formatUptime's convention.
  test("cold path emits transient_failure_count/transient_failed_samples/min_incident_samples rather than omitting them", () => {
    const out = formatIncidents({
      netuid: 1,
      slaRows: [{ surface_id: "cold", total: 10, ok_count: 10 }],
      incidentRows: [],
    }) as Row;
    assert.equal(out.min_incident_samples, MIN_INCIDENT_SAMPLES);
    assert.equal(out.surfaces[0].transient_failure_count, 0);
    assert.equal(out.surfaces[0].transient_failed_samples, 0);
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
    }) as Row;
    assert.equal(out.surfaces[0].incident_count, 2);
    assert.equal(out.surfaces[0].incidents.length, 2);
  });
  test("caps incidents per surface independently (regression: global cap starvation)", () => {
    const t = 1_000_000_000_000;
    const out = formatIncidents({
      netuid: 1,
      slaRows: [
        { surface_id: "a", total: 10, ok_count: 5 },
        { surface_id: "z", total: 10, ok_count: 5 },
      ],
      incidentRows: [
        ...Array.from({ length: 3 }, (_, i) => ({
          surface_id: "a",
          started_at: t + i * 60_000,
          ended_at: t + i * 60_000 + 1_000,
          failed_samples: 1,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          surface_id: "z",
          started_at: t + 100_000 + i * 60_000,
          ended_at: t + 100_000 + i * 60_000 + 1_000,
          failed_samples: 1,
        })),
      ],
      maxIncidents: 2,
    }) as Row;
    const a = out.surfaces.find((surface: Row) => surface.surface_id === "a");
    const z = out.surfaces.find((surface: Row) => surface.surface_id === "z");
    assert.equal(a.incident_count, 2);
    assert.equal(z.incident_count, 2);
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
    reliabilityRows: [
      {
        netuid: 1,
        samples: 100,
        ok_count: 100,
        avg_latency_ms: 50,
        latency_samples: 100,
      },
      {
        netuid: 2,
        samples: 100,
        ok_count: 80,
        avg_latency_ms: 50,
        latency_samples: 100,
      },
      // Zero samples → scoreFromStats returns null → dropped from the board.
      {
        netuid: 3,
        samples: 0,
        ok_count: 0,
        avg_latency_ms: null,
        latency_samples: 0,
      },
    ],
  };

  test("assembles all boards when no board filter", () => {
    const out = formatLeaderboards({
      ...inputs,
      board: null,
      limit: 10,
    }) as Row;
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
    assert.equal(out.boards["most-reliable"][0].netuid, 1); // 100% uptime ranks first
  });
  test("most-reliable ranks by windowed score and drops zero-sample subnets", () => {
    const out = formatLeaderboards({
      ...inputs,
      board: "most-reliable",
    }) as Row;
    const board = out.boards["most-reliable"];
    // netuid 3 has no samples in the window → null score → excluded.
    assert.equal(board.length, 2);
    assert.equal(board[0].netuid, 1); // 100% uptime outranks 80%
    assert.equal(board[1].netuid, 2);
    assert.ok(board[0].score >= board[1].score);
    assert.equal(typeof board[0].grade, "string");
    assert.equal(board[0].name, "One"); // subnet meta merged in
  });
  test("most-reliable breaks score ties by latency then netuid", () => {
    const out = formatLeaderboards({
      ...inputs,
      // All 100% uptime with latency <= the no-penalty threshold → identical
      // score, so the tiebreakers decide: lower latency first, then lower netuid.
      reliabilityRows: [
        {
          netuid: 7,
          samples: 100,
          ok_count: 100,
          avg_latency_ms: 300,
          latency_samples: 100,
        },
        {
          netuid: 4,
          samples: 100,
          ok_count: 100,
          avg_latency_ms: 100,
          latency_samples: 100,
        },
        {
          netuid: 9,
          samples: 100,
          ok_count: 100,
          avg_latency_ms: 100,
          latency_samples: 100,
        },
      ],
      board: "most-reliable",
    }) as Row;
    // 4 and 9 (latency 100) outrank 7 (latency 300); 4 before 9 on netuid.
    assert.deepEqual(
      out.boards["most-reliable"].map((e: Row) => e.netuid),
      [4, 9, 7],
    );
  });
  // Every registry board must end with an ascending-netuid tiebreak so tied
  // rows order deterministically (and the limit cap selects a stable
  // membership) instead of inheriting the unordered GROUP BY / profiles-artifact
  // input order. Each test reverses the input to prove order-independence.
  test("healthiest breaks uptime/latency ties by netuid", () => {
    const tied = [
      { netuid: 5, total: 4, ok_count: 4, avg_latency_ms: 100 },
      { netuid: 2, total: 4, ok_count: 4, avg_latency_ms: 100 },
      { netuid: 9, total: 4, ok_count: 4, avg_latency_ms: 100 },
    ];
    const order = (healthRows: Row[]) =>
      (
        formatLeaderboards({
          ...inputs,
          healthRows,
          board: "healthiest",
        }) as Row
      ).boards.healthiest.map((e: Row) => e.netuid);
    assert.deepEqual(order(tied), [2, 5, 9]);
    assert.deepEqual(order([...tied].reverse()), [2, 5, 9]);
  });
  test("fastest-rpc breaks latency ties by netuid", () => {
    const tied = [
      { netuid: 5, min_latency_ms: 100 },
      { netuid: 2, min_latency_ms: 100 },
      { netuid: 9, min_latency_ms: 100 },
    ];
    const order = (rpcRows: Row[]) =>
      (
        formatLeaderboards({
          ...inputs,
          rpcRows,
          board: "fastest-rpc",
        }) as Row
      ).boards["fastest-rpc"].map((e: Row) => e.netuid);
    assert.deepEqual(order(tied), [2, 5, 9]);
    assert.deepEqual(order([...tied].reverse()), [2, 5, 9]);
  });
  test("most-complete breaks score ties by netuid", () => {
    const tied = [
      { netuid: 5, slug: "five", name: "Five", completeness_score: 90 },
      { netuid: 2, slug: "two", name: "Two", completeness_score: 90 },
      { netuid: 9, slug: "nine", name: "Nine", completeness_score: 90 },
    ];
    const order = (mostComplete: Row[]) =>
      (
        formatLeaderboards({
          ...inputs,
          mostComplete,
          board: "most-complete",
        }) as Row
      ).boards["most-complete"].map((e: Row) => e.netuid);
    assert.deepEqual(order(tied), [2, 5, 9]);
    assert.deepEqual(order([...tied].reverse()), [2, 5, 9]);
  });
  test("most-complete excludes subnets with no completeness score", () => {
    // completeness_score is nullable (a not-yet-profiled subnet is null); a
    // "most-complete" ranking must drop it, not emit it with a null score —
    // matching every sibling board's absent-metric filter.
    const out = formatLeaderboards({
      ...inputs,
      mostComplete: [
        { netuid: 1, slug: "one", name: "One", completeness_score: 70 },
        { netuid: 9, slug: "nine", name: "Nine", completeness_score: null },
      ],
      board: "most-complete",
    }) as Row;
    assert.equal(out.boards["most-complete"].length, 1);
    assert.equal(out.boards["most-complete"][0].netuid, 1);
  });
  test("most-enriched breaks surface-count ties by netuid", () => {
    const tied = [
      {
        netuid: 5,
        slug: "five",
        name: "Five",
        surface_count: 8,
        operational_interface_count: 2,
      },
      {
        netuid: 2,
        slug: "two",
        name: "Two",
        surface_count: 8,
        operational_interface_count: 2,
      },
      {
        netuid: 9,
        slug: "nine",
        name: "Nine",
        surface_count: 8,
        operational_interface_count: 2,
      },
    ];
    const order = (mostComplete: Row[]) =>
      (
        formatLeaderboards({
          ...inputs,
          mostComplete,
          board: "most-enriched",
        }) as Row
      ).boards["most-enriched"].map((e: Row) => e.netuid);
    assert.deepEqual(order(tied), [2, 5, 9]);
    assert.deepEqual(order([...tied].reverse()), [2, 5, 9]);
  });
  test("fastest-growing breaks delta ties by netuid", () => {
    const tied = [
      { netuid: 5, delta: 7 },
      { netuid: 2, delta: 7 },
      { netuid: 9, delta: 7 },
    ];
    const order = (growthRows: Row[]) =>
      (
        formatLeaderboards({
          ...inputs,
          growthRows,
          board: "fastest-growing",
        }) as Row
      ).boards["fastest-growing"].map((e: Row) => e.netuid);
    assert.deepEqual(order(tied), [2, 5, 9]);
    assert.deepEqual(order([...tied].reverse()), [2, 5, 9]);
  });
  test("most-enriched excludes zero-surface subnets", () => {
    const out = formatLeaderboards({
      ...inputs,
      mostComplete: [
        { netuid: 1, slug: "one", name: "One", surface_count: 3 },
        { netuid: 9, slug: "nine", name: "Nine", surface_count: 0 },
      ],
      board: "most-enriched",
    }) as Row;
    assert.equal(out.boards["most-enriched"].length, 1);
    assert.equal(out.boards["most-enriched"][0].netuid, 1);
  });
  test("filters to a single board and respects limit cap", () => {
    const out = formatLeaderboards({
      ...inputs,
      board: "healthiest",
      limit: 1,
    }) as Row;
    assert.deepEqual(Object.keys(out.boards), ["healthiest"]);
    assert.equal(out.boards.healthiest.length, 1);
    assert.equal(out.board, "healthiest");
  });
  test("excludes zero-surface subnets from healthiest", () => {
    const out = formatLeaderboards({ ...inputs, board: "healthiest" }) as Row;
    assert.equal(
      out.boards.healthiest.some((e: Row) => e.netuid === 3),
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
      tao_in_emission_tao: 10,
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
      tao_in_emission_tao: 30,
      total_stake_tao: 9000,
      validator_count: 60,
      miner_count: 18,
      max_validators: 64,
    },
    {
      // Full + registration closed + zero validator headroom → excluded from
      // open-slots, cheapest-registration, and validator-headroom.
      //
      // ALSO THE GATED CASE (#9706): a non-zero emission_share with zero TAO
      // actually flowing in. Measured on mainnet, 52 of 127 subnets look like
      // this, and five of them sat in the board's top 30 — a miner reading it
      // would pay registration for a subnet that pays nothing. It must NOT
      // appear on highest-emission.
      netuid: 12,
      slug: "twelve",
      name: "Twelve",
      open_slots: 0,
      max_uids: 64,
      registration_cost_tao: 100,
      registration_allowed: false,
      emission_share: 0.05,
      tao_in_emission_tao: 0,
      emission_enabled: false,
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
      tao_in_emission_tao: null,
      total_stake_tao: null,
      validator_count: null,
      miner_count: null,
      max_validators: null,
    },
  ];

  test("ranks the economic boards from the economics tier", () => {
    const out = formatLeaderboards({
      ...inputs,
      economicsRows,
      board: null,
      limit: 10,
    }) as Row;
    // open-slots: most room first; full + unknown excluded.
    assert.deepEqual(
      out.boards["open-slots"].map((e: Row) => e.netuid),
      [10, 11],
    );
    assert.equal(out.boards["open-slots"][0].open_slots, 200);
    assert.equal(out.boards["open-slots"][0].name, "Ten");
    // cheapest-registration: lowest cost first; closed + unknown-cost excluded.
    assert.deepEqual(
      out.boards["cheapest-registration"].map((e: Row) => e.netuid),
      [11, 10],
    );
    assert.equal(
      out.boards["cheapest-registration"][0].registration_cost_tao,
      0.5,
    );
    // highest-emission: ranked by TAO ACTUALLY RECEIVED (#9706). Netuid 12
    // carries emission_share 0.05 but tao_in_emission_tao 0 — gated to
    // nothing — so it must be absent, not merely last. Ranking by
    // emission_share is what put five zero-earning subnets in the live board's
    // top 30.
    assert.deepEqual(
      out.boards["highest-emission"].map((e: Row) => e.netuid),
      [11, 10],
    );
    assert.equal(out.boards["highest-emission"][0].tao_in_emission_tao, 30);
    // The misleading number is still published, beside the one that corrects it.
    assert.equal(out.boards["highest-emission"][0].emission_share, 0.3);
    // validator-headroom: max_validators - validator_count, desc; zero excluded.
    assert.deepEqual(
      out.boards["validator-headroom"].map((e: Row) => e.netuid),
      [10, 11],
    );
    assert.equal(out.boards["validator-headroom"][0].validator_headroom, 54);
    // #7227 gain boards: empty without alpha_price_change_* on the rows.
    assert.deepEqual(out.boards["biggest-alpha-gain-1d"], []);
    assert.deepEqual(out.boards["biggest-alpha-gain-7d"], []);
  });

  test("biggest-alpha-gain boards rank positive 1d/7d price changes", () => {
    const out = formatLeaderboards({
      ...inputs,
      board: null,
      limit: 10,
      economicsRows: [
        {
          netuid: 10,
          slug: "ten",
          name: "Ten",
          alpha_price_tao: 2,
          alpha_price_change_1d: 50,
          alpha_price_change_7d: 10,
          emission_share: 0.1,
        },
        {
          netuid: 11,
          slug: "eleven",
          name: "Eleven",
          alpha_price_tao: 3,
          alpha_price_change_1d: 80,
          alpha_price_change_7d: 5,
          emission_share: 0.2,
        },
        {
          netuid: 12,
          slug: "twelve",
          name: "Twelve",
          alpha_price_tao: 1,
          alpha_price_change_1d: -20,
          alpha_price_change_7d: 40,
          emission_share: 0.05,
        },
        {
          // Zero / null change → excluded by eligible.
          netuid: 13,
          slug: "thirteen",
          name: "Thirteen",
          alpha_price_tao: 4,
          alpha_price_change_1d: 0,
          alpha_price_change_7d: null,
          emission_share: null,
        },
      ],
    }) as Row;
    assert.deepEqual(
      out.boards["biggest-alpha-gain-1d"].map((e: Row) => e.netuid),
      [11, 10],
    );
    assert.equal(
      out.boards["biggest-alpha-gain-1d"][0].alpha_price_change_1d,
      80,
    );
    assert.deepEqual(
      out.boards["biggest-alpha-gain-7d"].map((e: Row) => e.netuid),
      [12, 10, 11],
    );
  });

  test("biggest-alpha-gain boards break ties on alpha_price_tao (null last)", () => {
    const ranked = (board: string) =>
      (
        formatLeaderboards({
          ...inputs,
          board,
          limit: 10,
          economicsRows: [
            {
              netuid: 20,
              slug: "a",
              name: "A",
              alpha_price_change_1d: 10,
              alpha_price_change_7d: 10,
              alpha_price_tao: null,
              emission_share: null,
            },
            {
              netuid: 21,
              slug: "b",
              name: "B",
              alpha_price_change_1d: 10,
              alpha_price_change_7d: 10,
              alpha_price_tao: 5,
              emission_share: 0.1,
            },
            {
              netuid: 22,
              slug: "c",
              name: "C",
              alpha_price_change_1d: 10,
              alpha_price_change_7d: 10,
              // missing alpha_price_tao → null via finiteOrNull
              emission_share: 0.2,
            },
          ],
        }) as Row
      ).boards[board];

    for (const board of ["biggest-alpha-gain-1d", "biggest-alpha-gain-7d"]) {
      const entries = ranked(board);
      assert.deepEqual(
        entries.map((e: Row) => e.netuid),
        [21, 20, 22],
        board,
      );
      assert.equal(entries[0].alpha_price_tao, 5, board);
      assert.equal(entries[1].alpha_price_tao, null, board);
      assert.equal(entries[2].alpha_price_tao, null, board);
    }
  });

  test("economic boards are null-safe when the economics tier is cold", () => {
    const out = formatLeaderboards({
      ...inputs,
      board: null,
      limit: 10,
    }) as Row;
    for (const key of [
      "open-slots",
      "cheapest-registration",
      "highest-emission",
      "validator-headroom",
      "biggest-alpha-gain-1d",
      "biggest-alpha-gain-7d",
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
    }) as Row;
    assert.deepEqual(Object.keys(out.boards), ["highest-emission"]);
    assert.equal(out.boards["highest-emission"].length, 1);
    assert.equal(out.boards["highest-emission"][0].netuid, 11);
  });

  test("economic boards break metric ties by tiebreak then netuid, nulls last", () => {
    const ranked = (board: string, rows: Row[]) =>
      (
        formatLeaderboards({
          ...inputs,
          board,
          limit: 10,
          economicsRows: rows,
        }) as Row
      ).boards[board].map((entry: Row) => entry.netuid);

    // open-slots all tie at 100: cheaper cost first, equal cost breaks on netuid,
    // unknown cost (Infinity) ranks last. netuid 2 is in subnetMeta, so its
    // identity resolves from the map rather than the row.
    const openSlots = (
      formatLeaderboards({
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
      }) as Row
    ).boards["open-slots"];
    assert.deepEqual(
      openSlots.map((e: Row) => e.netuid),
      [32, 2, 30, 31],
    );
    assert.equal(openSlots.find((e: Row) => e.netuid === 2).name, "Two");

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
        // Tied on the BOARD METRIC, which is tao_in_emission_tao since #9706 --
        // emission_share is carried alongside but no longer orders anything.
        {
          netuid: 30,
          emission_share: 0.2,
          tao_in_emission_tao: 20,
          total_stake_tao: 100,
        },
        {
          netuid: 31,
          emission_share: 0.2,
          tao_in_emission_tao: 20,
          total_stake_tao: null,
        },
        {
          netuid: 32,
          emission_share: 0.2,
          tao_in_emission_tao: 20,
          total_stake_tao: 999,
        },
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
    const out = formatTrajectory({ netuid: 7, rows }) as Row;
    assert.equal(out.point_count, 14);
    assert.equal(out.deltas["7d"].completeness_score, 7);
    assert.equal(out.deltas["7d"].from_date, "2026-06-07");
    assert.equal(out.deltas["7d"].to_date, "2026-06-14");
    assert.equal(out.deltas["30d"], null); // not enough history
  });
  test("empty rows yield a cold-but-valid shape", () => {
    const out = formatTrajectory({ netuid: 1, rows: [] }) as Row;
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
    assert.equal(out.deltas["7d"], null);
  });
  test("coerces D1 numeric-string snapshot cells to schema types", () => {
    const out = formatTrajectory({
      netuid: 3,
      rows: [
        {
          snapshot_date: "2026-06-01",
          completeness_score: "80",
          surface_count: "5",
          endpoint_count: "3",
          validator_count: "9",
          miner_count: "247",
          total_stake_tao: "2522266",
          alpha_price_tao: "0.04",
          emission_share: "0.01",
        },
      ],
    }) as Row;
    const point = out.points[0];
    assert.equal(typeof point.completeness_score, "number");
    assert.equal(typeof point.surface_count, "number");
    assert.equal(typeof point.endpoint_count, "number");
    assert.equal(typeof point.validator_count, "number");
    assert.equal(typeof point.miner_count, "number");
    assert.equal(typeof point.total_stake_alpha, "number");
    assert.equal(typeof point.alpha_price_tao, "number");
    assert.equal(typeof point.emission_share, "number");
    assert.equal(point.surface_count, 5);
    assert.equal(point.validator_count, 9);
    assert.equal(point.miner_count, 247);
    assert.equal(point.total_stake_alpha, 2522266);
    assert.equal(point.alpha_price_tao, 0.04);
    assert.equal(point.emission_share, 0.01);
  });
  test("nulls non-finite D1 economics strings instead of leaking NaN", () => {
    const out = formatTrajectory({
      netuid: 5,
      rows: [
        {
          snapshot_date: "2026-06-01",
          completeness_score: "70",
          surface_count: "2",
          endpoint_count: "1",
          total_stake_tao: "not-a-number",
          alpha_price_tao: "bad",
          emission_share: "Infinity",
        },
      ],
    }) as Row;
    const point = out.points[0];
    assert.equal(point.total_stake_alpha, null);
    assert.equal(point.alpha_price_tao, null);
    assert.equal(point.emission_share, null);
    assert.equal(point.completeness_score, 70);
  });
  test("loadSubnetTrajectory is schema-stable (D1 fully eliminated, 2026-07-17)", async () => {
    // loadSubnetTrajectory no longer takes a D1 runner -- subnet_snapshots is
    // Postgres-only now (the REST route tries the Postgres tier first), so
    // this loader is only reached on a tier miss and always returns an empty
    // trajectory. See tests/request-handlers-analytics-routes.test.ts for the
    // Postgres-tier-hit coverage of handleTrajectory itself.
    const out = (await loadSubnetTrajectory(11)) as Row;
    assert.equal(out.netuid, 11);
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });
  test("preserves sub-4dp emission_share when coercing D1 strings", () => {
    const out = formatTrajectory({
      netuid: 4,
      rows: [
        {
          snapshot_date: "2026-06-01",
          completeness_score: 80,
          surface_count: 5,
          endpoint_count: 3,
          emission_share: "0.000049",
        },
      ],
    }) as Row;
    assert.equal(out.points[0].emission_share, 0.000049);
  });
});

// --- writeSubnetSnapshot ----------------------------------------------------

// writeSubnetSnapshot's `subnet_snapshots` result comes from
// writeSubnetSnapshotRows, which writes ONE store: D1. The Postgres mirror it
// used to POST alongside was retired to its auth gate with the box (#9193),
// and until this file changed, its guaranteed 503 was what the lane's verdict
// was taken from -- so a healthy D1 write reported `stale` on every hourly
// tick. These tests now assert against the write that actually happens.
// The identity-history mirror (syncSubnetIdentityToPostgres, an unrelated
// table) stays independent/best-effort exactly as before.
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
  const reader = (data: unknown) => () => Promise.resolve(data as Row);

  /** The snapshot write's real sink (D1) plus the unrelated identity mirror
   * (DATA_API), captured separately so asserting on one never depends on the
   * other. `snapshotOk: false` makes the D1 batch throw, which is the only way
   * this write can now fail. */
  function snapshotEnv({ snapshotOk = true, identityOk = true } = {}) {
    const captured: Row = { snapshot: [] as Row[] };
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind: (...values: unknown[]) => ({ sql, values }),
          };
        },
        async batch(statements: { values: unknown[] }[]) {
          if (!snapshotOk) throw new Error("D1_ERROR: no such table");
          for (const statement of statements) {
            // Column order matches the INSERT in upsertSubnetSnapshotsToD1.
            const [netuid, snapshot_date, completeness_score] =
              statement.values;
            (captured.snapshot as Row[]).push({
              netuid,
              snapshot_date,
              completeness_score,
              total_stake_tao: statement.values[10],
              alpha_price_tao: statement.values[11],
              alpha_in_pool: statement.values[14],
            });
          }
          return statements.map(() => ({ success: true }));
        },
      },
      DATA_API: {
        fetch: async (request: Request) => {
          captured.identity = (await request.json()) as Row;
          return identityOk
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response("nope", { status: 502 });
        },
      },
      SUBNET_IDENTITY_SYNC_SECRET: "shh-identity",
    };
    return { env, captured };
  }

  test("returns unavailable without a reader", async () => {
    assert.equal(
      (await writeSubnetSnapshot(mockEnv(), {})).reason,
      "unavailable",
    );
    assert.equal(
      (await writeSubnetSnapshot(mockEnv(), { now: () => Date.now() })).reason,
      "unavailable",
    );
  });
  test("reports when profiles are unavailable", async () => {
    const r = await writeSubnetSnapshot(mockEnv(), {
      readArtifact: reader({ ok: false }),
    });
    assert.equal(r.reason, "profiles_unavailable");
  });
  test("reports when there are no profiles", async () => {
    const r = await writeSubnetSnapshot(mockEnv(), {
      readArtifact: reader({ ok: true, data: { profiles: [] } }),
    });
    assert.equal(r.reason, "no_profiles");
  });
  test("writes one row per integer-netuid profile to D1", async () => {
    const { env } = snapshotEnv();
    const r = await writeSubnetSnapshot(mockEnv(env), {
      readArtifact: reader(profiles),
      now: () => Date.UTC(2026, 5, 10),
    });
    assert.equal(r.ok, true);
    assert.equal(r.rows, 2); // null-netuid profile skipped
    assert.equal(r.date, "2026-06-10");
  });
  test("mirrors the same profiles into identity-sync, independent of the snapshot write", async () => {
    const { env, captured } = snapshotEnv();
    const r = await writeSubnetSnapshot(mockEnv(env), {
      readArtifact: reader(profiles),
      now: () => Date.UTC(2026, 5, 10),
    });
    assert.equal(r.ok, true);
    assert.equal(r.rows, 2);
    assert.deepEqual(captured.identity, profiles.data.profiles);
  });
  test("returns ok:false with the write's own reason when D1 fails", async () => {
    // The ONE way this can now fail. Before, it reported the Postgres POST's
    // status -- which after #9193 was always 503, regardless of the D1 write
    // sitting above it having succeeded.
    const { env } = snapshotEnv({ snapshotOk: false });
    const r = await writeSubnetSnapshot(mockEnv(env), {
      readArtifact: reader(profiles),
      now: () => Date.UTC(2026, 5, 10),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "write_failed");
  });
  test("returns unavailable without the D1 binding", async () => {
    // The guard used to read DATA_API and SUBNET_SNAPSHOT_SYNC_SECRET, neither
    // of which this write touches -- so a deployment with the database and no
    // sync secret declined with the write sitting right there.
    const r = await writeSubnetSnapshot(mockEnv(), {
      readArtifact: reader(profiles),
      now: () => Date.UTC(2026, 5, 10),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unavailable");
  });
  test("ships every integer-netuid profile in one write, no batching cap", async () => {
    const { env, captured } = snapshotEnv();
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
    const r = await writeSubnetSnapshot(mockEnv(env), {
      readArtifact: reader(manyProfiles),
      now: () => Date.UTC(2026, 5, 10),
    });
    assert.equal(r.ok, true);
    assert.equal(r.rows, 55);
    assert.equal((captured.snapshot as Row[]).length, 55);
  });
  test("still counts structural rows when optional economics read throws", async () => {
    const { env, captured } = snapshotEnv();
    const r = await writeSubnetSnapshot(mockEnv(env), {
      readArtifact: (_env, path) => {
        if (path === "/metagraph/economics.json") {
          throw new Error("malformed economics artifact");
        }
        return Promise.resolve(profiles);
      },
      now: () => Date.UTC(2026, 5, 10),
    });

    assert.equal(r.ok, true);
    assert.equal(r.rows, 2);
    assert.equal((captured.snapshot as Row[]).length, 2);
    assert.equal((captured.snapshot as Row[])[0].total_stake_tao, null);
    assert.equal((captured.snapshot as Row[])[0].alpha_in_pool, null);
  });
});

// The snapshot rows' one write boundary, now that the Postgres mirror is gone.
describe("writeSubnetSnapshotRows", () => {
  const profiles = [{ netuid: 8, completeness_score: 90 }];
  const economicsByNetuid = new Map([[8, { validator_count: 5 }]]);
  const opts = {
    profiles,
    economicsByNetuid,
    date: "2026-06-10",
    capturedAt: 1,
  };

  /** The INSERT's column order, so a bound statement can be read back as the
   * row it represents. Positional assertions would pass just as well against a
   * write that shifted two columns, which is the mistake worth catching. */
  const COLUMNS = [
    "netuid",
    "snapshot_date",
    "completeness_score",
    "surface_count",
    "endpoint_count",
    "monitored_count",
    "candidate_count",
    "captured_at",
    "validator_count",
    "miner_count",
    "total_stake_tao",
    "alpha_price_tao",
    "emission_share",
    "tao_in_pool_tao",
    "alpha_in_pool",
    "alpha_out_pool",
    "subnet_volume_tao",
    "tao_in_emission_tao",
    "excess_tao",
    "alpha_in_emission",
    "alpha_out_emission",
    "miner_burned_fraction",
    "emission_enabled",
    "subtoken_enabled",
    "first_emission_block",
    "pipeline_block",
    "pipeline_block_hash",
  ] as const;

  /** A D1 double that hands back each written row as a named object. */
  function d1Env({ ok = true }: { ok?: boolean } = {}) {
    const written: Row[] = [];
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return { bind: (...values: unknown[]) => ({ sql, values }) };
        },
        async batch(statements: { sql: string; values: unknown[] }[]) {
          if (!ok) throw new Error("D1_ERROR: no such table: subnet_snapshots");
          for (const statement of statements) {
            written.push(
              Object.fromEntries(
                COLUMNS.map((name, i) => [name, statement.values[i]]),
              ) as Row,
            );
          }
          return statements.map(() => ({ success: true }));
        },
      },
    };
    return { env, written };
  }

  test("returns unavailable when the D1 binding is missing", async () => {
    // The binding this needs is METAGRAPH_HEALTH_DB. It used to guard on
    // DATA_API and SUBNET_SNAPSHOT_SYNC_SECRET, which it no longer touches --
    // so a deployment holding the database and no sync secret would have
    // declined with the write sitting right there.
    const result = await writeSubnetSnapshotRows(
      mockEnv({
        DATA_API: { fetch: async () => new Response("{}", { status: 200 }) },
        SUBNET_SNAPSHOT_SYNC_SECRET: "shh",
      }),
      opts,
    );
    assert.deepEqual(result, { synced: false, reason: "unavailable" });
  });

  test("returns no_profiles for an empty or missing profiles array", async () => {
    const { env } = d1Env();
    assert.deepEqual(
      await writeSubnetSnapshotRows(mockEnv(env), { ...opts, profiles: [] }),
      { synced: false, reason: "no_profiles" },
    );
    assert.deepEqual(await writeSubnetSnapshotRows(mockEnv(env), {}), {
      synced: false,
      reason: "no_profiles",
    });
  });

  test("returns no_rows when every profile lacks an integer netuid", async () => {
    const { env } = d1Env();
    const result = await writeSubnetSnapshotRows(mockEnv(env), {
      ...opts,
      profiles: [{ netuid: null }],
    });
    assert.deepEqual(result, { synced: false, reason: "no_rows" });
  });

  test("writes one row per profile and reports synced:true", async () => {
    const { env, written } = d1Env();
    const result = await writeSubnetSnapshotRows(mockEnv(env), opts);
    assert.deepEqual(result, { synced: true, rows: 1 });
    assert.deepEqual(written, [
      {
        netuid: 8,
        snapshot_date: "2026-06-10",
        completeness_score: 90,
        surface_count: null,
        endpoint_count: null,
        monitored_count: null,
        candidate_count: null,
        captured_at: 1,
        validator_count: 5,
        miner_count: null,
        total_stake_tao: null,
        alpha_price_tao: null,
        emission_share: null,
        tao_in_pool_tao: null,
        alpha_in_pool: null,
        alpha_out_pool: null,
        subnet_volume_tao: null,
        tao_in_emission_tao: null,
        excess_tao: null,
        alpha_in_emission: null,
        alpha_out_emission: null,
        miner_burned_fraction: null,
        emission_enabled: null,
        subtoken_enabled: null,
        first_emission_block: null,
        pipeline_block: null,
        pipeline_block_hash: null,
      },
    ]);
  });

  // #8743: the v440 pipeline inputs ride the same row. Zero on both TAO
  // channels and false on the flag are REAL measurements for a disabled
  // subnet, and `|| null` would erase all three -- which is exactly the row
  // worth having. Booleans land as 0/1 against the schema's CHECKs.
  test("carries the v440 pipeline inputs through, zeros and falses included", async () => {
    const { env, written } = d1Env();
    const result = await writeSubnetSnapshotRows(mockEnv(env), {
      ...opts,
      economicsByNetuid: new Map([
        [
          8,
          {
            validator_count: 5,
            tao_in_emission_tao: 0,
            excess_tao: 0,
            alpha_in_emission: 0.150157337,
            alpha_out_emission: 1,
            miner_burned_fraction: 0,
            emission_enabled: false,
            subtoken_enabled: true,
            first_emission_block: 5228683,
          },
        ],
      ]),
    });
    assert.deepEqual(result, { synced: true, rows: 1 });
    assert.equal(written[0].tao_in_emission_tao, 0);
    assert.equal(written[0].excess_tao, 0);
    assert.equal(written[0].miner_burned_fraction, 0);
    assert.equal(written[0].emission_enabled, 0);
    assert.equal(written[0].subtoken_enabled, 1);
    assert.equal(written[0].first_emission_block, 5228683);
    assert.equal(written[0].alpha_in_emission, 0.150157337);
  });

  test("reports the write's own reason when D1 fails, and never throws", async () => {
    const { env } = d1Env({ ok: false });
    const result = await writeSubnetSnapshotRows(mockEnv(env), opts);
    assert.deepEqual(result, { synced: false, reason: "write_failed" });
  });

  test("defaults every optional field to null when absent, without an economics map", async () => {
    const { env, written } = d1Env();
    const result = await writeSubnetSnapshotRows(mockEnv(env), {
      profiles,
      date: "2026-06-10",
      capturedAt: 1,
    });
    assert.deepEqual(result, { synced: true, rows: 1 });
    assert.equal(written[0].validator_count, null);
    assert.equal(written[0].emission_share, null);
    assert.equal(written[0].pipeline_block, null);
  });
});

// --- Worker dispatch (cold D1 -> empty-valid; fake D1 -> with data) ----------

function captureD1Env(queries: Row[]) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
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
function rowsForSql(sql: string) {
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
        completeness_score: "90",
        surface_count: "10",
        endpoint_count: "12",
        validator_count: "8",
        miner_count: "200",
        total_stake_tao: "1500000",
        alpha_price_tao: "0.03",
        emission_share: "0.008",
        tao_in_pool_tao: "20000",
        alpha_in_pool: "2900000",
        alpha_out_pool: "2200000",
        subnet_volume_tao: "700000",
      },
      {
        snapshot_date: "2026-06-10",
        completeness_score: "97",
        surface_count: "13",
        endpoint_count: "15",
        validator_count: "9",
        miner_count: "205",
        total_stake_alpha: "1600000",
        alpha_price_tao: "0.035",
        emission_share: "0.009",
        tao_in_pool_tao: "26707.57",
        alpha_in_pool: "2956464.98",
        alpha_out_pool: "2257199.02",
        subnet_volume_tao: "798027.45",
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

async function getJson(url: string, env: Row) {
  const res = await handleRequest(new Request(url), env as unknown as Env, {});
  return { status: res.status, body: await res.json() };
}

describe("analytics routes (Postgres tier unconfigured -- D1 fully eliminated)", () => {
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
  test("analytics routes reject non-canonical query strings before the Postgres tier", async () => {
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
  test("a failing Postgres-tier DATA_API call degrades to empty (never a client-facing error), captured for real observability (metagraphed#8081 follow-up)", async () => {
    // D1 is fully eliminated (2026-07-17, reconfirmed live 2026-07-25 -- zero
    // D1 databases remain on the account) -- this used to mock a hanging D1
    // .all() call, but METAGRAPH_HEALTH_SOURCE was never set to "postgres" in
    // that version, so tryPostgresTier short-circuited on the tier-flag check
    // before ever touching the (fictional) D1 mock: the test was vacuous. The
    // real failure mode tryPostgresTier actually protects against today is a
    // rejected DATA_API fetch (workers/postgres-tier.ts) -- exercise that,
    // and confirm it now reaches PostHog's $exception capture too (added
    // alongside this fix), not just Wrangler's own log tail.
    const posted: Row[] = [];
    const failingEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_SOURCE: "postgres",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      DATA_API: {
        fetch: async () => {
          throw new Error("DATA_API unreachable");
        },
      },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const pct = await getJson(
        "https://api.metagraph.sh/api/v1/subnets/7/health/percentiles",
        failingEnv,
      );
      assert.equal(pct.status, 200);
      assert.deepEqual(pct.body.data.surfaces, []);
      const trends = await getJson(
        "https://api.metagraph.sh/api/v1/subnets/7/health/trends",
        failingEnv,
      );
      assert.equal(trends.status, 200);
      const bulkTrends = await getJson(
        "https://api.metagraph.sh/api/v1/health/trends",
        failingEnv,
      );
      assert.equal(bulkTrends.status, 200);
      assert.deepEqual(bulkTrends.body.data.windows["7d"].subnets, []);
    } finally {
      globalThis.fetch = original;
    }
    const exceptionPost = posted.find((p) => p.body.event === "$exception");
    assert.ok(
      exceptionPost,
      "a Postgres-tier DATA_API failure should reach PostHog as $exception",
    );
    assert.equal(
      exceptionPost.body.properties.route,
      "postgres-tier:METAGRAPH_HEALTH_SOURCE",
    );
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
      "biggest-alpha-gain-1d",
      "biggest-alpha-gain-7d",
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
        async get(key: string) {
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
      body.data.boards["open-slots"].map((e: Row) => e.netuid),
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

describe("analytics routes reject malformed params before any tier call", () => {
  // D1 fully eliminated (2026-07-17): percentiles/incidents/uptime/trends never
  // read D1 anymore (a Postgres-tier miss falls straight through to the
  // schema-stable empty payload), so the query-validation-before-any-read
  // contract is the only thing left to assert here.
  test("uptime rejects a malformed min_samples with a 400", async () => {
    const queries: Row[] = [];
    const envWithCapture = captureD1Env(queries);
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/subnets/7/uptime?min_samples=lots",
      envWithCapture,
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "min_samples");
    assert.equal(queries.length, 0, "malformed input must not reach D1");
  });
});

describe("analytics routes tolerate a failing Postgres tier (D1 fully eliminated)", () => {
  // Same vacuous-mock bug as the "hung D1 query" test above: METAGRAPH_HEALTH_DB
  // is never read by any live code (D1 is gone), and METAGRAPH_HEALTH_SOURCE was
  // never set to "postgres" here either, so tryPostgresTier short-circuited on
  // the tier-flag check before this mock could matter either way. leaderboards
  // doesn't go through tryPostgresTier at all (composeLeaderboardsData's boards
  // are unconditionally empty now, D1 fully eliminated) -- unaffected either way.
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_SOURCE: "postgres",
    DATA_API: {
      fetch: async () => {
        throw new Error("DATA_API unreachable");
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
    const r = await writeSubnetSnapshot(mockEnv(), {
      readArtifact: () =>
        Promise.resolve({ ok: true, data: { profiles: [{ netuid: "x" }] } }),
    });
    assert.equal(r.reason, "no_rows");
  });
});

describe("hourly cron writes a daily snapshot", () => {
  test("handleScheduled hourly runs prune + snapshot", async () => {
    // The snapshot rows land in D1, captured off METAGRAPH_HEALTH_DB.batch.
    // They used to be POSTed to DATA_API's subnet-snapshot-sync route as well,
    // which #9193 retired to its auth gate -- and until that leg was deleted,
    // its guaranteed 503 was what this lane's verdict came from.
    let snapshotRowCount: number | null = null;
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => ({
            values,
            run: () => Promise.resolve({ meta: { changes: 0 } }),
          }),
        }),
        batch: async (statements: unknown[]) => {
          snapshotRowCount = (snapshotRowCount ?? 0) + statements.length;
          return statements.map(() => ({ success: true }));
        },
      },
      DATA_API: {
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      HEALTH_CHECKS_SYNC_SECRET: "test-secret",
    };
    const result = await handleScheduled(
      { cron: "0 * * * *" } as unknown as ScheduledController,
      env as unknown as Env,
      {} as unknown as ExecutionContext,
    );
    assert.equal((result as Row).pruned, true);
    assert.ok(snapshotRowCount! > 0, "the snapshot write should ship rows");
  });
});

// d1All / hasD1FallbackRows / markD1FallbackRows / d1FallbackGeneration were
// deleted (2026-07-17, D1 fully eliminated) -- every analytics route now
// tries the Postgres tier first and a miss falls through to a pure
// empty-shape builder directly, never a live D1 query, so the D1 read path
// + its fallback-row bookkeeping had zero remaining callers. See
// workers/request-handlers/analytics.ts's own header comment.

// GET /api/v1/chain/emission-pipeline (#8744). The route reads the economics
// tier, so these drive it through a stubbed artifact rather than the network.
describe("emission-pipeline route", () => {
  const CHAIN_STATE = {
    block: 8_740_436,
    block_hash: `0x${"ab".repeat(32)}`,
    total_issuance_tao: 9_500_000,
    emission_gate_bar: 0.00927284254359668,
    emission_bar_quantile: 0.75,
    emission_gate_exponent: null,
  };
  const SUBNETS = [
    {
      netuid: 1,
      moving_price_pinned: 0.4,
      miner_burned_fraction: 0.1,
      emission_enabled: true,
      subtoken_enabled: true,
      registration_allowed_pinned: true,
      emission_share: 0.4,
      first_emission_block: 5_228_683,
      tao_in_emission_tao: "0.001185079",
      excess_tao: "0.001106056",
      alpha_in_emission: 0,
      alpha_out_emission: 1,
    },
    {
      netuid: 2,
      moving_price_pinned: 0.6,
      miner_burned_fraction: 0.2,
      emission_enabled: false,
      subtoken_enabled: true,
      registration_allowed_pinned: true,
      emission_share: 0.6,
      first_emission_block: 5_228_684,
      tao_in_emission_tao: "0.000000000",
      excess_tao: "0.000000000",
      alpha_in_emission: 0,
      alpha_out_emission: 1,
    },
  ];

  // Drives the route through the LIVE economics blob -- the tier it actually
  // prefers -- rather than the committed artifact, which carries no chain_state
  // locally.
  function envWithEconomics(economics: Row | null) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key: string) {
          if (key !== "economics:current" || !economics) return null;
          return {
            schema_version: 1,
            contract_version: CONTRACT_VERSION,
            captured_at: new Date(Date.now() - 60_000).toISOString(),
            // resolveLiveEconomics refuses a blob whose row count disagrees
            // with the summary, or whose emission_share does not sum to ~1 --
            // both are partial-write guards, so the fixture must satisfy them
            // or the route never sees the live tier at all.
            summary: {
              with_economics_count: Array.isArray(economics.subnets)
                ? (economics.subnets as Row[]).length
                : 0,
            },
            ...economics,
          };
        },
      },
    } as unknown as Row;
  }

  // #9220: the provenance map published on /api/v1/economics must describe the
  // tier the row actually came from. Since #9197 the live KV blob is built by a
  // Worker cron with no bittensor SDK -- named storage maps pinned to one block
  // -- so the bulk-call provenance the R2 artifact carries would be a claim
  // about a read that never happened.
  test("economics field_sources follows the serving tier", async () => {
    const live = await getJson(
      "https://api.metagraph.sh/api/v1/economics?limit=1",
      envWithEconomics({ chain_state: CHAIN_STATE, subnets: SUBNETS }),
    );
    assert.equal(live.status, 200);
    assert.equal(live.body.meta.source, "live-kv");
    const liveSources = live.body.data.field_sources;
    assert.equal(liveSources.alpha_price_tao.read_at, "chain_state.block");
    assert.equal(
      liveSources.alpha_price_tao.storage,
      "SubtensorModule.SubnetMovingPrice",
    );
    // The aggregates come from D1 on this tier, so they claim no instant.
    assert.equal(liveSources.validator_count.read_at, undefined);

    // With no live blob the route falls back to the committed artifact, and the
    // bulk-call map is the true one again.
    const r2 = await getJson(
      "https://api.metagraph.sh/api/v1/economics?limit=1",
      envWithEconomics(null),
    );
    assert.equal(r2.status, 200);
    const r2Sources = r2.body.data.field_sources;
    assert.equal(r2Sources.alpha_price_tao.read_at, "capture");
    assert.equal(
      r2Sources.alpha_price_tao.storage,
      "SubnetInfoRuntimeApi.get_all_metagraphs_info",
    );
    assert.equal(r2Sources.validator_count.read_at, "capture");
  });

  // #9408 completion: the full economics blob was the one surface still serving
  // rows without spot_price_tao while its schema declared the field. Both tiers
  // pass through the same injection point, so both are asserted here.
  test("economics rows carry serve-time spot_price_tao on both tiers", async () => {
    const withReserves = SUBNETS.map((row, i) =>
      i === 0 ? { ...row, tao_in_pool_tao: 100, alpha_in_pool: 400 } : row,
    );
    const live = await getJson(
      "https://api.metagraph.sh/api/v1/economics",
      envWithEconomics({ chain_state: CHAIN_STATE, subnets: withReserves }),
    );
    assert.equal(live.status, 200);
    assert.equal(live.body.meta.source, "live-kv");
    const liveRows = live.body.data.subnets;
    assert.equal(liveRows[0].spot_price_tao, 0.25);
    // A row without reserves is an explicit null, never omitted or zero.
    assert.equal(liveRows[1].spot_price_tao, null);

    // R2 fallback: the committed artifact's rows pass through the same point.
    const r2 = await getJson(
      "https://api.metagraph.sh/api/v1/economics?limit=1",
      envWithEconomics(null),
    );
    assert.equal(r2.status, 200);
    assert.notEqual(r2.body.data.subnets[0].spot_price_tao, undefined);
  });

  test("serves the decomposition with its pinned block", async () => {
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline",
      envWithEconomics({ chain_state: CHAIN_STATE, subnets: SUBNETS } as Row),
    );
    assert.equal(status, 200);
    assert.equal(body.data.chain_state.block, 8_740_436);
    assert.equal(body.data.subnets.length, 2);
    // Stage 5: the disabled subnet is zeroed and its share redistributed, so
    // the enabled one takes all of it.
    const enabled = body.data.subnets.find((s: Row) => s.netuid === 1);
    const disabled = body.data.subnets.find((s: Row) => s.netuid === 2);
    assert.equal(disabled.emission_enabled, false);
    assert.equal(disabled.final_share, 0);
    assert.ok(Math.abs(enabled.final_share - 1) < 1e-9);
    // ADR 0023 decision 3: reconstructed fields say so in the contract.
    assert.equal(body.data.field_sources.final_share.kind, "reconstructed");
    assert.equal(
      body.data.field_sources.tao_in_emission.storage,
      "SubtensorModule.SubnetTaoInEmission",
    );
  });

  test("filters to one subnet without changing the aggregate", async () => {
    const { body } = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline?netuid=1",
      envWithEconomics({ chain_state: CHAIN_STATE, subnets: SUBNETS } as Row),
    );
    assert.equal(body.data.subnets.length, 1);
    assert.equal(body.data.subnets[0].netuid, 1);
    // The aggregate stays network-wide -- a filtered view must not silently
    // redefine "the network split" as "this subnet".
    assert.equal(body.data.aggregate.eligible_count, 2);
  });

  test("503s rather than serving a decomposition with no pinned block", async () => {
    // Every share is reconstructed; without the block nobody can check it.
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline",
      envWithEconomics({ subnets: SUBNETS } as Row),
    );
    assert.equal(status, 503);
    assert.equal(body.error.code, "emission_pipeline_unavailable");
  });

  // The live KV tier is preferred but not required: with it cold, the route
  // decomposes the committed R2 artifact rather than 503ing on a tier miss.
  function envWithArtifactOnly(economics: Row | null) {
    return {
      ...envWithEconomics(null),
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          if (key !== "latest/economics.json" || !economics) return null;
          return {
            async json() {
              return economics;
            },
          };
        },
      },
    } as unknown as Row;
  }

  test("falls back to the committed artifact when the live tier is cold", async () => {
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline",
      envWithArtifactOnly({
        chain_state: CHAIN_STATE,
        subnets: SUBNETS,
      } as Row),
    );
    assert.equal(status, 200);
    assert.equal(body.data.chain_state.block, 8_740_436);
    assert.equal(body.data.subnets.length, 2);
  });

  test("503s when both economics tiers are cold", async () => {
    const { status, body } = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline",
      envWithArtifactOnly(null),
    );
    assert.equal(status, 503);
    assert.equal(body.error.code, "emission_pipeline_unavailable");
  });

  test("rejects an unsupported or malformed query param", async () => {
    const env = envWithEconomics({
      chain_state: CHAIN_STATE,
      subnets: SUBNETS,
    } as Row);
    const bogus = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline?bogus=1",
      env,
    );
    assert.equal(bogus.status, 400);
    const bad = await getJson(
      "https://api.metagraph.sh/api/v1/chain/emission-pipeline?netuid=abc",
      env,
    );
    assert.equal(bad.status, 400);
  });
});

// #9452: the snapshot write REPORTS its outcome instead of returning it.
//
// THE INCIDENT THIS CLOSES: 2026-08-01 is missing entirely from
// subnet_snapshots -- all 129 subnets, a whole day of price/economics history
// that does not exist -- and nothing said so. Every decline was a bare
// `return { ok: false, reason }`, and workers/api.entry.ts discards what
// `scheduled` returns, so "the economics source gave us nothing and today's
// history was never written" and "everything is fine" produced byte-identical
// telemetry. It was found four days later by reading the table by hand.
describe("#9452 — writeSubnetSnapshot reports its verdict", () => {
  function spies() {
    const rows: Row[] = [];
    const captures: Row[] = [];
    return {
      rows,
      captures,
      overrides: {
        laneHealthDb: {
          prepare: (sql: string) => ({
            bind: (...values: unknown[]) => ({
              run: async () => {
                if (sql.startsWith("INSERT")) {
                  rows.push({
                    lane: values[0],
                    verdict: values[1],
                    age_ms: values[2],
                    detail: values[3],
                  });
                }
              },
            }),
          }),
          batch: async () => [],
        } as never,
        recordExceptionEvent: (async (_env: unknown, event: unknown) => {
          captures.push(event as Row);
          return true;
        }) as never,
      },
    };
  }

  test("a decline records a stale lane row AND notifies", async () => {
    const s = spies();
    const result = (await writeSubnetSnapshot({} as never, {
      // No profiles artifact: the shape a degraded upstream produces.
      readArtifact: (() => Promise.resolve({ ok: false })) as never,
      ...s.overrides,
    })) as Row;

    assert.equal(result.ok, false);
    assert.equal(result.reason, "profiles_unavailable");

    assert.equal(s.rows.length, 1, "a row per run, healthy or not");
    assert.equal(s.rows[0].lane, "subnet-snapshot");
    assert.equal(s.rows[0].verdict, "stale");
    assert.equal(s.rows[0].detail, "profiles_unavailable");

    assert.equal(s.captures.length, 1);
    assert.equal(s.captures[0].route, "subnet-snapshot-write");
    assert.equal(s.captures[0].errorCode, "stale_lane");
    assert.match(
      (s.captures[0].error as Error).message,
      /profiles_unavailable/,
    );
  });

  test("an empty profiles list is a decline, not a quiet success", async () => {
    // The exact shape that loses a day: the artifact reads fine and carries
    // nothing, so there is nothing to write and no error to throw.
    const s = spies();
    const result = (await writeSubnetSnapshot({} as never, {
      readArtifact: (() =>
        Promise.resolve({ ok: true, data: { profiles: [] } })) as never,
      ...s.overrides,
    })) as Row;

    assert.equal(result.reason, "no_profiles");
    assert.equal(s.rows[0].verdict, "stale");
    assert.equal(s.captures.length, 1);
  });

  test("a missing reader is reported too, not silently skipped", async () => {
    const s = spies();
    const result = (await writeSubnetSnapshot(
      {} as never,
      s.overrides as never,
    )) as Row;
    assert.equal(result.reason, "unavailable");
    assert.equal(s.rows[0].verdict, "stale");
    assert.equal(s.captures.length, 1);
  });

  test("a lane_health write that fails never breaks the run", async () => {
    // D1 migrations here are applied by hand, so "no such table" is a real
    // production state. A writer whose alarm-recording broke its write would
    // be worse than the bug being fixed.
    const result = (await writeSubnetSnapshot({} as never, {
      readArtifact: (() => Promise.resolve({ ok: false })) as never,
      laneHealthDb: {
        prepare: () => {
          throw new Error("no such table: lane_health");
        },
      } as never,
      recordExceptionEvent: (async () => true) as never,
    })) as Row;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "profiles_unavailable");
  });

  test("a capture that throws never breaks the run either", async () => {
    const result = (await writeSubnetSnapshot({} as never, {
      readArtifact: (() => Promise.resolve({ ok: false })) as never,
      recordExceptionEvent: (async () => {
        throw new Error("posthog unreachable");
      }) as never,
    })) as Row;
    assert.equal(result.reason, "profiles_unavailable");
  });
});
