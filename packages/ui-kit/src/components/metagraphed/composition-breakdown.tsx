import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import {
  compositionToneAt,
  type CompositionTimelineTone,
} from "./composition-timeline";

export interface CompositionSlice {
  /** Stable identity. Also the swatch's key. */
  id: string;
  label: ReactNode;
  /** Non-negative magnitude. Shares are derived from the total, not supplied. */
  value: number;
  /** Formatted magnitude, e.g. "2.3M α". */
  valueLabel: ReactNode;
  /** Marks a derived remainder: drawn neutral and labelled, never a category. */
  residual?: boolean;
}

/**
 * How one whole divides, as a single stacked bar plus a swatched rank grid.
 *
 * The grid is the legend — that is the point of pairing them. A colour with no
 * name is decoration, and a name with no colour cannot be found in the bar, so
 * neither half is optional. Shares are computed here from the values rather
 * than accepted as input, so the printed percentages can never disagree with
 * the widths drawn beside them.
 */
export function CompositionBreakdown({
  slices,
  ariaLabel,
  footnote,
  className,
}: {
  slices: readonly CompositionSlice[];
  ariaLabel: string;
  /** The window or basis, stated quietly beneath. */
  footnote?: ReactNode;
  className?: string;
}) {
  const usable = slices.filter(
    (slice) => Number.isFinite(slice.value) && slice.value > 0,
  );
  const total = usable.reduce((sum, slice) => sum + slice.value, 0);
  if (usable.length === 0 || total <= 0) return null;

  // A residual is not a category, so it never consumes a ramp slot — the real
  // slices keep the same colours whether or not a remainder is present.
  let toneIndex = 0;
  const toned = usable.map((slice) => ({
    slice,
    share: slice.value / total,
    tone: slice.residual
      ? ("residual" as const)
      : (compositionToneAt(toneIndex++) as CompositionTimelineTone),
  }));

  return (
    <figure className={classNames("mg-composition-breakdown", className)}>
      <div
        className="mg-composition-breakdown-bar"
        role="img"
        aria-label={ariaLabel}
      >
        {toned.map(({ slice, share, tone }) => (
          <span
            key={slice.id}
            className="mg-composition-breakdown-slice"
            data-tone={tone}
            style={{ width: `${share * 100}%` }}
          />
        ))}
      </div>

      {/* The legend IS the ranking: same order, same colours, exact shares. */}
      <ol className="mg-composition-breakdown-grid">
        {toned.map(({ slice, share, tone }, index) => (
          <li key={slice.id}>
            <span className="mg-composition-breakdown-rank" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <i
              aria-hidden="true"
              className="mg-composition-breakdown-swatch"
              data-tone={tone}
            />
            <span className="mg-composition-breakdown-label">
              {slice.label}
            </span>
            <span className="mg-composition-breakdown-value">
              {slice.valueLabel}
            </span>
            <span className="mg-composition-breakdown-share">
              {formatShare(share)}
            </span>
          </li>
        ))}
      </ol>

      {footnote ? (
        <figcaption className="mg-composition-breakdown-note">
          {footnote}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** One decimal above 1%, two below, so a small real slice never reads as zero. */
function formatShare(share: number): string {
  const percentage = share * 100;
  return percentage >= 1
    ? `${percentage.toFixed(1)}%`
    : `${percentage.toFixed(2)}%`;
}
