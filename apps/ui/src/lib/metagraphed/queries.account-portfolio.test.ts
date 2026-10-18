import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  accountPortfolioQuery,
  normalizePortfolioConcentration,
  normalizePortfolioPosition,
} from "./queries";

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
    url: "/api/v1/accounts/x/portfolio",
  });
}

// The queryFn is defined on the queryOptions returned by the factory.
async function runQuery(ss58: string) {
  const opts = accountPortfolioQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizePortfolioPosition", () => {
  it("preserves membership, emission and scores while declining legacy capital and yield", () => {
    expect(
      normalizePortfolioPosition({
        netuid: 7,
        uid: 42,
        role: "validator",
        active: true,
        stake_alpha: 1250.5,
        emission_alpha: 3.2,
        rank: 0.9,
        trust: 0.8,
        incentive: 0.5,
        dividends: 0.4,
        yield: 0.00256,
      }),
    ).toEqual({
      netuid: 7,
      uid: 42,
      role: "validator",
      active: true,
      stake_alpha: null,
      emission_alpha: 3.2,
      rank: 0.9,
      trust: 0.8,
      incentive: 0.5,
      dividends: 0.4,
      yield: null,
    });
  });

  it("nulls object/string economic cells and rejects an unknown role", () => {
    // Numeric-looking strings are not finite numbers to the strict coercer — they
    // drop to null rather than render as `[object Object]` or NaN.
    expect(
      normalizePortfolioPosition({
        netuid: 3,
        uid: { attacker: true },
        role: "overlord",
        stake_alpha: { attacker: true },
        emission_alpha: "1.5",
        yield: null,
      }),
    ).toEqual({
      netuid: 3,
      uid: null,
      role: null,
      active: undefined,
      stake_alpha: null,
      emission_alpha: null,
      rank: null,
      trust: null,
      incentive: null,
      dividends: null,
      yield: null,
    });
  });

  it("declines zero-valued capital too and drops unqualified extra aliases", () => {
    const position = normalizePortfolioPosition({
      netuid: 0,
      uid: 1,
      role: "miner",
      active: false,
      stake_alpha: 0,
      emission_alpha: 0,
      yield: 0,
      stake_tao: 100,
      total_stake_tao: 100,
    });
    expect(position?.role).toBe("miner");
    expect(position?.active).toBe(false);
    expect(position?.stake_alpha).toBeNull();
    expect(position?.emission_alpha).toBe(0);
    expect(position?.yield).toBeNull();
    expect(position).not.toHaveProperty("stake_tao");
    expect(position).not.toHaveProperty("total_stake_tao");
  });

  it("drops a row with no numeric netuid or a non-object input", () => {
    expect(normalizePortfolioPosition({ netuid: "abc", uid: 1 })).toBeNull();
    expect(normalizePortfolioPosition(null)).toBeNull();
    expect(normalizePortfolioPosition("nope")).toBeNull();
  });
});

describe("normalizePortfolioConcentration", () => {
  it("declines finite legacy lenses and any unqualified extra financial fields", () => {
    expect(
      normalizePortfolioConcentration({
        holders: 5,
        gini: 0.5,
        hhi_normalized: 0.31,
        nakamoto_coefficient: 2,
        total: 1000,
      }),
    ).toBeNull();
  });

  it("keeps unavailable distributions null", () => {
    expect(normalizePortfolioConcentration(null)).toBeNull();
    expect(normalizePortfolioConcentration(undefined)).toBeNull();
    expect(normalizePortfolioConcentration(42)).toBeNull();
  });

  it("returns null for an empty, all-null, or zero-holder distribution", () => {
    expect(normalizePortfolioConcentration({})).toBeNull();
    expect(
      normalizePortfolioConcentration({
        holders: null,
        gini: null,
        hhi_normalized: null,
        nakamoto_coefficient: null,
      }),
    ).toBeNull();
    expect(
      normalizePortfolioConcentration({
        holders: 0,
        gini: 0,
        hhi_normalized: 0,
        nakamoto_coefficient: 3,
      }),
    ).toBeNull();
  });
});

