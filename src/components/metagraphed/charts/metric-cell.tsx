import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";
import { SparkLegend } from "./spark-legend";
import { resolveMetric, type MetricKey, type MetricSource } from "@/lib/metagraphed/metric-sources";

type Variant = "card" | "inline" | "tile";

interface Props {
  /** Either a registered metric key, or supply `metric`/`source` directly. */
  metricKey?: MetricKey;
  metric?: string;
  source?: string;
  staleness?: string;
  windowLabel?: string | null;
  updatedAt?: string | null;
  /** Visual treatment. `card` = stacked block, `tile` = padded surface, `inline` = single line. */
  variant?: Variant;
  /** Small uppercase caption. */
  label?: ReactNode;
  /** Primary value (typically a number or AnimatedNumber). */
  value?: ReactNode;
  /** Secondary line (delta pill, sub-label). */
  sub?: ReactNode;
  /** Optional visualization (sparkline, mini-bars). */
  spark?: ReactNode;
  /** Right-aligned slot, e.g. a trend chip. */
  trailing?: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** Apply hover-lift + focus ring. Defaults to true for `tile`, false for `inline`. */
  interactive?: boolean;
  /** When false, fades value/spark to a "loading" register. Defaults true. */
  loaded?: boolean;
}

/**
 * The single, shared "metric cell" used by every card view. Internally wraps
 * itself in SparkLegend so every cell exposes a consistent
 * source/window/staleness tooltip. Pulls attribution from `metric-sources.ts`
 * so phrasing never drifts.
 *
 * Adopt this in place of hand-rolled `<SparkLegend>...</SparkLegend>` blocks
 * inside coverage cards, KPI tiles, leaderboard rows, and any inline stat.
 */
export function MetricCell({
  metricKey,
  metric,
  source,
  staleness,
  windowLabel,
  updatedAt,
  variant = "card",
  label,
  value,
  sub,
  spark,
  trailing,
  className,
  side,
  interactive,
  loaded = true,
}: Props) {
  const resolved: MetricSource = resolveMetric(metricKey, {
    metric,
    source,
    staleness,
  });
  const effectiveWindow = windowLabel ?? resolved.defaultWindow ?? null;
  const isInteractive = interactive ?? (variant === "tile" ? true : false);

  const inner =
    variant === "inline" ? (
      <span className={classNames("inline-flex items-baseline gap-2", className)}>
        {label ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {label}
          </span>
        ) : null}
        {value !== undefined ? (
          <span
            data-mg-fade
            className="font-display text-sm font-semibold text-ink-strong tabular-nums"
          >
            {value}
          </span>
        ) : null}
        {sub ? <span className="text-[11px] text-ink-muted">{sub}</span> : null}
        {spark ? (
          <span data-mg-fade className="ml-1 inline-flex">
            {spark}
          </span>
        ) : null}
        {trailing ? <span className="ml-auto">{trailing}</span> : null}
      </span>
    ) : (
      <div
        data-loaded={loaded ? "true" : "false"}
        className={classNames(
          "flex flex-col gap-1.5",
          variant === "tile" && "rounded-lg border border-border bg-card p-3",
          variant === "tile" && isInteractive && "mg-metric-tile mg-focus-ring",
          className,
        )}
        tabIndex={isInteractive ? 0 : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          {label ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              {label}
            </span>
          ) : (
            <span />
          )}
          {trailing}
        </div>
        {value !== undefined ? (
          <div
            data-mg-fade
            className="font-display text-2xl font-semibold tracking-tight text-ink-strong tabular-nums leading-none"
          >
            {value}
          </div>
        ) : null}
        {spark ? (
          <div data-mg-fade className="pt-0.5">
            {spark}
          </div>
        ) : null}
        {sub ? <div className="text-[11px] text-ink-muted leading-snug">{sub}</div> : null}
      </div>
    );

  return (
    <SparkLegend
      metric={resolved.metric}
      source={resolved.source}
      staleness={resolved.staleness}
      windowLabel={effectiveWindow}
      updatedAt={updatedAt ?? null}
      side={side}
    >
      {inner}
    </SparkLegend>
  );
}
