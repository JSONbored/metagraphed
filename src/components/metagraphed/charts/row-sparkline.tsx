import { useId, useMemo } from "react";

interface Props {
  /** Numeric trend series. Empty/missing → flat baseline. */
  values?: number[] | null;
  /** Fallback seed used to synthesize a deterministic pseudo-trend
   *  when no series is provided, so each row has a visually distinct
   *  but stable shape across renders. */
  seed?: number;
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  ariaLabel?: string;
  /** When true, draws an area fill below the line. */
  fill?: boolean;
}

/**
 * Inline 48×16-ish SVG sparkline used in dense leaderboard rows.
 * Pure SVG, no interaction — animated stroke draw on mount via CSS
 * (respects prefers-reduced-motion).
 */
export function RowSparkline({
  values,
  seed = 0,
  width = 56,
  height = 18,
  color = "var(--ink-muted)",
  className,
  ariaLabel,
  fill = true,
}: Props) {
  const id = useId();

  const series = useMemo(() => {
    if (values && values.length >= 2) return values;
    // Deterministic pseudo-trend from seed — never empty, never flat.
    const n = 14;
    const a = (seed * 9301 + 49297) % 233280;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const wave =
        Math.sin((t + (a % 100) / 100) * Math.PI * 2) * 0.45 +
        Math.sin((t + (a % 37) / 37) * Math.PI * 4) * 0.25;
      out.push(0.5 + wave * 0.35);
    }
    return out;
  }, [values, seed]);

  const { path, area } = useMemo(() => {
    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = max - min || 1;
    const stepX = width / Math.max(1, series.length - 1);
    const pts = series.map((v, i) => {
      const x = i * stepX;
      const y = height - 2 - ((v - min) / range) * (height - 4);
      return [x, y] as const;
    });
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
      .join(" ");
    const a = `${d} L${width},${height} L0,${height} Z`;
    return { path: d, area: a };
  }, [series, width, height]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role={ariaLabel ? "img" : "presentation"}
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={`rsg-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#rsg-${id})`} />
        </>
      )}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mg-row-spark-line"
      />
    </svg>
  );
}
