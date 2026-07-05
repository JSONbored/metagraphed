import { describe, it, expect } from "vitest";
import { healthStatusSegments } from "./health-segments";

describe("healthStatusSegments", () => {
  it("builds the four tiers in order with their health CSS-variable colours", () => {
    const segs = healthStatusSegments({ ok: 4, warn: 3, down: 2, unknown: 1 });
    expect(segs.map((s) => [s.label, s.value])).toEqual([
      ["OK", 4],
      ["Degraded", 3],
      ["Down", 2],
      ["Unknown", 1],
    ]);
    expect(segs.map((s) => s.color)).toEqual([
      "var(--health-ok, #22c55e)",
      "var(--health-warn, #f59e0b)",
      "var(--health-down, #ef4444)",
      "var(--ink-muted, #94a3b8)",
    ]);
  });

  it("defaults the middle tier's label to 'Degraded' (the /status wording)", () => {
    const warn = healthStatusSegments({ ok: 1, warn: 1, down: 0, unknown: 0 })[1];
    expect(warn.label).toBe("Degraded");
  });

  it("honours a custom warnLabel (the /providers page passes 'Warn')", () => {
    const segs = healthStatusSegments(
      { ok: 1, warn: 2, down: 0, unknown: 0 },
      { warnLabel: "Warn" },
    );
    expect(segs.find((s) => s.value === 2)?.label).toBe("Warn");
  });

  it("drops zero-value tiers so empty segments never render", () => {
    const segs = healthStatusSegments({ ok: 5, warn: 0, down: 0, unknown: 2 });
    expect(segs.map((s) => s.label)).toEqual(["OK", "Unknown"]);
  });

  it("returns an empty array when every tier is zero", () => {
    expect(healthStatusSegments({ ok: 0, warn: 0, down: 0, unknown: 0 })).toEqual([]);
  });
});
