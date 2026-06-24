import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { scoreFromStats, computeReliability } from "../src/reliability.mjs";

describe("scoreFromStats", () => {
  test("returns null when there are no probe samples", () => {
    assert.equal(scoreFromStats({ samples: 0, okCount: 0, avgLatencyMs: null }), null);
  });

  test("maps perfect uptime with low latency to grade A", () => {
    const result = scoreFromStats({
      samples: 100,
      okCount: 100,
      avgLatencyMs: 200,
      latencySamples: 100,
    });
    assert.equal(result.score, 100);
    assert.equal(result.grade, "A");
    assert.equal(result.uptime_ratio, 1);
    assert.equal(result.avg_latency_ms, 200);
  });

  test("applies the documented latency penalty above 500ms", () => {
    const result = scoreFromStats({
      samples: 100,
      okCount: 100,
      avgLatencyMs: 800,
      latencySamples: 50,
    });
    // 100 uptime − 3 latency penalty (300ms over free tier at 1pt/100ms)
    assert.equal(result.score, 97);
    assert.equal(result.grade, "B");
    assert.equal(result.latency_sample_count, 50);
  });

  test("treats missing latency as zero penalty", () => {
    const result = scoreFromStats({
      samples: 80,
      okCount: 72,
      avgLatencyMs: null,
    });
    assert.equal(result.score, 90);
    assert.equal(result.grade, "C");
    assert.equal(result.avg_latency_ms, null);
  });
});

describe("computeReliability", () => {
  test("rolls up per-surface scores and subnet totals", () => {
    const { subnet, surfaces } = computeReliability(
      [
        {
          surface_id: "docs",
          day: "2026-06-01",
          samples: 10,
          ok_count: 10,
          avg_latency_ms: 100,
          latency_samples: 10,
        },
        {
          surface_id: "api",
          day: "2026-06-01",
          samples: 10,
          ok_count: 5,
          avg_latency_ms: 600,
          latency_samples: 5,
        },
      ],
      { window: "7d", now: "2026-06-19T00:00:00.000Z" },
    );

    assert.equal(subnet.window, "7d");
    assert.equal(subnet.surface_count, 2);
    assert.equal(subnet.day_count, 1);
    assert.equal(subnet.computed_at, "2026-06-19T00:00:00.000Z");
    assert.equal(surfaces.docs.grade, "A");
    assert.equal(surfaces.api.score, 49); // 50% uptime − 1 latency penalty
    assert.equal(subnet.score, 75); // 15/20 ok overall, weighted latency under free tier
  });

  test("returns null subnet when no rows carry samples", () => {
    const { subnet, surfaces } = computeReliability([]);
    assert.equal(subnet, null);
    assert.deepEqual(surfaces, {});
  });
});
