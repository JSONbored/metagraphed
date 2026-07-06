import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainEventMixQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/event-mix",
  });
}

async function runQuery(window?: "7d" | "30d") {
  const opts = chainEventMixQuery(window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("chainEventMixQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes a well-formed card", async () => {
    resolveWith({
      window: "7d",
      observed_at: "2026-07-01T00:00:00.000Z",
      total_events: 100,
      distinct_kinds: 2,
      dominant_kind: "WeightsSet",
      kinds: [
        {
          event_kind: "WeightsSet",
          count: 60,
          share: 0.6,
          first_observed_at: "2026-06-25T00:00:00.000Z",
          last_observed_at: "2026-07-01T00:00:00.000Z",
        },
        { event_kind: "StakeAdded", count: 40, share: 0.4 },
      ],
    });
    const res = await runQuery("7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/event-mix",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.total_events).toBe(100);
    expect(res.data.distinct_kinds).toBe(2);
    expect(res.data.dominant_kind).toBe("WeightsSet");
    expect(res.data.kinds).toEqual([
      {
        event_kind: "WeightsSet",
        count: 60,
        share: 0.6,
        first_observed_at: "2026-06-25T00:00:00.000Z",
        last_observed_at: "2026-07-01T00:00:00.000Z",
      },
      // absent timestamp cells normalize to null
      {
        event_kind: "StakeAdded",
        count: 40,
        share: 0.4,
        first_observed_at: null,
        last_observed_at: null,
      },
    ]);
  });

  it("defaults to the 7d window", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/event-mix",
      expect.objectContaining({ params: { window: "7d" } }),
    );
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", async () => {
    for (const raw of [{}, null, "x", { total_events: "nope" }]) {
      resolveWith(raw);
      const res = await runQuery("7d");
      expect(res.data.total_events).toBe(0);
      expect(res.data.distinct_kinds).toBe(0);
      expect(res.data.dominant_kind).toBeNull();
      expect(res.data.kinds).toEqual([]);
      expect(res.data.observed_at).toBeNull();
    }
  });

  it("drops malformed kind rows and coerces a junk share to null", async () => {
    resolveWith({
      total_events: 10,
      kinds: [
        { count: 5 }, // no event_kind
        { event_kind: "Transfer" }, // no count
        { event_kind: "WeightsSet", count: 5, share: { pct: 1 } },
      ],
    });
    const res = await runQuery("7d");
    expect(res.data.kinds).toHaveLength(1);
    expect(res.data.kinds[0]?.event_kind).toBe("WeightsSet");
    expect(res.data.kinds[0]?.share).toBeNull();
    // distinct_kinds falls back to the surviving row count when absent.
    expect(res.data.distinct_kinds).toBe(1);
  });
});
