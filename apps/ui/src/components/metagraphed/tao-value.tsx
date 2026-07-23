import { useTaoPrice } from "@/hooks/use-tao-price";
import { formatNumber } from "@/lib/metagraphed/format";
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
    return <span className="font-mono text-[11px] text-ink-muted">—</span>;
  }

  const tao = `τ ${formatNumber(Number(amount.toFixed(precision)))}`;
  const usd =
    price != null
      ? `$${formatNumber(Number((amount * price).toFixed(amount * price >= 1 ? 2 : 4)))}`
      : null;

  // Fall back to τ when USD is requested but unavailable.
  const showTao = unit === "tao" || unit === "both" || (unit === "usd" && usd == null);
  const showUsd = (unit === "usd" || unit === "both") && usd != null;

  const taoClass =
    size === "md"
      ? "font-display text-base sm:text-xl md:text-2xl font-semibold tabular-nums leading-none text-ink-strong"
      : "font-mono text-[11px] tabular-nums text-ink-strong";
  const usdClass =
    size === "md"
      ? "font-mono text-[10px] tabular-nums text-ink-muted"
      : "font-mono text-[10px] tabular-nums text-ink-muted";

  const taoNode = showTao ? <span className={taoClass}>{tao}</span> : null;
  const usdNode = showUsd ? (
    <span className={usdClass} title="TAO price via coinpaprika, refreshed ~1×/min">
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
