import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetOhlcQuery } from "@/lib/metagraphed/queries";
import { LineWithWindow, RangeControl, formatLineDate, type LinePoint } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatTao, formatUsdApprox } from "@/lib/metagraphed/format";
import { alphaUsdCoverage } from "@/lib/metagraphed/alpha-usd.functions";

// Lookback windows. "max" is 365d, the server's own clamp ceiling for ?days=
// (see subnetOhlcQuery's params doc) -- naming it "max" rather than "365d"
// keeps the label honest if that ceiling ever moves.
const WINDOWS = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "max", days: 365 },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];

// Interval is derived from the window rather than exposed as its own control:
// hourly closes below 30d, daily at 30d and above, so every window stays
// lossless (7d hourly = 168 points; 30d daily = 30).
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

const hourFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  timeZone: "UTC",
});

/**
 * Alpha close price over time for one subnet (#5656 → #11608: the close
 * series as a `LineWithWindow`; the candlestick was not a question any page
 * asked). Root (netuid 0) and a cold/empty series both render an EmptyState
 * rather than an empty chart, matching the backend's own root_excluded /
 * empty-candles contract.
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

  const points = useMemo<LinePoint[]>(
    () =>
      (data?.candles ?? [])
        .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.bucket_start))
        .map((c) => ({ t: c.bucket_start, v: c.close }))
        .sort((a, b) => a.t - b.t),
    [data?.candles],
  );

  // A subnet younger than the selected window -- or one that only started
  // trading partway through it -- gets its real extent labeled, rather than
  // silently rendering a short series under a control claiming a long one.
  // Only annotated when the first bucket lands more than one bucket after the
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
    <RangeControl
      label="Price history window"
      options={WINDOWS.map((w) => ({ value: w.key, label: w.key }))}
      value={windowKey}
      onChange={setWindowKey}
    />
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
  // What the response STATES about its own USD coverage (#10385) -- never
  // inferred by counting nulls in the candle array.
  const usd = alphaUsdCoverage(data);
  const latestUsd =
    usd.available && latest ? formatUsdApprox(latest.close, latest.usd_per_tao) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">{windowSelector}</div>
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : points.length === 0 ? (
        <EmptyState
          title="No trades yet"
          description="Price history is built from executed stake/unstake trades -- once this subnet has trading activity in the selected window, it will appear here."
        />
      ) : (
        <div className="space-y-2">
          <LineWithWindow
            points={points}
            window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
            unit="τ per α, close"
            formatValue={fmtOhlcPrice}
            formatDate={(t) =>
              interval === "1h" ? hourFormat.format(new Date(t)).toUpperCase() : formatLineDate(t)
            }
            ariaLabel={`Subnet ${netuid} alpha close price, ${points.length} ${interval} buckets over ${windowKey}`}
            source={`subnet-${netuid}-price`}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-10 text-ink-muted">
            <span>
              {points.length} {interval} closes
              {coverageStart ? ` · price history begins ${coverageStart}` : ""}
            </span>
            {latest ? (
              <span>
                latest close {fmtOhlcPrice(latest.close)} τ/α
                {latestUsd ? ` (${latestUsd})` : ""} · vol {formatTao(latest.volume_tao)}
              </span>
            ) : null}
          </div>
          {/* The USD boundary, rendered only when it differs from the TAO
              window. A caption on a fully-covered chart is noise, and noise is
              what stops captions being read on the charts that need them. */}
          {usd.caption ? <div className="text-10 text-ink-muted">{usd.caption}</div> : null}
        </div>
      )}
    </div>
  );
}
