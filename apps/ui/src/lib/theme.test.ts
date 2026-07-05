import { describe, expect, it } from "vitest";

import {
  THEME_BOOTSTRAP_SCRIPT,
  THEME_STORAGE_KEY,
  bootstrapTheme,
  normalizeThemeChoice,
  resolveTheme,
} from "./theme";

describe("normalizeThemeChoice", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "system"],
    [null, "system"],
    [undefined, "system"],
    ["", "system"],
    ["auto", "system"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeThemeChoice(input)).toBe(expected);
  });
});

describe("resolveTheme", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)("resolves %s with prefersDark=%s to %s", (choice, prefersDark, expected) => {
    expect(resolveTheme(choice, prefersDark)).toBe(expected);
  });
});

describe("bootstrapTheme", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
    [null, false, "light"],
    [null, true, "dark"],
    ["auto", false, "light"],
    ["auto", true, "dark"],
  ] as const)("bootstrap stored=%s prefersDark=%s -> %s", (stored, prefersDark, expected) => {
    expect(bootstrapTheme(stored, prefersDark)).toBe(expected);
  });

  it("stays in sync with normalizeThemeChoice + resolveTheme", () => {
    const storedValues = ["light", "dark", "system", null, "invalid"] as const;
    for (const stored of storedValues) {
      for (const prefersDark of [false, true]) {
        const choice = stored === "light" || stored === "dark" ? stored : ("system" as const);
        expect(bootstrapTheme(stored, prefersDark)).toBe(resolveTheme(choice, prefersDark));
      }
    }
  });
});

describe("THEME_BOOTSTRAP_SCRIPT", () => {
  it("reads the same storage key as runtime theme state", () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('localStorage.getItem("mg-theme")');
  });

  it("applies dark class and dataset.theme like resolveTheme", () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('r.classList.add("dark")');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('r.classList.remove("dark")');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('r.dataset.theme = dark ? "dark" : "light"');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('matchMedia("(prefers-color-scheme: dark)")');
  });
});
