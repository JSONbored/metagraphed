import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetStakeTransfers, subnetStakeTransfersQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/stake-transfers",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetStakeTransfersQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetStakeTransfers", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeSubnetStakeTransfers(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        observed_at: "2026-07-01T00:00:00Z",
        distinct_senders: 2,
        transfers: 3,
        transfers_per_sender: 1.5,
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      distinct_senders: 2,
      transfers: 3,
      transfers_per_sender: 1.5,
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { distinct_senders: "nope" }]) {
      const card = normalizeSubnetStakeTransfers(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.distinct_senders).toBe(0);
      expect(card.transfers).toBe(0);
      expect(card.transfers_per_sender).toBeNull();
      expect(card.observed_at).toBeNull();
    }
  });

  it("coerces a junk average to null (never NaN)", () => {
    const card = normalizeSubnetStakeTransfers(7, {
      transfers: 3,
      transfers_per_sender: { avg: 1 },
    });
    expect(card.transfers).toBe(3);
    expect(card.transfers_per_sender).toBeNull();
  });

  it("falls back to the passed netuid when the payload omits it", () => {
    const card = normalizeSubnetStakeTransfers(12, { transfers: 1, distinct_senders: 1 });
    expect(card.netuid).toBe(12);
  });
});

describe("subnetStakeTransfersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ netuid: 7, window: "7d", distinct_senders: 2, transfers: 5 });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/stake-transfers",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.transfers).toBe(5);
    expect(res.data.distinct_senders).toBe(2);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/stake-transfers",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