describe("accountPortfolioQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it.each([0, 100])("declines legacy capital %s", async (capital) => {
    resolveWith({
      ss58: "5Server",
      captured_at: "2026-07-05T00:00:00Z",
      subnet_count: 2,
      position_count: 2,
      validator_count: 1,
      miner_count: 1,
      total_stake_tao: capital,
      total_emission_tao: 4,
      overall_yield: 0.04,
      stake_concentration: { holders: 2, gini: 0.5, hhi_normalized: 0.6, nakamoto_coefficient: 1 },
      positions: [
        { netuid: 1, uid: 10, role: "validator", stake_alpha: 90, emission_alpha: 3, yield: 0.033 },
        { role: "miner", uid: 5 }, // no numeric netuid → dropped
      ],
    });

    const result = await runQuery(ALICE);

    expect(mockedApiFetch).toHaveBeenCalledWith(`/api/v1/accounts/${ALICE}/portfolio`, {
      signal: expect.any(AbortSignal),
    });
    expect(result.data.ss58).toBe("5Server");
    expect(result.data.captured_at).toBe("2026-07-05T00:00:00Z");
    expect(result.data.positions).toHaveLength(1);
    expect(result.data.positions[0]).toMatchObject({
      netuid: 1,
      role: "validator",
      stake_alpha: null,
      emission_alpha: 3,
      yield: null,
    });
    expect(result.data.subnet_count).toBe(2);
    expect(result.data.position_count).toBe(2);
    expect(result.data.validator_count).toBe(1);
    expect(result.data.miner_count).toBe(1);
    expect(result.data.total_stake_tao).toBeNull();
    expect(result.data.total_emission_tao).toBe(4);
    expect(result.data.overall_yield).toBeNull();
    expect(result.data.stake_concentration).toBeNull();
  });

  it("keeps absent counts and capital unknown for a non-object body", async () => {
    resolveWith(null);

    const result = await runQuery(BOB);

    expect(result.data.ss58).toBe(BOB);
    expect(result.data.positions).toEqual([]);
    expect(result.data.subnet_count).toBeNull();
    expect(result.data.position_count).toBeNull();
    expect(result.data.validator_count).toBeNull();
    expect(result.data.miner_count).toBeNull();
    expect(result.data.total_stake_tao).toBeNull();
    expect(result.data.overall_yield).toBeNull();
    expect(result.data.stake_concentration).toBeNull();
  });

  it("caps neutral-ordered rows without replacing the source's full counts", async () => {
    resolveWith({
      subnet_count: 300,
      position_count: 300,
      validator_count: 0,
      miner_count: 300,
      positions: Array.from({ length: 300 }, (_, i) => ({
        netuid: 300 - i,
        uid: i,
        role: "miner",
        stake_alpha: 1,
        emission_alpha: 0,
        yield: 0,
      })),
    });

    const result = await runQuery(CHARLIE);

    expect(result.data.positions).toHaveLength(256);
    expect(result.data.positions[0]?.netuid).toBe(1);
    expect(result.data.positions[255]?.netuid).toBe(256);
    expect(result.data.subnet_count).toBe(300);
    expect(result.data.position_count).toBe(300);
    expect(result.data.validator_count).toBe(0);
    expect(result.data.miner_count).toBe(300);
  });

  it("uses netuid/uid order and never infers full counts from available rows", async () => {
    resolveWith({
      positions: [
        { netuid: 7, uid: 9, stake_alpha: 999 },
        { netuid: 2, uid: 4, stake_alpha: 50 },
        { netuid: 2, uid: 1, stake_alpha: 0 },
      ],
    });
    const result = await runQuery(ALICE);
    expect(result.data.positions.map(({ netuid, uid }) => [netuid, uid])).toEqual([
      [2, 1],
      [2, 4],
      [7, 9],
    ]);
    expect(result.data.position_count).toBeNull();
    expect(result.data.subnet_count).toBeNull();
  });
});
