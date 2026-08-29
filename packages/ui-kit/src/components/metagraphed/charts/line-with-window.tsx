import { useMemo, useRef, type CSSProperties } from "react";
import { classNames } from "@/lib/format";
import { Skeleton } from "../skeleton";
import { useActiveEntity, useEntityMark } from "../interaction/active-entity";
import { ChartTooltip } from "../interaction/chart-tooltip";
import { markAriaLabel, momentumAriaLabel } from "./chart-aria";
import {
  LINE_VIEWBOX,
  monthTicks,
  placePoints,
  smoothPath,
  windowDelta,
  windowPoints,
  type LinePoint,
  type LineWindow,
} from "./line-geometry";

/**
 * The single-series history chart (#11608): the full history as a muted
 * 1.5px line, the selected window re-drawn over it in the accent, three 6px
 * square markers (history start, window start, window end), a delta chip
 * hanging off the window end, a months row beneath -- and nothing else: no
 * gridlines, no area fill, no y-axis. The summary above the plot carries the
 * window-end value and the same chip.
 *
 * Every point is an entity mark: hovering or arrowing along the plot sets
 * the page's active entity to that point's key, draws a cursor at its x, and
 * the `ChartTooltip` shows its date and value. A visually hidden `<table>`
 * carries the numbers.
 */
export interface LineWithWindowProps {
  id?: string;
  points: readonly LinePoint[];
  window: LineWindow;
  /** What the series counts, for the summary and the accessible name: "tokens", "TAO". */
  unit: string;
  formatValue?: (value: number) => string;
  /** Tooltip title / table label for a point. Defaults to an en-US "AUG 22" date. */
  formatDate?: (t: number) => string;
  /** The window's extent for the summary and the accessible name; defaults to dates. */
  formatRange?: (from: number, to: number) => string;
  /** Group name for the plot and caption for the table. */
  ariaLabel: string;
  /** Entity key for a point; defaults to `${source}:${t}`. */
  keyOf?: (point: LinePoint) => string;
  /** Entity source namespace. */
  source?: string;
  /** 120px plot, no summary, no months row -- the in-strip variant. */
  compact?: boolean;
  /**
   * A `t` to rule vertically, for a window drawn AROUND one subject (#11621):
   * /blocks/$ref plots the block time either side of the block it is about,
   * and without the rule the reader cannot tell which of a hundred points is
   * the one they navigated to. Distinct from the hover cursor, which the
   * reader controls and which supersedes it while it is up.
   */
  marker?: number;
  /** Accessible name for the marker rule; required whenever `marker` is set. */
  markerLabel?: string;
  className?: string;
  /** Reserve the summary and plot geometry until a time-series source answers. */
  loading?: boolean;
  /** Anchor non-negative count series to zero instead of exaggerating a narrow extent. */
  zeroBaseline?: boolean;
  /** Draw the line on mount; pair with a keyed metric switch to replay the transition. */
  animate?: boolean;
}

const defaultFormat = (v: number) => String(v);
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
export const formatLineDate = (t: number) =>
  dateFormat.format(new Date(t)).toUpperCase();
const rangeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function LineWithWindow({
  id,
  points,
  window,
  unit,
  formatValue = defaultFormat,
  formatDate = formatLineDate,
  formatRange,
  ariaLabel,
  keyOf,
  source = "line",
  compact = false,
  marker,
  markerLabel,
  className,
  loading = false,
  zeroBaseline = false,
  animate = false,
}: LineWithWindowProps) {
  const placed = useMemo(
    () => placePoints(points, LINE_VIEWBOX, { zeroBaseline }),
    [points, zeroBaseline],
  );
  const inside = useMemo(() => windowPoints(placed, window), [placed, window]);
  const delta = useMemo(() => windowDelta(points, window), [points, window]);
  const months = useMemo(() => monthTicks(points), [points]);
  const keyFor = keyOf ?? ((p: LinePoint) => `${source}:${p.t}`);

  const { active } = useActiveEntity();
  const activePoint = active
    ? placed.find((p) => keyFor(p) === active.key)
    : undefined;

  if (loading) {
    return (
      <LineSkeleton
        id={id}
        ariaLabel={ariaLabel}
        compact={compact}
        className={className}
      />
    );
  }

  const markerPoint =
    typeof marker === "number" ? placed.find((p) => p.t === marker) : undefined;
  const first = placed[0];
  const wStart = inside[0];
  const wEnd = inside[inside.length - 1];
  const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(2)}%`;
  const rangeLabel =
    wStart && wEnd
      ? formatRange
        ? formatRange(wStart.t, wEnd.t)
        : `${rangeFormat.format(new Date(wStart.t)).toUpperCase()} → ${rangeFormat.format(new Date(wEnd.t)).toUpperCase()}`
      : "";
  const summary = momentumAriaLabel(
    unit,
    wEnd ? formatValue(wEnd.v) : null,
    delta.label,
    rangeLabel,
  );

  return (
    <div
      id={id}
      className={classNames("mg-line", className)}
      data-mg-line=""
      data-compact={compact ? "true" : undefined}
      data-state={delta.state}
      data-animate={animate ? "true" : undefined}
    >
      {compact ? null : (
        <div className="mg-line-summary">
          <p className="mg-line-total">
            <strong>{wEnd ? formatValue(wEnd.v) : "—"}</strong>
            <span className="mg-line-delta" data-state={delta.state}>
              {delta.label}
            </span>
          </p>
          <p className="mg-line-range">
            {rangeLabel} · {unit}
          </p>
        </div>
      )}
      <div
        className="mg-line-plot"
        role="group"
        aria-label={summary}
        data-marks
      >
        <ChartTooltip top={compact ? 16 : 110} />
        <svg
          viewBox={`0 0 ${LINE_VIEWBOX.width} ${LINE_VIEWBOX.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path
            className="mg-line-muted"
            d={smoothPath(placed)}
            pathLength="1"
          />
          <path
            className="mg-line-active"
            d={smoothPath(inside)}
            pathLength="1"
          />
          {markerPoint ? (
            <line
              className="mg-line-subject"
              x1={markerPoint.x}
              x2={markerPoint.x}
              y1={0}
              y2={LINE_VIEWBOX.height}
            />
          ) : null}
          {activePoint ? (
            <line
              className="mg-line-cursor"
              x1={activePoint.x}
              x2={activePoint.x}
              y1={0}
              y2={LINE_VIEWBOX.height}
            />
          ) : null}
        </svg>
        {[first, wStart, wEnd]
          .filter((p): p is NonNullable<typeof p> => Boolean(p))
          .map((p, i) => (
            <i
              key={`${i}-${p.t}`}
              className="mg-line-marker"
              data-window={i > 0 ? "true" : undefined}
              style={
                {
                  "--mg-line-x": pct(p.x, LINE_VIEWBOX.width),
                  "--mg-line-y": pct(p.y, LINE_VIEWBOX.height),
                } as CSSProperties
              }
            />
          ))}
        {activePoint ? (
          <i
            className="mg-line-marker mg-line-marker-cursor"
            style={
              {
                "--mg-line-x": pct(activePoint.x, LINE_VIEWBOX.width),
                "--mg-line-y": pct(activePoint.y, LINE_VIEWBOX.height),
              } as CSSProperties
            }
          />
        ) : null}
        {markerPoint && markerLabel ? (
          <i
            className="mg-line-marker mg-line-marker-subject"
            aria-label={markerLabel}
            role="img"
            style={
              {
                "--mg-line-x": pct(markerPoint.x, LINE_VIEWBOX.width),
                "--mg-line-y": pct(markerPoint.y, LINE_VIEWBOX.height),
              } as CSSProperties
            }
          />
        ) : null}
        {wEnd && delta.state !== "empty" ? (
          <span
            className="mg-line-end"
            data-state={delta.state}
            aria-hidden="true"
            style={
              {
                "--mg-line-x": pct(wEnd.x, LINE_VIEWBOX.width),
                "--mg-line-y": pct(wEnd.y, LINE_VIEWBOX.height),
              } as CSSProperties
            }
          >
            {delta.label}
            <i />
          </span>
        ) : null}
        <div className="mg-line-hits">
          {placed.map((p, i) => {
            const left = i === 0 ? 0 : (placed[i - 1]!.x + p.x) / 2;
            const right =
              i === placed.length - 1
                ? LINE_VIEWBOX.width
                : (p.x + placed[i + 1]!.x) / 2;
            return (
              <Hit
                key={p.t}
                entityKey={keyFor(p)}
                label={formatDate(p.t)}
                value={formatValue(p.v)}
                source={source}
                left={pct(left, LINE_VIEWBOX.width)}
                width={pct(right - left, LINE_VIEWBOX.width)}
              />
            );
          })}
        </div>
      </div>
      {compact ? null : (
        <div className="mg-line-months" aria-hidden="true">
          {months.map((m) => (
            <span key={m.pct} style={{ left: `${m.pct}%` }}>
              {m.label}
            </span>
          ))}
        </div>
      )}
      <div className="mg-sr-table">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.t}>
                <th scope="row">{formatDate(p.t)}</th>
                <td>{formatValue(p.v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The real chart's summary, plot, and cadence row without invented values. */
function LineSkeleton({
  id,
  ariaLabel,
  compact,
  className,
}: Pick<LineWithWindowProps, "id" | "ariaLabel" | "compact" | "className">) {
  return (
    <div
      id={id}
      className={classNames("mg-line", className)}
      data-mg-line=""
      data-compact={compact ? "true" : undefined}
      data-loading="true"
    >
      {compact ? null : (
        <div className="mg-line-summary" aria-hidden="true">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-3 w-52 max-w-full" />
        </div>
      )}
      <div
        className="mg-line-plot"
        role="group"
        aria-label={ariaLabel}
        aria-busy="true"
      >
        <span className="sr-only">Loading {ariaLabel}</span>
        <Skeleton className="h-full w-full" />
      </div>
      {compact ? null : <Skeleton className="h-3 w-full" aria-hidden="true" />}
    </div>
  );
}

function Hit({
  entityKey,
  label,
  value,
  source,
  left,
  width,
}: {
  entityKey: string;
  label: string;
  value: string;
  source: string;
  left: string;
  width: string;
}) {
  const elRef = useRef<HTMLButtonElement>(null);
  const mark = useEntityMark(entityKey, {
    source,
    label: markAriaLabel(label, value),
    data: { title: label, total: value },
  });
  return (
    <button
      type="button"
      {...mark}
      ref={(el) => {
        elRef.current = el;
        mark.ref(el);
      }}
      className="mg-line-hit"
      style={{ left, width }}
    />
  );
}

/** A deterministic specimen for /design/primitives and the e2e project. */
export function lineSpecimen(days = 120): {
  points: LinePoint[];
  window: LineWindow;
} {
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 3, 24);
  const points: LinePoint[] = [];
  let v = 40;
  for (let i = 0; i < days; i++) {
    v = Math.max(5, v + Math.sin(i / 9) * 6 + (i % 7 === 0 ? 9 : 1.2));
    points.push({ t: t0 + i * day, v: Math.round(v * 10) / 10 });
  }
  return {
    points,
    window: { from: t0 + (days - 56) * day, to: t0 + (days - 1) * day },
  };
}
