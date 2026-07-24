import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTaoMarketData } from "./market.functions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTaoMarketData", () => {
  it("returns the USD quote when price is positive", async () => {
    const usd = { price: 412.5, market_cap: 1e9, volume_24h: 2e7 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ quotes: { USD: usd } }),
      }),
    );

    await expect(fetchTaoMarketData()).resolves.toEqual(usd);
    expect(fetch).toHaveBeenCalledWith("https://api.coinpaprika.com/v1/tickers/tao-bittensor");
  });

  it("returns an empty object when the USD quote is missing (price guard lives in the hook)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ quotes: {} }),
      }),
    );
    await expect(fetchTaoMarketData()).resolves.toEqual({});
  });

  it("returns the payload even when price is zero or negative (hook rejects those)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ quotes: { USD: { price: 0 } } }),
      }),
    );
    await expect(fetchTaoMarketData()).resolves.toEqual({ price: 0 });
  });

  it("throws when the upstream response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    await expect(fetchTaoMarketData()).rejects.toThrow("TAO market data returned 503");
  });
});
