import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { economicsTrendsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/economics/trends",
  });
}

async function runQuery(window?: "7d" | "30d") {
  const opts = window == null ? economicsTrendsQuery() : economicsTrendsQuery(window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("economicsTrendsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes chronological-descending rows", async () => {
    resolveWith({
      window: "30d",
      day_count: 2,
      days: [
        {
          snapshot_date: "2026-07-08",
          subnet_count: 129,
          total_stake_tao: 12_500_000,
          alpha_price_tao_weighted: 0.045,
          alpha_price_tao_median: 0.041,
          validator_count: 4200,
          miner_count: 15800,
          mean_emission_share: 0.00775,
        },
        {
          snapshot_date: "2026-07-07",
          subnet_count: 128,
          total_stake_tao: 12_300_000,
          alpha_price_tao_weighted: 0.044,
          alpha_price_tao_median: 0.04,
          validator_count: 4190,
          miner_count: 15750,
          mean_emission_share: 0.00776,
        },
      ],
    });
    const res = await runQuery("30d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/economics/trends",
      expect.objectContaining({ params: { window: "30d" } }),
    );
    expect(res.data.window).toBe("30d");
    expect(res.data.day_count).toBe(2);
    expect(res.data.days).toHaveLength(2);
    expect(res.data.days[0]).toEqual({
      snapshot_date: "2026-07-08",
      subnet_count: 129,
      total_stake_tao: 12_500_000,
      alpha_price_tao_weighted: 0.045,
      alpha_price_tao_median: 0.041,
      validator_count: 4200,
      miner_count: 15800,
      mean_emission_share: 0.00775,
    });
  });

  it("defaults to a 7d window", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/economics/trends",
      expect.objectContaining({ params: { window: "7d" } }),
    );
  });

  it("degrades a cold / junk store to a schema-stable empty card", async () => {
    for (const raw of [{}, null, "x", { day_count: "nope", days: "nope" }]) {
      resolveWith(raw);
      const res = await runQuery("30d");
      expect(res.data.day_count).toBe(0);
      expect(res.data.days).toEqual([]);
      // window falls through to the requested window on a cold store, matching
      // the sibling chain-analytics queries' cold-store behavior.
      expect(res.data.window).toBe("30d");
    }
  });

  it("drops a row missing snapshot_date or subnet_count, keeping per-metric nulls", async () => {
    resolveWith({
      day_count: 3,
      days: [
        { subnet_count: 129, total_stake_tao: 100 }, // no snapshot_date -> dropped
        { snapshot_date: "2026-07-06", subnet_count: "nope" }, // junk count -> dropped
        {
          // no subnet reported a price or validator/miner count this day, but the
          // row itself is well-formed -> kept, with every optional metric null.
          snapshot_date: "2026-07-05",
          subnet_count: 3,
          total_stake_tao: null,
          alpha_price_tao_weighted: null,
          alpha_price_tao_median: null,
          validator_count: null,
          miner_count: null,
          mean_emission_share: null,
        },
      ],
    });
    const res = await runQuery();
    expect(res.data.days).toHaveLength(1);
    expect(res.data.days[0]).toEqual({
      snapshot_date: "2026-07-05",
      subnet_count: 3,
      total_stake_tao: null,
      alpha_price_tao_weighted: null,
      alpha_price_tao_median: null,
      validator_count: null,
      miner_count: null,
      mean_emission_share: null,
    });
  });

  it("caps the rendered rows at 31 days", async () => {
    resolveWith({
      day_count: 60,
      days: Array.from({ length: 60 }, (_, i) => ({
        snapshot_date: `2026-07-${String(i + 1).padStart(2, "0")}`,
        subnet_count: 129,
      })),
    });
    const res = await runQuery();
    expect(res.data.days).toHaveLength(31);
  });
});
