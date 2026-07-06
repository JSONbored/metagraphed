import { describe, expect, it } from "vitest";
import { parseNetuidsInput } from "./webhook-subscription-manager";

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
