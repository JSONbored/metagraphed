interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * Tiny inline-SVG sparkline. Accepts any numeric series; flat / single-point
 * input renders a horizontal baseline rather than blowing up.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = "var(--accent, #7aa2ff)",
  fill = true,
  className,
  ariaLabel,
}: Props) {
  const pts = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (pts.length === 0) {
    return (
      <svg width={width} height={height} className={className} aria-label={ariaLabel}>
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
  const min = Math.min(...pts);
  const max = Math.max(...pts);
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

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel}
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
    </svg>
  );
}
