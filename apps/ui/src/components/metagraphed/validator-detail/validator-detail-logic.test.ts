import { describe, expect, it } from "vitest";
import type { ValidatorDetailSubnet, ValidatorNominatorEntry } from "@/lib/metagraphed/types";
import {
  fmtAlpha,
  fmtScore,
  fmtStake,
  membershipsBySubnet,
  nominatorRail,
  shortKey,
} from "./validator-detail-logic";

describe("membershipsBySubnet", () => {
  it("retains null and zero weights in subnet order without ranking or mutating the input", () => {
    const rows = [
      { netuid: 2, uid: 9, validator_permit: true, stake_alpha: 999 },
      { netuid: 1, uid: 2, validator_permit: true, stake_alpha: null },
      { netuid: 0, uid: 1, validator_permit: true, stake_alpha: 0 },
      { netuid: 1, uid: 1, validator_permit: false, stake_alpha: 1000 },
    ] satisfies ValidatorDetailSubnet[];
    const ordered = membershipsBySubnet(rows);
    expect(ordered.map((row) => [row.netuid, row.uid, row.stake_alpha])).toEqual([
      [0, 1, 0],
      [1, 1, 1000],
      [1, 2, null],
      [2, 9, 999],
    ]);
    expect(rows[0]!.netuid).toBe(2);
  });
});

describe("formatters", () => {
  it("formats denomination only where the source establishes it", () => {
    expect(fmtStake(1_914_956)).toBe("1.91Mτ");
    expect(fmtAlpha(2_500)).toBe("2.5k α");
    expect(fmtAlpha(2.5)).toBe("2.50 α");
    expect(fmtStake(null)).toBe("—");
  });

  it("scores to three places and truncates only long keys", () => {
    expect(fmtScore(0.9773456)).toBe("0.977");
    expect(fmtScore(null)).toBe("—");
    expect(shortKey("5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u")).toBe("5E2LP6…eZ5u");
    expect(shortKey("5E2L")).toBe("5E2L");
  });
});

describe("nominatorRail", () => {
  const nominators: ValidatorNominatorEntry[] = [
    {
      coldkey: "5AAAAAAAAAAAAAAA",
      staked_tao: 10,
      unstaked_tao: 990,
      net_staked_tao: -980,
      gross_staked_tao: 1000,
      event_count: 9,
    },
    {
      coldkey: "5BBBBBBBBBBBBBBB",
      staked_tao: 300,
      unstaked_tao: 0,
      net_staked_tao: 300,
      gross_staked_tao: 300,
      event_count: 1,
    },
    {
      coldkey: "5CCCCCCCCCCCCCCC",
      staked_tao: 0,
      unstaked_tao: 0,
      net_staked_tao: 0,
      gross_staked_tao: 0,
      event_count: 0,
    },
  ];

  it("ranks by observed gross movement, retaining the largest departing delegator", () => {
    expect(nominatorRail(nominators).map((row) => row.key)).toEqual([
      "5AAAAAAAAAAAAAAA",
      "5BBBBBBBBBBBBBBB",
    ]);
  });

  it("drops zero movement and preserves the movement direction", () => {
    const rows = nominatorRail(nominators);
    expect(rows.some((row) => row.key === "5CCCCCCCCCCCCCCC")).toBe(false);
    expect(rows[0]?.detail.map((detail) => detail.value)).toEqual([
      "10.00τ",
      "990.00τ",
      "-980.00τ",
      "9",
    ]);
  });

  it("honours the limit", () => {
    expect(nominatorRail(nominators, 1)).toHaveLength(1);
  });
});
