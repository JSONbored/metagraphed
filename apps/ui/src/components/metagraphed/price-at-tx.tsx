import { formatNumber } from "@/lib/metagraphed/format";

/** Mirrors the API's `price_basis` enum (schemas-src/routes/subnet-events.ts). */
export type PriceBasis = "trade_exact" | "root_no_pool";

/**
 * Build the hover explainer for a resolved price (#8369 requirement 4: state
 * the basis and when it was measured, so precision is never guessed at).
 * Exported separately from the component so the wording is unit-testable.
 */
export function priceAtTxTooltip(
  price: number,
  basis: PriceBasis | null | undefined,
  blockNumber: number | null | undefined,
): string {
  const at = blockNumber != null ? ` at block ${formatNumber(blockNumber)}` : "";
  if (basis === "trade_exact") {
    return `${price} τ per alpha — this trade's own execution price${at}, from its TAO and alpha legs. Not a bucket average.`;
  }
  return `${price} τ per alpha${at}.`;
}

/**
 * Secondary "what was it worth, then" line under an event's amount (#8369).
 *
 * Renders NOTHING when there's no derivable price — a transfer, a
 * registration, root (no AMM pool), or a malformed leg. That silence is
 * deliberate: the issue's own requirement is "rows with null show nothing —
 * no fake precision", so an em-dash placeholder implying a missing value
 * would be worse than absence, since for most event kinds a price is not
 * missing, it simply doesn't exist.
 *
 * TAO-denominated only. There is no USD companion here on purpose — see
 * src/price-at-tx.ts's header and the follow-up issue it points to.
 */
export function PriceAtTx({
  price,
  basis,
  blockNumber,
}: {
  price?: number | null;
  basis?: PriceBasis | null;
  blockNumber?: number | null;
}) {
  if (price == null || !Number.isFinite(price)) return null;
  return (
    <span
      className="block mg-type-data-sm tabular-nums text-ink-muted"
      title={priceAtTxTooltip(price, basis, blockNumber)}
    >
      @ {price} τ/α
    </span>
  );
}
