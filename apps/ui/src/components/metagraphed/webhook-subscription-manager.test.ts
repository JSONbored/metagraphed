import { describe, expect, it } from "vitest";
import { parseNetuidsInput, validateSecret } from "./webhook-subscription-manager";

describe("parseNetuidsInput", () => {
  it("returns an empty list for blank input", () => {
    expect(parseNetuidsInput("")).toEqual({ ok: true, value: [] });
    expect(parseNetuidsInput("   ")).toEqual({ ok: true, value: [] });
  });

  it("parses a comma-separated list of netuids", () => {
    expect(parseNetuidsInput("7, 43")).toEqual({ ok: true, value: [7, 43] });
  });

  it("tolerates stray whitespace and trailing commas", () => {
    expect(parseNetuidsInput(" 1 ,2,, 3 ,")).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it("rejects a non-numeric token with the offending value in the error", () => {
    const result = parseNetuidsInput("7, abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("abc");
  });

  it("rejects a negative number (not a bare digit token)", () => {
    expect(parseNetuidsInput("-1").ok).toBe(false);
  });
});

describe("validateSecret", () => {
  it("allows a blank secret (server auto-generates one)", () => {
    expect(validateSecret("")).toBeNull();
    expect(validateSecret("   ")).toBeNull();
  });

  it("accepts a secret at the 16- and 256-char bounds", () => {
    expect(validateSecret("a".repeat(16))).toBeNull();
    expect(validateSecret("a".repeat(256))).toBeNull();
  });

  it("rejects a secret shorter than 16 characters", () => {
    expect(validateSecret("short")).toContain("16");
  });

  it("rejects a secret longer than 256 characters", () => {
    expect(validateSecret("a".repeat(257))).toContain("256");
  });

  it("validates the trimmed value, so surrounding whitespace does not pad the length", () => {
    expect(validateSecret(`   ${"a".repeat(5)}   `)).toContain("16");
  });
});
