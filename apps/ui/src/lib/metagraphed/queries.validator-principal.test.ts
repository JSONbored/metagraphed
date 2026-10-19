import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./client";
import {
  normalizeGlobalValidators,
  normalizeValidatorOperatorDirectory,
  validatorDetailQuery,
  validatorHistoryQuery,
} from "./queries";
import { deserializeOperatorRows, serializeOperatorRows } from "./validator-operators";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const capturedAt = "2026-08-01T01:00:00Z";
const generatedAt = "2026-08-02T01:00:00Z";
const legacyCapital = {
  total_stake_tao: 123,
  root_stake_tao: 23,
  alpha_stake_tao: 100,
  apy_estimate: 0.5,
  apy_estimate_eligible_subnet_count: 8,
  stake_dominance: 0.2,
  realized_return_1d: 0.1,
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe("validator principal provenance", () => {
  it.each([undefined, null, 0, 123, "123"])(
    "rejects unsupported capital values %s while retaining membership evidence",
    (value) => {
      const validator = normalizeGlobalValidators({
        validators: [
          {
            hotkey: HOTKEY,
            ...legacyCapital,
            total_stake_tao: value,
            take: 0.18,
            avg_validator_trust: 0.9,
            latest_captured_at: capturedAt,
            subnets: [{ netuid: 1, uid: 2, stake_tao: 50, validator_trust: 0.9 }],
          },
        ],
      }).validators[0]!;
      expect(validator).toMatchObject({
        total_stake_tao: null,
        root_stake_tao: null,
        alpha_stake_tao: null,
        apy_estimate: null,
        apy_estimate_eligible_subnet_count: 0,
        stake_dominance: null,
        realized_return_1d: null,
        take: 0.18,
        avg_validator_trust: 0.9,
        latest_captured_at: capturedAt,
      });
      expect(validator.subnets).toHaveLength(1);
    },
  );

  it("retains canonical voting weight and does not backfill an explicitly unknown weight", () => {
    const row = normalizeGlobalValidators({
      validators: [
        {
          hotkey: HOTKEY,
          subnets: [
            { netuid: 1, uid: 1, stake_alpha: 12, stake_tao: 999 },
            { netuid: 2, uid: 2, stake_alpha: null, stake_tao: 999 },
            { netuid: 3, uid: 3 },
          ],
        },
      ],
    }).validators[0]!;
    expect(row.subnets.map((subnet) => subnet.stake_tao)).toEqual([12, null, null]);
  });

  it("keeps detail source time and voting weight without recovering legacy capital", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: {
        hotkey: HOTKEY,
        ...legacyCapital,
        captured_at: capturedAt,
        subnets: [{ netuid: 1, uid: 2, validator_permit: true, stake_alpha: 123 }],
      },
      meta: { generated_at: generatedAt },
      url: "fixture",
    });
    const options = validatorDetailQuery(HOTKEY);
    if (!options.queryFn) throw new Error("expected queryFn");
    const result = await options.queryFn({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as unknown as Parameters<NonNullable<typeof options.queryFn>>[0]);
    expect(result.data).toMatchObject({
      total_stake_tao: null,
      root_stake_tao: null,
      alpha_stake_tao: null,
      apy_estimate: null,
      apy_estimate_eligible_subnet_count: 0,
      captured_at: capturedAt,
      subnets: [{ netuid: 1, uid: 2, stake_alpha: 123 }],
    });
    expect(result.meta?.generated_at).toBe(generatedAt);
  });

  it("retains dated history evidence without deriving principal or a yield denominator", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: {
        hotkey: HOTKEY,
        points: [
          {
            snapshot_date: "2026-08-01",
            subnet_count: 3,
            total_stake_tao: 123,
            total_emission_tao: 2,
            rewards_per_1000_tao: 16,
          },
        ],
      },
      meta: {},
      url: "fixture",
    });
    const options = validatorHistoryQuery(HOTKEY, "30d");
    if (!options.queryFn) throw new Error("expected queryFn");
    const result = await options.queryFn({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as unknown as Parameters<NonNullable<typeof options.queryFn>>[0]);
    expect(result.data.points).toEqual([
      {
        snapshot_date: "2026-08-01",
        subnet_count: 3,
        total_stake_tao: null,
        total_emission_tao: 2,
        rewards_per_1000_tao: null,
      },
    ]);
  });

  it("does not resurrect numerical capital or APY from an older SSR tuple", () => {
    const rows = deserializeOperatorRows([
      [
        "Legacy",
        [
          ["first", 999, 0.1],
          ["second", 1, 0.2],
        ],
        "first",
        "owner",
        1000,
        2,
        4,
        2,
        2,
        null,
        0.5,
        1,
      ],
    ]);
    expect(rows[0]).toMatchObject({
      totalStakeTao: null,
      apyEstimate: null,
      dominance: null,
      takeMin: 0.1,
      takeMax: 0.2,
      nominators: null,
    });
    expect(rows[0]!.keys.every((key) => key.totalStakeTao === null)).toBe(true);
    expect(deserializeOperatorRows(serializeOperatorRows(rows))).toEqual(rows);
  });

  it("keeps null capital through compact directory normalization", () => {
    const normalized = normalizeValidatorOperatorDirectory({
      captured_at: capturedAt,
      operators: [{ primary_hotkey: HOTKEY, ...legacyCapital }],
    });
    expect(normalized.captured_at).toBe(capturedAt);
    expect(deserializeOperatorRows(normalized.operators)[0]).toMatchObject({
      totalStakeTao: null,
      apyEstimate: null,
      dominance: null,
    });
  });
});
