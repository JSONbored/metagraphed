import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { blocksSummaryQuery, normalizeBlocksSummary } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/blocks/summary",
  });
}

// Invoke a queryOptions' queryFn directly (the factory returns a fully-typed
// options object; each call site keeps its own precise data type).
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

describe("normalizeBlocksSummary", () => {
  it("passes a well-formed card through", () => {
    const raw = {
      schema_version: 1,
      block_count: 4200,
      first_block: 1000,
      last_block: 5199,
      first_observed_at: "2026-07-01T00:00:00.000Z",
      last_observed_at: "2026-07-01T14:00:00.000Z",
      block_time: {
        count: 4100,
        mean_ms: 12010,
        min_ms: 11800,
        max_ms: 24300,
        p50_ms: 12000,
        p90_ms: 12400,
      },
      throughput: {
        total_extrinsics: 84000,
        total_events: 210000,
        mean_extrinsics_per_block: 20,
        mean_events_per_block: 50,
        max_extrinsics_in_block: 312,
      },
      distinct_authors: 128,
      author_concentration: {
        holders: 128,
        total: 4200,
        gini: 0.42,
        hhi: 0.03,
        hhi_normalized: 0.02,
        nakamoto_coefficient: 44,
        top_1pct_share: 0.05,
        top_5pct_share: 0.18,
        top_10pct_share: 0.31,
        top_20pct_share: 0.5,
        entropy: 6.7,
        entropy_normalized: 0.96,
      },
      distinct_spec_versions: 2,
      latest_spec_version: 224,
    };
    const card = normalizeBlocksSummary(raw);
    expect(card.block_count).toBe(4200);
    expect(card.first_block).toBe(1000);
    expect(card.last_block).toBe(5199);
    expect(card.block_time?.mean_ms).toBe(12010);
    expect(card.block_time?.p90_ms).toBe(12400);
    expect(card.throughput?.mean_extrinsics_per_block).toBe(20);
    expect(card.throughput?.mean_events_per_block).toBe(50);
    expect(card.distinct_authors).toBe(128);
    expect(card.author_concentration?.nakamoto_coefficient).toBe(44);
    expect(card.author_concentration?.gini).toBe(0.42);
    expect(card.latest_spec_version).toBe(224);
  });

  it("degrades a cold store to a schema-stable zeroed card (nested objects null)", () => {
    const raw = {
      schema_version: 1,
      block_count: 0,
      first_block: null,
      last_block: null,
      first_observed_at: null,
      last_observed_at: null,
      block_time: null,
      throughput: null,
      distinct_authors: 0,
      author_concentration: null,
      distinct_spec_versions: 0,
      latest_spec_version: null,
    };
    const card = normalizeBlocksSummary(raw);
    expect(card.block_count).toBe(0);
    expect(card.first_block).toBeNull();
    expect(card.block_time).toBeNull();
    expect(card.throughput).toBeNull();
    expect(card.author_concentration).toBeNull();
    expect(card.latest_spec_version).toBeNull();
  });

  it("degrades junk / missing input to a zeroed card, never NaN", () => {
    for (const raw of [{}, null, undefined, "nope", { block_count: "many" }]) {
      const card = normalizeBlocksSummary(raw);
      expect(card.block_count).toBe(0);
      expect(card.distinct_authors).toBe(0);
      expect(card.distinct_spec_versions).toBe(0);
      expect(card.block_time).toBeNull();
      expect(card.throughput).toBeNull();
      expect(card.author_concentration).toBeNull();
      expect(card.first_block).toBeNull();
      expect(card.latest_spec_version).toBeNull();
    }
  });

  it("collapses an all-null block_time / throughput to null (never a partial NaN card)", () => {
    const card = normalizeBlocksSummary({
      block_count: 1,
      block_time: {},
      throughput: {},
      author_concentration: { holders: 0 },
    });
    expect(card.block_time).toBeNull();
    expect(card.throughput).toBeNull();
    expect(card.author_concentration).toBeNull();
  });
});

describe("blocksSummaryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits /api/v1/blocks/summary and normalizes the response", async () => {
    resolveWith({ block_count: 12, distinct_authors: 4, latest_spec_version: 224 });
    const res = await runQuery(blocksSummaryQuery());
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/blocks/summary",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.data.block_count).toBe(12);
    expect(res.data.distinct_authors).toBe(4);
    expect(res.data.latest_spec_version).toBe(224);
  });

  it("degrades a cold response to a zeroed card without throwing", async () => {
    resolveWith(null);
    const res = await runQuery(blocksSummaryQuery());
    expect(res.data.block_count).toBe(0);
    expect(res.data.block_time).toBeNull();
    expect(res.data.author_concentration).toBeNull();
  });
});
