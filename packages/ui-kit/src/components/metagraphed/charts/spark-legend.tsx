import type { ReactNode } from "react";
import { Definition } from "../interaction/definition";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/format";

/**
 * Consistent provenance legend for every sparkline / mini-stack / density
 * bar: the viz is a `Definition` trigger whose sentence names the metric,
 * window, source, staleness and last check. Wrap any inline viz with this
 * so users always know what they're looking at.
 */
export function SparkLegend({
  children,
  metric,
  source,
  windowLabel,
  updatedAt,
  staleness,
}: {
  children: ReactNode;
  /** Short metric name, e.g. "Health trend". */
  metric: string;
  /** Clause describing the upstream artifact / measurement. */
  source: string;
  /** Time window label such as "7d" or "latest snapshot". */
  windowLabel?: string | null;
  /** ISO timestamp for the underlying snapshot. */
  updatedAt?: string | null;
  /** One-line fallback / staleness behavior. */
  staleness?: string;
}) {
  const fresh = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  const term = windowLabel ? `${metric} · ${windowLabel}` : metric;
  const sentence = [
    source.replace(/\.?$/, "."),
    staleness ? `Staleness: ${staleness.replace(/\.?$/, ".")}` : null,
    fresh || freshAbs
      ? `${fresh ?? ""}${freshAbs ? `${fresh ? " · " : ""}last checked ${freshAbs}` : ""}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Definition term={term} sentence={sentence}>
      <span className="inline-flex max-w-full items-center">{children}</span>
    </Definition>
  );
}
