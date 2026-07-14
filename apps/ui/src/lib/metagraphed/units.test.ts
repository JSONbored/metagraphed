import { describe, it, expect } from "vitest";
import {
  taoToRao,
  raoToTao,
  alphaToRawAlpha,
  rawAlphaToAlpha,
  asRao,
  asRawAlpha,
  UNITS_PER_WHOLE,
} from "./units";

describe("taoToRao / raoToTao", () => {
  it("round-trips whole amounts", () => {
    expect(taoToRao("1")).toBe(1_000_000_000n);
    expect(raoToTao(taoToRao("1"))).toBe("1");
  });

  it("round-trips fractional amounts to full rao precision", () => {
    expect(taoToRao("0.5")).toBe(500_000_000n);
    expect(taoToRao("0.000000001")).toBe(1n);
    expect(raoToTao(taoToRao("123.456789012"))).toBe("123.456789012");
  });

  it("trims trailing zeros on format", () => {
    expect(raoToTao(taoToRao("1.500000000"))).toBe("1.5");
    expect(raoToTao(taoToRao("2.000000000"))).toBe("2");
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // 20,000,000 TAO -- well beyond 2^53 rao -- must not lose precision.
    const huge = "20000000.123456789";
    expect(raoToTao(taoToRao(huge))).toBe(huge);
  });

  it("accepts a plain number input", () => {
    expect(taoToRao(1.5)).toBe(1_500_000_000n);
  });

  it("handles negative amounts", () => {
    expect(taoToRao("-1.5")).toBe(-1_500_000_000n);
    expect(raoToTao(asRao(-1_500_000_000n))).toBe("-1.5");
  });

  it("rejects sub-rao precision (more than 9 fractional digits)", () => {
    expect(() => taoToRao("1.0000000001")).toThrow(/sub-unit precision/i);
  });

  it("rejects a malformed amount", () => {
    expect(() => taoToRao("not-a-number")).toThrow(/invalid tao amount/i);
    expect(() => taoToRao("1.2.3")).toThrow(/invalid tao amount/i);
  });

  it("UNITS_PER_WHOLE is exactly 1e9", () => {
    expect(UNITS_PER_WHOLE).toBe(1_000_000_000n);
  });
});

describe("alphaToRawAlpha / rawAlphaToAlpha", () => {
  it("round-trips using the same 1e9 scale as TAO", () => {
    expect(alphaToRawAlpha("1")).toBe(1_000_000_000n);
    expect(rawAlphaToAlpha(alphaToRawAlpha("42.5"))).toBe("42.5");
  });

  it("rejects sub-unit precision", () => {
    expect(() => alphaToRawAlpha("1.0000000001")).toThrow(/sub-unit precision/i);
  });

  it("rejects a malformed amount", () => {
    expect(() => alphaToRawAlpha("nope")).toThrow(/invalid alpha amount/i);
  });
});

describe("asRao / asRawAlpha", () => {
  it("wrap a raw bigint without conversion", () => {
    expect(asRao(5n)).toBe(5n);
    expect(asRawAlpha(7n)).toBe(7n);
  });
});
