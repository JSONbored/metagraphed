import type { ReactNode } from "react";
import { Definition } from "./definition";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/format";

/**
 * A `Definition` whose sentence is a datum's provenance: the metric, its
 * window, the upstream source, the staleness rule and the last check. Wrap
 * a value, a chip or a timestamp so the reader can ask "where is this
 * from?" the same way they ask "what is this?".
 */
export interface ProvenanceProps {
  children: ReactNode;
  /** Short metric name, e.g. "Endpoint health". */
  metric: string;
  /** Clause describing the upstream artifact / measurement. */
  source: string;
  /** Time window label such as "7d" or "latest snapshot". */
  windowLabel?: string | null;
  /** ISO timestamp for the underlying snapshot. */
  updatedAt?: string | null;
  /** One-line fallback / staleness behaviour. */
  staleness?: string;
}

export function provenanceSentence({
  source,
  windowLabel,
  updatedAt,
  staleness,
}: Omit<ProvenanceProps, "children" | "metric">): string {
  const fresh = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  return [
    source.replace(/\.?$/, "."),
    staleness ? `Staleness: ${staleness.replace(/\.?$/, ".")}` : null,
    fresh || freshAbs
      ? `${fresh ?? ""}${freshAbs ? `${fresh ? " · " : ""}last checked ${freshAbs}` : ""}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Provenance({
  children,
  metric,
  source,
  windowLabel,
  updatedAt,
  staleness,
}: ProvenanceProps) {
  const term = windowLabel ? `${metric} · ${windowLabel}` : metric;
  return (
    <Definition
      term={term}
      sentence={provenanceSentence({
        source,
        windowLabel,
        updatedAt,
        staleness,
      })}
    >
      <span className="inline-flex max-w-full items-center">{children}</span>
    </Definition>
  );
}
