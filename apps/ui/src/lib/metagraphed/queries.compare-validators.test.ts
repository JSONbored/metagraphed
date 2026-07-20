import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { compareValidatorsQuery, normalizeCompareValidators } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Valid-format ss58 addresses.
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/compare/validators",
  });
}

// The queryFn is defined on the queryOptions returned by the factory.
async function runQuery(hotkeys: string[], netuid?: number) {
  const opts = compareValidatorsQuery(hotkeys, netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeCompareValidators", () => {
  it("coerces a well-formed comparison, keeping caller order", () => {
    const result = normalizeCompareValidators({
      schema_version: 1,
      netuid: null,
      validator_count: 2,
      validators: [
        {
          hotkey: ALICE,
          coldkey: BOB,
          coldkey_identity: { has_identity: true, name: "Alice Ops" },
          take: 0.09,
          apy_estimate: 0.123,
          apy_estimate_eligible_subnet_count: 3,
          nominator_count: 41,
          total_stake_tao: 1200.5,
          total_emission_tao: 4.2,
          avg_validator_trust: 0.91,
          max_validator_trust: 0.99,
          subnet_count: 5,
          subnet_context: null,
        },
        {
          hotkey: BOB,
          coldkey: null,
          coldkey_identity: null,
          take: null,
          apy_estimate: null,
          apy_estimate_eligible_subnet_count: null,
          nominator_count: null,
          total_stake_tao: null,
          total_emission_tao: null,
          avg_validator_trust: null,
          max_validator_trust: null,
          subnet_count: null,
          subnet_context: null,
        },
      ],
    });
    expect(result.netuid).toBeNull();
    expect(result.validator_count).toBe(2);
    expect(result.validators.map((v) => v.hotkey)).toEqual([ALICE, BOB]);
    expect(result.validators[0]).toMatchObject({
      coldkey: BOB,
      take: 0.09,
      apy_estimate: 0.123,
      nominator_count: 41,
      total_stake_tao: 1200.5,
      subnet_count: 5,
      subnet_context: null,
    });
    expect(result.validators[0].coldkey_identity).toMatchObject({
      has_identity: true,
      name: "Alice Ops",
    });
    // A tier-empty row keeps its hotkey and stays all-null (buildValidatorDetail([], hotkey)).
    expect(result.validators[1]).toMatchObject({
      hotkey: BOB,
      coldkey: null,
      coldkey_identity: null,
      take: null,
      total_stake_tao: null,
    });
  });

  it("carries the netuid context and its subnet_context membership row", () => {
    const result = normalizeCompareValidators({
      netuid: 8,
      validator_count: 1,
      validators: [
        {
          hotkey: ALICE,
          subnet_context: {
            netuid: 8,
            uid: 12,
            stake_tao: 100.25,
            emission_tao: 0.5,
            validator_trust: 0.87,
          },
        },
      ],
    });
    expect(result.netuid).toBe(8);
    expect(result.validators[0].subnet_context).toEqual({
      netuid: 8,
      uid: 12,
      stake_tao: 100.25,
      emission_tao: 0.5,
      validator_trust: 0.87,
    });
  });

  it("drops rows without a hotkey and non-record rows, then recounts", () => {
    const result = normalizeCompareValidators({
      // validator_count deliberately absent — falls back to the surviving row count.
      validators: [{ hotkey: ALICE }, { take: 0.1 }, "junk", null, 7],
    });
    expect(result.validators.map((v) => v.hotkey)).toEqual([ALICE]);
    expect(result.validator_count).toBe(1);
  });

  it("returns a schema-stable empty shape for malformed input", () => {
    for (const raw of [null, undefined, "x", 4, [], { validators: "nope" }]) {
      const result = normalizeCompareValidators(raw);
      expect(result.netuid).toBeNull();
      expect(result.validator_count).toBe(0);
      expect(result.validators).toEqual([]);
    }
  });

  it("coerces numeric strings and nulls non-finite metrics", () => {
    const result = normalizeCompareValidators({
      validators: [
        {
          hotkey: ALICE,
          take: "0.18",
          nominator_count: "12",
          total_stake_tao: Number.NaN,
          avg_validator_trust: "not-a-number",
        },
      ],
    });
    expect(result.validators[0].take).toBe(0.18);
    expect(result.validators[0].nominator_count).toBe(12);
    expect(result.validators[0].total_stake_tao).toBeNull();
    expect(result.validators[0].avg_validator_trust).toBeNull();
  });
});

describe("compareValidatorsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("requests the joined hotkey list and normalizes the response", async () => {
    resolveWith({ netuid: null, validator_count: 1, validators: [{ hotkey: ALICE }] });
    const res = await runQuery([ALICE, BOB]);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/compare/validators",
      expect.objectContaining({
        params: { hotkeys: `${ALICE},${BOB}`, netuid: undefined },
      }),
    );
    expect(res.data.validators.map((v) => v.hotkey)).toEqual([ALICE]);
  });

  it("passes the optional netuid context through to the request", async () => {
    resolveWith({ netuid: 8, validator_count: 0, validators: [] });
    await runQuery([ALICE], 8);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/compare/validators",
      expect.objectContaining({ params: { hotkeys: ALICE, netuid: 8 } }),
    );
  });

  it("keys the cache on the sorted hotkey set plus the netuid context", () => {
    const a = compareValidatorsQuery([BOB, ALICE], 8);
    const b = compareValidatorsQuery([ALICE, BOB], 8);
    expect(a.queryKey).toEqual(b.queryKey);
    const noContext = compareValidatorsQuery([ALICE, BOB]);
    expect(noContext.queryKey).not.toEqual(a.queryKey);
  });

  it("is disabled with an empty selection", () => {
    expect(compareValidatorsQuery([]).enabled).toBe(false);
    expect(compareValidatorsQuery([ALICE]).enabled).toBe(true);
  });
});
