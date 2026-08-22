import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { classNames } from "@/lib/format";
import { useActiveEntity, useEntityMark } from "../interaction/active-entity";
import { ChartTooltip } from "../interaction/chart-tooltip";
import { markAriaLabel } from "./chart-aria";
import {
  OTHER_KEY,
  SeriesPaletteRegistry,
  collapseOther,
  type SeriesPalette,
} from "./series-palette";

/**
 * The temporal composition chart (#11608), built to the measured grammar of
 * opencode.ai/data's "Top Models": one column per period, segments stacked
 * by series on a dotted lane, a rotated label cadence above, and the page's
 * active-entity store driving emphasis — hovering a segment makes its
 * series the active entity, and every other series in every column turns
 * `--chart-idle` (the reference recolours, it does not fade).
 *
 * Columns are entity marks (`useEntityMark(column.key)`), so the roving
 * Tab stop, Arrow Left/Right and Escape come from the store; Arrow Up/Down
 * walks the focused column's segments. A visually hidden `<table>` carries
 * the same numbers.
 */
export interface StackedSegment {
  key: string;
  label: string;
  value: number;
}

export interface StackedColumn {
  key: string;
  /** Full label for the tooltip, the table and the accessible name. */
  label: string;
  /** Short rotated axis text; defaults to `label`. */
  axisLabel?: string;
  total: number;
  segments: readonly StackedSegment[];
}

export interface StackedColumnsProps {
  id?: string;
  columns: readonly StackedColumn[];
  /** Which series take a swatch, in ramp order; the rest collapse into Other. */
  seriesOrder: readonly string[];
  /** Shared registry so the same key keeps its colour across the page. */
  registry?: SeriesPaletteRegistry;
  /** Label for the collapsed residual series. */
  other?: string;
  formatValue?: (value: number) => string;
  /** Table caption / group name, e.g. "Daily emission by subnet". */
  ariaLabel: string;
  /** Entity key namespace for columns; series keys are used as-is. */
  columnSource?: string;
  className?: string;
}

const defaultFormat = (v: number) => String(v);
/** The measured column width; the gap flexes, the bar never does. */
const BAR_PX = 15;

