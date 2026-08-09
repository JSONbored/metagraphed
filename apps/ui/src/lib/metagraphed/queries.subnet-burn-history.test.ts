import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetBurnHistory, subnetBurnHistoryQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const NETUID = 1;

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/subnets/${NETUID}/burn/history`,
  });
}

async function runQuery(window?: "24h" | "7d" | "30d" | "90d") {
  const opts = subnetBurnHistoryQuery(NETUID, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

/** The shape production actually returns, copied from a live response. */
const LIVE = {
  schema_version: 1,
  netuid: 1,
  window: "30d",
  point_count: 352,
  current_burn_tao: 0.0005,
  change_tao: 0,
  change_pct: 0,
  points: [
    { observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0.0005 },
    { observed_at: "2026-08-08T08:16:01.874Z", burn_tao: 0.0005 },
  ],
};

describe("normalizeSubnetBurnHistory", () => {
  it("passes a live card through unchanged", () => {
    expect(normalizeSubnetBurnHistory(NETUID, LIVE)).toEqual(LIVE);
  });

  it("keeps the ROUTE's movement, never recomputing it from the points", () => {
    // /burn/history caps at 2,000 newest-first, so a first-vs-last over the
    // points measures the page, not the window. A card whose points are flat
    // must still report the window's real movement.
    const out = normalizeSubnetBurnHistory(NETUID, {
      ...LIVE,
      change_tao: -0.25,
      change_pct: -12.5,
      points: [{ observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0.0005 }],
    });
    expect(out.change_pct).toBe(-12.5);
    expect(out.change_tao).toBe(-0.25);
  });

  it("a point with no price is dropped, never charted as a free registration", () => {
    // 0 is a REAL burn (netuid 76 reads a true zero), so an unreadable sample
    // must not become the cheapest point in the series.
    const out = normalizeSubnetBurnHistory(NETUID, {
      ...LIVE,
      points: [
        { observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0.5 },
        { observed_at: "2026-08-08T08:16:01.874Z", burn_tao: null },
        { observed_at: "2026-08-08T08:01:01.000Z" },
        { burn_tao: 0.7 },
        null,
      ],
    });
    expect(out.points).toEqual([{ observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0.5 }]);
  });

  it("a genuine zero burn is KEPT", () => {
    const out = normalizeSubnetBurnHistory(NETUID, {
      ...LIVE,
      points: [{ observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0 }],
    });
    expect(out.points).toEqual([{ observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0 }]);
  });

  it("an empty or malformed body yields a defined card, not undefined fields", () => {
    // Every field the generated artifact declares is required; the tile reads
    // them directly rather than branching on undefined at each use.
    for (const raw of [undefined, null, {}, "nope", []]) {
      const out = normalizeSubnetBurnHistory(NETUID, raw);
      expect(out.netuid).toBe(NETUID);
      expect(out.points).toEqual([]);
      expect(out.point_count).toBe(0);
      expect(out.current_burn_tao).toBeNull();
      expect(out.change_pct).toBeNull();
      expect(out.window).toBeNull();
    }
  });

  it("falls back to the caller's netuid and the counted points", () => {
    const out = normalizeSubnetBurnHistory(NETUID, {
      points: [{ observed_at: "2026-08-08T08:31:01.855Z", burn_tao: 0.5 }],
    });
    expect(out.netuid).toBe(NETUID);
    expect(out.point_count).toBe(1);
  });
});

describe("subnetBurnHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("requests the route with the window, and defaults to 7d", async () => {
    resolveWith(LIVE);
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/subnets/${NETUID}/burn/history`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
  });

  it("passes an explicit window through", async () => {
    resolveWith(LIVE);
    await runQuery("90d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/subnets/${NETUID}/burn/history`,
      expect.objectContaining({ params: { window: "90d" } }),
    );
  });

  it("keys the cache on netuid AND window, so two windows do not share a slot", () => {
    expect(subnetBurnHistoryQuery(1, "7d").queryKey).not.toEqual(
      subnetBurnHistoryQuery(1, "30d").queryKey,
    );
    expect(subnetBurnHistoryQuery(1, "7d").queryKey).not.toEqual(
      subnetBurnHistoryQuery(2, "7d").queryKey,
    );
  });

  it("returns the normalized card", async () => {
    resolveWith(LIVE);
    const out = await runQuery("30d");
    expect(out.data.points).toHaveLength(2);
    expect(out.data.current_burn_tao).toBe(0.0005);
  });
});
