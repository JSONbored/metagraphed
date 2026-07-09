import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetOverview, subnetOverviewQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

describe("normalizeSubnetOverview", () => {
  it("passes a well-formed overview artifact through", () => {
    const overview = normalizeSubnetOverview(
      {
        netuid: 1,
        name: "Apex",
        slug: "sn-1",
        status: "active",
        profile: { symbol: "α" },
        health: { status: "unknown", surface_count: 0 },
        curation: { level: "maintainer-reviewed" },
        gaps: { missing_kinds: ["sse"] },
        counts: { surfaces: 16, endpoints: 16, candidates: 14 },
        gap_priorities: [{ suggested_next_action: "evaluate for subnet-specific adapter" }],
      },
      1,
    );
    expect(overview.netuid).toBe(1);
    expect(overview.name).toBe("Apex");
    expect(overview.status).toBe("active");
    expect(overview.health).toEqual({ status: "unknown", surface_count: 0 });
    expect(overview.curation).toEqual({ level: "maintainer-reviewed" });
    expect(overview.counts).toEqual({ surfaces: 16, endpoints: 16, candidates: 14 });
    expect(overview.gap_priorities).toEqual([
      { suggested_next_action: "evaluate for subnet-specific adapter" },
    ]);
  });

  it("degrades a cold/junk store to a schema-stable shape, never throws", () => {
    for (const raw of [{}, null, "x", { counts: "nope", gap_priorities: "nope" }]) {
      const overview = normalizeSubnetOverview(raw, 7);
      expect(overview.netuid).toBe(7);
      expect(overview.counts).toEqual({ surfaces: 0, endpoints: 0, candidates: 0 });
      expect(overview.gap_priorities).toEqual([]);
      expect(overview.health).toBeUndefined();
      expect(overview.curation).toBeUndefined();
    }
  });

  it("falls back to the passed netuid when the payload omits it", () => {
    expect(normalizeSubnetOverview({ status: "active" }, 42).netuid).toBe(42);
  });
});

describe("subnetOverviewQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches the per-netuid overview route and normalizes the response", async () => {
    mockedApiFetch.mockResolvedValue({
      data: { netuid: 5, status: "active", counts: { surfaces: 3, endpoints: 2, candidates: 1 } },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/subnets/5/overview",
    });

    const opts = subnetOverviewQuery(5);
    if (!opts.queryFn) throw new Error("expected a queryFn");
    const res = await opts.queryFn({
      signal: new AbortController().signal,
      queryKey: opts.queryKey,
      meta: undefined,
    } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/5/overview",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.data.counts).toEqual({ surfaces: 3, endpoints: 2, candidates: 1 });
    expect(res.data.status).toBe("active");
  });
});
