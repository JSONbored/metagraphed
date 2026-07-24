import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTaoMarket } from "./market.functions";

const COINPAPRIKA_URL = "https://api.coinpaprika.com/v1/tickers/tao-bittensor";

describe("fetchTaoMarket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed USD quote on a successful fetch with a positive price", async () => {
    const usd = { price: 412.5, market_cap: 1_000_000_000, volume_24h: 20_000_000 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ quotes: { USD: usd } }) }),
    );

    await expect(fetchTaoMarket()).resolves.toEqual(usd);
    expect(fetch).toHaveBeenCalledWith(COINPAPRIKA_URL);
  });

  it("passes a zero/negative price through unchanged (the >0 guard lives in the hook)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ quotes: { USD: { price: 0 } } }) }),
    );

    await expect(fetchTaoMarket()).resolves.toEqual({ price: 0 });
  });

  it("resolves an empty object when the payload has a quotes block but no USD quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ quotes: {} }) }),
    );

    await expect(fetchTaoMarket()).resolves.toEqual({});
  });

  it("resolves an empty object when the payload has no quotes block at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    await expect(fetchTaoMarket()).resolves.toEqual({});
  });

  it("throws with the status code on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    await expect(fetchTaoMarket()).rejects.toThrow("TAO market data returned 503");
  });

  it("propagates a network-level fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(fetchTaoMarket()).rejects.toThrow("network down");
  });
});
