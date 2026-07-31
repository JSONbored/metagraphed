import { useTaoPrice } from "@/hooks/use-tao-price";
import { formatNumber, formatUsdApprox } from "@/lib/metagraphed/format";
import { useValueUnit } from "@/lib/metagraphed/value-unit";

/**
 * Renders an on-chain TAO amount alongside its USD equivalent.
 * Respects the page-level ValueUnit preference (τ / USD / Both). When USD is
 * requested but the price hasn't loaded, gracefully falls back to τ so a value
 * always renders.
 *
 * Layout:
 *  - inline (default): "τ 1.2345  ≈ $8.42"
 *  - stacked:          amount on top, USD as a muted line below
 */
export function TaoValue({
  amount,
  layout = "inline",
  precision = 4,
  className,
  align = "right",
  size = "sm",
}: {
  amount: number | null | undefined;
  layout?: "inline" | "stacked";
  precision?: number;
  className?: string;
  align?: "left" | "right";
  size?: "sm" | "md";
}) {
  const { price } = useTaoPrice();
  const { unit } = useValueUnit();

  if (amount == null || Number.isNaN(amount)) {
    return <span className="mg-type-data text-ink-muted">—</span>;
  }

  // #8815: only pre-round via toFixed once the amount is already whole-unit-or-larger -- for a
  // sub-unit amount, toFixed(precision) followed by formatNumber's own rounding double-rounded dust
  // straight to zero (a fee_tao of 0.000166248 rendered "τ 0"). Below 1, hand the raw amount to
  // formatNumber and let its significant-digit tiering keep the leading non-zero digits.
  const tao = `τ ${formatNumber(Math.abs(amount) >= 1 ? Number(amount.toFixed(precision)) : amount)}`;
  const usd = formatUsdApprox(amount, price);

  // Fall back to τ when USD is requested but unavailable.
  const showTao = unit === "tao" || unit === "both" || (unit === "usd" && usd == null);
  const showUsd = (unit === "usd" || unit === "both") && usd != null;

  const taoClass =
    size === "md"
      ? "font-display text-base sm:text-xl md:text-2xl font-semibold tabular-nums leading-none text-ink-strong"
      : "mg-type-data tabular-nums text-ink-strong";
  const usdClass =
    size === "md"
      ? "mg-type-data-sm tabular-nums text-ink-muted"
      : "mg-type-data-sm tabular-nums text-ink-muted";

  const taoNode = showTao ? <span className={taoClass}>{tao}</span> : null;
  const usdNode = showUsd ? (
    <span className={usdClass} title="at current price">
      {unit === "both" ? `≈ ${usd}` : usd}
    </span>
  ) : null;

  if (layout === "stacked") {
    return (
      <span
        className={`inline-flex flex-col ${size === "md" ? "gap-1" : "leading-tight"} ${align === "right" ? "items-end" : "items-start"} ${className ?? ""}`}
      >
        {taoNode}
        {usdNode}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className ?? ""}`}>
      {taoNode}
      {usdNode}
    </span>
  );
}
