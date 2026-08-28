import { describe, expect, it } from "vitest";
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type { ChainActivityDay, SubnetEconomics, SubnetMover } from "@/lib/metagraphed/types";
import {
  chainPoints,
  emissionRails,
  fmtCount,
  fmtShare,
  healthRail,
  lastCompleteDay,
  valueSegments,
} from "./home-logic";

const nameOf = (netuid: number) => `SN${netuid}`;

const mover = (over: Partial<SubnetMover> & { netuid: number }): SubnetMover =>
  ({
    stake_start_alpha: 0,
    stake_end_alpha: 0,
    stake_delta_alpha: 0,
    stake_pct_change: null,
    stake_share_pct: null,
    emission_start_alpha: 0,
    emission_end_alpha: 0,
    emission_delta_alpha: 0,
    emission_pct_change: null,
    emission_share_pct: null,
    validators_start: 0,
    validators_end: 0,
    validators_delta: 0,
    neurons_start: 0,
    neurons_end: 0,
    neurons_delta: 0,
    ...over,
  }) as SubnetMover;

describe("formatters", () => {
  it("compacts counts and refuses a non-number", () => {
    expect(fmtCount(1_436_676)).toBe("1.44M");
    expect(fmtCount(7_200)).toBe("7.2k");
    expect(fmtCount(12)).toBe("12");
    expect(fmtCount(null)).toBe("—");
  });

  it("renders a fraction as a percentage at the requested precision", () => {
    expect(fmtShare(0.00821, 3)).toBe("0.821%");
    expect(fmtShare(undefined)).toBe("—");
  });
});

describe("valueSegments", () => {
  const rows = [1, 2, 3, 4].map(
    (n) => ({ netuid: n, name: `SN${n}`, emission_share: n / 100 }) as SubnetEconomics,
  );

  it("ranks by share and rolls the tail into one residual", () => {
    const { segments } = valueSegments(rows, 2);
    expect(segments.map((s) => s.key)).toEqual(["4", "3", RESIDUAL_KEY]);
    expect(segments[2]).toMatchObject({ label: "2 more subnets", value: 0.03 });
  });

  it("reports how much of the emission the rows account for", () => {
    expect(valueSegments(rows, 2).accounted).toBeCloseTo(0.1);
  });

  it("drops a subnet earning nothing, and survives an empty read", () => {
    expect(valueSegments([{ netuid: 9, emission_share: 0 } as SubnetEconomics]).segments).toEqual(
      [],
    );
    expect(valueSegments([])).toEqual({ segments: [], accounted: 0 });
  });

  it("emits no residual when the head is everything", () => {
    expect(valueSegments(rows, 10).segments.some((s) => s.key === RESIDUAL_KEY)).toBe(false);
  });
});

describe("emissionRails", () => {
  const movers = [
    mover({ netuid: 1, emission_end_alpha: 10, emission_share_pct: 1, emission_pct_change: 5 }),
    mover({ netuid: 2, emission_end_alpha: 50 }),
    mover({ netuid: 3, emission_end_alpha: 0 }),
  ];

  it("ranks by the window's END reading, so the rail and its change agree", () => {
    expect(emissionRails(movers, nameOf).map((r) => r.key)).toEqual(["2", "1"]);
  });

  it("drops a subnet that emitted nothing", () => {
    expect(emissionRails(movers, nameOf).some((r) => r.key === "3")).toBe(false);
  });

  it("converts the API's percentage share into a fraction for display", () => {
    const [, first] = emissionRails(movers, nameOf);
    expect(first?.detail[0]).toEqual({ key: "share", label: "Share", value: "1.00%" });
    expect(first?.detail[1]?.value).toBe("+5.0%");
  });

  it("honours the limit", () => {
    expect(emissionRails(movers, nameOf, 1)).toHaveLength(1);
  });
});

describe("chainPoints / lastCompleteDay", () => {
  const days = [
    { day: "2026-08-23", block_count: 1588, extrinsic_count: 28875, event_count: 299267 },
    { day: "2026-08-21", block_count: 7200, extrinsic_count: 140000, event_count: 1400000 },
    { day: "2026-08-22", block_count: 7200, extrinsic_count: 143325, event_count: 1436676 },
  ] as ChainActivityDay[];

  it("sorts into time order and reads the metric asked for", () => {
    expect(chainPoints(days, "blocks", "2026-08-23").map((p) => p.v)).toEqual([7200, 7200]);
    expect(chainPoints(days, "extrinsics", "2026-08-23").map((p) => p.v)).toEqual([140000, 143325]);
  });

  it("quotes the last COMPLETE day, not the one in progress", () => {
    // The newest row is today so far -- 1,588 blocks against a full day's
    // 7,200 -- and quoting it reads as a collapse in throughput, not a clock.
    expect(lastCompleteDay(days, "2026-08-23")?.day).toBe("2026-08-22");
  });

  it("keeps the newest row when it is already complete", () => {
    expect(lastCompleteDay(days, "2026-08-24")?.day).toBe("2026-08-23");
  });

  it("keeps historical callers compatible and survives no complete rows", () => {
    expect(chainPoints(days, "blocks")).toHaveLength(3);
    expect(lastCompleteDay([days[0]!])?.day).toBe("2026-08-23");
    expect(lastCompleteDay([days[0]!], "2026-08-23")).toBeNull();
    expect(lastCompleteDay([])).toBeNull();
  });
});

describe("healthRail", () => {
  const subnets = [
    { netuid: 1, uptime_ratio: 0.99 },
    { netuid: 2, uptime_ratio: 0.5 },
    { netuid: 3, uptime_ratio: 1 },
    { netuid: 4 },
  ];

  it("ranks WORST first, because those are the readings worth acting on", () => {
    expect(healthRail(subnets, nameOf).map((r) => r.key)).toEqual(["sn-2", "sn-1", "sn-3"]);
  });

  it("drops a subnet with no probe reading rather than calling it zero", () => {
    expect(healthRail(subnets, nameOf).some((r) => r.key === "sn-4")).toBe(false);
  });

  it("converts the ratio to a percentage and honours the limit", () => {
    expect(healthRail(subnets, nameOf, 1)).toEqual([
      { key: "sn-2", label: "SN2", value: 50, href: "/subnets/2" },
    ]);
  });
});
