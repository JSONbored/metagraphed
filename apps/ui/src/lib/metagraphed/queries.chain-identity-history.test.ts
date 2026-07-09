import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainIdentityHistoryQuery, normalizeChainIdentityHistory } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/identity-history",
  });
}

async function runQuery(limit?: number) {
  const opts = chainIdentityHistoryQuery(limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainIdentityHistory", () => {
  it("passes a well-formed feed through", () => {
    const card = normalizeChainIdentityHistory({
      schema_version: 1,
      count: 2,
      subnet_count: 2,
      changes: [
        {
          netuid: 7,
          identity_hash: "0xabc",
          block_number: 100,
          observed_at: "2026-07-01T00:00:00Z",
          subnet_name: "Allways",
          symbol: "ALL",
          description: "desc",
          github_repo: "https://github.com/x",
          subnet_url: "https://all-ways.io",
          logo_url: null,
          discord: null,
        },
        { netuid: 74, identity_hash: "0xdef" },
      ],
    });
    expect(card.count).toBe(2);
    expect(card.changes).toHaveLength(2);
    expect(card.changes[0]?.netuid).toBe(7);
    expect(card.changes[0]?.subnet_name).toBe("Allways");
    // missing string fields coerce to null, not undefined
    expect(card.changes[1]?.subnet_name).toBeNull();
    expect(card.changes[1]?.block_number).toBeNull();
  });

  it("degrades a cold / junk store to a schema-stable empty feed", () => {
    for (const raw of [{}, null, "x", { count: "nope" }]) {
      const card = normalizeChainIdentityHistory(raw);
      expect(card.count).toBe(0);
      expect(card.changes).toEqual([]);
    }
  });

  it("drops change rows that have no netuid", () => {
    const card = normalizeChainIdentityHistory({
      changes: [{ identity_hash: "0x1" }, { netuid: 3, identity_hash: "0x2" }],
    });
    expect(card.changes).toHaveLength(1);
    expect(card.changes[0]?.netuid).toBe(3);
  });
});

describe("chainIdentityHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the limit param and normalizes the feed", async () => {
    resolveWith({ count: 1, changes: [{ netuid: 5, identity_hash: "0x5" }] });
    const res = await runQuery(25);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/identity-history",
      expect.objectContaining({ params: { limit: 25 } }),
    );
    expect(res.data.changes).toHaveLength(1);
  });

  it("defaults to limit 10", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/identity-history",
      expect.objectContaining({ params: { limit: 10 } }),
    );
  });
});
