// The emission-split card (#10928).
//
// Two renders in this card are claims, not formatting, and both are unit-tested
// because getting either wrong states something the data does not.
import { describe, expect, it } from "vitest";
import { earningLabel, percent } from "./subnet-emission-split-panel";

describe("rendering a share", () => {
  it("formats a real share as a percentage", () => {
    expect(percent(0.179995422)).toBe("18.0%");
    expect(percent(0.724144562)).toBe("72.4%");
    expect(percent(1)).toBe("100.0%");
  });

  it("renders a MEASURED zero as 0%, because that is a reading", () => {
    // A class that genuinely received none of a day's emission is a fact, and
    // it must not be hidden behind the same dash that means "not known".
    expect(percent(0)).toBe("0.0%");
  });

  it("renders an ABSENT share as a dash, never as 0%", () => {
    // The route publishes null when a day emitted nothing or could not be
    // priced. Rendering that as 0% would claim a class received nothing, which
    // is a different statement from "there was nothing to receive" — the same
    // null-is-not-zero rule the route itself holds.
    expect(percent(null)).toBe("—");
    expect(percent(undefined)).toBe("—");
  });
});

describe("rendering how many miners earned", () => {
  it("shows earners against the registered population", () => {
    // The number a miner count alone hides: on the median subnet almost none
    // of the registered miners earn anything.
    expect(
      earningLabel({
        snapshot_date: "2026-08-12",
        earning_miner_count: 14,
        miner_count: 240,
      }),
    ).toBe("14 / 240");
  });

  it("shows zero earners as 0, not as missing", () => {
    expect(
      earningLabel({
        snapshot_date: "2026-08-12",
        earning_miner_count: 0,
        miner_count: 240,
      }),
    ).toBe("0 / 240");
  });

  it("declines when either side is unknown", () => {
    // A ratio with one unknown side is not a ratio.
    for (const point of [
      { snapshot_date: "d", earning_miner_count: 14 },
      { snapshot_date: "d", miner_count: 240 },
      { snapshot_date: "d" },
    ]) {
      expect(earningLabel(point)).toBe("—");
    }
  });
});
