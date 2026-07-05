import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  chainConcentrationQuery,
  chainPerformanceQuery,
  normalizeChainConcentration,
  normalizeChainPerformance,
  normalizeConcentrationMetricsOrNull,
  normalizeScoreDistributionOrNull,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(path: string, data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: path,
  });
}

async function runChainConcentrationQuery() {
  const opts = chainConcentrationQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

async function runChainPerformanceQuery() {
  const opts = chainPerformanceQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeConcentrationMetricsOrNull", () => {
  it("passes through a populated lens", () => {
    expect(
      normalizeConcentrationMetricsOrNull({
        holders: 3,
        total: 60,
        gini: 0.25,
        nakamoto_coefficient: 2,
      }),
    ).toMatchObject({ holders: 3, total: 60, gini: 0.25, nakamoto_coefficient: 2 });
  });

  it("returns null for cold-store null, zero holders, and all-null objects", () => {
    expect(normalizeConcentrationMetricsOrNull(null)).toBeNull();
    expect(normalizeConcentrationMetricsOrNull({ holders: 0 })).toBeNull();
    expect(normalizeConcentrationMetricsOrNull({})).toBeNull();
  });
});

describe("normalizeScoreDistributionOrNull", () => {
  it("normalizes percentile fields", () => {
    expect(
      normalizeScoreDistributionOrNull({
        count: 4,
        mean: 0.5,
        min: 0,
        max: 0.9,
        p10: 0,
        p50: 0.4,
        p90: 0.9,
      }),
    ).toEqual({
      count: 4,
      mean: 0.5,
      min: 0,
      max: 0.9,
      p10: 0,
      p25: null,
      p50: 0.4,
      p75: null,
      p90: 0.9,
    });
  });

  it("returns null for cold-store null and zero-count distributions", () => {
    expect(normalizeScoreDistributionOrNull(null)).toBeNull();
    expect(normalizeScoreDistributionOrNull({ count: 0 })).toBeNull();
  });
});

describe("normalizeChainConcentration", () => {
  it("maps network-wide concentration lenses", () => {
    expect(
      normalizeChainConcentration({
        schema_version: 1,
        subnet_count: 2,
        neuron_count: 3,
        entity_count: 2,
        uids_per_entity: 1.5,
        captured_at: "2026-06-27T00:00:00Z",
        stake: { holders: 3, total: 60, gini: 0.1 },
        emission: { holders: 3, total: 6, gini: 0.2 },
        entity_stake: { holders: 2, total: 60, gini: 0 },
        entity_emission: { holders: 2, total: 6, gini: 0 },
        validator_stake: { holders: 2, total: 30, gini: 0.5 },
      }),
    ).toMatchObject({
      schema_version: 1,
      subnet_count: 2,
      neuron_count: 3,
      entity_count: 2,
      uids_per_entity: 1.5,
      captured_at: "2026-06-27T00:00:00Z",
      stake: { holders: 3, total: 60, gini: 0.1 },
      validator_stake: { holders: 2, total: 30, gini: 0.5 },
    });
  });

  it("falls back to schema-stable null lenses on a cold body", () => {
    expect(
      normalizeChainConcentration({
        schema_version: 1,
        subnet_count: 0,
        neuron_count: 0,
        entity_count: 0,
        uids_per_entity: null,
        captured_at: null,
        stake: null,
        emission: null,
        entity_stake: null,
        entity_emission: null,
        validator_stake: null,
      }),
    ).toEqual({
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      captured_at: null,
      stake: null,
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });
  });
});

describe("normalizeChainPerformance", () => {
  it("maps reward concentration and score spreads", () => {
    expect(
      normalizeChainPerformance({
        schema_version: 1,
        subnet_count: 2,
        neuron_count: 3,
        validator_count: 2,
        active_count: 3,
        captured_at: "2026-06-27T00:00:00Z",
        incentive: { holders: 3, gini: 0.4 },
        dividends: { holders: 2, gini: 0.6 },
        trust: { count: 3, mean: 0.7, p10: 0.4, p90: 0.9 },
        consensus: { count: 3, mean: 0.55, p50: 0.6 },
        validator_trust: { count: 2, mean: 0.9, p50: 0.9 },
      }),
    ).toMatchObject({
      subnet_count: 2,
      validator_count: 2,
      active_count: 3,
      incentive: { holders: 3, gini: 0.4 },
      trust: { count: 3, mean: 0.7, p10: 0.4, p90: 0.9 },
    });
  });

  it("falls back to schema-stable null blocks on a cold body", () => {
    expect(
      normalizeChainPerformance({
        schema_version: 1,
        subnet_count: 0,
        neuron_count: 0,
        captured_at: null,
        incentive: null,
        dividends: null,
        trust: null,
        consensus: null,
        validator_trust: null,
      }),
    ).toMatchObject({
      subnet_count: 0,
      neuron_count: 0,
      captured_at: null,
      incentive: null,
      dividends: null,
      trust: null,
      consensus: null,
      validator_trust: null,
    });
  });
});

describe("chainConcentrationQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches and normalizes the network concentration artifact", async () => {
    resolveWith("/api/v1/chain/concentration", {
      schema_version: 1,
      subnet_count: 1,
      neuron_count: 2,
      entity_count: 2,
      uids_per_entity: 1,
      captured_at: "2026-01-01T00:00:00Z",
      stake: { holders: 2, total: 30 },
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });

    const result = await runChainConcentrationQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/concentration", {
      signal: expect.any(AbortSignal),
    });
    expect(result.data.stake).toMatchObject({ holders: 2, total: 30 });
    expect(result.data.emission).toBeNull();
  });
});

describe("chainPerformanceQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches and normalizes the network performance artifact", async () => {
    resolveWith("/api/v1/chain/performance", {
      schema_version: 1,
      subnet_count: 1,
      neuron_count: 2,
      validator_count: 1,
      active_count: 2,
      captured_at: "2026-01-01T00:00:00Z",
      incentive: { holders: 2, gini: 0.3 },
      dividends: null,
      trust: { count: 2, mean: 0.8 },
      consensus: null,
      validator_trust: null,
    });

    const result = await runChainPerformanceQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/performance", {
      signal: expect.any(AbortSignal),
    });
    expect(result.data.incentive).toMatchObject({ holders: 2, gini: 0.3 });
    expect(result.data.trust).toMatchObject({ count: 2, mean: 0.8 });
    expect(result.data.consensus).toBeNull();
  });
});
