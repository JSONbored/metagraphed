import { describe, expect, it } from "vitest";
import { diffNewRows } from "./new-row-tracker";

describe("diffNewRows", () => {
  it("reports nothing new on the first (priming) render, even with rows present", () => {
    const seen = new Set<string>();
    const { newKeys, primed } = diffNewRows(["a", "b", "c"], seen, false);
    expect([...newKeys]).toEqual([]); // initial populated paint must not cascade-animate
    expect(primed).toBe(true);
    expect([...seen].sort()).toEqual(["a", "b", "c"]); // all primed as seen
  });

  it("reports only genuinely-new keys on later renders", () => {
    const seen = new Set<string>();
    diffNewRows(["b", "c"], seen, false); // prime
    const { newKeys } = diffNewRows(["a", "b", "c"], seen, true);
    expect([...newKeys]).toEqual(["a"]); // only the arrival animates
  });

  it("does not re-animate existing rows on a re-render/refetch/re-sort", () => {
    const seen = new Set<string>();
    diffNewRows(["a", "b"], seen, false); // prime
    // same rows, reordered (a re-sort) — nothing new
    expect([...diffNewRows(["b", "a"], seen, true).newKeys]).toEqual([]);
    // a plain re-render with the identical set — nothing new
    expect([...diffNewRows(["a", "b"], seen, true).newKeys]).toEqual([]);
  });

  it("treats a key that vanished and returned as new again (live feed churn)", () => {
    const seen = new Set<string>();
    diffNewRows(["a"], seen, false); // prime with a
    diffNewRows([], seen, true); // a scrolled off — seen still holds a (never pruned)
    // Real churn: a brand-new key after the fact still animates.
    expect([...diffNewRows(["a", "z"], seen, true).newKeys]).toEqual(["z"]);
  });
});
