import { createServerFn } from "@tanstack/react-start";

export interface TaoMarketData {
  price?: number;
  market_cap?: number;
  volume_24h?: number;
}

/**
 * Fetch TAO/USD market quotes from CoinPaprika. Throws on non-OK HTTP.
 * Extracted from the createServerFn handler so unit tests can cover success /
 * empty / failure without the TanStack Start transport.
 */
export async function fetchTaoMarketData(): Promise<TaoMarketData> {
  const response = await fetch("https://api.coinpaprika.com/v1/tickers/tao-bittensor");
  if (!response.ok) throw new Error(`TAO market data returned ${response.status}`);
  const payload = (await response.json()) as { quotes?: { USD?: TaoMarketData } };
  return payload.quotes?.USD ?? {};
}

export const getTaoMarket = createServerFn({ method: "GET" }).handler(
  async (): Promise<TaoMarketData> => fetchTaoMarketData(),
);
