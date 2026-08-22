import { Definition } from "@jsonbored/ui-kit";
import { formatNumber } from "@/lib/metagraphed/format";

/** Mirrors the API's `price_basis` enum (schemas-src/routes/subnet-events.ts). */
export type PriceBasis = "trade_exact" | "root_no_pool";

/** Mirrors the API's `usd_basis` enum. Deliberately a DIFFERENT vocabulary
 * from PriceBasis: the alpha price is exact, the dollar leg is a lookup. */
export type UsdBasis = "index_at_or_before";

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
 * The hover explainer for the fiat leg (#8602).
 *
 * States the BASIS in words, because `index_at_or_before` means something a
 * reader will otherwise assume wrongly: the alpha price is this trade's own
 * execution price, while the dollar figure is a lookup against the newest
 * index reading at or before it. Those are different confidences and the
 * tooltip is where a reader finds that out.
 */
export function usdAtTxTooltip(
  usd: number,
  observedAt?: string | null,
  poolCount?: number | null,
): string {
  const at = observedAt ? `, observed ${observedAt}` : "";
  const venues =
    poolCount != null && poolCount > 0
      ? ` across ${poolCount} qualifying liquidity pool${poolCount === 1 ? "" : "s"}`
      : "";
  return `≈ $${usd} per alpha — our TAO/USD index at or before this trade${at}${venues}. The alpha price is exact; this conversion is a lookup, so it is the less precise of the two.`;
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
 * The USD companion renders beside it when the API resolved one (#8602), and
 * renders NOTHING when it did not — an event predating the index has no dollar
 * price, and an em-dash there would imply a value we are withholding rather
 * than one that never existed. Same rule as the TAO figure, for the same
 * reason.
 */
export function PriceAtTx({
  price,
  basis,
  blockNumber,
  usd,
  usdObservedAt,
  usdPoolCount,
}: {
  price?: number | null;
  basis?: PriceBasis | null;
  blockNumber?: number | null;
  usd?: number | null;
  usdObservedAt?: string | null;
  usdPoolCount?: number | null;
}) {
  if (price == null || !Number.isFinite(price)) return null;
  const showUsd = usd != null && Number.isFinite(usd);
  return (
    <span className="block text-10 tabular-nums text-ink-muted">
      <Definition
        term="Price at transaction"
        sentence={priceAtTxTooltip(price, basis, blockNumber)}
      >
        <span>@ {price} τ/α</span>
      </Definition>
      {showUsd ? (
        <Definition
          term="USD at transaction"
          sentence={usdAtTxTooltip(usd, usdObservedAt, usdPoolCount)}
        >
          <span> (≈ ${usd})</span>
        </Definition>
      ) : null}
    </span>
  );
}
