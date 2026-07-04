import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export interface SparklinePoint {
  /** Timestamp label, e.g. "12:40 UTC" */
  t: string;
  v: number;
}

const MAX_SPARKLINE_POINTS = 500;

interface Props {
  values: number[];
  /** Optional aligned labels for hover tooltip. Must match `values.length`. */
  points?: SparklinePoint[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Format value for the tooltip (e.g. (v) => `${v.toFixed(1)}%`). */
  formatValue?: (v: number) => string;
  /** Disable interactive tooltip when false. */
  interactive?: boolean;
}

/**
 * Tiny inline-SVG sparkline. Accepts any numeric series; flat / single-point
 * input renders a horizontal baseline rather than blowing up.
 *
 * When `points` and `formatValue` are supplied and `interactive` is true,
 * hovering shows a vertical guide + dot + tooltip with the value at cursor.
 */
export function Sparkline({
  values,
  points,
  width = 120,
  height = 28,
  color = "var(--accent, #7aa2ff)",
  fill = true,
  className,
  ariaLabel,
  formatValue,
  interactive = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const pts = values
    .slice(-MAX_SPARKLINE_POINTS)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (pts.length === 0) {
    return (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`block max-w-full ${className ?? ""}`}
        style={{ maxWidth: width }}
        aria-label={ariaLabel}
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
  let min = pts[0]!;
  let max = pts[0]!;
  for (const value of pts) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min || 1;
  const step = pts.length > 1 ? width / (pts.length - 1) : 0;
  const coords = pts.map((v, i) => {
    const x = pts.length === 1 ? width / 2 : i * step;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return [x, y] as const;
  });
  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${coords[coords.length - 1]![0].toFixed(1)},${height} L0,${height} Z`;

  const canTooltip = interactive && pts.length > 1;

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canTooltip) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const idx = Math.round((x / rect.width) * (pts.length - 1));
    setHover(idx);
  }

  const hoverPoint = hover != null ? coords[hover] : null;
  const hoverValue = hover != null ? pts[hover] : null;
  const hoverLabel = hover != null ? points?.[hover]?.t : undefined;
  const tooltipText =
    hoverValue != null
      ? `${hoverLabel ? `${hoverLabel} · ` : ""}${formatValue ? formatValue(hoverValue) : hoverValue}`
      : "";

  return (
    <div
      ref={wrapRef}
      className={`relative block w-full ${className ?? ""}`}
      style={{ width: "100%", maxWidth: width, height }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        className="block w-full"
      >
        {fill ? <path d={area} fill={color} opacity={0.12} /> : null}
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverPoint ? (
          <>
            <line
              x1={hoverPoint[0]}
              x2={hoverPoint[0]}
              y1={0}
              y2={height}
              stroke="var(--ink-muted)"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            <circle cx={hoverPoint[0]} cy={hoverPoint[1]} r={2.5} fill={color} />
          </>
        ) : null}
      </svg>
      {hoverPoint && tooltipText ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] leading-tight text-ink-strong shadow-sm whitespace-nowrap"
          style={{
            left: Math.max(24, Math.min(width - 24, hoverPoint[0])),
            top: hoverPoint[1] - 4,
          }}
          role="tooltip"
        >
          {tooltipText}
        </div>
      ) : null}
    </div>
  );
}
