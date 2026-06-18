import { useId } from "react";

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface Props {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
  centerSub?: string;
  className?: string;
}

/**
 * Minimal SVG donut. No external dependency. Segments are rendered as
 * stroked arcs on a single circle using `pathLength`-style math.
 */
export function Donut({
  segments,
  size = 96,
  strokeWidth = 12,
  centerLabel,
  centerSub,
  className,
}: Props) {
  const id = useId();
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div
      className={className}
      style={{ width: size, height: size, position: "relative", flexShrink: 0 }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeWidth}
          opacity={0.4}
        />
        {total > 0
          ? segments.map((s, i) => {
              const len = (Math.max(0, s.value) / total) * circumference;
              const dasharray = `${len} ${circumference - len}`;
              const dashoffset = -offset;
              offset += len;
              return (
                <circle
                  key={`${id}-${i}`}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dasharray}
                  strokeDashoffset={dashoffset}
                  strokeLinecap="butt"
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              );
            })
          : null}
      </svg>
      {centerLabel || centerSub ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          {centerLabel ? (
            <span className="font-display text-base font-semibold tabular-nums text-ink-strong leading-none">
              {centerLabel}
            </span>
          ) : null}
          {centerSub ? (
            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-muted mt-0.5">
              {centerSub}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DonutLegend({ segments }: { segments: DonutSegment[] }) {
  return (
    <ul className="space-y-1">
      {segments.map((s) => (
        <li
          key={s.label}
          className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted"
        >
          <span
            aria-hidden
            className="inline-block size-2 rounded-sm"
            style={{ background: s.color }}
          />
          <span className="text-ink">{s.label}</span>
          <span className="ml-auto tabular-nums text-ink-strong">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}
