import { classNames, formatRelative, isStaleFreshness } from "@/lib/metagraphed/format";

interface Props {
  at?: string | null;
  /** Stale threshold in ms (default 5 min). */
  thresholdMs?: number;
  className?: string;
  /** Show the dot only, no relative text. */
  dotOnly?: boolean;
}

/**
 * Per-row freshness indicator — green dot when fresh, amber when stale,
 * grey when missing. Always shows the relative time unless dotOnly.
 */
export function FreshnessIndicator({ at, thresholdMs, className, dotOnly }: Props) {
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  const cls = missing
    ? "bg-health-unknown"
    : stale
      ? "bg-health-warn"
      : "bg-health-ok";
  const title = missing
    ? "No freshness data"
    : stale
      ? `Stale — last updated ${formatRelative(at)}`
      : `Fresh — updated ${formatRelative(at)}`;
  return (
    <span className={classNames("inline-flex items-center gap-1.5", className)} title={title}>
      <span className={classNames("size-1.5 rounded-full", cls)} />
      {!dotOnly ? (
        <span className="font-mono text-[10px] text-ink-muted">{formatRelative(at)}</span>
      ) : null}
    </span>
  );
}
