import { describe, it, expect } from "vitest";
import { isSchemaDrift, normalizeDriftStatus } from "./schema-drift";

describe("normalizeDriftStatus", () => {
  it("trims and lowercases string input", () => {
    expect(normalizeDriftStatus("  Changed  ")).toBe("changed");
    expect(normalizeDriftStatus("NEW")).toBe("new");
  });

  it("returns undefined for non-string input", () => {
    expect(normalizeDriftStatus(undefined)).toBeUndefined();
    expect(normalizeDriftStatus(null)).toBeUndefined();
    expect(normalizeDriftStatus(42)).toBeUndefined();
    expect(normalizeDriftStatus({})).toBeUndefined();
  });

  it("preserves an empty string after trimming", () => {
    expect(normalizeDriftStatus("   ")).toBe("");
  });
});

describe("isSchemaDrift", () => {
  it("excludes the non-drift statuses 'unchanged' and 'new'", () => {
    expect(isSchemaDrift("unchanged")).toBe(false);
    expect(isSchemaDrift("UNCHANGED")).toBe(false);
    expect(isSchemaDrift("new")).toBe(false);
    expect(isSchemaDrift("  New ")).toBe(false);
  });

  it("treats any other recognised status as drift", () => {
    expect(isSchemaDrift("changed")).toBe(true);
    expect(isSchemaDrift("removed")).toBe(true);
    expect(isSchemaDrift("MODIFIED")).toBe(true);
  });

  it("returns false for non-string / nullish input", () => {
    expect(isSchemaDrift(undefined)).toBe(false);
    expect(isSchemaDrift(null)).toBe(false);
    expect(isSchemaDrift(123)).toBe(false);
  });
});
