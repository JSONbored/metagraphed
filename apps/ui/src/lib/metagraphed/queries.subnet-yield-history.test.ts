import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetYieldHistory, subnetYieldHistoryQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/yield/history",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetYieldHistoryQuery(netuid, window as "7d" | "30d" | "90d" | undefined);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetYieldHistory", () => {
  it("passes a well-formed series through", () => {
    expect(
      normalizeSubnetYieldHistory(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        point_count: 2,
        points: [
          {
            snapshot_date: "2026-07-01",
            neuron_count: 64,
            validator_count: 8,
            yield_count: 60,
            subnet_yield: 0.012,
            mean_yield: 0.011,
            median_yield: 0.0105,
            p25_yield: 0.008,
            p75_yield: 0.013,
            p90_yield: 0.015,
          },
          {
            snapshot_date: "2026-07-02",
            neuron_count: 64,
            validator_count: 8,
            yield_count: 58,
            subnet_yield: null,
            mean_yield: null,
            median_yield: null,
            p25_yield: null,
            p75_yield: null,
            p90_yield: null,
          },
        ],
      }),
    ).toEqual({
      netuid: 7,
      window: "30d",
      point_count: 2,
      points: [
        {
          snapshot_date: "2026-07-01",
          neuron_count: 64,
          validator_count: 8,
          yield_count: 60,
          subnet_yield: 0.012,
          mean_yield: 0.011,
          median_yield: 0.0105,
          p25_yield: 0.008,
          p75_yield: 0.013,
          p90_yield: 0.015,
        },
        {
          snapshot_date: "2026-07-02",
          neuron_count: 64,
          validator_count: 8,
          yield_count: 58,
          subnet_yield: null,
          mean_yield: null,
          median_yield: null,
          p25_yield: null,
          p75_yield: null,
          p90_yield: null,
        },
      ],
    });
  });

  it("degrades a cold / junk store to an empty series", () => {
    for (const raw of [{}, null, "x", { points: "nope" }]) {
      const series = normalizeSubnetYieldHistory(7, raw);
      expect(series.netuid).toBe(7);
      expect(series.points).toEqual([]);
      expect(series.point_count).toBe(0);
    }
  });

  it("drops malformed points and coerces junk yield cells to null", () => {
    const series = normalizeSubnetYieldHistory(7, {
      points: [
        { snapshot_date: "2026-07-01", median_yield: { x: 1 } },
        { snapshot_date: "2026-07-02", mean_yield: 0.02, p90_yield: "bad" },
      ],
    });
    expect(series.points).toHaveLength(2);
    expect(series.points[0]?.median_yield).toBeNull();
    expect(series.points[1]?.mean_yield).toBe(0.02);
    expect(series.points[1]?.p90_yield).toBeNull();
  });

  it("falls back to the requested netuid when the payload omits it", () => {
    expect(normalizeSubnetYieldHistory(12, { points: [] }).netuid).toBe(12);
  });
});

describe("subnetYieldHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the series", async () => {
    resolveWith({
      netuid: 7,
      window: "7d",
      points: [{ snapshot_date: "2026-07-01", mean_yield: 0.01 }],
    });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/yield/history",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.points).toHaveLength(1);
    expect(res.data.points[0]?.mean_yield).toBe(0.01);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({ points: [] });
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/yield/history",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
