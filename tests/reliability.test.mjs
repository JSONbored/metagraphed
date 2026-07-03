import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeReliability,
  displayUptimeRatio,
  scoreFromStats,
} from "../src/reliability.mjs";

describe("displayUptimeRatio", () => {
  test("passes an exact-1 ratio through unchanged", () => {
    assert.equal(displayUptimeRatio(1), 1);
  });

  test("clamps a sub-1 ratio that rounds up to 1.0000 down to 0.9999", () => {
    // (0.99996).toFixed(4) === "1.0000" would collapse a 99.996%-uptime surface
    // to a perfect-looking 1; the guard keeps it just below 1.
    assert.equal(displayUptimeRatio(0.99996), 0.9999);
  });

  test("rounds a normal ratio to four decimals", () => {
    assert.equal(displayUptimeRatio(0.987654), 0.9877);
  });
});

describe("scoreFromStats", () => {
  test("returns null when there are no samples", () => {
    assert.equal(scoreFromStats({ samples: 0, okCount: 0 }), null);
  });

  test("applies no latency penalty when avgLatencyMs is null", () => {
    const stats = scoreFromStats({
      samples: 100,
      okCount: 100,
      avgLatencyMs: null,
    });
    assert.deepEqual(stats, {
      score: 100,
      grade: "A",
      uptime_ratio: 1,
      avg_latency_ms: null,
      sample_count: 100,
      latency_sample_count: 0,
    });
  });

  test("penalizes latency above 500ms at 1 point per 100ms", () => {
    // (800 - 500) / 100 = 3 points off a perfect 100.
    const stats = scoreFromStats({
      samples: 100,
      okCount: 100,
      avgLatencyMs: 800,
      latencySamples: 50,
    });
    assert.equal(stats.score, 97);
    assert.equal(stats.grade, "B");
    assert.equal(stats.avg_latency_ms, 800);
    assert.equal(stats.latency_sample_count, 50);
  });

  test("does not penalize latency at or under the 500ms free threshold", () => {
    // Exactly at the threshold and below it both incur zero penalty (the
    // Math.max(0, …) arm), so a perfect uptime stays a perfect 100.
    for (const avgLatencyMs of [499, 500]) {
      const stats = scoreFromStats({
        samples: 100,
        okCount: 100,
        avgLatencyMs,
      });
      assert.equal(stats.score, 100, `${avgLatencyMs}ms should not penalize`);
    }
  });

  test("caps the latency penalty at 15 points", () => {
    // (5000 - 500) / 100 = 45, clamped to the 15-point maximum → 100 - 15 = 85.
    const stats = scoreFromStats({
      samples: 100,
      okCount: 100,
      avgLatencyMs: 5000,
    });
    assert.equal(stats.score, 85);
    assert.equal(stats.grade, "D");
  });

  test("clamps a rounded-up sub-perfect uptime to 99 (anti-overstatement)", () => {
    // 9995/10000 = 0.9995 → 99.95 rounds to 100, but the surface had downtime,
    // so it must not headline a flawless score: 100.
    const stats = scoreFromStats({
      samples: 10000,
      okCount: 9995,
      avgLatencyMs: null,
    });
    assert.equal(stats.score, 99);
    assert.equal(stats.grade, "A");
    assert.equal(stats.uptime_ratio, 0.9995);
  });

  test("assigns each grade band from the uptime score", () => {
    const grade = (okCount) =>
      scoreFromStats({ samples: 100, okCount, avgLatencyMs: null }).grade;
    assert.equal(grade(99), "A");
    assert.equal(grade(96), "B");
    assert.equal(grade(92), "C");
    assert.equal(grade(80), "D");
    assert.equal(grade(50), "F");
  });

  test("assigns the grade exactly at and just below each cutoff", () => {
    // gradeFor is a public, documented contract (A>=99, B>=95, C>=90, D>=75,
    // else F); pin both sides of every boundary so a threshold change fails here.
    const grade = (score) =>
      scoreFromStats({ samples: 100, okCount: score, avgLatencyMs: null })
        .grade;
    assert.equal(grade(99), "A");
    assert.equal(grade(98), "B");
    assert.equal(grade(95), "B");
    assert.equal(grade(94), "C");
    assert.equal(grade(90), "C");
    assert.equal(grade(89), "D");
    assert.equal(grade(75), "D");
    assert.equal(grade(74), "F");
  });
});

