import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * One entry in a directory, as a card rather than a full-width row.
 *
 * Three zones, and deliberately nothing else: who it is, what it does, and the
 * two figures you would choose on. The first version of this carried nine
 * things — mark, name, key, price, a two-line purpose, a health pill, a probe
 * ratio, an interface count and a faded watermark — and read as clutter no
 * matter how the type was tuned, because the problem was the count. The
 * reference's own compact card carries four and is mostly empty space; the
 * calm IS the emptiness, not the styling of what fills it.
 *
 * What was cut, and where it went: the probe ratio and interface count are
 * columns in Research, one click away, and both restate what the health state
 * already says at browse depth. The watermark went because a 60px numeral
 * behind a 10px line is noise however faint it is.
 *
 * Square corners are deliberate and match the reference, whose cards are the
 * one thing on its page with no radius at all.
 */
export function EntityCard({
  watermark,
  media,
  title,
  meta,
  state,
  value,
  direction,
  className,
}: {
  /**
   * An oversized, heavily faded mark in the top-right corner — here the
   * entry's own stable key, set large.
   *
   * Deliberately TEXT, not a second copy of the logo: the reference tints one
   * SVG sprite twice for free, but our marks are `<img>`, so a watermark
   * variant would mean a second network request per card — 129 of them on this
   * page, to draw something at 8% opacity. It also replaces the small
   * identifier that used to sit on the title line, rather than adding to it.
   */
  watermark?: ReactNode;
  /** The entry's own small mark. */
  media?: ReactNode;
  title: ReactNode;
  /** What this entry is for. Clamped — a card is a fixed shape or it is a row. */
  meta?: ReactNode;
  /** The qualitative reading, bottom left. */
  state?: ReactNode;
  /** The quantitative one, bottom right. */
  value?: ReactNode;
  /**
   * Which way `value` has moved. Colours it green/red, or leaves it neutral
   * when flat or unknown — an unknown direction must not read as "flat".
   */
  direction?: "up" | "down" | "flat";
  className?: string;
}) {
  return (
    <article className={classNames("mg-entity-card", className)}>
      {watermark ? (
        <span className="mg-entity-card-watermark" aria-hidden="true">
          {watermark}
        </span>
      ) : null}
      <div className="mg-entity-card-head">
        {media ? <span className="mg-entity-card-media">{media}</span> : null}
        <span className="mg-entity-card-title">{title}</span>
      </div>
      {meta ? <p className="mg-entity-card-meta">{meta}</p> : null}
      {state || value ? (
        <div className="mg-entity-card-foot">
          <span className="mg-entity-card-state">{state}</span>
          {value ? (
            <span className="mg-entity-card-value" data-direction={direction}>
              {value}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The grid entity cards live in.
 *
 * `auto-fill` with a floor rather than fixed column counts: the same list has
 * to work at 375px and 1280px, and a card that reflows is one component
 * instead of three breakpoint variants.
 */
export function EntityCardGrid({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={classNames("mg-entity-card-grid", className)}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}
