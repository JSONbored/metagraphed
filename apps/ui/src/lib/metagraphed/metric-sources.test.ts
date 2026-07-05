import { describe, expect, it } from "vitest";

import { METRIC_SOURCES, resolveMetric, type MetricKey } from "./metric-sources";

const METRIC_KEYS = Object.keys(METRIC_SOURCES) as MetricKey[];

describe("resolveMetric", () => {
  it("returns the canonical attribution for known metric keys", () => {
    expect(resolveMetric("health")).toEqual(METRIC_SOURCES.health);
    expect(resolveMetric("freshness")).toEqual(METRIC_SOURCES.freshness);
    expect(resolveMetric("latency")).toEqual(METRIC_SOURCES.latency);
  });

  it("covers every registered metric key", () => {
    for (const key of METRIC_KEYS) {
      expect(resolveMetric(key).metric).toBe(METRIC_SOURCES[key].metric);
    }
    expect(METRIC_KEYS).toHaveLength(10);
  });

  it("falls back when the key is missing or unknown", () => {
    expect(resolveMetric(undefined)).toEqual({
      metric: "Metric",
      source: "Registry artifacts",
      staleness: "Refresh follows upstream artifact cadence.",
      defaultWindow: undefined,
    });
    expect(resolveMetric("not-a-metric" as MetricKey)).toEqual({
      metric: "Metric",
      source: "Registry artifacts",
      staleness: "Refresh follows upstream artifact cadence.",
      defaultWindow: undefined,
    });
  });

  it("merges caller-provided fallback fields", () => {
    expect(
      resolveMetric(undefined, {
        metric: "Custom metric",
        source: "Custom source",
        staleness: "Custom staleness",
        defaultWindow: "7d",
      }),
    ).toEqual({
      metric: "Custom metric",
      source: "Custom source",
      staleness: "Custom staleness",
      defaultWindow: "7d",
    });
  });
});
