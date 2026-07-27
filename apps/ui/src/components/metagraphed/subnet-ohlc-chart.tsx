import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetOhlcQuery } from "@/lib/metagraphed/queries";
import { CandlestickMini, type CandlestickDatum } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { classNames, formatTao } from "@/lib/metagraphed/format";

// Lookback windows offered as pills. "max" is 365d, the server's own clamp
// ceiling for ?days= (see subnetOhlcQuery's params doc) -- naming it "max"
// rather than "365d" keeps the label honest if that ceiling ever moves.
const WINDOWS = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "max", days: 365 },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];

// Interval is derived from the window rather than exposed as its own control:
// hourly candles below 30d, daily at 30d and above. The threshold isn't
// arbitrary -- it's the point where hourly buckets would exceed CandlestickMini's
// 500-candle cap and the chart would silently plot only the most recent slice
// while the pill still claimed the full window (30d hourly = 720 buckets, vs.
// 30 daily). Every window below therefore stays lossless: 7d hourly = 168.
function intervalForWindow(days: number): "1h" | "1d" {
  return days < 30 ? "1h" : "1d";
}

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
  const [windowKey, setWindowKey] = useState<WindowKey>("30d");
  const days = (WINDOWS.find((w) => w.key === windowKey) ?? WINDOWS[1]).days;
  const interval = intervalForWindow(days);
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetOhlcQuery(netuid, { interval, days }));
  const data = res?.data;

  const candles = useMemo<CandlestickDatum[]>(() => {
    if (!data?.candles.length) return [];
    return data.candles.map((c) => ({
      label: c.bucket_start_iso,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume_tao,
    }));
  }, [data?.candles]);

  // A subnet younger than the selected window -- or one that only started
  // trading partway through it -- gets its real extent labeled, rather than
  // silently rendering a short series under a pill claiming a long one. Only
  // annotated when the first bucket lands more than one bucket after the
  // window's own start, so a series that simply begins on the boundary isn't.
  //
  // The explicit "en-US" locale is the #8356 fix, not a style choice:
  // `toLocaleDateString(undefined, ...)` resolves to the RUNTIME's default,
  // which Cloudflare Workers (SSR) and a non-en-US browser (hydration) never
  // agree on -- that mismatch is exactly what threw React #418 on mobile UA.
  const coverageStart = useMemo(() => {
    const first = data?.candles[0];
    if (!first) return null;
    const bucketMs = interval === "1h" ? 3_600_000 : 86_400_000;
    if (first.bucket_start <= Date.now() - days * 86_400_000 + bucketMs) return null;
    return new Date(first.bucket_start).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }, [data?.candles, days, interval]);

  const windowSelector = (
    <div
      role="tablist"
      aria-label="Price history window"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          role="tab"
          aria-selected={w.key === windowKey}
          onClick={() => setWindowKey(w.key)}
          className={classNames(
            "px-2.5 py-1 mg-type-label uppercase rounded transition-colors",
            w.key === windowKey
              ? "bg-ink-strong text-paper"
              : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w.key}
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

  const latest = data?.candles[data.candles.length - 1];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">{windowSelector}</div>
      {isLoading ? (
        // Matches the rendered chart's height so switching windows doesn't
        // bounce the page (the chart is the tab's lead module -- anything
        // below it would shift on every pill press).
        <Skeleton className="h-[220px] w-full" />
      ) : candles.length === 0 ? (
        <EmptyState
          title="No trades yet"
          description="OHLC candles are built from executed stake/unstake trades -- once this subnet has trading activity in the selected window, candles will appear here."
        />
      ) : (
        <Panel as="div" dense>
          <CandlestickMini
            data={candles}
            width={640}
            // The lead module of the tab: it fills the panel instead of
            // stopping at the 640-unit viewBox width mid-panel (which left
            // roughly half of a desktop-width panel empty).
            maxWidth="none"
            height={220}
            formatValue={fmtOhlcPrice}
            formatVolume={formatTao}
            ariaLabel={`Subnet ${netuid} alpha price and volume, ${candles.length} ${interval} candles over ${windowKey}`}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mg-type-data-sm text-ink-muted">
            <span>
              {candles.length} {interval} candles
              {coverageStart ? ` · price history begins ${coverageStart}` : ""}
            </span>
            {latest ? (
              <span>
                latest close {fmtOhlcPrice(latest.close)} τ/α · vol {formatTao(latest.volume_tao)}
              </span>
            ) : null}
          </div>
        </Panel>
      )}
    </div>
  );
}
