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

async function runQuery() {
  const opts = blocksSummaryQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeBlocksSummary", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeBlocksSummary({
        schema_version: 1,
        block_count: 5,
        first_block: 100,
        last_block: 110,
        first_observed_at: "2026-07-01T00:00:00Z",
        last_observed_at: "2026-07-01T00:02:00Z",
        distinct_authors: 2,
        distinct_spec_versions: 2,
        latest_spec_version: 201,
        block_time: {
          count: 3,
          mean_ms: 12000,
          min_ms: 12000,
          max_ms: 12000,
          p50_ms: 12000,
          p90_ms: 12000,
        },
        throughput: {
          total_extrinsics: 11,
          total_events: 42,
          mean_extrinsics_per_block: 2.2,
          mean_events_per_block: 8.4,
          max_extrinsics_in_block: 5,
        },
        author_concentration: {
          holders: 2,
          total: 4,
          nakamoto_coefficient: 1,
        },
      }),
    ).toEqual({
      schema_version: 1,
      block_count: 5,
      first_block: 100,
      last_block: 110,
      first_observed_at: "2026-07-01T00:00:00Z",
      last_observed_at: "2026-07-01T00:02:00Z",
      distinct_authors: 2,
      distinct_spec_versions: 2,
      latest_spec_version: 201,
      block_time: {
        count: 3,
        mean_ms: 12000,
        min_ms: 12000,
        max_ms: 12000,
        p50_ms: 12000,
        p90_ms: 12000,
      },
      throughput: {
        total_extrinsics: 11,
        total_events: 42,
        mean_extrinsics_per_block: 2.2,
        mean_events_per_block: 8.4,
        max_extrinsics_in_block: 5,
      },
      author_concentration: {
        holders: 2,
        total: 4,
        nakamoto_coefficient: 1,
      },
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { block_count: "nope" }]) {
      const card = normalizeBlocksSummary(raw);
      expect(card.block_count).toBe(0);
      expect(card.block_time).toBeNull();
      expect(card.throughput).toBeNull();
      expect(card.author_concentration).toBeNull();
    }
  });

  it("nulls block_time when count is below two and drops junk concentration", () => {
    const card = normalizeBlocksSummary({
      block_time: { count: 1, mean_ms: 1000 },
      author_concentration: { holders: 0 },
    });
    expect(card.block_time).toBeNull();
    expect(card.author_concentration).toBeNull();
  });
});

describe("blocksSummaryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches /api/v1/blocks/summary and normalizes the card", async () => {
    resolveWith({ block_count: 3, distinct_authors: 2 });
    const res = await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/blocks/summary", expect.any(Object));
    expect(res.data.block_count).toBe(3);
    expect(res.data.distinct_authors).toBe(2);
  });
});