export function StackedColumns({
  id,
  columns,
  seriesOrder,
  registry,
  other = OTHER_KEY,
  formatValue = defaultFormat,
  ariaLabel,
  columnSource = "stacked-columns",
  className,
}: StackedColumnsProps) {
  const ownRegistry = useRef<SeriesPaletteRegistry | null>(null);
  if (!registry && !ownRegistry.current)
    ownRegistry.current = new SeriesPaletteRegistry();
  const reg = registry ?? ownRegistry.current!;
  reg.assign(seriesOrder);
  const palette = reg.palette();

  const rows = useMemo(
    () =>
      columns.map((c) => ({
        ...c,
        segments: collapseOther(c.segments, reg, other),
      })),
    [columns, reg, other],
  );
  const seriesKeys = useMemo(() => {
    const keys = reg
      .keys()
      .filter((k) => rows.some((r) => r.segments.some((s) => s.key === k)));
    if (rows.some((r) => r.segments.some((s) => s.key === OTHER_KEY)))
      keys.push(OTHER_KEY);
    return keys;
  }, [reg, rows]);

  const { active } = useActiveEntity();
  const activeSeries =
    active && seriesKeys.includes(active.key) ? active.key : null;

  // From the rendered width: the column gap the reference uses at this
  // density (12px, 8px when that no longer fits, 6px as the floor -- only
  // then does the plot scroll), and the label cadence (weekly from 768px,
  // fortnightly below).
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cadence, setCadence] = useState(7);
  const [gap, setGap] = useState(12);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const width = el.clientWidth;
      setCadence(width >= 768 ? 7 : 14);
      const pitch = width / Math.max(1, rows.length);
      setGap(pitch >= BAR_PX + 12 ? 12 : pitch >= BAR_PX + 8 ? 8 : 6);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);
  // Latest period on the right on mount.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [rows.length]);

  const max = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div
      id={id}
      className={classNames("mg-stack", className)}
      data-mg-stack=""
      data-series-active={activeSeries ? "true" : undefined}
      style={
        {
          "--mg-stack-count": rows.length,
          "--mg-stack-gap": `${gap}px`,
        } as CSSProperties
      }
    >
      {/* Outside the scroller, so neither its clip nor its scroll offset
          touches the tooltip; it still anchors to the active column. */}
      <ChartTooltip top={110} />
      <div ref={scrollRef} className="mg-stack-scroll">
        <div className="mg-stack-chart">
          <div className="mg-stack-axis" aria-hidden="true">
            {rows.map((c, i) => (
              <div
                key={c.key}
                data-entity={c.key}
                data-active={active?.key === c.key ? "true" : undefined}
                data-label-hidden={i % cadence !== 0 ? "true" : undefined}
              >
                <span className="mg-stack-axis-label">
                  <span className="mg-stack-axis-total">
                    {formatValue(c.total)}
                  </span>
                  <span>{c.axisLabel ?? c.label}</span>
                </span>
              </div>
            ))}
          </div>
          <div
            className="mg-stack-bars"
            role="group"
            aria-label={ariaLabel}
            data-marks
          >
            {rows.map((c) => (
              <Column
                key={c.key}
                column={c}
                max={max}
                palette={palette}
                activeSeries={activeSeries}
                formatValue={formatValue}
                source={columnSource}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="mg-sr-table">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Total</th>
              {seriesKeys.map((k) => (
                <th key={k} scope="col">
                  {k === OTHER_KEY
                    ? other
                    : (rows.flatMap((r) => r.segments).find((s) => s.key === k)
                        ?.label ?? k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}</th>
                <td>{formatValue(c.total)}</td>
                {seriesKeys.map((k) => (
                  <td key={k}>
                    {formatValue(
                      c.segments.find((s) => s.key === k)?.value ?? 0,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Column({
  column: c,
  max,
  palette,
  activeSeries,
  formatValue,
  source,
}: {
  column: StackedColumn;
  max: number;
  palette: SeriesPalette;
  activeSeries: string | null;
  formatValue: (v: number) => string;
  source: string;
}) {
  const { set } = useActiveEntity();
  const [focusedSeries, setFocusedSeries] = useState<number>(-1);
  const data = useMemo(
    () => ({
      title: c.label,
      total: `${formatValue(c.total)} total`,
      rows: c.segments.map((s) => ({
        key: s.key,
        label: s.label,
        value: formatValue(s.value),
        swatch: palette.colorOf(s.key),
      })),
    }),
    [c, formatValue, palette],
  );
  const mark = useEntityMark(c.key, {
    source,
    label: markAriaLabel(c.label, formatValue(c.total)),
    data,
  });
  const elRef = useRef<Element | null>(null);
  const ref = useCallback(
    (el: Element | null) => {
      elRef.current = el;
      mark.ref(el);
    },
    [mark],
  );
  const onKeyDown = (event: KeyboardEvent<Element>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const n = c.segments.length;
      if (n === 0) return;
      const next =
        event.key === "ArrowUp"
          ? (focusedSeries + 1) % n
          : (focusedSeries - 1 + n) % n;
      setFocusedSeries(next);
      const s = c.segments[next]!;
      set({ key: s.key, source, element: elRef.current, data });
      return;
    }
    mark.onKeyDown(event);
  };
  const onBlur = (event: React.FocusEvent<Element>) => {
    setFocusedSeries(-1);
    mark.onBlur(event);
  };
  const height = `${(c.total / max) * 100}%`;
  const rowsTemplate = c.segments
    .map((s) => `${c.total > 0 ? (s.value / c.total) * 100 : 0}%`)
    .join(" ");
  return (
    <button
      type="button"
      {...mark}
      ref={ref}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className="mg-stack-col"
      style={
        {
          "--mg-stack-h": height,
          "--mg-stack-rows": rowsTemplate,
        } as CSSProperties
      }
    >
      <span className="mg-stack-stack" aria-hidden="true">
        {c.segments.map((s) => (
          <i
            key={s.key}
            data-entity={s.key}
            data-active={activeSeries === s.key ? "true" : undefined}
            data-dim={
              activeSeries && activeSeries !== s.key ? "true" : undefined
            }
            style={{ "--swatch": palette.colorOf(s.key) } as CSSProperties}
            onPointerEnter={(event) => {
              if (event.pointerType === "touch") return;
              set({ key: s.key, source, element: elRef.current, data });
            }}
          />
        ))}
      </span>
    </button>
  );
}

export function stackedSpecimen(): {
  columns: StackedColumn[];
  seriesOrder: string[];
} {
  const series = [
    "Apex",
    "Targon",
    "Chutes",
    "Affine",
    "Score",
    "Nineteen",
    "Bitmind",
    "Gradients",
    "Macrocosmos",
    "Omron",
    "Vidaio",
    "Dippy",
  ];
  const columns: StackedColumn[] = Array.from({ length: 56 }, (_, i) => {
    const segments = series.map((name, j) => ({
      key: name,
      label: name,
      value: Math.round(40 + 30 * Math.sin((i + j * 3) / 5) + j * 4),
    }));
    const total = segments.reduce((a, s) => a + s.value, 0);
    const d = new Date(Date.UTC(2026, 5, 28) + i * 86_400_000);
    const label = d
      .toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
      .toUpperCase();
    return { key: `d${i}`, label, axisLabel: label, total, segments };
  });
  return { columns, seriesOrder: series.slice(0, 8) };
}
