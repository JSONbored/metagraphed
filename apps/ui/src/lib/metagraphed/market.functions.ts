import { createServerFn } from "@tanstack/react-start";

export interface TaoMarketData {
  price?: number;
  market_cap?: number;
  volume_24h?: number;
}

export const getTaoMarket = createServerFn({ method: "GET" }).handler(
  async (): Promise<TaoMarketData> => {
    const response = await fetch("https://api.coinpaprika.com/v1/tickers/tao-bittensor");
    if (!response.ok) throw new Error(`TAO market data returned ${response.status}`);
    const payload = (await response.json()) as { quotes?: { USD?: TaoMarketData } };
    return payload.quotes?.USD ?? {};
  },
);
