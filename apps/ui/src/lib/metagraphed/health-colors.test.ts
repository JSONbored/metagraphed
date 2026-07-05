import { describe, expect, it } from "vitest";

import { HEALTH_COLOR, healthStateInlineColor } from "./health-colors";

describe("HEALTH_COLOR", () => {
  it("references the shared CSS tokens without per-file hex fallbacks", () => {
    expect(HEALTH_COLOR.ok).toBe("var(--health-ok)");
    expect(HEALTH_COLOR.warn).toBe("var(--health-warn)");
    expect(HEALTH_COLOR.down).toBe("var(--health-down)");
    expect(HEALTH_COLOR.unknown).toBe("var(--health-unknown)");
  });
});

describe("healthStateInlineColor", () => {
  it.each([
    ["ok", HEALTH_COLOR.ok],
    ["warn", HEALTH_COLOR.warn],
    ["degraded", HEALTH_COLOR.warn],
    ["down", HEALTH_COLOR.down],
    ["offline", HEALTH_COLOR.down],
    ["unknown", HEALTH_COLOR.unknown],
    [undefined, HEALTH_COLOR.unknown],
  ] as const)("maps %s to the canonical token", (state, expected) => {
    expect(healthStateInlineColor(state)).toBe(expected);
  });
});
