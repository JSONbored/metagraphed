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
  it("passes a well-formed leaderboard through", () => {
    const board = normalizeChainTransfers({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      total_volume_tao: 1234.5,
      transfer_count: 42,
      unique_senders: 9,
      unique_receivers: 11,
      top_sender_share: 0.3,
      top_senders: [
        { address: "5AAA", volume_tao: 900, transfer_count: 20 },
        { address: "5BBB", volume_tao: 300, transfer_count: 10 },
      ],
      top_receivers: [{ address: "5CCC", volume_tao: 800, transfer_count: 15 }],
    });
    expect(board.total_volume_tao).toBe(1234.5);
    expect(board.unique_senders).toBe(9);
    expect(board.top_sender_share).toBe(0.3);
    expect(board.top_senders).toHaveLength(2);
    expect(board.top_senders[0]?.address).toBe("5AAA");
    expect(board.top_receivers).toHaveLength(1);
    expect(board.top_receivers[0]?.volume_tao).toBe(800);
  });

  it("degrades a cold / junk store to two schema-stable empty leaderboards", () => {
    for (const raw of [{}, null, "x", { total_volume_tao: "nope" }]) {
      const board = normalizeChainTransfers(raw);
      expect(board.total_volume_tao).toBe(0);
      expect(board.unique_senders).toBe(0);
      expect(board.top_sender_share).toBeNull();
      expect(board.top_senders).toEqual([]);
      expect(board.top_receivers).toEqual([]);
    }
  });

  it("drops party rows that have no address and zeroes non-finite cells", () => {
    const board = normalizeChainTransfers({
      top_senders: [
        { volume_tao: 5 },
        { address: "5DDD", volume_tao: "x", transfer_count: null },
      ],
      top_receivers: [{ address: "5EEE" }],
    });
    expect(board.top_senders).toHaveLength(1);
    expect(board.top_senders[0]?.address).toBe("5DDD");
    expect(board.top_senders[0]?.volume_tao).toBe(0);
    expect(board.top_senders[0]?.transfer_count).toBe(0);
    expect(board.top_receivers[0]?.transfer_count).toBe(0);
  });
});

describe("chainTransfersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window and limit params and normalizes the board", async () => {
    resolveWith({ total_volume_tao: 10, top_senders: [{ address: "5FFF", volume_tao: 10 }] });
    const res = await runQuery("30d", 25);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/transfers",
      expect.objectContaining({ params: { window: "30d", limit: 25 } }),
    );
    expect(res.data.top_senders).toHaveLength(1);
  });

  it("defaults to the 7d window and limit 20", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/transfers",
      expect.objectContaining({ params: { window: "7d", limit: 20 } }),
    );
  });
});
