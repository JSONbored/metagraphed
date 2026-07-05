import { describe, expect, it } from "vitest";
import { HEALTH_TOKEN_FALLBACK, healthColorVar, type HealthTone } from "./health-tokens";

describe("healthColorVar", () => {
  it("returns the canonical var() with the one agreed fallback per tier", () => {
    expect(healthColorVar("ok")).toBe("var(--health-ok, #22c55e)");
    expect(healthColorVar("warn")).toBe("var(--health-warn, #f59e0b)");
    expect(healthColorVar("down")).toBe("var(--health-down, #ef4444)");
    expect(healthColorVar("unknown")).toBe("var(--health-unknown, #94a3b8)");
  });

  it("always references the same token name it falls back for", () => {
    const tones: HealthTone[] = ["ok", "warn", "down", "unknown"];
    for (const tone of tones) {
      expect(healthColorVar(tone)).toBe(`var(--health-${tone}, ${HEALTH_TOKEN_FALLBACK[tone]})`);
    }
  });
});
