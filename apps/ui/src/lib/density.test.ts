import { describe, expect, it } from "vitest";

import {
  DENSITY_BOOTSTRAP_SCRIPT,
  DENSITY_STORAGE_KEY,
  bootstrapDensity,
  normalizeDensityChoice,
} from "./density";

describe("normalizeDensityChoice", () => {
  it.each([
    ["compact", "compact"],
    ["comfortable", "comfortable"],
    [null, "comfortable"],
    [undefined, "comfortable"],
    ["", "comfortable"],
    ["cozy", "comfortable"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeDensityChoice(input)).toBe(expected);
  });
});

describe("bootstrapDensity", () => {
  it.each([
    ["compact", "compact"],
    ["comfortable", "comfortable"],
    [null, "comfortable"],
    ["invalid", "comfortable"],
  ] as const)("bootstrap stored=%s -> %s", (stored, expected) => {
    expect(bootstrapDensity(stored)).toBe(expected);
  });

  it("stays in sync with normalizeDensityChoice", () => {
    for (const stored of ["compact", "comfortable", null, "other"] as const) {
      expect(bootstrapDensity(stored)).toBe(normalizeDensityChoice(stored));
    }
  });
});

describe("DENSITY_BOOTSTRAP_SCRIPT", () => {
  it("reads the same storage key as runtime density state", () => {
    expect(DENSITY_BOOTSTRAP_SCRIPT).toContain(DENSITY_STORAGE_KEY);
    expect(DENSITY_BOOTSTRAP_SCRIPT).toContain('localStorage.getItem("mg-density")');
  });

  it("sets dataset.density for compact and comfortable modes", () => {
    expect(DENSITY_BOOTSTRAP_SCRIPT).toContain('v === "compact" ? "compact" : "comfortable"');
    expect(DENSITY_BOOTSTRAP_SCRIPT).toContain("document.documentElement.dataset.density");
  });
});
