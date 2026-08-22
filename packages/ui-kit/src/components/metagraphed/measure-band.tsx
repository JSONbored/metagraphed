import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export interface Measure {
  /** Tiny uppercase label. Says what the number is, not how to feel about it. */
  label: string;
  /** The value. A node so an interactive control (a window toggle) can live here. */
  value: ReactNode;
  /** One quiet line of context — a denominator, a window, a breakdown. */
  hint?: ReactNode;
}

/**
 * The few decision-critical numbers for an entity, as one calm band.
 *
 * The thing this replaces is a wall of six rounded, glass-backed, glowing KPI
 * cards. That treatment gives every number the same loud frame, so nothing
 * leads and the eye has six equal places to land — and it is exactly the
 * "generic SaaS dashboard" look the design direction rules out. Hairline
 * separators do the same grouping work for none of the noise.
 *
 * Deliberately not scrollable and not a grid of cards: if a page needs more
 * than a handful of measures here, the extra ones belong in a section below,
 * not in a wider band.
 */
export function MeasureBand({
  measures,
  ariaLabel,
  className,
}: {
  measures: readonly Measure[];
  ariaLabel?: string;
  className?: string;
}) {
  if (measures.length === 0) return null;

  return (
    <dl
      className={classNames("mg-measure-band", className)}
      aria-label={ariaLabel}
      data-count={measures.length}
    >
      {measures.map((measure) => (
        <div key={measure.label} className="mg-measure">
          <dt className="mg-measure-label">{measure.label}</dt>
          <dd className="mg-measure-value">{measure.value}</dd>
          {measure.hint ? (
            <p className="mg-measure-hint">{measure.hint}</p>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
