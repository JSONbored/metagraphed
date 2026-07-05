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
  it("coerces a well-formed position and passes yield through unchanged", () => {
    expect(
      normalizePortfolioPosition({
        netuid: 7,
        uid: 42,
        role: "validator",
        active: true,
        stake_tao: 1250.5,
        emission_tao: 3.2,
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
      stake_tao: 1250.5,
      emission_tao: 3.2,
      rank: 0.9,
      trust: 0.8,
      incentive: 0.5,
      dividends: 0.4,
      yield: 0.00256,
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
        stake_tao: { attacker: true },
        emission_tao: "1.5",
        yield: null,
      }),
    ).toEqual({
      netuid: 3,
      uid: null,
      role: null,
      active: undefined,
      stake_tao: null,
      emission_tao: null,
      rank: null,
      trust: null,
      incentive: null,
      dividends: null,
      yield: null,
    });
  });

  it("keeps the miner role and a zero-stake null yield", () => {
    const position = normalizePortfolioPosition({
      netuid: 0,
      uid: 1,
      role: "miner",
      active: false,
      stake_tao: 0,
      emission_tao: 0,
      yield: null,
    });
    expect(position?.role).toBe("miner");
    expect(position?.active).toBe(false);
    expect(position?.yield).toBeNull();
  });

  it("drops a row with no numeric netuid or a non-object input", () => {
    expect(normalizePortfolioPosition({ netuid: "abc", uid: 1 })).toBeNull();
    expect(normalizePortfolioPosition(null)).toBeNull();
    expect(normalizePortfolioPosition("nope")).toBeNull();
  });
});

describe("normalizePortfolioConcentration", () => {
  it("keeps finite lenses, nulls a junk typed cell, and passes extra fields through", () => {
    expect(
      normalizePortfolioConcentration({
        holders: 5,
        gini: { attacker: true }, // junk in a typed cell → null (never rendered raw)
        hhi_normalized: 0.31,
        nakamoto_coefficient: 2,
        total: 1000, // an un-typed lens field passes through untouched
      }),
    ).toEqual({
      holders: 5,
      gini: null,
      hhi_normalized: 0.31,
      nakamoto_coefficient: 2,
      total: 1000,
    });
  });

  it("returns null for a null / non-object distribution (cold wallet)", () => {
    expect(normalizePortfolioConcentration(null)).toBeNull();
    expect(normalizePortfolioConcentration(undefined)).toBeNull();
    expect(normalizePortfolioConcentration(42)).toBeNull();
  });
});

describe("accountPortfolioQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("requests the ss58 portfolio path and shapes the envelope", async () => {
    resolveWith({
      ss58: "5Server",
      captured_at: "2026-07-05T00:00:00Z",
      subnet_count: 2,
      position_count: 2,
      validator_count: 1,
      miner_count: 1,
      total_stake_tao: 100,
      total_emission_tao: 4,
      overall_yield: 0.04,
      stake_concentration: { holders: 2, gini: 0.5, hhi_normalized: 0.6, nakamoto_coefficient: 1 },
      positions: [
        { netuid: 1, uid: 10, role: "validator", stake_tao: 90, emission_tao: 3, yield: 0.033 },
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
    expect(result.data.positions[0]).toMatchObject({ netuid: 1, role: "validator", yield: 0.033 });
    expect(result.data.stake_concentration).toEqual({
      holders: 2,
      gini: 0.5,
      hhi_normalized: 0.6,
      nakamoto_coefficient: 1,
    });
  });

  it("falls back to safe defaults when the body is a non-object (cold/absent)", async () => {
    resolveWith(null);

    const result = await runQuery(BOB);

    expect(result.data.ss58).toBe(BOB);
    expect(result.data.positions).toEqual([]);
    expect(result.data.subnet_count).toBe(0);
    expect(result.data.position_count).toBe(0);
    expect(result.data.validator_count).toBe(0);
    expect(result.data.total_stake_tao).toBeNull();
    expect(result.data.overall_yield).toBeNull();
    expect(result.data.stake_concentration).toBeNull();
  });

  it("caps the position list defensively", async () => {
    resolveWith({
      positions: Array.from({ length: 300 }, (_, i) => ({
        netuid: i,
        uid: i,
        role: "miner",
        stake_tao: 1,
        emission_tao: 0,
        yield: 0,
      })),
    });

    const result = await runQuery(CHARLIE);

    expect(result.data.positions).toHaveLength(256);
    // subnet_count/position_count fall back to the (capped) rendered length.
    expect(result.data.position_count).toBe(256);
  });
});
