import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountEntitiesQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Valid-format ss58 address (ss58PathSegment rejects malformed input).
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/accounts/${ALICE}/entities`,
  });
}

async function runQuery(ss58: string) {
  const opts = accountEntitiesQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("accountEntitiesQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the entities route and passes through labels + ownership ties", async () => {
    resolveWith({
      ss58: ALICE,
      labels: [
        {
          name: "Foundation",
          category: "foundation",
          notes: "core dev",
          source_urls: ["https://example.com/a", "https://example.com/b"],
        },
      ],
      ownership_tie_count: 2,
      ownership_ties: [
        {
          netuid: 5,
          role: "gained_ownership",
          block_number: 1000,
          observed_at: "2026-07-20T00:00:00.000Z",
        },
        { netuid: 6, role: "lost_ownership", block_number: 900, observed_at: null },
      ],
    });
    const res = await runQuery(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/entities`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data.ss58).toBe(ALICE);
    expect(res.data.labels).toEqual([
      {
        name: "Foundation",
        category: "foundation",
        notes: "core dev",
        source_urls: ["https://example.com/a", "https://example.com/b"],
      },
    ]);
    expect(res.data.ownership_tie_count).toBe(2);
    expect(res.data.ownership_ties).toEqual([
      {
        netuid: 5,
        role: "gained_ownership",
        block_number: 1000,
        observed_at: "2026-07-20T00:00:00.000Z",
      },
      { netuid: 6, role: "lost_ownership", block_number: 900, observed_at: null },
    ]);
  });

  it("nulls missing label/tie fields, drops non-string source URLs and empty ties, and never NaNs", async () => {
    resolveWith({
      ss58: ALICE,
      labels: [{ source_urls: ["https://ok", 42, null] }],
      ownership_ties: [
        { netuid: "junk", role: "gained_ownership", block_number: "junk" },
        {},
      ],
    });
    const res = await runQuery(ALICE);
    expect(res.data.labels).toEqual([
      { name: null, category: null, notes: null, source_urls: ["https://ok"] },
    ]);
    expect(res.data.ownership_ties).toEqual([
      { netuid: null, role: "gained_ownership", block_number: null, observed_at: null },
    ]);
    expect(res.data.ownership_tie_count).toBe(1);
  });

  it("degrades a cold / unknown account to empty labels + ties (never throws)", async () => {
    for (const raw of [{}, null, { labels: "x", ownership_ties: 3 }]) {
      resolveWith(raw);
      const res = await runQuery(ALICE);
      expect(res.data.ss58).toBe(ALICE);
      expect(res.data.labels).toEqual([]);
      expect(res.data.ownership_ties).toEqual([]);
      expect(res.data.ownership_tie_count).toBe(0);
    }
  });
});
