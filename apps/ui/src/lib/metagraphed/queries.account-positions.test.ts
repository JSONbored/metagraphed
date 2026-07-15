import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountPositionsQuery, normalizeAccountPosition } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Valid-format ss58 addresses (ss58PathSegment rejects malformed input).
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/accounts/x/positions",
  });
}

// The queryFn is defined on the queryOptions returned by the factory.
async function runQuery(ss58: string) {
  const opts = accountPositionsQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeAccountPosition", () => {
  it("coerces a well-formed position", () => {
    expect(
      normalizeAccountPosition({
        hotkey: "5Hotkey",
        netuid: 4,
        share_fraction: 0.25,
        stake_tao: 12.5,
      }),
    ).toEqual({ hotkey: "5Hotkey", netuid: 4, share_fraction: 0.25, stake_tao: 12.5 });
  });

  it("drops a row missing hotkey, netuid, share_fraction, or stake_tao", () => {
    expect(normalizeAccountPosition({ netuid: 4, share_fraction: 0.25, stake_tao: 1 })).toBeNull();
    expect(
      normalizeAccountPosition({ hotkey: "5Hotkey", share_fraction: 0.25, stake_tao: 1 }),
    ).toBeNull();
    expect(normalizeAccountPosition({ hotkey: "5Hotkey", netuid: 4, stake_tao: 1 })).toBeNull();
    expect(
      normalizeAccountPosition({ hotkey: "5Hotkey", netuid: 4, share_fraction: 0.25 }),
    ).toBeNull();
  });

  it("drops a non-object or junk-typed input", () => {
    expect(normalizeAccountPosition(null)).toBeNull();
    expect(normalizeAccountPosition("nope")).toBeNull();
    expect(
      normalizeAccountPosition({
        hotkey: "5Hotkey",
        netuid: "abc",
        share_fraction: 0.25,
        stake_tao: 1,
      }),
    ).toBeNull();
  });
});

describe("accountPositionsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("requests the ss58 positions path and shapes the envelope", async () => {
    resolveWith({
      ss58: "5Server",
      captured_at: "2026-07-05T00:00:00Z",
      position_count: 2,
      total_stake_tao: 100,
      positions: [
        { hotkey: "5HotkeyA", netuid: 4, share_fraction: 0.9, stake_tao: 90 },
        { hotkey: "5HotkeyB", netuid: 0 }, // missing share_fraction/stake_tao -> dropped
      ],
    });

    const result = await runQuery(ALICE);

    expect(mockedApiFetch).toHaveBeenCalledWith(`/api/v1/accounts/${ALICE}/positions`, {
      signal: expect.any(AbortSignal),
    });
    expect(result.data.ss58).toBe("5Server");
    expect(result.data.captured_at).toBe("2026-07-05T00:00:00Z");
    expect(result.data.positions).toHaveLength(1);
    expect(result.data.positions[0]).toEqual({
      hotkey: "5HotkeyA",
      netuid: 4,
      share_fraction: 0.9,
      stake_tao: 90,
    });
  });

  it("falls back to safe defaults when the body is a non-object (cold/absent)", async () => {
    resolveWith(null);

    const result = await runQuery(BOB);

    expect(result.data.ss58).toBe(BOB);
    expect(result.data.captured_at).toBeNull();
    expect(result.data.positions).toEqual([]);
    expect(result.data.position_count).toBe(0);
    expect(result.data.total_stake_tao).toBe(0);
  });

  it("caps the position list defensively", async () => {
    resolveWith({
      positions: Array.from({ length: 300 }, (_, i) => ({
        hotkey: `5Hotkey${i}`,
        netuid: i,
        share_fraction: 0.1,
        stake_tao: 1,
      })),
    });

    const result = await runQuery(CHARLIE);

    expect(result.data.positions).toHaveLength(256);
    expect(result.data.position_count).toBe(256);
  });
});
