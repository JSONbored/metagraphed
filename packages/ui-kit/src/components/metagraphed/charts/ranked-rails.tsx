import { useState, type CSSProperties, type ReactNode } from "react";
import { classNames } from "@/lib/format";
import { Skeleton } from "../skeleton";
import {
  useEntityMark,
  type ActiveEntityData,
} from "../interaction/active-entity";
import { ChartTooltip } from "../interaction/chart-tooltip";
import { markAriaLabel } from "./chart-aria";

/**
 * Ranked horizontal bars (#11609): value · name · track, one 28px button
 * per row, the track a 5px rail filled by `--fill`. The answer to "which
 * is largest?". Rows are entity marks; the active row's fill turns accent
 * and its `detail` rows show in the chart tooltip.
 */
export interface RankedRailItem {
  key: string;
  label: string;
  value: number;
  /** Second track (e.g. emission next to stake). */
  secondary?: number;
  avatar?: ReactNode;
  href?: string;
  /** Rows for the tooltip on active. */
  detail?: ActiveEntityData["rows"];
}

export interface RankedRailsProps {
  items: readonly RankedRailItem[];
  formatValue: (value: number) => string;
  formatSecondary?: (value: number) => string;
  /** `sqrt` for heavy tails. */
  scale?: "linear" | "sqrt";
  /** Pin the scale (e.g. across two rails); defaults to the largest value. */
  max?: number;
  /**
   * Scale the SECOND track against its own largest value instead of sharing
   * the first's.
   *
   * Share the scale when the two series are commensurate -- stake in against
   * stake out, where a longer track genuinely means more. Split it when they
   * are not: a validator's stake (2.65M α) beside its emission (124 α) put the
   * second track four orders of magnitude down, so every emission drew as the
   * same flat 2px line and the track carried no information at all (#11693).
   */
  secondaryScale?: "shared" | "own";
  /** Header labels; omitted = no header row. */
  columns?: { value: string; name: string; track: string; secondary?: string };
  /** Rows shown before "Show all". */
  limit?: number;
  ariaLabel: string;
  source?: string;
  onActivate?: (item: RankedRailItem) => void;
  className?: string;
  /** Preserve the ranked-rail geometry while the source has not answered. */
  loading?: boolean;
  /** Number of rail rows to reserve while loading. */
  loadingRows?: number;
  /** The settled rail has two series, so reserve both tracks while loading. */
  loadingSecondary?: boolean;
}

/** Track fill as a 0–100 percentage. */
export function railFill(
  value: number,
  max: number,
  scale: "linear" | "sqrt" = "linear",
): number {
  if (!(max > 0) || !(value > 0)) return 0;
  const ratio = Math.min(1, value / max);
  return Math.round((scale === "sqrt" ? Math.sqrt(ratio) : ratio) * 1000) / 10;
}

