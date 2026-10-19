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
  it("retains identity without trusting unqualified numeric stake or share fields", () => {
    expect(
      normalizeAccountPosition({
        hotkey: "5Hotkey",
        netuid: 4,
        share_fraction: 0.25,
        stake_tao: 12.5,
      }),
    ).toEqual({ hotkey: "5Hotkey", netuid: 4, share_fraction: null, stake_tao: null });
  });

  it("requires position identity but retains unknown stake and share cells", () => {
    expect(normalizeAccountPosition({ netuid: 4, share_fraction: 0.25, stake_tao: 1 })).toBeNull();
    expect(
      normalizeAccountPosition({ hotkey: "5Hotkey", share_fraction: 0.25, stake_tao: 1 }),
    ).toBeNull();
    expect(normalizeAccountPosition({ hotkey: "5Hotkey", netuid: 4, stake_tao: 1 })).toEqual({
      hotkey: "5Hotkey",
      netuid: 4,
      stake_tao: null,
      share_fraction: null,
    });
    expect(
      normalizeAccountPosition({ hotkey: "5Hotkey", netuid: 4, share_fraction: 0.25 }),
    ).toEqual({ hotkey: "5Hotkey", netuid: 4, share_fraction: null, stake_tao: null });
  });

  it("declines all legacy quantity/share cells, including finite positive values and zero", () => {
    expect(
      normalizeAccountPosition({ hotkey: "5Hotkey", netuid: 4, share_fraction: 0, stake_tao: 0 }),
    ).toMatchObject({ share_fraction: null, stake_tao: null });
    for (const value of [0.25, 12.5, -1, NaN, Infinity, "", "junk", null]) {
      expect(
        normalizeAccountPosition({
          hotkey: "5Hotkey",
          netuid: 4,
          share_fraction: value,
          stake_tao: value,
        }),
      ).toMatchObject({ share_fraction: null, stake_tao: null });
    }
    expect(
      normalizeAccountPosition({ hotkey: "5Hotkey", netuid: 4, share_fraction: 1.1, stake_tao: 1 }),
    ).toMatchObject({ share_fraction: null, stake_tao: null });
    for (const netuid of [-1, 1.5, Infinity]) {
      expect(
        normalizeAccountPosition({ hotkey: "5Hotkey", netuid, share_fraction: 0, stake_tao: 1 }),
      ).toBeNull();
    }
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
      total_stake_alpha: 100,
      positions: [
        { hotkey: "5HotkeyA", netuid: 4, share_fraction: 0.9, stake_tao: 90 },
        { hotkey: "5HotkeyB", netuid: 2 }, // known identity, unknown cells
      ],
    });

    const result = await runQuery(ALICE);

    expect(mockedApiFetch).toHaveBeenCalledWith(`/api/v1/accounts/${ALICE}/positions`, {
      signal: expect.any(AbortSignal),
    });
    expect(result.data.ss58).toBe("5Server");
    expect(result.data.captured_at).toBe("2026-07-05T00:00:00Z");
    expect(result.data.positions).toHaveLength(2);
    expect(result.data.positions[0]).toEqual({
      hotkey: "5HotkeyA",
      netuid: 4,
      share_fraction: null,
      stake_tao: null,
    });
    expect(result.data.positions[1]).toEqual({
      hotkey: "5HotkeyB",
      netuid: 2,
      stake_tao: null,
      share_fraction: null,
    });
    expect(result.data.degraded).toBeUndefined();
    expect(result.data.total_stake_alpha).toBeNull();
  });

  it("keeps an absent response unknown instead of fabricating an empty relationship list", async () => {
    resolveWith(null);

    const result = await runQuery(BOB);

    expect(result.data.ss58).toBe(BOB);
    expect(result.data.captured_at).toBeNull();
    expect(result.data.positions).toEqual([]);
    expect(result.data.position_count).toBeNull();
    expect(result.data.total_stake_alpha).toBeNull();
    expect(result.data.degraded?.reason).toBe("positions_response_incomplete");
  });

  it("preserves source degradation and its independent snapshot/event clocks", async () => {
    const degraded = {
      reason: "snapshot_predates_stake_activity",
      snapshot_captured_at: "2026-07-01T00:00:00Z",
      latest_stake_event_at: "2026-07-05T00:00:00Z",
    };
    resolveWith({
      captured_at: null,
      position_count: 0,
      total_stake_alpha: 0,
      positions: [],
      degraded,
    });
    const result = await runQuery(BOB);
    expect(result.data.degraded).toEqual(degraded);
    expect(result.data.position_count).toBe(0);
  });

  it("preserves an explicit empty relationship list without asserting a token balance", async () => {
    resolveWith({ position_count: 0, total_stake_alpha: 0, positions: [] });
    const result = await runQuery(BOB);
    expect(result.data.position_count).toBe(0);
    expect(result.data.total_stake_alpha).toBeNull();
    expect(result.data.degraded).toBeUndefined();
  });

  it("does not replace an invalid count or aggregate with zero", async () => {
    resolveWith({ position_count: -1, total_stake_alpha: -1, positions: [] });
    const result = await runQuery(BOB);
    expect(result.data.position_count).toBeNull();
    expect(result.data.total_stake_alpha).toBeNull();
    expect(result.data.degraded?.reason).toBe("positions_response_incomplete");
  });

  it("marks dropped identity rows and inconsistent counts as incomplete", async () => {
    for (const data of [
      { position_count: 1, positions: [{ hotkey: "5Hotkey", netuid: -1 }] },
      {
        position_count: 2,
        positions: [{ hotkey: "5Hotkey", netuid: 4, stake_tao: 1, share_fraction: 0.1 }],
      },
    ]) {
      resolveWith(data);
      expect((await runQuery(BOB)).data.degraded?.reason).toBe("positions_response_incomplete");
    }
  });

  it("caps the position list defensively", async () => {
    resolveWith({
      position_count: 300,
      positions: Array.from({ length: 300 }, (_, i) => ({
        hotkey: `5Hotkey${i}`,
        netuid: i,
        share_fraction: 0.1,
        stake_tao: 1,
      })),
    });

    const result = await runQuery(CHARLIE);

    expect(result.data.positions).toHaveLength(256);
    expect(result.data.position_count).toBe(300);
    expect(result.data.degraded?.reason).toBe("positions_response_incomplete");
  });
});
