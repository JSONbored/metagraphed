import { useEffect, useState } from "react";
import {
  classNames,
  formatRelative,
  isStaleFreshness,
  formatFreshnessAbsolute,
} from "@/lib/format";

export type FreshnessTier = "realtime" | "daily";

interface Props {
  at?: string | null;
  tier: FreshnessTier;
  /** Stale threshold in ms (default 12h — see isStaleFreshness). */
  thresholdMs?: number;
  className?: string;
}

/** Visible tier label for realtime block data vs daily rollup snapshots. */
export function freshnessTierLabel(tier: FreshnessTier): string {
  return tier === "realtime" ? "Live" : "Daily rollup";
}

/** Dot colour class mirroring FreshnessIndicator staleness semantics. */
export function freshnessDotClass(
  at?: string | null,
  thresholdMs?: number,
): string {
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  return missing
    ? "bg-health-unknown"
    : stale
      ? "bg-health-warn"
      : "bg-health-ok";
}

/** Absolute + relative copy derived from the shared freshness formatters. */
export function freshnessBadgeTimeCopy(
  at?: string | null,
  mounted = true,
): { absolutePhrase: string | null; relative: string } {
  if (!mounted) return { absolutePhrase: null, relative: "" };
  const absolute = formatFreshnessAbsolute(at);
  return {
    absolutePhrase: absolute ? `as of ${absolute}` : null,
    relative: formatRelative(at),
  };
}

function tierChipClass(tier: FreshnessTier): string {
  return tier === "realtime"
    ? "border-accent/35 bg-accent/10 text-accent"
    : "border-border bg-surface/50 text-ink-muted";
}

/**
 * Reusable freshness badge — tier label ("Live" vs "Daily rollup"), staleness
 * dot, absolute "as of …" stamp, and relative "N ago" phrasing. Built on the
 * same formatRelative/isStaleFreshness/formatFreshnessAbsolute primitives as
 * FreshnessIndicator and the spark/methodology call sites.
 */
export function FreshnessBadge({ at, tier, thresholdMs, className }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  const dotCls = freshnessDotClass(at, thresholdMs);
  const { absolutePhrase, relative } = freshnessBadgeTimeCopy(at, mounted);
  const title = missing
    ? "No freshness data"
    : !mounted
      ? undefined
      : stale
        ? `Stale — ${absolutePhrase ?? "unknown time"} (${relative})`
        : `Fresh — ${absolutePhrase ?? "unknown time"} (${relative})`;

  return (
    <span
      className={classNames(
        "inline-flex flex-wrap items-center gap-1.5",
        className,
      )}
      title={title}
      suppressHydrationWarning
    >
      <span
        className={classNames(
          "inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]",
          tierChipClass(tier),
        )}
      >
        {freshnessTierLabel(tier)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={classNames("size-1.5 shrink-0 rounded-full", dotCls)}
        />
        <span
          className="font-mono text-[10px] text-ink-muted"
          suppressHydrationWarning
        >
          {absolutePhrase ? (
            <>
              <span>{absolutePhrase}</span>
              <span className="text-ink-muted/70"> · </span>
            </>
          ) : null}
          <span>{relative}</span>
        </span>
      </span>
    </span>
  );
}
