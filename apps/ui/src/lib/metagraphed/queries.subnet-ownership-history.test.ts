import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  normalizeSubnetOwnershipChange,
  normalizeSubnetOwnershipHistory,
  subnetOwnershipHistoryQuery,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/ownership-history",
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

const RAW_CHANGE = {
  netuid: 7,
  old_coldkey: "5Old1",
  new_coldkey: "5New1",
  block_number: 8_600_000,
  observed_at: "2026-07-01T00:00:00.000Z",
};

describe("normalizeSubnetOwnershipChange", () => {
  it("passes a well-formed change through", () => {
    expect(normalizeSubnetOwnershipChange(RAW_CHANGE)).toEqual(RAW_CHANGE);
  });

  it("returns null for a non-object row", () => {
    for (const raw of [null, undefined, 42, "x", []]) {
      expect(normalizeSubnetOwnershipChange(raw)).toBeNull();
    }
  });

  it("returns null when old_coldkey, new_coldkey, and block_number are all absent", () => {
    expect(normalizeSubnetOwnershipChange({ netuid: 7 })).toBeNull();
  });

  it("keeps a row with at least one identifying field, nulling the rest", () => {
    const change = normalizeSubnetOwnershipChange({ block_number: 100 });
    expect(change).toEqual({
      netuid: null,
      old_coldkey: null,
      new_coldkey: null,
      block_number: 100,
      observed_at: null,
    });
  });
});

describe("normalizeSubnetOwnershipHistory", () => {
  it("passes a well-formed response through", () => {
    const raw = {
      schema_version: 1,
      netuid: 7,
      event_pallet: "SubtensorModule",
      event_method: "SubnetOwnerChanged",
      count: 1,
      ownership_changes: [RAW_CHANGE],
    };
    expect(normalizeSubnetOwnershipHistory(7, raw)).toEqual(raw);
  });

  it("degrades cold / junk input to a schema-stable empty history", () => {
    for (const raw of [{}, null, undefined, "not-an-object"]) {
      const data = normalizeSubnetOwnershipHistory(7, raw);
      expect(data.netuid).toBe(7);
      expect(data.schema_version).toBe(1);
      expect(data.event_pallet).toBe("SubtensorModule");
      expect(data.event_method).toBe("SubnetOwnerChanged");
      expect(data.count).toBe(0);
      expect(data.ownership_changes).toEqual([]);
    }
  });

  it("drops a malformed change without dropping the rest of the batch", () => {
    const data = normalizeSubnetOwnershipHistory(7, {
      ownership_changes: [RAW_CHANGE, {}, { ...RAW_CHANGE, block_number: 8_600_001 }],
    });
    expect(data.ownership_changes).toHaveLength(2);
  });

  it("falls back to the requested netuid when the server omits it", () => {
    const data = normalizeSubnetOwnershipHistory(12, {});
    expect(data.netuid).toBe(12);
  });
});

describe("subnetOwnershipHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits its route", async () => {
    resolveWith({ netuid: 7, ownership_changes: [] });
    const res = await runQuery(subnetOwnershipHistoryQuery(7));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/ownership-history",
      expect.objectContaining({}),
    );
    expect(res.data.netuid).toBe(7);
  });

  it("normalizes the response through normalizeSubnetOwnershipHistory", async () => {
    resolveWith({ ownership_changes: [RAW_CHANGE] });
    const res = await runQuery(subnetOwnershipHistoryQuery(7));
    expect(res.data.ownership_changes).toEqual([RAW_CHANGE]);
  });
});
