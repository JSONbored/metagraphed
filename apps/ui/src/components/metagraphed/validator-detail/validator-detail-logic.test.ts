import { describe, expect, it } from "vitest";
import type {
  ValidatorDetailSubnet,
  ValidatorHistoryPoint,
  ValidatorNominatorEntry,
} from "@/lib/metagraphed/types";
import {
  apyPoints,
  changeOver,
  fmtAlpha,
  fmtScore,
  fmtStake,
  historyPoints,
  nominatorRail,
  peerWindow,
  shortKey,
  stakeBySubnet,
} from "./validator-detail-logic";

const nameOf = (netuid: number) => `SN${netuid}`;

const membership = (over: Partial<ValidatorDetailSubnet>): ValidatorDetailSubnet =>
  ({ netuid: 1, uid: 1, validator_permit: true, ...over }) as ValidatorDetailSubnet;

describe("formatters", () => {
  it("compacts stake and alpha at each magnitude", () => {
    expect(fmtStake(1_914_956)).toBe("1.91M τ");
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

describe("stakeBySubnet", () => {
  const memberships = [
    membership({ netuid: 1, stake_alpha: 10, emission_alpha: 1 }),
    membership({ netuid: 2, stake_alpha: 50, emission_alpha: 5 }),
    membership({ netuid: 3, stake_alpha: 0, emission_alpha: 0 }),
  ];
  const fmt = (value: number) => `${value} a`;

  it("orders by stake and carries both legs on every row", () => {
    const rails = stakeBySubnet(memberships, nameOf, fmt);
    expect(rails.map((rail) => rail.key)).toEqual(["sn-2", "sn-1"]);
    expect(rails[0]).toMatchObject({ value: 50, secondary: 5 });
  });

  it("names and links the row rather than leaving it to an axis label", () => {
    // Stacked columns thinned the axis like dates and labelled two of twelve.
    expect(stakeBySubnet(memberships, nameOf, fmt)[0]).toMatchObject({
      label: nameOf(2),
      href: "/subnets/2",
    });
  });

  it("carries stake and emission for the tooltip", () => {
    expect(stakeBySubnet(memberships, nameOf, fmt)[0]?.detail).toEqual([
      { key: "stake", label: "Stake", value: "50 a" },
      { key: "emission", label: "Emission", value: "5 a" },
    ]);
  });

  it("drops a membership holding and earning nothing", () => {
    expect(stakeBySubnet(memberships, nameOf, fmt).some((rail) => rail.key === "sn-3")).toBe(false);
  });

  it("honours the ceiling so a 116-membership validator draws a chart, not a wall", () => {
    expect(stakeBySubnet(memberships, nameOf, fmt, 1)).toHaveLength(1);
  });
});

describe("historyPoints / apyPoints / changeOver", () => {
  const points: ValidatorHistoryPoint[] = [
    { snapshot_date: "2026-08-03", total_stake_tao: 200, rewards_per_1000_tao: 2 },
    { snapshot_date: "2026-08-01", total_stake_tao: 100, rewards_per_1000_tao: 1 },
    { snapshot_date: "2026-08-02", total_stake_tao: null },
  ];

  it("sorts into time order and drops a day with no reading", () => {
    expect(historyPoints(points, (p) => p.total_stake_tao).map((p) => p.v)).toEqual([100, 200]);
  });

  it("annualises the daily reward rate simply, not compounded", () => {
    // The series is a reward per 1,000 τ per day; compounding it would state a
    // return the validator did not produce.
    // Rounding here is the ASSERTION's, not the app's -- it compares floats
    // without pinning IEEE-754 noise, so it is arithmetic rather than display.
    // eslint-disable-next-line no-restricted-syntax -- float comparison, not display
    expect(apyPoints(points).map((p) => Number(p.v.toFixed(4)))).toEqual([0.365, 0.73]);
  });

  it("measures first to last, and refuses a zero baseline", () => {
    expect(changeOver([{ v: 100 }, { v: 150 }])).toBeCloseTo(0.5);
    expect(changeOver([{ v: 0 }, { v: 5 }])).toBeNull();
    expect(changeOver([])).toBeNull();
  });
});

describe("nominatorRail", () => {
  const nominators = [
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
  ] as ValidatorNominatorEntry[];

  it("ranks by GROSS, so the largest departing delegator is not sorted last", () => {
    // net_staked_tao goes negative for anyone unwinding; ranking "who
    // delegates here" by it answers a different question.
    expect(nominatorRail(nominators).map((r) => r.key)).toEqual([
      "5AAAAAAAAAAAAAAA",
      "5BBBBBBBBBBBBBBB",
    ]);
  });

  it("drops a delegator who moved nothing, and keeps the direction in the tooltip", () => {
    const rows = nominatorRail(nominators);
    expect(rows.some((r) => r.key === "5CCCCCCCCCCCCCCC")).toBe(false);
    expect(rows[0]?.detail.map((d) => d.value)).toEqual(["10.00 τ", "990.00 τ", "-980.00 τ", "9"]);
  });

  it("honours the limit", () => {
    expect(nominatorRail(nominators, 1)).toHaveLength(1);
  });
});

describe("peerWindow", () => {
  const ranked = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    hotkey: `5${n}`,
    name: `Op ${n}`,
    totalStakeTao: (8 - n) * 100,
  }));

  it("centres the window on the subject and marks it", () => {
    const peers = peerWindow(ranked, "54", 3);
    expect(peers.map((p) => p.key)).toEqual(["53", "54", "55"]);
    expect(peers.find((p) => p.key === "54")?.current).toBe(true);
  });

  it("clamps at both ends rather than running off the list", () => {
    expect(peerWindow(ranked, "51", 3).map((p) => p.key)).toEqual(["51", "52", "53"]);
    expect(peerWindow(ranked, "57", 3).map((p) => p.key)).toEqual(["55", "56", "57"]);
  });

  it("falls back to the head for a hotkey the ranking does not contain", () => {
    expect(peerWindow(ranked, "unknown", 2).map((p) => p.key)).toEqual(["51", "52"]);
  });

  it("survives a ranking shorter than the window", () => {
    expect(peerWindow(ranked.slice(0, 2), "51", 5)).toHaveLength(2);
  });
});
