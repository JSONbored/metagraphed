// The deregistration-standing series (#10296).
//
// Two properties carry this panel, and both are easy to get backwards:
//
//   1. A LOWER RANK NUMBER IS WORSE. Rank 1 is next to be pruned, so a rank
//      that FELL is a subnet in more danger. A plus/minus or an arrow reads the
//      opposite way to half the people who see it, which is why the wording
//      names the consequence instead.
//   2. A NULL RANK IS NOT A MISSING RANK. While immune the subnet holds no
//      position in the prunable order at all. Rendering that as "—" beside real
//      numbers would read as a failed measurement rather than as protection.
import { describe, expect, it } from "vitest";
import {
  countCarriedForward,
  describeStanding,
  rankMovement,
} from "./subnet-deregistration-history";
import type {
  SubnetDeregistrationHistory,
  SubnetDeregistrationHistoryPoint,
} from "@/lib/metagraphed/types";

const point = (
  day: string,
  over: Partial<SubnetDeregistrationHistoryPoint> = {},
): SubnetDeregistrationHistoryPoint => ({
  day,
  pinned_block: 8_800_000,
  repeats_previous_observation: false,
  captured_at: null,
  rank: 40,
  immune: false,
  blocks_until_prunable: 0,
  ranked_count: 112,
  immune_count: 16,
  comparison_price: 0.003,
  moving_price: 0.003,
  next_to_deregister: 36,
  next_to_deregister_comparison_price: 0.0014,
  ...over,
});

const history = (points: SubnetDeregistrationHistoryPoint[]): SubnetDeregistrationHistory => ({
  netuid: 74,
  window: "30d",
  point_count: points.length,
  distinct_observations: null,
  oldest_day: points[0]?.day ?? null,
  newest_day: points[points.length - 1]?.day ?? null,
  first_captured_day: "2026-08-10",
  points,
});

describe("describing the newest standing", () => {
  it("carries the field size, because 94 of 100 is not 94 of 128", () => {
    expect(describeStanding(point("2026-08-15", { rank: 94, ranked_count: 128 }))).toBe(
      "#94 of 128",
    );
    expect(describeStanding(point("2026-08-15", { rank: 94, ranked_count: null }))).toBe("#94");
  });

  it("an immune day reads as immune, never as a rank", () => {
    // The subnet holds no position at all. Showing one -- even a null rendered
    // as a dash -- would report protection as a failed measurement.
    expect(describeStanding(point("2026-08-15", { immune: true, rank: null }))).toBe("immune");
  });

  it("no day and an undescribable day are both unknown", () => {
    expect(describeStanding(null)).toBe("—");
    expect(describeStanding(point("2026-08-15", { immune: null, rank: null }))).toBe("—");
  });
});

describe("describing which way the standing moved", () => {
  it("a rank that FELL is closer to the bar, not an improvement", () => {
    // The exact inversion this wording exists to prevent: 71 -> 40 is a subnet
    // in MORE danger, and an arrow or a minus sign says the opposite.
    const move = rankMovement(
      history([point("2026-07-16", { rank: 71 }), point("2026-08-15", { rank: 40 })]),
    );
    expect(move.label).toBe("closer to the bar by 31");
    expect(move.hint).toContain("HIGHER number is further");
  });

  it("a rank that ROSE is safer", () => {
    const move = rankMovement(
      history([point("2026-07-16", { rank: 40 }), point("2026-08-15", { rank: 71 })]),
    );
    expect(move.label).toBe("safer by 31");
  });

  it("an unchanged rank says so, and points at the reading count", () => {
    const move = rankMovement(
      history([point("2026-08-14", { rank: 40 }), point("2026-08-15", { rank: 40 })]),
    );
    expect(move.label).toBe("unchanged");
    // Because a rank that was not re-measured looks identical to one that held.
    expect(move.hint).toContain("distinct-readings");
  });

  it("immune days are not compared against ranked ones", () => {
    // A position and the ABSENCE of one cannot be subtracted. The real netuid
    // 70 window is exactly this shape: ranked, then immune after it
    // re-registered.
    const move = rankMovement(
      history([
        point("2026-08-10", { rank: 1 }),
        point("2026-08-12", { rank: null, immune: true }),
        point("2026-08-15", { rank: null, immune: true }),
      ]),
    );
    expect(move.label).toBe("—");
    expect(move.hint).toContain("immune holds no position");
  });

  it("one ranked day and an empty window have no direction to report", () => {
    expect(rankMovement(history([point("2026-08-15")])).label).toBe("—");
    expect(rankMovement(history([])).label).toBe("—");
  });
});

describe("counting carried-forward days", () => {
  it("counts the days that say they repeat", () => {
    const h = history([
      point("2026-08-13", { repeats_previous_observation: false }),
      point("2026-08-14", { repeats_previous_observation: true }),
      point("2026-08-15", { repeats_previous_observation: true }),
    ]);
    expect(countCarriedForward(h)).toBe(2);
  });

  it("a NULL flag is not counted as a repeat", () => {
    // A warning that over-reports is one readers learn to ignore, which loses
    // the case it exists for.
    const h = history([point("2026-08-15", { repeats_previous_observation: null })]);
    expect(countCarriedForward(h)).toBe(0);
  });

  it("an empty series is zero, not a crash", () => {
    expect(countCarriedForward(history([]))).toBe(0);
  });
});
