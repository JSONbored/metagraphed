import { useQuery } from "@tanstack/react-query";
import { getTaoMarket, type TaoMarketData } from "@/lib/metagraphed/market.functions";

/**
 * Shared TAO/USD price hook. Backed by the same coinpaprika query used on
 * /subnets so the browser cache dedupes across the app.
 *
 * Returns `null` price when the request is pending or has failed — callers
 * must render a "USD unavailable" fallback rather than invent a number.
 */
export function useTaoPrice() {
  const { data, isPending, isError } = useQuery<TaoMarketData>({
    queryKey: ["tao-market"],
    queryFn: () => getTaoMarket(),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });
  const price = typeof data?.price === "number" && data.price > 0 ? data.price : null;
  return { price, isPending, isError };
}
