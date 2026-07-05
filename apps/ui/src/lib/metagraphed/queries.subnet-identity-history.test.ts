import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetIdentityHistoryEntry, subnetIdentityHistoryQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/identity-history",
  });
}

// The queryFn is defined on the queryOptions returned by the factory.
async function runQuery(netuid: number) {
  const opts = subnetIdentityHistoryQuery(netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetIdentityHistoryEntry", () => {
  it("passes a well-formed entry through unchanged", () => {
    const raw = {
      identity_hash: "0xabc",
      block_number: 123,
      observed_at: "2026-07-01T00:00:00Z",
      subnet_name: "Alpha",
      symbol: "α",
      description: "d",
      github_repo: "https://github.com/x/y",
      subnet_url: "https://x.io",
      logo_url: "https://x.io/logo.png",
      discord: "https://discord.gg/x",
    };
    expect(normalizeSubnetIdentityHistoryEntry(raw)).toEqual(raw);
  });

  it("discards a row with no identity_hash (the keyset anchor)", () => {
    expect(normalizeSubnetIdentityHistoryEntry({ block_number: 1 })).toBeNull();
    expect(normalizeSubnetIdentityHistoryEntry(null)).toBeNull();
    expect(normalizeSubnetIdentityHistoryEntry("x")).toBeNull();
  });

  it("coerces junk cells to null (never NaN or [object Object])", () => {
    const entry = normalizeSubnetIdentityHistoryEntry({
      identity_hash: "0xabc",
      block_number: "not-a-number",
      observed_at: { x: 1 },
      subnet_name: 42,
      description: ["nope"],
    });
    expect(entry).not.toBeNull();
    expect(entry?.block_number).toBeNull();
    expect(entry?.observed_at).toBeNull();
    expect(entry?.subnet_name).toBeNull();
    expect(entry?.description).toBeNull();
  });
});

describe("subnetIdentityHistoryQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("normalizes the envelope and filters junk entries", async () => {
    resolveWith({
      schema_version: 1,
      netuid: 7,
      entry_count: 2,
      entries: [
        { identity_hash: "0x1", subnet_name: "A" },
        { block_number: 5 }, // no identity_hash -> dropped
      ],
      next_cursor: null,
    });
    const res = await runQuery(7);
    expect(res.data.netuid).toBe(7);
    expect(res.data.entries).toHaveLength(1);
    expect(res.data.entries[0]?.identity_hash).toBe("0x1");
  });

  it("degrades a cold / empty store to a schema-stable zeroed envelope", async () => {
    resolveWith({});
    const res = await runQuery(7);
    expect(res.data.entries).toEqual([]);
    expect(res.data.entry_count).toBe(0);
    expect(res.data.netuid).toBe(7);
    expect(res.data.next_cursor).toBeNull();
  });
});
