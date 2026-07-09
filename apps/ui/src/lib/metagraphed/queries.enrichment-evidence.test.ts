import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { reviewEnrichmentEvidenceQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/review/enrichment-evidence",
  });
}

// Invoke a queryOptions' queryFn directly (mirrors the sibling query tests).
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

describe("reviewEnrichmentEvidenceQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits /api/v1/review/enrichment-evidence and reads the `entries` collection", async () => {
    resolveWith({
      entries: [
        {
          netuid: 12,
          name: "Foo",
          slug: "foo",
          lane: "candidate",
          evidence_action: "verify-openapi",
          missing_kinds: ["openapi", "sdk"],
          direct_submission_kinds: ["docs"],
          priority_score: 87.4,
          extra_ignored_field: "x",
        },
      ],
    });
    const res = await runQuery(reviewEnrichmentEvidenceQuery());
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/review/enrichment-evidence",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data).toEqual([
      {
        netuid: 12,
        name: "Foo",
        slug: "foo",
        lane: "candidate",
        evidence_action: "verify-openapi",
        missing_kinds: ["openapi", "sdk"],
        direct_submission_kinds: ["docs"],
        priority_score: 87.4,
      },
    ]);
  });

  it("defaults kind arrays to [] and score to undefined for sparse rows (never NaN/undefined leaks)", async () => {
    resolveWith({ entries: [{ netuid: 3 }] });
    const res = await runQuery(reviewEnrichmentEvidenceQuery());
    expect(res.data[0]).toMatchObject({
      netuid: 3,
      missing_kinds: [],
      direct_submission_kinds: [],
      priority_score: undefined,
    });
  });

  it("coerces non-array kind fields to [] rather than passing them through", async () => {
    resolveWith({ entries: [{ netuid: 5, missing_kinds: "openapi", direct_submission_kinds: null }] });
    const res = await runQuery(reviewEnrichmentEvidenceQuery());
    expect(res.data[0].missing_kinds).toEqual([]);
    expect(res.data[0].direct_submission_kinds).toEqual([]);
  });

  it("returns an empty list when the artifact has no entries", async () => {
    resolveWith({});
    const res = await runQuery(reviewEnrichmentEvidenceQuery());
    expect(res.data).toEqual([]);
  });
});
