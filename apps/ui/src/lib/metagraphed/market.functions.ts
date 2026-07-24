import { createServerFn } from "@tanstack/react-start";

export interface TaoMarketData {
  price?: number;
  market_cap?: number;
  volume_24h?: number;
}

// Extracted from the handler so it's unit-testable without depending on
// createServerFn's AsyncLocalStorage request context -- see
// market.functions.test.ts.
export async function fetchTaoMarket(): Promise<TaoMarketData> {
  const response = await fetch("https://api.coinpaprika.com/v1/tickers/tao-bittensor");
  if (!response.ok) throw new Error(`TAO market data returned ${response.status}`);
  const payload = (await response.json()) as { quotes?: { USD?: TaoMarketData } };
  return payload.quotes?.USD ?? {};
}

export const getTaoMarket = createServerFn({ method: "GET" }).handler(fetchTaoMarket);
