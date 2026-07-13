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
    url: "/api/v1/subnets/7",
  });
}

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

describe("normalizeSubnetEventSummary", () => {
  it("passes a well-formed rollup through, keeping its categories", () => {
    const card = normalizeSubnetEventSummary(7, {
      schema_version: 1,
      netuid: 7,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      total_events: 12,
      kind_count: 4,
      category_count: 2,
      limit: 5,
      categories: [
        { category: "stake", event_count: 8, kind_count: 2, amount_tao: 1.5, alpha_amount: 0.5 },
        { category: "registration", event_count: 4, kind_count: 2 },
      ],
    });
    expect(card.total_events).toBe(12);
    expect(card.category_count).toBe(2);
    expect(card.categories).toHaveLength(2);
    expect(card.categories[0]).toMatchObject({ category: "stake", event_count: 8, amount_tao: 1.5 });
  });

  it("degrades cold / junk to a zeroed rollup with no categories (never NaN)", () => {
    for (const raw of [{}, null, { total_events: "nope", categories: "nope" }]) {
      const card = normalizeSubnetEventSummary(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.total_events).toBe(0);
      expect(card.category_count).toBe(0);
      expect(card.categories).toEqual([]);
    }
  });

  it("drops non-object category entries defensively", () => {
    const card = normalizeSubnetEventSummary(7, {
      categories: [null, "bad", { category: "serving", event_count: 3 }],
    });
    expect(card.categories).toHaveLength(1);
    expect(card.categories[0].category).toBe("serving");
  });
});

describe("subnetEventSummaryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits its route with an explicit window param", async () => {
    resolveWith({ netuid: 7, total_events: 9 });
    const res = await runQuery(subnetEventSummaryQuery(7, "30d"));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/event-summary",
      expect.objectContaining({ params: { window: "30d" } }),
    );
    expect(res.data.total_events).toBe(9);
  });

  it("defaults to the 7d window", async () => {
    resolveWith({});
    await runQuery(subnetEventSummaryQuery(7));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/event-summary",
      expect.objectContaining({ params: { window: "7d" } }),
    );
  });
});
