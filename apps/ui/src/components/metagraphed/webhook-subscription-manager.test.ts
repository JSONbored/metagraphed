import { describe, expect, it } from "vitest";
import { parseNetuidsInput, validateSecretInput } from "./webhook-subscription-manager";

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

describe("validateSecretInput", () => {
  it("treats blank/whitespace-only input as valid (auto-generated server-side)", () => {
    expect(validateSecretInput("")).toEqual({ ok: true });
    expect(validateSecretInput("   ")).toEqual({ ok: true });
  });

  it("accepts a secret within the 16–256 character bound", () => {
    expect(validateSecretInput("a".repeat(16))).toEqual({ ok: true });
    expect(validateSecretInput("a".repeat(256))).toEqual({ ok: true });
  });

  it("rejects a too-short secret with its length in the error", () => {
    const result = validateSecretInput("short");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("5");
  });

  it("rejects a too-long secret", () => {
    expect(validateSecretInput("a".repeat(257)).ok).toBe(false);
  });

  it("validates the trimmed value, matching what onSubmit sends", () => {
    // 16 real chars padded with surrounding whitespace still passes.
    expect(validateSecretInput(`   ${"a".repeat(16)}   `)).toEqual({ ok: true });
    // 8 real chars in surrounding whitespace is still too short.
    expect(validateSecretInput(`   ${"a".repeat(8)}   `).ok).toBe(false);
  });
});
