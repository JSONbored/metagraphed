import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainIdentityHistoryQuery, normalizeChainIdentityChange } from "./queries";

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

async function runQuery(limit = 10) {
  const opts = chainIdentityHistoryQuery(limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainIdentityChange", () => {
  it("requires identity_hash and a valid netuid", () => {
    expect(
      normalizeChainIdentityChange({
        identity_hash: "0xabc",
        netuid: 7,
        subnet_name: "Alpha",
      }),
    ).toMatchObject({ identity_hash: "0xabc", netuid: 7, subnet_name: "Alpha" });
    expect(normalizeChainIdentityChange({ identity_hash: "0xabc" })).toBeNull();
    expect(normalizeChainIdentityChange({ identity_hash: "0xabc", netuid: -1 })).toBeNull();
  });
});

describe("chainIdentityHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("calls the network-wide route and normalizes changes", async () => {
    resolveWith({
      schema_version: 1,
      count: 1,
      subnet_count: 1,
      changes: [
        {
          identity_hash: "0xabc",
          netuid: 7,
          observed_at: "2026-07-01T00:00:00Z",
          subnet_name: "Alpha",
          symbol: "α",
          description: "updated copy",
        },
        { netuid: 8 },
      ],
    });

    const out = await runQuery(10);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/identity-history", {
      params: { limit: 10 },
      signal: expect.any(AbortSignal),
    });
    expect(out.data.changes).toHaveLength(1);
    expect(out.data.changes[0]).toMatchObject({
      netuid: 7,
      subnet_name: "Alpha",
      description: "updated copy",
    });
  });

  it("clamps the request limit to the API maximum", async () => {
    resolveWith({ schema_version: 1, count: 0, subnet_count: 0, changes: [] });

    await runQuery(9999);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/identity-history", {
      params: { limit: 200 },
      signal: expect.any(AbortSignal),
    });
  });
});
