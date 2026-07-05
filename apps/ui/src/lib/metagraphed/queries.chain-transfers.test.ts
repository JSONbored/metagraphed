import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainTransfersQuery, normalizeChainTransfers } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/transfers",
  });
}

async function runQuery(window?: string, limit?: number) {
  const opts = chainTransfersQuery(window, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainTransfers", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeChainTransfers({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        total_volume_tao: 100,
        transfer_count: 10,
        unique_senders: 4,
        unique_receivers: 6,
        top_sender_share: 0.8,
        top_senders: [
          {
            address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            volume_tao: 80,
            transfer_count: 5,
          },
        ],
        top_receivers: [
          {
            address: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
            volume_tao: 60,
            transfer_count: 4,
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      total_volume_tao: 100,
      transfer_count: 10,
      unique_senders: 4,
      unique_receivers: 6,
      top_sender_share: 0.8,
      top_senders: [
        {
          address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          volume_tao: 80,
          transfer_count: 5,
        },
      ],
      top_receivers: [
        {
          address: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
          volume_tao: 60,
          transfer_count: 4,
        },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { unique_senders: "nope" }]) {
      const card = normalizeChainTransfers(raw);
      expect(card.unique_senders).toBe(0);
      expect(card.unique_receivers).toBe(0);
      expect(card.top_senders).toEqual([]);
      expect(card.top_receivers).toEqual([]);
      expect(card.top_sender_share).toBeNull();
    }
  });

  it("drops malformed leaderboard rows and coerces a junk share to null", () => {
    const card = normalizeChainTransfers({
      top_sender_share: { pct: 1 },
      top_senders: [
        { address: "not-ss58" },
        { address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", volume_tao: 1 },
      ],
    });
    expect(card.top_senders).toHaveLength(1);
    expect(card.top_sender_share).toBeNull();
  });
});

describe("chainTransfersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes window and limit params and normalizes the card", async () => {
    resolveWith({
      window: "7d",
      unique_senders: 2,
      top_senders: [
        {
          address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          volume_tao: 3,
          transfer_count: 1,
        },
      ],
    });
    const res = await runQuery("7d", 5);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/transfers",
      expect.objectContaining({ params: { window: "7d", limit: 5 } }),
    );
    expect(res.data.unique_senders).toBe(2);
    expect(res.data.top_senders).toHaveLength(1);
  });

  it("defaults to the 30d window and limit 25", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/transfers",
      expect.objectContaining({ params: { window: "30d", limit: 25 } }),
    );
  });
});
