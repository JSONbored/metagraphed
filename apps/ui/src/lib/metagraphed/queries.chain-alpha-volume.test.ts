import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeChainAlphaVolume, chainAlphaVolumeQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/alpha-volume",
  });
}

// Mirrors queries.subnet-ohlc.test.ts's own runQuery helper.
function runQuery<
  O extends {
    queryKey: readonly unknown[];
    queryFn?: (context: never) => unknown;
  },
>(opts: O): ReturnType<NonNullable<O["queryFn"]>> {
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never) as ReturnType<NonNullable<O["queryFn"]>>;
}

const RAW_NETWORK = {
  buy_volume_alpha: 1000,
  sell_volume_alpha: 400,
  total_volume_alpha: 1400,
  buy_volume_tao: 40,
  sell_volume_tao: 16,
  total_volume_tao: 56,
  buy_count: 20,
  sell_count: 8,
  net_volume_alpha: 600,
  sentiment_ratio: 0.4286,
  sentiment: "bullish",
};

describe("normalizeChainAlphaVolume", () => {
  it("passes a well-formed response through", () => {
    const raw = {
      schema_version: 1,
      window: "24h",
      observed_at: "2026-07-18T00:00:00.000Z",
      subnet_count: 42,
      network: RAW_NETWORK,
      volume_distribution: {
        count: 42,
        mean: 10,
        min: 1,
        p25: 5,
        median: 8,
        p75: 12,
        p90: 20,
        max: 100,
      },
      subnets: [],
    };
    expect(normalizeChainAlphaVolume(raw)).toEqual(raw);
  });

  it("degrades cold / junk input to a schema-stable zeroed neutral reading", () => {
    for (const raw of [{}, null, undefined, "not-an-object"]) {
      const data = normalizeChainAlphaVolume(raw);
      expect(data.schema_version).toBe(1);
      expect(data.window).toBe("24h");
      expect(data.observed_at).toBeNull();
      expect(data.subnet_count).toBe(0);
      expect(data.network).toEqual({
        buy_volume_alpha: 0,
        sell_volume_alpha: 0,
        total_volume_alpha: 0,
        buy_volume_tao: 0,
        sell_volume_tao: 0,
        total_volume_tao: 0,
        buy_count: 0,
        sell_count: 0,
        net_volume_alpha: 0,
        sentiment_ratio: null,
        sentiment: "neutral",
      });
      expect(data.volume_distribution).toBeNull();
      expect(data.subnets).toEqual([]);
    }
  });

  it("coerces a junk sentiment string to neutral rather than passing it through", () => {
    const data = normalizeChainAlphaVolume({ network: { ...RAW_NETWORK, sentiment: "moon" } });
    expect(data.network.sentiment).toBe("neutral");
  });

  it("passes through bearish sentiment", () => {
    const data = normalizeChainAlphaVolume({
      network: { ...RAW_NETWORK, sentiment: "bearish", sentiment_ratio: -0.6 },
    });
    expect(data.network.sentiment).toBe("bearish");
    expect(data.network.sentiment_ratio).toBe(-0.6);
  });
});

describe("chainAlphaVolumeQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits its route with no params", async () => {
    resolveWith({ network: RAW_NETWORK });
    const res = await runQuery(chainAlphaVolumeQuery());
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/alpha-volume",
      expect.objectContaining({}),
    );
    expect(res.data.network.sentiment).toBe("bullish");
  });

  it("normalizes the response through normalizeChainAlphaVolume", async () => {
    resolveWith({ network: RAW_NETWORK, subnet_count: 7 });
    const res = await runQuery(chainAlphaVolumeQuery());
    expect(res.data.subnet_count).toBe(7);
    expect(res.data.network.sentiment_ratio).toBe(0.4286);
  });
});
