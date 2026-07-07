import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetEventSummary, subnetEventSummaryQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/64/event-summary",
  });
}

async function runQuery(netuid = 64, window?: string) {
  const opts =
    window == null ? subnetEventSummaryQuery(netuid) : subnetEventSummaryQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetEventSummary", () => {
  it("passes a well-formed rollup through", () => {
    expect(
      normalizeSubnetEventSummary(64, {
        schema_version: 1,
        netuid: 64,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        total_events: 1234,
        kind_count: 6,
        category_count: 2,
        categories: [
          {
            category: "stake",
            event_count: 800,
            kind_count: 3,
            amount_tao: 42,
            alpha_amount: 0,
            first_block: 100,
            last_block: 200,
            first_observed_at: "2026-06-30T00:00:00Z",
            last_observed_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 64,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      total_events: 1234,
      kind_count: 6,
      category_count: 2,
      categories: [
        {
          category: "stake",
          event_count: 800,
          kind_count: 3,
          amount_tao: 42,
          alpha_amount: 0,
          first_block: 100,
          last_block: 200,
          first_observed_at: "2026-06-30T00:00:00Z",
          last_observed_at: "2026-07-01T00:00:00Z",
        },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card, never NaN", () => {
    for (const raw of [{}, null, "x", { total_events: "nope", categories: "nope" }]) {
      const card = normalizeSubnetEventSummary(64, raw);
      expect(card.total_events).toBe(0);
      expect(card.category_count).toBe(0);
      expect(card.categories).toEqual([]);
      expect(card.window).toBe("7d");
      expect(card.netuid).toBe(64);
    }
  });

  it("drops malformed category rows (missing category or count) and coerces junk numbers", () => {
    const card = normalizeSubnetEventSummary(64, {
      categories: [
        { event_count: 5 }, // no category -> dropped
        { category: "stake", event_count: "nope" }, // junk count -> dropped
        { category: "serving", event_count: 10, amount_tao: "junk" }, // kept, amount coerces to 0
      ],
    });
    expect(card.categories).toHaveLength(1);
    expect(card.categories[0]?.category).toBe("serving");
    expect(card.categories[0]?.event_count).toBe(10);
    expect(card.categories[0]?.amount_tao).toBe(0);
  });

  it("falls back category_count to the normalized category length when absent", () => {
    const card = normalizeSubnetEventSummary(64, {
      categories: [
        { category: "stake", event_count: 1 },
        { category: "serving", event_count: 2 },
      ],
    });
    expect(card.category_count).toBe(2);
  });
});

describe("subnetEventSummaryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the subnet event-summary route with the window param and normalizes", async () => {
    resolveWith({ total_events: 42, categories: [{ category: "stake", event_count: 42 }] });
    const res = await runQuery(64, "30d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/64/event-summary",
      expect.objectContaining({ params: { window: "30d" } }),
    );
    expect(res.data.total_events).toBe(42);
    expect(res.data.categories).toHaveLength(1);
  });

  it("defaults to the 7d window", async () => {
    resolveWith({});
    await runQuery(64);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/64/event-summary",
      expect.objectContaining({ params: { window: "7d" } }),
    );
  });
});