export function RankedRails({
  items,
  formatValue,
  formatSecondary,
  scale = "linear",
  max,
  secondaryScale = "shared",
  columns,
  limit = 10,
  ariaLabel,
  source = "ranked-rails",
  onActivate,
  className,
  loading = false,
  loadingRows = 6,
  loadingSecondary = false,
}: RankedRailsProps) {
  const [expanded, setExpanded] = useState(false);
  const cap =
    max ??
    Math.max(0, ...items.map((i) => Math.max(i.value, i.secondary ?? 0)));
  const shown = expanded ? items : items.slice(0, limit);
  const placeholders = Math.max(1, Math.min(loadingRows, limit));
  const hasSecondary =
    items.some((i) => i.secondary !== undefined) ||
    (loading && loadingSecondary);
  const secondaryCap =
    secondaryScale === "own"
      ? Math.max(0, ...items.map((i) => i.secondary ?? 0))
      : cap;
  return (
    <div
      className={classNames("mg-rails", className)}
      data-mg-rails=""
      data-secondary={hasSecondary ? "true" : undefined}
    >
      {columns ? (
        <div className="mg-rails-head" aria-hidden="true">
          <span>{columns.value}</span>
          <span>{columns.name}</span>
          <span>{columns.track}</span>
          {hasSecondary ? <span>{columns.secondary ?? ""}</span> : null}
        </div>
      ) : null}
      <div
        className="mg-rails-rows"
        role="group"
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        data-marks={loading ? undefined : ""}
      >
        {loading ? <span className="sr-only">Loading {ariaLabel}</span> : null}
        {loading ? (
          Array.from({ length: placeholders }, (_, index) => (
            <RailSkeleton
              key={`skeleton-${index}`}
              hasSecondary={hasSecondary}
            />
          ))
        ) : (
          <>
            <ChartTooltip top="mark" offsetLeft={268} />
            {shown.map((item) => (
              <Rail
                key={item.key}
                item={item}
                cap={cap}
                secondaryCap={secondaryCap}
                scale={scale}
                formatValue={formatValue}
                formatSecondary={formatSecondary ?? formatValue}
                hasSecondary={hasSecondary}
                source={source}
                onActivate={onActivate}
              />
            ))}
          </>
        )}
      </div>
      {items.length > limit && !expanded && !loading ? (
        <button
          type="button"
          className="mg-rails-more"
          onClick={() => setExpanded(true)}
        >
          Show all {items.length}
        </button>
      ) : null}
    </div>
  );
}

/** Same grid tracks as a settled rail; loading never substitutes a generic panel. */
function RailSkeleton({ hasSecondary }: { hasSecondary: boolean }) {
  return (
    <div className="mg-rails-row mg-rails-row--skeleton" aria-hidden="true">
      <span className="mg-rails-value">
        <Skeleton className="ml-auto h-3 w-10" />
      </span>
      <span className="mg-rails-name">
        <Skeleton className="h-3 w-3/5" />
      </span>
      <span className="mg-rails-track">
        <Skeleton className="h-full w-3/5" />
      </span>
      {hasSecondary ? (
        <span className="mg-rails-track" data-secondary>
          <Skeleton className="h-full w-2/5" />
        </span>
      ) : null}
    </div>
  );
}

function Rail({
  item,
  cap,
  secondaryCap,
  scale,
  formatValue,
  formatSecondary,
  hasSecondary,
  source,
  onActivate,
}: {
  item: RankedRailItem;
  cap: number;
  secondaryCap: number;
  scale: "linear" | "sqrt";
  formatValue: (v: number) => string;
  formatSecondary: (v: number) => string;
  hasSecondary: boolean;
  source: string;
  onActivate?: (item: RankedRailItem) => void;
}) {
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(item.label, formatValue(item.value)),
    data: item.detail
      ? { title: item.label, total: formatValue(item.value), rows: item.detail }
      : { title: item.label, total: formatValue(item.value) },
    onActivate: item.href
      ? undefined
      : onActivate
        ? () => onActivate(item)
        : undefined,
  });
  const body = (
    <>
      <span className="mg-rails-value">{formatValue(item.value)}</span>
      <span className="mg-rails-name">
        {item.avatar ? (
          <span className="mg-rails-avatar">{item.avatar}</span>
        ) : null}
        <span>{item.label}</span>
      </span>
      <span className="mg-rails-track">
        <b
          style={
            {
              "--fill": `${railFill(item.value, cap, scale)}%`,
            } as CSSProperties
          }
        />
      </span>
      {hasSecondary ? (
        <span
          className="mg-rails-track"
          data-secondary
          title={
            item.secondary === undefined
              ? undefined
              : formatSecondary(item.secondary)
          }
        >
          <b
            style={
              {
                "--fill": `${railFill(item.secondary ?? 0, secondaryCap, scale)}%`,
              } as CSSProperties
            }
          />
        </span>
      ) : null}
    </>
  );
  const { role: _role, ...linkMark } = mark;
  void _role;
  return item.href ? (
    <a {...linkMark} href={item.href} className="mg-rails-row">
      {body}
    </a>
  ) : (
    <button type="button" {...mark} className="mg-rails-row">
      {body}
    </button>
  );
}
