import { describe, it, expect } from "vitest";
import { parseSubmitError } from "./use-tx-status";

describe("parseSubmitError", () => {
  it("extracts a Custom(N) tx-pool code from a polkadot.js-shaped rejection message", () => {
    const decoded = parseSubmitError(new Error("1010: Invalid Transaction: Custom error: 8"));
    expect(decoded.category).toBe("insufficient_liquidity");
    expect(decoded.source).toBe("Custom(8:SlippageTooHigh)");
  });

  it("matches the code regardless of surrounding message text", () => {
    const decoded = parseSubmitError(new Error("Custom error: 25"));
    expect(decoded.source).toBe("Custom(25:NonAssociatedColdKey)");
  });

  it("falls back to a generic decode for a message with no Custom error code", () => {
    const decoded = parseSubmitError(new Error("User rejected the request"));
    expect(decoded.category).toBe("unknown");
    expect(decoded.message).toBe("User rejected the request");
  });

  it("falls back to a generic decode for a non-Error thrown value, without throwing itself", () => {
    expect(() => parseSubmitError("some string")).not.toThrow();
    expect(() => parseSubmitError(undefined)).not.toThrow();
    expect(() => parseSubmitError({ weird: "object" })).not.toThrow();
  });

  it("never returns an empty message", () => {
    expect(parseSubmitError(new Error("")).message.length).toBeGreaterThan(0);
  });
});
