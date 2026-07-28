import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { STACKED_AREA_EMPTY_ARIA_LABEL } from "./chart-aria";

export interface StackedAreaSeries {
  id: string;
  label: string;
  /** One value per x-slot; series are aligned by index. Non-finite values
   * read as 0 (a gap in one band must not tear the whole stack). */
  values: number[];
  color: string;
}

export interface StackedAreaLayoutBand {
  id: string;
  /** Per-slot [lower, upper] stacked values (data space, not pixels). */
  lower: number[];
  upper: number[];
}

const MAX_SLOTS = 500;

/**
 * Stack the series bottom-up in the order given. Pure and exported for
 * tests, like layoutSankey/candlestick-geometry. Negative and non-finite
 * values clamp to 0 -- these are holdings bands, not signed deltas.
 */
export function layoutStackedArea(series: StackedAreaSeries[]): {
  bands: StackedAreaLayoutBand[];
  totals: number[];
  max: number;
  slots: number;
} {
  const slots = Math.min(
    MAX_SLOTS,
    series.reduce((n, s) => Math.max(n, s.values.length), 0),
  );
  const running = new Array<number>(slots).fill(0);
  const bands: StackedAreaLayoutBand[] = [];
  for (const s of series) {
    const lower = [...running];
    for (let i = 0; i < slots; i++) {
      const idx = s.values.length - slots + i;
      const raw = idx >= 0 && idx < s.values.length ? s.values[idx] : 0;
      const v =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
      running[i] = running[i]! + v;
    }
    bands.push({ id: s.id, lower, upper: [...running] });
  }
  let max = 0;
  for (const t of running) if (t > max) max = t;
  return { bands, totals: running, max, slots };
}

interface Props {
  series: StackedAreaSeries[];
  /** Optional aligned x labels (e.g. dates) for the hover tooltip. */
  labels?: string[];
  width?: number;
  height?: number;
  className?: string;
  ariaLabel?: string;
  formatValue?: (v: number) => string;
  interactive?: boolean;
}

/**
 * Small stacked-area chart -- the composition-over-time sibling of
 * `Sparkline` (single series) and `BarMini` (categorical), added for #8370's
 * holdings-history view. Same conventions as the other minis: `var(--*)`
 * token colors supplied by the caller, `role="img"` with a synthesized or
 * caller-provided aria-label, an empty-state placeholder instead of
 * rendering nothing silently, and Sparkline's pointer/keyboard hover
 * affordance showing the per-band breakdown at a slot.
 */
export function StackedAreaMini({
  series,
  labels,
  width = 560,
  height = 160,
  className,
  ariaLabel,
  formatValue,
  interactive = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const drawable = series.filter((s) =>
    s.values.some((v) => Number.isFinite(v) && v > 0),
  );
  const { bands, totals, max, slots } = layoutStackedArea(drawable);

  if (drawable.length === 0 || slots === 0 || max <= 0) {
    return (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`block w-full ${className ?? ""}`}
        role="img"
        aria-label={ariaLabel ?? STACKED_AREA_EMPTY_ARIA_LABEL}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border)"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const padTop = 4;
  const padBottom = 2;
  const innerHeight = height - padTop - padBottom;
  const step = slots > 1 ? width / (slots - 1) : 0;
  const xAt = (i: number) => (slots === 1 ? width / 2 : i * step);
  const yAt = (v: number) => padTop + innerHeight - (v / max) * innerHeight;

  const paths = bands.map((band) => {
    const upper = band.upper.map((v, i) => [xAt(i), yAt(v)] as const);
    const lower = band.lower.map((v, i) => [xAt(i), yAt(v)] as const).reverse();
    const d =
      upper
        .map(
          ([x, y], i) =>
            `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
        )
        .join(" ") +
      " " +
      lower.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
      " Z";
    return { id: band.id, d };
  });

  const canTooltip = interactive && slots > 1;

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canTooltip) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    setHover(Math.round((x / rect.width) * (slots - 1)));
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!canTooltip) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setHover((prev) => Math.min(slots - 1, (prev ?? -1) + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((prev) => Math.max(0, (prev ?? slots) - 1));
    }
  }

  const fmt = formatValue ?? ((v: number) => String(v));
  const hoverX = hover != null ? xAt(hover) : null;
  const hoverLines =
    hover != null
      ? [
          ...(labels?.[hover] ? [labels[hover]!] : []),
          ...drawable
            .map((s, bi) => {
              const size = bands[bi]!.upper[hover]! - bands[bi]!.lower[hover]!;
              return size > 0 ? `${s.label}: ${fmt(size)}` : null;
            })
            .filter((line): line is string => line != null),
          `Total: ${fmt(totals[hover]!)}`,
        ]
      : [];

  const resolvedAriaLabel =
    ariaLabel ??
    `Stacked area chart: ${drawable.map((s) => s.label).join(", ")} over ${slots} points`;

  return (
    <div
      ref={wrapRef}
      className={`relative block w-full ${className ?? ""}`}
      // No maxWidth clamp, unlike Sparkline: that primitive is sized for an
      // inline table cell, this one is a full-panel chart -- capping it at
      // the viewBox width left it short of its container's right edge, which
      // reads as a broken/misaligned chart rather than a deliberate size.
      // `width` stays the viewBox coordinate space (preserveAspectRatio
      // "none" stretches it to whatever the container actually is).
      style={{ width: "100%", height }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (canTooltip) setHover((prev) => prev ?? 0);
      }}
      onBlur={() => setHover(null)}
      tabIndex={canTooltip ? 0 : undefined}
      aria-label={
        canTooltip
          ? `${resolvedAriaLabel}, use arrow keys to step through values`
          : undefined
      }
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={resolvedAriaLabel}
        className="block w-full"
      >
        {paths.map((p, i) => (
          <path key={p.id} d={p.d} fill={drawable[i]!.color} opacity={0.75}>
            <title>{drawable[i]!.label}</title>
          </path>
        ))}
        {hoverX != null ? (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={0}
            y2={height}
            stroke="var(--ink-muted)"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
        ) : null}
      </svg>
      {hoverX != null && hoverLines.length > 0 ? (
        <div
          className="pointer-events-none absolute z-[var(--mg-z-sticky)] -translate-x-1/2 -translate-y-full rounded border border-border bg-paper px-1.5 py-1 mg-type-data-sm leading-tight text-ink-strong shadow-sm whitespace-nowrap"
          // Percentage, not px: the SVG stretches to the container's real
          // width, so `hoverX` (a viewBox coordinate) only maps back onto
          // screen space as a fraction of `width`.
          style={{
            left: `${Math.max(8, Math.min(92, (hoverX / width) * 100))}%`,
            top: height * 0.35,
          }}
          role="tooltip"
        >
          {hoverLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {hoverLines.join(", ")}
      </span>
    </div>
  );
}
