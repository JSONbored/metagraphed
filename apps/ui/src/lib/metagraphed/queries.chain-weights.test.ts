import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainWeightsQuery, normalizeChainWeights } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/weights",
  });
}

async function runQuery(window?: string, limit?: number) {
  const opts = chainWeightsQuery(window as "7d" | "30d" | undefined, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainWeights", () => {
  it("passes a well-formed leaderboard through", () => {
    expect(
      normalizeChainWeights({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: {
          distinct_setters: 6,
          weight_sets: 90,
          sets_per_setter: 15,
        },
        intensity_distribution: {
          count: 2,
          mean: 13.5,
          min: 12,
          p25: 12,
          median: 12,
          p75: 15,
          p90: 15,
          max: 15,
        },
        subnets: [
          { netuid: 1, distinct_setters: 4, weight_sets: 60, sets_per_setter: 15 },
          { netuid: 2, distinct_setters: 2, weight_sets: 24, sets_per_setter: 12 },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 2,
      network: {
        distinct_setters: 6,
        weight_sets: 90,
        sets_per_setter: 15,
      },
      intensity_distribution: {
        count: 2,
        mean: 13.5,
        min: 12,
        p25: 12,
        median: 12,
        p75: 15,
        p90: 15,
        max: 15,
      },
      subnets: [
        { netuid: 1, distinct_setters: 4, weight_sets: 60, sets_per_setter: 15 },
        { netuid: 2, distinct_setters: 2, weight_sets: 24, sets_per_setter: 12 },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed leaderboard", () => {
    for (const raw of [{}, null, "x", { subnet_count: "nope" }]) {
      const card = normalizeChainWeights(raw);
      expect(card.subnet_count).toBe(0);
      expect(card.network.weight_sets).toBe(0);
      expect(card.network.distinct_setters).toBe(0);
      expect(card.network.sets_per_setter).toBeNull();
      expect(card.intensity_distribution).toBeNull();
      expect(card.subnets).toEqual([]);
    }
  });

  it("drops malformed subnet rows", () => {
    const card = normalizeChainWeights({
      subnet_count: 2,
      network: {},
      subnets: [{ netuid: "bad" }, { netuid: 3, weight_sets: 5 }],
    });
    expect(card.subnets).toEqual([
      { netuid: 3, distinct_setters: 0, weight_sets: 5, sets_per_setter: null },
    ]);
  });
});

describe("chainWeightsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches with window and limit params", async () => {
    resolveWith({ subnet_count: 0, network: {}, subnets: [] });
    await runQuery("30d", 50);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/weights", {
      params: { window: "30d", limit: 50 },
      signal: expect.any(AbortSignal),
    });
  });

  it("defaults to 7d and limit 20", async () => {
    resolveWith({ subnet_count: 0, network: {}, subnets: [] });
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/weights", {
      params: { window: "7d", limit: 20 },
      signal: expect.any(AbortSignal),
    });
  });
});
