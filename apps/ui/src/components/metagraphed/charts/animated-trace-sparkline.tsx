import { useEffect, useId, useMemo, useRef, useState } from "react";

export type TraceDirection = "up" | "down" | "flat";

interface Props {
  values: number[];
  width?: number;
  height?: number;
  /** When it changes, the trace animation replays. Pass slide index / metric key. */
  animateKey?: string | number;
  direction?: TraceDirection;
  ariaLabel?: string;
  className?: string;
  /** Trace duration in ms. Respects prefers-reduced-motion. */
  durationMs?: number;
}

const COLOR_BY_DIRECTION: Record<TraceDirection, string> = {
  up: "var(--health-ok)",
  down: "var(--health-down)",
  flat: "var(--ink-muted)",
};

/** Percentile clamp so a single outlier doesn't flatten the whole series. */
function clampToPercentile(values: number[], lo = 0.05, hi = 0.95): number[] {
  if (values.length < 4) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const loV = sorted[Math.floor(sorted.length * lo)];
  const hiV = sorted[Math.floor(sorted.length * hi)];
  return values.map((v) => Math.max(loV, Math.min(hiV, v)));
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolation → produces a smooth curve
 * through every point without the overshoot of naive Catmull–Rom. Returns an
 * SVG path `d` string starting with a Move to the first point.
 */
function monotoneCubicPath(pts: ReadonlyArray<readonly [number, number]>): string {
  const n = pts.length;
  if (n < 2) return "";
  if (n === 2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;

  const dx: number[] = new Array(n - 1);
  const dy: number[] = new Array(n - 1);
  const m: number[] = new Array(n - 1); // slopes between points
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dy[i] / (dx[i] || 1);
  }

  // Tangents at each point
  const t: number[] = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0;
    else t[i] = (m[i - 1] + m[i]) / 2;
  }
  // Fritsch–Carlson monotone correction
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i] / m[i];
      const b = t[i + 1] / m[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const factor = 3 / h;
        t[i] = factor * a * m[i];
        t[i + 1] = factor * b * m[i];
      }
    }
  }

  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const cp1x = pts[i][0] + dx[i] / 3;
    const cp1y = pts[i][1] + (t[i] * dx[i]) / 3;
    const cp2x = pts[i + 1][0] - dx[i] / 3;
    const cp2y = pts[i + 1][1] - (t[i + 1] * dx[i]) / 3;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${pts[i + 1][0].toFixed(2)} ${pts[i + 1][1].toFixed(2)}`;
  }
  return d;
}

/**
 * Sparkline that traces left→right on mount / when `animateKey` changes,
 * with a stroke color tied to the direction of the series (green/red/neutral)
 * and a soft area fill under the line. Uses monotone-cubic interpolation for
 * a natural, unhurried curve and clamps outliers to the 5–95 percentile so a
 * single spike doesn't flatten the rest of the data.
 */
export function AnimatedTraceSparkline({
  values,
  width = 640,
  height = 180,
  animateKey,
  direction = "flat",
  ariaLabel,
  className,
  durationMs = 2000,
}: Props) {
  const gradId = useId();
  const clean = useMemo(
    () => clampToPercentile(values.filter((v) => Number.isFinite(v))),
    [values],
  );
  const pathRef = useRef<SVGPathElement | null>(null);
  const [pathLen, setPathLen] = useState<number>(0);
  const [drawn, setDrawn] = useState<boolean>(false);

  const { linePath, areaPath, tail } = useMemo(() => {
    const padTop = 14;
    const padBottom = 10;
    if (clean.length < 2) {
      const y = height / 2;
      return {
        linePath: `M 0 ${y} L ${width} ${y}`,
        areaPath: `M 0 ${height} L 0 ${y} L ${width} ${y} L ${width} ${height} Z`,
        tail: [width, y] as const,
      };
    }
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const span = max - min || 1;
    const stepX = width / (clean.length - 1);
    const usableH = height - padTop - padBottom;
    const coords = clean.map((v, i) => {
      const x = i * stepX;
      const y = padTop + usableH - ((v - min) / span) * usableH;
      return [x, y] as const;
    });
    const line = monotoneCubicPath(coords);
    const area = `${line} L ${width} ${height} L 0 ${height} Z`;
    return { linePath: line, areaPath: area, tail: coords[coords.length - 1] };
  }, [clean, width, height]);

  // Re-measure and replay when animateKey changes.
  useEffect(() => {
    const node = pathRef.current;
    if (!node) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setDrawn(false);
    const len = node.getTotalLength();
    setPathLen(len);
    if (reduced) {
      setDrawn(true);
      return;
    }
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(raf);
  }, [linePath, animateKey]);

  const color = COLOR_BY_DIRECTION[direction];
  const easing = "cubic-bezier(0.22, 0.61, 0.36, 1)";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`block h-full w-full ${className ?? ""}`}
      role="img"
      aria-label={ariaLabel ?? "trend sparkline"}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.24} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path
        d={areaPath}
        fill={`url(#${gradId})`}
        opacity={drawn ? 1 : 0}
        style={{
          transition: `opacity ${durationMs * 0.7}ms ${easing} ${durationMs * 0.35}ms`,
        }}
      />
      <path
        ref={pathRef}
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{
          strokeDasharray: pathLen || 1,
          strokeDashoffset: drawn ? 0 : pathLen || 1,
          transition: `stroke-dashoffset ${durationMs}ms ${easing}`,
        }}
      />
      {/* Trailing endpoint dot — fades in as the trace completes. */}
      <circle
        cx={tail[0]}
        cy={tail[1]}
        r={3}
        fill={color}
        opacity={drawn ? 1 : 0}
        style={{
          transition: `opacity 400ms ease-out ${durationMs * 0.85}ms`,
        }}
      />
      <circle
        cx={tail[0]}
        cy={tail[1]}
        r={6}
        fill={color}
        opacity={drawn ? 0.18 : 0}
        style={{
          transition: `opacity 500ms ease-out ${durationMs * 0.85}ms`,
        }}
      />
    </svg>
  );
}

export function directionFor(values: number[]): TraceDirection {
  if (values.length < 2) return "flat";
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const scale = Math.max(Math.abs(first), Math.abs(last), 1);
  const pct = delta / scale;
  if (pct > 0.005) return "up";
  if (pct < -0.005) return "down";
  return "flat";
}
