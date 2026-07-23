// Unit tests for reconcile-neurons drift-tolerance decision boundary
// (`fieldsDiffer` + alert-ratio gate). Pure functions only — no Postgres /
// chain / webhook I/O.

import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_FLOOR_TAO,
  ALERT_THRESHOLD_RATIO,
  RELATIVE_TOLERANCE,
  exceedsAlertThreshold,
  fieldsDiffer,
} from "../scripts/lib/reconcile-neurons-tolerance.ts";

describe("fieldsDiffer", () => {
  it("returns false when live is non-finite (fetch produced no value)", () => {
    expect(fieldsDiffer(NaN, 1)).toBe(false);
    expect(fieldsDiffer(Infinity, 1)).toBe(false);
    expect(fieldsDiffer(-Infinity, 1)).toBe(false);
    expect(fieldsDiffer("not-a-number", 1)).toBe(false);
    expect(fieldsDiffer(undefined, 1)).toBe(false);
  });

  it("returns true when live is finite but stored is null or non-finite", () => {
    expect(fieldsDiffer(1, null)).toBe(true);
    expect(fieldsDiffer(1, NaN)).toBe(true);
    expect(fieldsDiffer(1, Infinity)).toBe(true);
    expect(fieldsDiffer(1, "not-a-number")).toBe(true);
    expect(fieldsDiffer(1, undefined)).toBe(true);
  });

  it("returns false when |delta| is at or under ABSOLUTE_FLOOR_TAO", () => {
    const live = 1;
    expect(fieldsDiffer(live, live)).toBe(false);
    expect(fieldsDiffer(live, live + ABSOLUTE_FLOOR_TAO)).toBe(false);
    expect(fieldsDiffer(live, live - ABSOLUTE_FLOOR_TAO)).toBe(false);
    // Near-zero stakes: tiny absolute delta is still under the floor even if
    // relative % would look huge.
    expect(fieldsDiffer(0.005, 0.005 + ABSOLUTE_FLOOR_TAO / 2)).toBe(false);
  });

  it("returns false when delta exceeds the floor but stays within relative tolerance", () => {
    // live=100 → relative tolerance = max(0.01, 0.02*100) = 2
    const live = 100;
    const relativeTol = RELATIVE_TOLERANCE * Math.abs(live);
    expect(relativeTol).toBeGreaterThan(ABSOLUTE_FLOOR_TAO);
    // Just over the floor, well under relative.
    expect(fieldsDiffer(live, live + ABSOLUTE_FLOOR_TAO + 0.001)).toBe(false);
    // Exactly at relative tolerance: delta > tolerance is false.
    expect(fieldsDiffer(live, live + relativeTol)).toBe(false);
  });

  it("returns true when delta exceeds both the floor and relative tolerance", () => {
    const live = 100;
    const relativeTol = RELATIVE_TOLERANCE * Math.abs(live);
    expect(fieldsDiffer(live, live + relativeTol + 0.001)).toBe(true);
    expect(fieldsDiffer(live, live - relativeTol - 1)).toBe(true);
  });

  it("uses the absolute floor as tolerance when relative tolerance is smaller", () => {
    // live=0.1 → relative = 0.002 < floor 0.01, so tolerance = 0.01
    const live = 0.1;
    expect(RELATIVE_TOLERANCE * Math.abs(live)).toBeLessThan(
      ABSOLUTE_FLOOR_TAO,
    );
    expect(fieldsDiffer(live, live + ABSOLUTE_FLOOR_TAO)).toBe(false);
    expect(fieldsDiffer(live, live + ABSOLUTE_FLOOR_TAO + 0.0001)).toBe(true);
  });
});

describe("exceedsAlertThreshold", () => {
  it("alerts at or above ALERT_THRESHOLD_RATIO and not below", () => {
    expect(exceedsAlertThreshold(ALERT_THRESHOLD_RATIO)).toBe(true);
    expect(exceedsAlertThreshold(ALERT_THRESHOLD_RATIO + 0.0001)).toBe(true);
    expect(exceedsAlertThreshold(ALERT_THRESHOLD_RATIO - 0.0001)).toBe(false);
    expect(exceedsAlertThreshold(0)).toBe(false);
    expect(exceedsAlertThreshold(1)).toBe(true);
  });
});
