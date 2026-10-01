import { queryOptions } from "@tanstack/react-query";
import type { ApiSchema } from "@jsonbored/metagraphed";
import { apiFetch } from "./client";
import { metagraphedQueryKey } from "./queries";
import { getApiBase } from "./config";

export type RootBasketResult = ApiSchema<"RootBasketsArtifact">;
export type BasketPricing = ApiSchema<"RootBasketPricing">;
export type BasketSummary = ApiSchema<"RootBasketSummary">;
export type BasketEntry = ApiSchema<"RootBasketAccountEntry">;

export const rootBasketsQuery = (
  params: { cursor?: string; as_of?: string; hotkey?: string } = {},
) =>
  queryOptions({
    queryKey: metagraphedQueryKey(
      "root-baskets",
      { apiBase: getApiBase() },
      params,
    ),
    queryFn: ({ signal }) =>
      apiFetch<RootBasketResult>("/api/v1/root-baskets", { params, signal }),
    staleTime: 30_000,
    retry: 0,
  });

export const accountRootBasketsQuery = (
  ss58: string,
  params: { offset?: number; as_of?: string } = {},
) =>
  queryOptions({
    queryKey: metagraphedQueryKey(
      "account-root-baskets",
      { apiBase: getApiBase() },
      ss58,
      params,
    ),
    queryFn: ({ signal }) =>
      apiFetch<RootBasketResult>(
        `/api/v1/accounts/${encodeURIComponent(ss58)}/root-baskets`,
        {
          params,
          signal,
        },
      ),
    staleTime: 30_000,
    retry: 0,
  });

/** Atomic TAO stays exact even beyond Number.MAX_SAFE_INTEGER. */
export function basketTao(rao: string | null | undefined): string {
  if (rao == null) return "—";
  const value = BigInt(rao);
  const fraction = (value % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ""} TAO`;
}

/** A display index, truncated to four places. Exact raw bits remain copyable. */
export function basketIndex(bits: string): string {
  const scaled = (BigInt(bits) * 10_000n) / (1n << 64n);
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`;
}

export function basketReadState(
  result: RootBasketResult | undefined,
  failed: boolean,
): string | null {
  if (failed || result?.status === "unavailable")
    return "Basket data is temporarily unavailable. Retry to read a finalized snapshot.";
  if (result?.status === "unsupported")
    return "This network's basket runtime is not supported by the audited reader yet.";
  if (result === undefined) return "Loading finalized basket state…";
  return null;
}
