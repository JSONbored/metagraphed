import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountWeightSettersQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/accounts/${SS58}/weight-setters`,
  });
}

async function runQuery(ss58: string, window?: string) {
  const opts = accountWeightSettersQuery(ss58, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("accountWeightSettersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and filters junk subnet rows", async () => {
    resolveWith({
      address: SS58,
      window: "7d",
      total_weight_sets: 4,
      subnet_count: 1,
      concentration: 1,
      dominant_netuid: 12,
      subnets: [
        {
          netuid: 12,
          weight_sets: 4,
          first_set_at: "2026-07-01T00:00:00Z",
          last_set_at: "2026-07-02T00:00:00Z",
        },
        { weight_sets: 9 }, // no netuid -> dropped
      ],
    });
    const res = await runQuery(SS58, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/weight-setters`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.subnets).toHaveLength(1);
    expect(res.data.subnets[0]).toEqual({
      netuid: 12,
      weight_sets: 4,
      first_set_at: "2026-07-01T00:00:00Z",
      last_set_at: "2026-07-02T00:00:00Z",
    });
  });

  it("defaults to 30d and degrades a cold store to a zeroed, empty-subnet card", async () => {
    resolveWith({});
    const res = await runQuery(SS58);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/weight-setters`,
      expect.objectContaining({ params: { window: "30d" } }),
    );
    expect(res.data.subnets).toEqual([]);
    expect(res.data.subnet_count).toBe(0);
    expect(res.data.total_weight_sets).toBe(0);
    expect(res.data.dominant_netuid).toBeNull();
    expect(res.data.address).toBe(SS58);
  });
});
