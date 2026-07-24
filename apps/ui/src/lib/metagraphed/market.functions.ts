import { createServerFn } from "@tanstack/react-start";

export interface TaoMarketData {
  price?: number;
  market_cap?: number;
  volume_24h?: number;
}

// Extracted from the createServerFn handler so the fetch/parse/error path is
// unit-testable directly, without TanStack Start's AsyncLocalStorage request
// context (see market.functions.test.ts). getTaoMarket delegates to it, so
// runtime behavior is unchanged.
export async function fetchTaoMarket(): Promise<TaoMarketData> {
  const response = await fetch("https://api.coinpaprika.com/v1/tickers/tao-bittensor");
  if (!response.ok) throw new Error(`TAO market data returned ${response.status}`);
  const payload = (await response.json()) as { quotes?: { USD?: TaoMarketData } };
  return payload.quotes?.USD ?? {};
}

export const getTaoMarket = createServerFn({ method: "GET" }).handler(fetchTaoMarket);
