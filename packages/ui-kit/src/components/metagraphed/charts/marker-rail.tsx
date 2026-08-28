import type { CSSProperties, ReactNode } from "react";
import { classNames } from "@/lib/format";
import { Skeleton } from "../skeleton";
import { useEntityMark } from "../interaction/active-entity";
import { markAriaLabel } from "./chart-aria";

const SCALE_INTERVALS = [0, 1, 2, 3, 4] as const;

/**
 * A bounded ratio per row (#11609): uptime %, readiness /100, trust 0–1,
 * take %. A 7px rail with hairline ticks every 20% and a 7px marker at
 * `--pos`. The header row is always shown, so the scale is never implied.
 */
export interface MarkerRailItem {
  key: string;
  label: string;
  /** In the rail's own units; `max` bounds it. */
  value: number | null;
  avatar?: ReactNode;
  href?: string;
  /** Optional chip text left of the name (a kind, a tier). */
  tag?: string;
}

export interface MarkerRailProps {
  /** Omit while loading; otherwise the ratio rows to display. */
  items?: readonly MarkerRailItem[];
  /** The rail's upper bound (100 for percentages, 1 for ratios). */
  max?: number;
  formatValue: (value: number) => string;
  columns: { ratio: string; name: string; scale: string };
  ariaLabel: string;
  source?: string;
  onActivate?: (item: MarkerRailItem) => void;
  className?: string;
  /** Preserve the ratio-rail geometry while the source has not answered. */
  loading?: boolean;
  /** Number of ratio rows to reserve while loading. */
  loadingRows?: number;
}

/** Marker position as a 0–100 percentage. */
export function markerPosition(
  value: number | null,
  max: number,
): number | null {
  if (value === null || !Number.isFinite(value) || !(max > 0)) return null;
  return Math.round(Math.min(1, Math.max(0, value / max)) * 1000) / 10;
}

export function MarkerRail({
  items,
  max = 100,
  formatValue,
  columns,
  ariaLabel,
  source = "marker-rail",
  onActivate,
  className,
  loading = false,
  loadingRows = 5,
}: MarkerRailProps) {
  const placeholders = Math.max(1, loadingRows);
  return (
    <div
      className={classNames("mg-marker-rail", className)}
      data-mg-marker-rail=""
    >
      <div className="mg-rails-head" aria-hidden="true">
        <span>{columns.ratio}</span>
        <span>{columns.name}</span>
        <span>{columns.scale}</span>
      </div>
      <div
        className="mg-rails-rows"
        role="group"
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        data-marks={loading ? undefined : ""}
      >
        {loading ? <span className="sr-only">Loading {ariaLabel}</span> : null}
        {loading
          ? Array.from({ length: placeholders }, (_, index) => (
              <MarkerRowSkeleton key={`skeleton-${index}`} />
            ))
          : (items ?? []).map((item) => (
              <MarkerRow
                key={item.key}
                item={item}
                max={max}
                formatValue={formatValue}
                source={source}
                onActivate={onActivate}
              />
            ))}
      </div>
    </div>
  );
}

/** Same three-column marker rail; no ratio is implied before a probe answers. */
function MarkerRowSkeleton() {
  return (
    <div className="mg-rails-row mg-rails-row--skeleton" aria-hidden="true">
      <span className="mg-rails-value">
        <Skeleton className="ml-auto h-3 w-10" />
      </span>
      <span className="mg-rails-name">
        <Skeleton className="h-3 w-3/5" />
      </span>
      <span className="mg-marker-rail-track">
        <span className="mg-marker-rail-ticks" aria-hidden="true">
          {SCALE_INTERVALS.map((interval) => (
            <b key={interval} />
          ))}
        </span>
        <Skeleton className="h-full w-full" />
      </span>
    </div>
  );
}

function MarkerRow({
  item,
  max,
  formatValue,
  source,
  onActivate,
}: {
  item: MarkerRailItem;
  max: number;
  formatValue: (v: number) => string;
  source: string;
  onActivate?: (item: MarkerRailItem) => void;
}) {
  const pos = markerPosition(item.value, max);
  const shown =
    item.value === null || pos === null ? "—" : formatValue(item.value);
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(item.label, shown === "—" ? null : shown),
    onActivate: item.href
      ? undefined
      : onActivate
        ? () => onActivate(item)
        : undefined,
  });
  const body = (
    <>
      <span className="mg-rails-value">{shown}</span>
      <span className="mg-rails-name">
        {item.avatar ? (
          <span className="mg-rails-avatar">{item.avatar}</span>
        ) : null}
        {item.tag ? <span className="mg-rails-tag">{item.tag}</span> : null}
        <span>{item.label}</span>
      </span>
      <span
        className="mg-marker-rail-track"
        data-empty={pos === null ? "true" : undefined}
      >
        <span className="mg-marker-rail-ticks" aria-hidden="true">
          {SCALE_INTERVALS.map((interval) => (
            <b key={interval} />
          ))}
        </span>
        {pos === null ? null : (
          <i
            className="mg-marker-rail-marker"
            style={{ "--pos": `${pos}%` } as CSSProperties}
          />
        )}
      </span>
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
