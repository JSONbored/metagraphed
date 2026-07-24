import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTaoMarket } from "./market.functions";

describe("fetchTaoMarket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed USD quote on a successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          quotes: { USD: { price: 412.5, market_cap: 1, volume_24h: 2 } },
        }),
      }),
    );

    await expect(fetchTaoMarket()).resolves.toEqual({
      price: 412.5,
      market_cap: 1,
      volume_24h: 2,
    });
  });

  it("resolves an empty object when the payload has no USD quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ quotes: {} }),
      }),
    );

    await expect(fetchTaoMarket()).resolves.toEqual({});
  });

  it("throws with the status code on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    await expect(fetchTaoMarket()).rejects.toThrow("TAO market data returned 503");
  });

  it("propagates a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(fetchTaoMarket()).rejects.toThrow("network down");
  });
});
