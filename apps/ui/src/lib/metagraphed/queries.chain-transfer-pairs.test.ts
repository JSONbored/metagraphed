import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainTransferPairsQuery, normalizeChainTransferPairs } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/transfer-pairs",
  });
}

async function runQuery(window?: string, limit?: number, sort?: "volume" | "count") {
  const opts = chainTransferPairsQuery(window, limit, sort);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainTransferPairs", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeChainTransferPairs({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        sort: "count",
        total_volume_tao: 100,
        transfer_count: 10,
        unique_pairs: 4,
        pair_count: 1,
        top_pair_share: 0.8,
        pairs: [
          {
            from: "5Sa",
            to: "5Rx",
            volume_tao: 80,
            transfer_count: 5,
            last_block: 8454388,
            last_observed_at: "2026-07-03T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      sort: "count",
      total_volume_tao: 100,
      transfer_count: 10,
      unique_pairs: 4,
      pair_count: 1,
      top_pair_share: 0.8,
      pairs: [
        {
          from: "5Sa",
          to: "5Rx",
          volume_tao: 80,
          transfer_count: 5,
          last_block: 8454388,
          last_observed_at: "2026-07-03T00:00:00.000Z",
        },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { unique_pairs: "nope" }]) {
      const card = normalizeChainTransferPairs(raw);
      expect(card.unique_pairs).toBe(0);
      expect(card.pair_count).toBe(0);
      expect(card.pairs).toEqual([]);
      expect(card.top_pair_share).toBeNull();
      expect(card.sort).toBe("volume");
    }
  });

  it("drops malformed pair rows and coerces a junk share to null", () => {
    const card = normalizeChainTransferPairs({
      top_pair_share: { pct: 1 },
      pairs: [{ from: "5Sa" }, { to: "5Rx" }, { from: "5Sa", to: "5Rx", volume_tao: 1 }],
    });
    expect(card.pairs).toHaveLength(1);
    expect(card.pairs[0]?.from).toBe("5Sa");
    expect(card.top_pair_share).toBeNull();
  });
});

describe("chainTransferPairsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes window, limit, and sort params and normalizes the card", async () => {
    resolveWith({
      window: "7d",
      sort: "count",
      unique_pairs: 2,
      pairs: [{ from: "5Sa", to: "5Rx", volume_tao: 3, transfer_count: 1 }],
    });
    const res = await runQuery("7d", 5, "count");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/transfer-pairs",
      expect.objectContaining({ params: { window: "7d", limit: 5, sort: "count" } }),
    );
    expect(res.data.unique_pairs).toBe(2);
    expect(res.data.pairs).toHaveLength(1);
  });

  it("defaults to the 30d window, limit 25, and volume sort", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/transfer-pairs",
      expect.objectContaining({ params: { window: "30d", limit: 25, sort: "volume" } }),
    );
  });
});
