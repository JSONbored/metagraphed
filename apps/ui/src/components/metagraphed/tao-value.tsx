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
 *
 * Sub-unit amounts are not pre-rounded away: |amount| < 1 is passed through
 * to formatNumber's significant-digit tier so dust like 0.000166248 renders
 * as "τ 0.0001662" rather than "τ 0".
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

  const displayAmount =
    Math.abs(amount) >= 1 ? Number(amount.toFixed(precision)) : amount;
  const tao = `τ ${formatNumber(displayAmount)}`;
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
