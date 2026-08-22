import type { CSSProperties, ReactNode } from "react";
import { classNames } from "@/lib/format";
import { useEntityMark } from "../interaction/active-entity";
import { markAriaLabel } from "./chart-aria";

/**
 * The compact legend (#11609): an ordered grid of rank · swatch · name ·
 * value · share rows, each an entity mark so hovering a row lights the same
 * key in every chart on the page. 3/4/5 columns by `cols`, 2 at 768, 1 at 375.
 */
export interface RankGridItem {
  key: string;
  label: string;
  /** Formatted value, e.g. "1.2M τ". */
  value?: string;
  /** Formatted share, e.g. "42%". */
  share?: string;
  /** A CSS colour for the 6×6 swatch; omitted = no swatch. */
  swatch?: string;
  /** Whole row becomes a link. */
  href?: string;
  /** Replaces the swatch with a 14px avatar. */
  avatar?: ReactNode;
  /** Outline this row (the current entity among its peers). */
  current?: boolean;
}

export interface RankGridProps {
  items: readonly RankGridItem[];
  cols?: 3 | 4 | 5;
  /** Group name; each row reads "{label} · {value} total". */
  ariaLabel: string;
  source?: string;
  /** Rank numbering starts here (a second page of a leaderboard). */
  start?: number;
  onActivate?: (item: RankGridItem) => void;
  className?: string;
}

export function RankGrid({
  items,
  cols = 4,
  ariaLabel,
  source = "rank-grid",
  start = 1,
  onActivate,
  className,
}: RankGridProps) {
  return (
    <ol
      className={classNames("mg-rank-grid", className)}
      style={{ "--cols": cols } as CSSProperties}
      role="group"
      aria-label={ariaLabel}
      data-marks
      data-mg-rank-grid=""
    >
      {items.map((item, i) => (
        <RankRow
          key={item.key}
          item={item}
          rank={start + i}
          source={source}
          onActivate={onActivate}
        />
      ))}
    </ol>
  );
}

function RankRow({
  item,
  rank,
  source,
  onActivate,
}: {
  item: RankGridItem;
  rank: number;
  source: string;
  onActivate?: (item: RankGridItem) => void;
}) {
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(item.label, item.value),
    onActivate: item.href
      ? undefined
      : onActivate
        ? () => onActivate(item)
        : undefined,
  });
  const body = (
    <>
      <span className="mg-rank-grid-rank">{String(rank).padStart(2, "0")}</span>
      {item.avatar ? (
        <span className="mg-rank-grid-avatar">{item.avatar}</span>
      ) : (
        <i
          className="mg-swatch"
          style={{ "--swatch": item.swatch ?? "var(--faint)" } as CSSProperties}
        />
      )}
      <span className="mg-rank-grid-name">{item.label}</span>
      {item.value ? (
        <span className="mg-rank-grid-value">{item.value}</span>
      ) : null}
      {item.share ? (
        <span className="mg-rank-grid-share">{item.share}</span>
      ) : null}
    </>
  );
  // role="button" comes from the mark; a link row keeps its href and reads as
  // a link to assistive tech through the anchor itself.
  const { role: _role, ...linkMark } = mark;
  void _role;
  return (
    <li data-current={item.current ? "true" : undefined}>
      {item.href ? (
        <a {...linkMark} href={item.href} className="mg-rank-grid-row">
          {body}
        </a>
      ) : (
        <button type="button" {...mark} className="mg-rank-grid-row">
          {body}
        </button>
      )}
    </li>
  );
}
