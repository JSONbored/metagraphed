import { describe, expect, it } from "vitest";
import { buildValidatorIdentityIndex, formatRatePercentRange } from "./validator-identities";
import type { GlobalValidator } from "./types";

// #11522: the directory ranks operators, not hotkeys. These pin the two things
// that make that honest — what may be summed, and what may not.

function validator(
  hotkey: string,
  name: string | null,
  overrides: Partial<GlobalValidator> = {},
): GlobalValidator {
  return {
    hotkey,
    coldkey: `cold-${hotkey}`,
    total_stake_tao: 100,
    take: 0.09,
    apy_estimate: 0.15,
    subnets: [],
    coldkey_identity: name
      ? { has_identity: true, name, url: "https://example.test", image: null, description: "d" }
      : { has_identity: false, name: null },
    ...overrides,
  } as unknown as GlobalValidator;
}

describe("buildValidatorIdentityIndex", () => {
  it("collapses an operator's hotkeys into one ranked row", () => {
    const { identities } = buildValidatorIdentityIndex([
      validator("a", "Yuma", { total_stake_tao: 300 }),
      validator("b", "Yuma", { total_stake_tao: 200 }),
      validator("c", "Kraken", { total_stake_tao: 400 }),
    ]);

    expect(identities.map((i) => i.name)).toEqual(["Yuma", "Kraken"]);
    expect(identities[0]!.hotkeyCount).toBe(2);
    expect(identities[0]!.totalStakeTao).toBe(500);
  });

  it("reports take as a RANGE, never a blend", () => {
    // Yuma really does run both 9% and 18%. A single averaged 13.5% would be a
    // rate no delegator is ever charged.
    const { identities } = buildValidatorIdentityIndex([
      validator("a", "Yuma", { take: 0.09 }),
      validator("b", "Yuma", { take: 0.18 }),
    ]);
    expect(identities[0]!.takeRange).toEqual([0.09, 0.18]);
    expect(formatRatePercentRange(identities[0]!.takeRange)).toBe("9.0–18.0%");
  });

  it("never reports a nominator total", () => {
    // One delegator can back several of an operator's hotkeys, so summing the
    // per-hotkey counts would claim more distinct people than exist. The field
    // is absent by design; this fails if someone adds it back.
    const { identities } = buildValidatorIdentityIndex([
      validator("a", "Yuma", { nominator_count: 900 } as Partial<GlobalValidator>),
      validator("b", "Yuma", { nominator_count: 900 } as Partial<GlobalValidator>),
    ]);
    expect(identities[0]).not.toHaveProperty("nominatorCount");
    expect(JSON.stringify(identities[0])).not.toContain("1800");
  });

  it("counts subnet POSITIONS from subnet_count, never from the capped array", () => {
    // The list response caps `subnets[]` at 10 entries. tao.bot reports
    // subnet_count 116 with 10 array entries, so a union over the arrays would
    // have silently reported 10. Positions come from the authoritative scalar.
    const { identities } = buildValidatorIdentityIndex([
      validator("a", "tao.bot", {
        subnet_count: 116,
        subnets: Array.from({ length: 10 }, (_, i) => ({ netuid: i })),
      } as Partial<GlobalValidator>),
      validator("b", "tao.bot", { subnet_count: 4, subnets: [] } as Partial<GlobalValidator>),
    ]);
    expect(identities[0]!.subnetPositions).toBe(120);
    expect(identities[0]!.hotkeyCount).toBe(2);
  });

  it("orders an operator's keys by the stake behind them", () => {
    const { identities } = buildValidatorIdentityIndex([
      validator("small", "Yuma", { total_stake_tao: 5 }),
      validator("big", "Yuma", { total_stake_tao: 500 }),
    ]);
    expect(identities[0]!.members.map((m) => m.hotkey)).toEqual(["big", "small"]);
  });

  it("leaves unnamed hotkeys separate rather than inventing an operator", () => {
    const { identities, unnamed } = buildValidatorIdentityIndex([
      validator("a", null),
      validator("b", null),
      validator("c", "Yuma"),
    ]);
    expect(identities).toHaveLength(1);
    // Two unrelated operators that share only the absence of a name.
    expect(unnamed).toHaveLength(2);
  });

  it("reports the share of stake the named set actually covers", () => {
    const { namedStakeShare } = buildValidatorIdentityIndex([
      validator("a", "Yuma", { total_stake_tao: 857 }),
      validator("b", null, { total_stake_tao: 143 }),
    ]);
    expect(namedStakeShare).toBeCloseTo(0.857, 3);
  });

  it("survives a validator list with no identities at all", () => {
    const index = buildValidatorIdentityIndex([validator("a", null)]);
    expect(index.identities).toEqual([]);
    expect(index.namedStakeShare).toBe(0);
  });
});

describe("formatRatePercentRange", () => {
  it("collapses a range whose ends agree", () => {
    expect(formatRatePercentRange([0.09, 0.09])).toBe("9.0%");
  });

  it("stays silent when nothing was reported", () => {
    expect(formatRatePercentRange(null)).toBeNull();
  });
});
