import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeUsageAnalytics, usageAnalyticsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/usage",
  });
}

// Invoke a queryOptions' queryFn directly (mirrors queries.blocks-summary.test).
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

// A representative /api/v1/usage payload — the #366 route/day + per-MCP-tool
// event schema this view consumes, in the shape the endpoint will serve.
const WELL_FORMED = {
  window: "7d",
  observed_at: "2026-07-16T00:00:00.000Z",
  source: "analytics-engine",
  summary: {
    total_calls: 1500,
    ok_calls: 1440,
    error_calls: 60,
    error_rate: 0.04,
    route_calls: 1100,
    mcp_calls: 400,
  },
  routes: [
    {
      rank: 1,
      route: "GET /api/v1/subnets",
      calls: 800,
      ok_calls: 790,
      error_calls: 10,
      error_rate: 0.0125,
    },
    {
      rank: 2,
      route: "GET /api/v1/health",
      calls: 300,
      ok_calls: 250,
      error_calls: 50,
      error_rate: 0.1667,
    },
  ],
  tools: [
    { rank: 1, tool: "list_subnets", calls: 250, ok_calls: 250, error_calls: 0, error_rate: 0 },
    { rank: 2, tool: "get_subnet", calls: 150, ok_calls: 150, error_calls: 0, error_rate: 0 },
  ],
};

describe("normalizeUsageAnalytics", () => {
  it("passes a well-formed payload through", () => {
    const u = normalizeUsageAnalytics(WELL_FORMED);
    expect(u.window).toBe("7d");
    expect(u.observed_at).toBe("2026-07-16T00:00:00.000Z");
    expect(u.source).toBe("analytics-engine");
    expect(u.summary.total_calls).toBe(1500);
    expect(u.summary.ok_calls).toBe(1440);
    expect(u.summary.error_calls).toBe(60);
    expect(u.summary.error_rate).toBe(0.04);
    expect(u.summary.route_calls).toBe(1100);
    expect(u.summary.mcp_calls).toBe(400);
    expect(u.routes).toHaveLength(2);
    expect(u.routes[0]).toMatchObject({ rank: 1, route: "GET /api/v1/subnets", calls: 800 });
    expect(u.tools).toHaveLength(2);
    expect(u.tools[1]).toMatchObject({ rank: 2, tool: "get_subnet", calls: 150 });
  });

  it("degrades a cold store to a schema-stable zeroed shape (empty lists)", () => {
    const u = normalizeUsageAnalytics({
      window: null,
      observed_at: null,
      summary: {
        total_calls: 0,
        ok_calls: 0,
        error_calls: 0,
        error_rate: null,
        route_calls: 0,
        mcp_calls: 0,
      },
      routes: [],
      tools: [],
    });
    expect(u.window).toBeNull();
    expect(u.observed_at).toBeNull();
    expect(u.source).toBe("usage");
    expect(u.summary.total_calls).toBe(0);
    expect(u.summary.error_rate).toBeNull();
    expect(u.routes).toEqual([]);
    expect(u.tools).toEqual([]);
  });

  it("degrades junk / missing input to a zeroed shape, never NaN", () => {
    for (const raw of [{}, null, undefined, "nope", 42, { summary: "many" }]) {
      const u = normalizeUsageAnalytics(raw);
      expect(u.summary.total_calls).toBe(0);
      expect(u.summary.ok_calls).toBe(0);
      expect(u.summary.error_calls).toBe(0);
      expect(u.summary.route_calls).toBe(0);
      expect(u.summary.mcp_calls).toBe(0);
      expect(u.summary.error_rate).toBeNull();
      expect(u.routes).toEqual([]);
      expect(u.tools).toEqual([]);
    }
  });

  it("drops nameless/malformed rows and back-fills rank + numeric fields from position", () => {
    const u = normalizeUsageAnalytics({
      routes: [
        { route: "GET /api/v1/blocks" }, // no rank/counts → rank from index, counts 0
        { rank: 9, calls: 5 }, // no route → dropped
        "garbage", // non-object → dropped
        { route: "GET /api/v1/accounts", rank: 4, calls: "lots", error_rate: 0.5 },
      ],
      tools: [
        { tool: "search" }, // rank from index, counts 0
        { calls: 10 }, // no tool → dropped
      ],
    });
    expect(u.routes).toHaveLength(2);
    expect(u.routes[0]).toMatchObject({ rank: 1, route: "GET /api/v1/blocks", calls: 0 });
    // calls: "lots" is non-finite → 0, but explicit rank 4 and error_rate survive.
    expect(u.routes[1]).toMatchObject({
      rank: 4,
      route: "GET /api/v1/accounts",
      calls: 0,
      error_rate: 0.5,
    });
    expect(u.tools).toHaveLength(1);
    expect(u.tools[0]).toMatchObject({ rank: 1, tool: "search", calls: 0 });
  });
});

describe("usageAnalyticsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits /api/v1/usage with the window param and normalizes the response", async () => {
    resolveWith(WELL_FORMED);
    const res = await runQuery(usageAnalyticsQuery("30d"));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/usage",
      expect.objectContaining({
        params: { window: "30d" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(res.data.summary.total_calls).toBe(1500);
    expect(res.data.routes).toHaveLength(2);
    expect(res.data.tools).toHaveLength(2);
  });

  it("defaults the window to 7d", async () => {
    resolveWith(WELL_FORMED);
    await runQuery(usageAnalyticsQuery());
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/usage",
      expect.objectContaining({ params: { window: "7d" } }),
    );
  });

  it("degrades a not-yet-shipped endpoint (404) to a zeroed shape without throwing", async () => {
    mockedApiFetch.mockRejectedValue(
      new ApiError("Not found", { status: 404, url: "/api/v1/usage" }),
    );
    const res = await runQuery(usageAnalyticsQuery("24h"));
    expect(res.data.summary.total_calls).toBe(0);
    expect(res.data.routes).toEqual([]);
    expect(res.data.tools).toEqual([]);
    expect(res.url).toBe("/api/v1/usage");
  });

  it("degrades an offline dev worker (status 0) to a zeroed shape", async () => {
    mockedApiFetch.mockRejectedValue(new ApiError("Network error", { status: 0, url: "x" }));
    const res = await runQuery(usageAnalyticsQuery());
    expect(res.data.summary.total_calls).toBe(0);
  });

  it("re-throws a genuine server error (5xx) so the error boundary can show it", async () => {
    mockedApiFetch.mockRejectedValue(new ApiError("boom", { status: 500, url: "/api/v1/usage" }));
    await expect(runQuery(usageAnalyticsQuery())).rejects.toThrow("boom");
  });
});
