import { describe, expect, it } from "vitest";

import { resolveTaoPriceUsd } from "./use-tao-price";

describe("resolveTaoPriceUsd", () => {
  it("returns a positive price", () => {
    expect(resolveTaoPriceUsd({ price: 412.5 })).toBe(412.5);
  });

  it("returns null when price is missing, zero, negative, or non-numeric", () => {
    expect(resolveTaoPriceUsd(undefined)).toBeNull();
    expect(resolveTaoPriceUsd({})).toBeNull();
    expect(resolveTaoPriceUsd({ price: 0 })).toBeNull();
    expect(resolveTaoPriceUsd({ price: -1 })).toBeNull();
    expect(resolveTaoPriceUsd({ price: Number.NaN })).toBeNull();
  });
});
