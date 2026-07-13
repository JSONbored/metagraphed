import { useEffect, useState } from "react";
import { classNames, formatRelative, isStaleFreshness } from "@/lib/format";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";

interface Props {
  at?: string | null;
  /** Stale threshold in ms (default 12h — see isStaleFreshness). */
  thresholdMs?: number;
  className?: string;
  /** Show the dot only, no relative text. */
  dotOnly?: boolean;
}

/**
 * Per-row freshness indicator — green dot when fresh, amber when stale,
 * grey when missing. Relative time is rendered after mount to avoid SSR
 * hydration mismatches (the wall clock advances between server and client).
 */
export function FreshnessIndicator({
  at,
  thresholdMs,
  className,
  dotOnly,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  const cls = missing
    ? "bg-health-unknown"
    : stale
      ? "bg-health-warn"
      : "bg-health-ok";
  const rel = mounted ? formatRelative(at) : "";
  const title = missing
    ? "No freshness data"
    : !mounted
      ? undefined
      : stale
        ? `Stale — last updated ${rel}`
        : `Fresh — updated ${rel}`;
  return (
    <span
      className={classNames("inline-flex items-center gap-1.5", className)}
      title={title}
      suppressHydrationWarning
    >
      <span className={classNames("size-1.5 rounded-full", cls)} />
      {!dotOnly ? (
        <span
          className="font-mono text-[10px] text-ink-muted"
          suppressHydrationWarning
        >
          {rel}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Minimal daily-rollup freshness signal — a staleness dot plus an info icon
 * whose tooltip carries the tier + relative time, instead of always-visible
 * text. Keeps section headers short on narrow viewports; the full context
 * ("Daily rollup snapshot — updated 2h ago") is one hover/tap away.
 */
export function DailyRollupFreshness({
  at,
  className,
}: {
  at?: string | null;
  className?: string;
}) {
  const label =
    at == null
      ? "No freshness data"
      : `Daily rollup snapshot — updated ${formatRelative(at)}`;
  return (
    <span className={classNames("inline-flex items-center gap-1", className)}>
      <FreshnessIndicator at={at} dotOnly />
      <InfoTooltip label={label} />
    </span>
  );
}
