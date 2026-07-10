import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { reviewGapPrioritiesQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/review/gaps",
  });
}

// fetchList calls apiFetch and lifts the named collection; invoke the queryFn directly.
function runQuery() {
  const opts = reviewGapPrioritiesQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("reviewGapPrioritiesQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("reads the `priorities` collection from /api/v1/review/gaps and normalizes a row", async () => {
    resolveWith({
      priorities: [
        {
          netuid: 64,
          name: "Chutes",
          curation_level: "maintainer-reviewed",
          priority_score: 190.6,
          missing_kinds: ["openapi", "sdk"],
          surface_count: 38,
          candidate_count: 4,
          verified_candidate_count: 2,
        },
      ],
    });
    const res = await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/review/gaps",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data[0]).toEqual({
      id: "64",
      netuid: 64,
      name: "Chutes",
      curationLevel: "maintainer-reviewed",
      missingKinds: ["openapi", "sdk"],
      surfaceCount: 38,
      candidateCount: 4,
      verifiedCandidateCount: 2,
      priority: "191", // rounded from 190.6
    });
  });

  it("defaults array/number fields and rounds priority; missing values stay undefined", async () => {
    resolveWith({ priorities: [{ netuid: 3, missing_kinds: "nope" }] });
    const res = await runQuery();
    expect(res.data[0]).toMatchObject({
      netuid: 3,
      missingKinds: [], // non-array coerced to []
      surfaceCount: undefined,
      priority: undefined,
    });
  });

  it("returns an empty list when the artifact has no priorities", async () => {
    resolveWith({});
    const res = await runQuery();
    expect(res.data).toEqual([]);
  });
});
