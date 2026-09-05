import { useRef, type CSSProperties } from "react";
import { classNames } from "@/lib/format";
import { Skeleton } from "../skeleton";
import { useActiveEntity } from "../interaction/active-entity";
import { RankGrid, type RankGridItem } from "./rank-grid";
import {
  collapseOther,
  OTHER_KEY,
  RESIDUAL_KEY,
  SeriesPaletteRegistry,
} from "./series-palette";

/**
 * Additive shares at a point in time (#11609): one 24px stacked bar with
 * 2px canvas gaps and a `RankGrid` legend beneath it. Segments and legend
 * rows share entity keys, so hovering either lights both; series colours
 * come from the page's palette registry so the same key matches every
 * other chart on the page.
 */
export interface CompositionSegment {
  key: string;
  label: string;
  value: number;
  href?: string;
}

export interface CompositionBreakdownProps {
  /** Omit while loading; otherwise the additive series to display. */
  segments?: readonly CompositionSegment[];
  registry?: SeriesPaletteRegistry;
  formatValue: (value: number) => string;
  /** Collapse past this many series into Other (default: the palette size). */
  limit?: number;
  other?: string;
  legendCols?: 3 | 4 | 5;
  ariaLabel: string;
  source?: string;
  /** Click / Enter on a legend row; receives the segment key. */
  onActivate?: (key: string) => void;
  className?: string;
  /** Preserve the bar and legend geometry until the source answers. */
  loading?: boolean;
  /** Number of legend cells to reserve while loading. */
  loadingItems?: number;
}

export function CompositionBreakdown({
  segments,
  registry,
  formatValue,
  limit,
  other = OTHER_KEY,
  legendCols = 4,
  ariaLabel,
  source = "composition",
  onActivate,
  className,
  loading = false,
  loadingItems,
}: CompositionBreakdownProps) {
  const own = useRef<SeriesPaletteRegistry | null>(null);
  if (!registry && !own.current) own.current = new SeriesPaletteRegistry();
  const reg = registry ?? own.current!;
  const { active, set, clear } = useActiveEntity();
  const barRef = useRef<HTMLDivElement>(null);

  if (loading) {
    return (
      <CompositionSkeleton
        ariaLabel={ariaLabel}
        className={className}
        legendCols={legendCols}
        loadingItems={loadingItems}
      />
    );
  }

  const presentSegments = segments ?? [];
  // Largest first, EXCEPT a caller-supplied residual, which is pinned last
  // however large it is. A residual is not a peer of the named segments: it
  // is what is left after them, and sorting it by value put "595 more
  // operators" at rank 01 of a concentration chart -- the reading the chart
  // exists to give, stated backwards (#11616).
  const isResidual = (key: string) => key === OTHER_KEY || key === RESIDUAL_KEY;
  const ordered = [...presentSegments].sort((a, b) => {
    if (isResidual(a.key) !== isResidual(b.key))
      return isResidual(a.key) ? 1 : -1;
    return b.value - a.value;
  });
  const keep = limit === undefined ? ordered : ordered.slice(0, limit);
  reg.assign(keep.map((s) => s.key));
  const palette = reg.palette();
  const shown = collapseOther(ordered, reg, other).filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  const activeKey =
    active && shown.some((s) => s.key === active.key) ? active.key : null;
  const legend: RankGridItem[] = shown.map((s) => ({
    key: s.key,
    // collapseOther already decided this: a caller's residual keeps its own
    // label and the ramp's collapse takes the `other` prop. Re-deciding here
    // overwrote the caller's label with "Other".
    label: s.label,
    value: formatValue(s.value),
    share:
      total > 0 ? `${Math.round((s.value / total) * 1000) / 10}%` : undefined,
    swatch: palette.colorOf(s.key),
    href: presentSegments.find((o) => o.key === s.key)?.href,
  }));
  return (
    <div
      className={classNames("mg-composition", className)}
      data-mg-composition=""
    >
      <div
        ref={barRef}
        className="mg-composition-bar"
        role="img"
        aria-label={`${ariaLabel}: ${legend.map((l) => `${l.label} ${l.share ?? l.value}`).join(", ")}`}
        data-series-active={activeKey ? "true" : undefined}
      >
        {shown.map((s) => (
          <i
            key={s.key}
            data-entity={s.key}
            data-active={activeKey === s.key ? "true" : undefined}
            data-dim={activeKey && activeKey !== s.key ? "true" : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === "touch") return;
              set({
                key: s.key,
                source,
                element: barRef.current,
                data: {
                  title: s.label,
                  total: formatValue(s.value),
                },
              });
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "touch") return;
              clear();
            }}
            style={
              {
                "--share": total > 0 ? `${(s.value / total) * 100}%` : "0%",
                // Keep the human-readable percentage for inspection and use
                // the unitless share as the flex weight. The latter allocates
                // the remaining bar width after inter-segment gaps, instead
                // of adding every gap on top of 100% fixed-width segments.
                "--weight": total > 0 ? String(s.value / total) : "0",
                "--swatch": palette.colorOf(s.key),
              } as CSSProperties
            }
          />
        ))}
      </div>
      <RankGrid
        items={legend}
        cols={legendCols}
        ariaLabel={ariaLabel}
        source={source}
        onActivate={onActivate ? (item) => onActivate(item.key) : undefined}
      />
    </div>
  );
}

/** A composition's bar plus its categorical legend, without made-up shares. */
function CompositionSkeleton({
  ariaLabel,
  className,
  legendCols,
  loadingItems,
}: Pick<
  CompositionBreakdownProps,
  "ariaLabel" | "className" | "legendCols" | "loadingItems"
>) {
  return (
    <div
      className={classNames("mg-composition", className)}
      data-mg-composition=""
      data-loading="true"
    >
      <div
        className="mg-composition-bar"
        role="group"
        aria-label={ariaLabel}
        aria-busy="true"
      >
        <span className="sr-only">Loading {ariaLabel}</span>
        <Skeleton className="h-full flex-[1.25]" />
        <Skeleton className="h-full flex-1" />
        <Skeleton className="h-full flex-[0.75]" />
      </div>
      <RankGrid
        items={[]}
        cols={legendCols}
        ariaLabel={`${ariaLabel} legend`}
        loading
        loadingItems={loadingItems ?? legendCols}
      />
    </div>
  );
}
