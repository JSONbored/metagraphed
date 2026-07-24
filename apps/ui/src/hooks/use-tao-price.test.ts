import { describe, expect, it } from "vitest";

import { resolveTaoPrice } from "./use-tao-price";

describe("resolveTaoPrice", () => {
  it("returns the price on a successful fetch with a positive price", () => {
    expect(resolveTaoPrice({ price: 412.5 })).toBe(412.5);
    expect(resolveTaoPrice({ price: 0.0001 })).toBe(0.0001);
  });

  it("returns null when price is zero or negative", () => {
    expect(resolveTaoPrice({ price: 0 })).toBeNull();
    expect(resolveTaoPrice({ price: -1 })).toBeNull();
  });

  it("returns null when price is non-numeric or NaN", () => {
    expect(resolveTaoPrice({ price: Number.NaN })).toBeNull();
    expect(resolveTaoPrice({ price: undefined })).toBeNull();
  });

  it("returns null when there is no data yet (pending) or the query failed (error)", () => {
    expect(resolveTaoPrice(undefined)).toBeNull();
    expect(resolveTaoPrice({})).toBeNull();
  });
});