describe("computeReliability", () => {
  test("returns a null subnet for null or empty rows", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(computeReliability(rows), {
        subnet: null,
        surfaces: {},
      });
    }
  });

  test("keeps a renamed surface as one bucket via surface_key", () => {
    // Same surface_key across two different surface_id values within the window
    // must aggregate into a single bucket, not split into two.
    const { subnet, surfaces } = computeReliability(
      [
        {
          surface_key: "k1",
          surface_id: "a",
          day: "2024-01-01",
          samples: 10,
          ok_count: 10,
          avg_latency_ms: 100,
          latency_samples: 10,
        },
        {
          surface_key: "k1",
          surface_id: "b",
          day: "2024-01-02",
          samples: 10,
          ok_count: 8,
          avg_latency_ms: 300,
          latency_samples: 10,
        },
      ],
      { window: "30d", now: "2024-01-03T00:00:00Z" },
    );
    assert.deepEqual(Object.keys(surfaces), ["k1"]);
    assert.equal(surfaces.k1.sample_count, 20);
    assert.equal(surfaces.k1.avg_latency_ms, 200); // (100*10 + 300*10) / 20
    assert.equal(subnet.score, 90); // 18/20 uptime, no latency penalty
    assert.equal(subnet.grade, "C");
    assert.equal(subnet.uptime_ratio, 0.9);
    assert.equal(subnet.surface_count, 1);
    assert.equal(subnet.day_count, 2);
    assert.equal(subnet.window, "30d");
    assert.equal(subnet.computed_at, "2024-01-03T00:00:00Z");
  });

  test("falls back to surface_id when surface_key is absent (legacy rows)", () => {
    const { surfaces } = computeReliability([
      { surface_id: "legacy", day: "d1", samples: 5, ok_count: 5 },
    ]);
    assert.deepEqual(Object.keys(surfaces), ["legacy"]);
  });

  test("weights the latency mean by latency_samples, not total samples", () => {
    // A slow day backed by a single healthy reading must not outweigh a fast day
    // backed by nine: (1000*1 + 100*9) / 10 = 190, whereas total-sample weighting
    // would give (1000*10 + 100*10) / 20 = 550.
    const { subnet } = computeReliability([
      {
        surface_key: "s",
        day: "d1",
        samples: 10,
        ok_count: 10,
        avg_latency_ms: 1000,
        latency_samples: 1,
      },
      {
        surface_key: "s",
        day: "d2",
        samples: 10,
        ok_count: 10,
        avg_latency_ms: 100,
        latency_samples: 9,
      },
    ]);
    assert.equal(subnet.avg_latency_ms, 190);
  });

  test("falls back to total samples for latency weighting on legacy rows", () => {
    // Rows without latency_samples weight the latency mean by total samples:
    // (1000*1 + 100*9) / 10 = 190.
    const { subnet } = computeReliability([
      {
        surface_key: "L",
        day: "d1",
        samples: 1,
        ok_count: 1,
        avg_latency_ms: 1000,
      },
      {
        surface_key: "L",
        day: "d2",
        samples: 9,
        ok_count: 9,
        avg_latency_ms: 100,
      },
    ]);
    assert.equal(subnet.avg_latency_ms, 190);
  });

  test("coerces non-numeric row cells to zero", () => {
    // Defensive coercion: a row with garbage sample/count/latency_samples cells
    // contributes nothing rather than poisoning the aggregate with NaN.
    const { subnet, surfaces } = computeReliability([
      {
        surface_key: "good",
        day: "d1",
        samples: 10,
        ok_count: 10,
        avg_latency_ms: 100,
        latency_samples: 10,
      },
      {
        surface_key: "junk",
        day: "d1",
        samples: "x",
        ok_count: "y",
        avg_latency_ms: 200,
        latency_samples: "z",
      },
    ]);
    assert.equal(surfaces.junk, null); // 0 samples → no score
    assert.equal(subnet.sample_count, 10);
    assert.equal(subnet.avg_latency_ms, 100); // junk latency excluded
  });

  test("scores a subnet with no latency data and no day stamps", () => {
    // Rows with a null avg_latency_ms and no day exercise the false arms of the
    // latency-accumulation and day-tracking guards.
    const { subnet } = computeReliability([
      { surface_key: "s", samples: 4, ok_count: 4 },
    ]);
    assert.equal(subnet.score, 100);
    assert.equal(subnet.avg_latency_ms, null);
    assert.equal(subnet.day_count, 0);
    assert.equal(subnet.surface_count, 1);
    assert.equal(subnet.latency_sample_count, 0);
  });
});
