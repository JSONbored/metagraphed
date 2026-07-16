import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetOhlcQuery } from "@/lib/metagraphed/queries";
import { CandlestickMini, type CandlestickDatum } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, formatTao } from "@/lib/metagraphed/format";

const INTERVALS = ["1h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];

// Same precision rule as accounts.$ss58.tsx's fmtAlphaPrice / subnets.$netuid.tsx's
// fmtQuotePrice -- the alpha_price_tao scale is small enough (typically well under
// 1 TAO/alpha) that a fixed decimal count reads as either all-zeros or unreadably
// long; scientific notation only kicks in once fixed notation would round to 0.
function fmtOhlcPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.001) return v.toExponential(2);
  return v < 1 ? v.toFixed(4) : v.toFixed(3);
}

/**
 * OHLC price/volume candlestick chart for one subnet (#5656, Phase 2 of the
 * OHLC epic #5304 -- follows #5655's backend). An interval toggle mirrors
 * subnet-history-chart.tsx's window-selector pattern; root (netuid 0) and a
 * cold/empty series both render an EmptyState rather than an empty chart
 * area, matching the backend's own root_excluded / empty-candles contract.
 */
export function SubnetOhlcChart({ netuid }: { netuid: number }) {
  const [interval, setIntervalState] = useState<Interval>("1h");
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetOhlcQuery(netuid, { interval }));
  const data = res?.data;

  const candles = useMemo<CandlestickDatum[]>(() => {
    if (!data?.candles.length) return [];
    return data.candles.map((c) => ({
      label: c.bucket_start_iso,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  }, [data?.candles]);

  const intervalSelector = (
    <div
      role="tablist"
      aria-label="Candle interval"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {INTERVALS.map((i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === interval}
          onClick={() => setIntervalState(i)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            i === interval ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {i}
        </button>
      ))}
    </div>
  );

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet OHLC" />;
  }

  if (data?.root_excluded) {
    return (
      <EmptyState
        title="No market for root"
        description="Root (netuid 0) has no AMM pool -- stake there is 1:1 TAO, with no price to chart."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">{intervalSelector}</div>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : candles.length === 0 ? (
        <EmptyState
          title="No trades yet"
          description="OHLC candles are built from executed stake/unstake trades -- once this subnet has trading activity in the selected interval, candles will appear here."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <CandlestickMini
            data={candles}
            width={640}
            height={180}
            formatValue={fmtOhlcPrice}
            ariaLabel={`Subnet ${netuid} alpha price, ${candles.length} ${interval} candles`}
          />
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-ink-muted">
            <span>{candles.length} candles</span>
            <span>
              latest close {fmtOhlcPrice(candles[candles.length - 1]!.close)} τ/α · vol{" "}
              {formatTao(data!.candles[data!.candles.length - 1]!.volume_tao)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
