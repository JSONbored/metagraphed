import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  chainServingQuery,
  chainPrometheusQuery,
  normalizeChainServing,
  normalizeChainPrometheus,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown, url: string): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url,
  });
}

describe("normalizeChainServing", () => {
  it("passes a well-formed serving leaderboard through", () => {
    expect(
      normalizeChainServing({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: { distinct_servers: 5, announcements: 70, announcements_per_server: 14 },
        intensity_distribution: {
          count: 2,
          mean: 12.5,
          min: 10,
          p25: 10,
          median: 10,
          p75: 15,
          p90: 15,
          max: 15,
        },
        subnets: [
          { netuid: 1, distinct_servers: 4, announcements: 40, announcements_per_server: 10 },
          { netuid: 2, distinct_servers: 2, announcements: 30, announcements_per_server: 15 },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 2,
      network: { distinct_servers: 5, announcements: 70, announcements_per_server: 14 },
      intensity_distribution: {
        count: 2,
        mean: 12.5,
        min: 10,
        p25: 10,
        median: 10,
        p75: 15,
        p90: 15,
        max: 15,
      },
      subnets: [
        { netuid: 1, distinct_servers: 4, announcements: 40, announcements_per_server: 10 },
        { netuid: 2, distinct_servers: 2, announcements: 30, announcements_per_server: 15 },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed leaderboard", () => {
    for (const raw of [{}, null, "x", { subnet_count: "nope" }]) {
      const card = normalizeChainServing(raw);
      expect(card.subnet_count).toBe(0);
      expect(card.subnets).toEqual([]);
      expect(card.network).toEqual({
        distinct_servers: 0,
        announcements: 0,
        announcements_per_server: null,
      });
      expect(card.intensity_distribution).toBeNull();
    }
  });

  it("drops malformed subnet rows and coerces a junk per-server ratio to null", () => {
    const card = normalizeChainServing({
      network: { announcements_per_server: { pct: 1 } },
      subnets: [{ distinct_servers: 4 }, { netuid: 2, announcements: 30 }],
    });
    expect(card.subnets).toHaveLength(1);
    expect(card.subnets[0]?.netuid).toBe(2);
    expect(card.subnets[0]?.announcements_per_server).toBeNull();
    expect(card.network.announcements_per_server).toBeNull();
  });
});

describe("normalizeChainPrometheus", () => {
  it("passes a well-formed telemetry leaderboard through", () => {
    const card = normalizeChainPrometheus({
      window: "30d",
      subnet_count: 1,
      network: { distinct_exporters: 3, announcements: 9, announcements_per_exporter: 3 },
      subnets: [
        { netuid: 7, distinct_exporters: 3, announcements: 9, announcements_per_exporter: 3 },
      ],
    });
    expect(card.subnet_count).toBe(1);
    expect(card.subnets).toEqual([
      { netuid: 7, distinct_exporters: 3, announcements: 9, announcements_per_exporter: 3 },
    ]);
  });

  it("degrades a cold / empty store to a schema-stable zeroed leaderboard", () => {
    const card = normalizeChainPrometheus({});
    expect(card.subnet_count).toBe(0);
    expect(card.subnets).toEqual([]);
    expect(card.network).toEqual({
      distinct_exporters: 0,
      announcements: 0,
      announcements_per_exporter: null,
    });
    expect(card.intensity_distribution).toBeNull();
  });
});

describe("chain operations queries", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("chainServingQuery passes window/limit params and normalizes", async () => {
    resolveWith(
      {
        window: "30d",
        subnet_count: 1,
        network: { distinct_servers: 4, announcements: 40, announcements_per_server: 10 },
        subnets: [
          { netuid: 1, distinct_servers: 4, announcements: 40, announcements_per_server: 10 },
        ],
      },
      "/api/v1/chain/serving",
    );
    const opts = chainServingQuery("30d", 5);
    const res = await opts.queryFn!({
      signal: new AbortController().signal,
      queryKey: opts.queryKey,
      meta: undefined,
    } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/serving",
      expect.objectContaining({ params: { window: "30d", limit: 5 } }),
    );
    expect(res.data.subnets).toHaveLength(1);
  });

  it("chainPrometheusQuery defaults to the 7d window and limit 20", async () => {
    resolveWith({}, "/api/v1/chain/prometheus");
    const opts = chainPrometheusQuery();
    await opts.queryFn!({
      signal: new AbortController().signal,
      queryKey: opts.queryKey,
      meta: undefined,
    } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/prometheus",
      expect.objectContaining({ params: { window: "7d", limit: 20 } }),
    );
  });
});
