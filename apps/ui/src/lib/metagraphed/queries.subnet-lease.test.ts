import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  normalizeSubnetLeaseHistory,
  normalizeSubnetLeaseState,
  subnetLeaseHistoryQuery,
  subnetLeaseQuery,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(url: string, data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url,
  });
}

async function runLease(netuid: number) {
  const opts = subnetLeaseQuery(netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

async function runHistory(netuid: number) {
  const opts = subnetLeaseHistoryQuery(netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetLeaseState", () => {
  it("passes a confirmed no-lease card through", () => {
    expect(
      normalizeSubnetLeaseState(7, {
        schema_version: 1,
        netuid: 7,
        leased: false,
        lease: null,
        queried_at: "2026-07-20T00:00:00Z",
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      leased: false,
      lease: null,
      queried_at: "2026-07-20T00:00:00Z",
    });
  });

  it("preserves leased:null (RPC failure) — never coerces to false", () => {
    expect(normalizeSubnetLeaseState(7, { leased: null }).leased).toBeNull();
    expect(normalizeSubnetLeaseState(7, {}).leased).toBeNull();
    expect(normalizeSubnetLeaseState(7, null).leased).toBeNull();
  });

  it("normalizes active lease terms and keeps null dividends", () => {
    const out = normalizeSubnetLeaseState(7, {
      leased: true,
      lease: {
        lease_id: 3,
        beneficiary: "5Ben",
        coldkey: "5Cold",
        hotkey: "5Hot",
        emissions_share_percent: 40,
        end_block: null,
        netuid: 7,
        cost_tao: 12.5,
        accumulated_dividends_alpha: null,
      },
    });
    expect(out.leased).toBe(true);
    expect(out.lease?.lease_id).toBe(3);
    expect(out.lease?.end_block).toBeNull();
    expect(out.lease?.accumulated_dividends_alpha).toBeNull();
  });

  it("drops a malformed lease object to null", () => {
    const out = normalizeSubnetLeaseState(7, {
      leased: true,
      lease: { lease_id: 1 },
    });
    expect(out.leased).toBe(true);
    expect(out.lease).toBeNull();
  });
});

describe("normalizeSubnetLeaseHistory", () => {
  it("passes events through and defaults metadata", () => {
    const out = normalizeSubnetLeaseHistory(7, {
      lease_events: [
        {
          event_kind: "SubnetLeaseCreated",
          beneficiary: "5Ben",
          block_number: 100,
          observed_at: "2026-07-01T00:00:00Z",
        },
      ],
    });
    expect(out.netuid).toBe(7);
    expect(out.count).toBe(1);
    expect(out.event_pallet).toBe("SubtensorModule");
    expect(out.lease_events).toHaveLength(1);
  });

  it("degrades junk to an empty history", () => {
    for (const raw of [{}, null, "x"]) {
      const out = normalizeSubnetLeaseHistory(7, raw);
      expect(out.lease_events).toEqual([]);
      expect(out.count).toBe(0);
    }
  });
});

describe("subnetLeaseQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits /api/v1/subnets/{netuid}/lease", async () => {
    resolveWith("/api/v1/subnets/7/lease", { leased: false, lease: null });
    const res = await runLease(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/lease",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.data.leased).toBe(false);
  });
});

describe("subnetLeaseHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits /api/v1/subnets/{netuid}/lease/history", async () => {
    resolveWith("/api/v1/subnets/7/lease/history", { lease_events: [], count: 0 });
    const res = await runHistory(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/lease/history",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.data.lease_events).toEqual([]);
  });
});
