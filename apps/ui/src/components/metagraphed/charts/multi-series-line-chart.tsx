import { useId } from "react";
import type { OverlaySeries } from "@/lib/metagraphed/compare-overlay-series";

// #6885: a compact multi-series line chart — the one primitive the metagraphed
// chart stack was missing (Sparkline is single-series and index-scaled). Draws N
// pre-aligned series (see buildOverlaySeries) on one shared linear scale: one
// <path> per subnet over a shared x (index into the shared date axis) and a
// shared y (the [min,max] span across all series), breaking each line on null
// gaps rather than interpolating across missing snapshots. Presentation only —
// all alignment/scaling is done upstream in the pure helper.

const PAD_X = 6;
const PAD_Y = 8;

function xAt(index: number, count: number, width: number): number {
  const inner = width - PAD_X * 2;
  if (count <= 1) return PAD_X + inner / 2;
  return PAD_X + (index / (count - 1)) * inner;
}

function yAt(value: number, min: number, max: number, height: number): number {
  const inner = height - PAD_Y * 2;
  if (max <= min) return PAD_Y + inner / 2;
  return PAD_Y + (1 - (value - min) / (max - min)) * inner;
}

// Build an SVG path, starting a fresh subpath (M) after every null gap so a
// subnet missing a day's snapshot leaves a break instead of a straight jump.
function linePath(
  values: (number | null)[],
  min: number,
  max: number,
  width: number,
  height: number,
): string {
  const count = values.length;
  let d = "";
  let penDown = false;
  for (let i = 0; i < count; i += 1) {
    const value = values[i];
    if (value == null) {
      penDown = false;
      continue;
    }
    const x = xAt(i, count, width).toFixed(2);
    const y = yAt(value, min, max, height).toFixed(2);
    d += `${penDown ? "L" : "M"}${x} ${y} `;
    penDown = true;
  }
  return d.trim();
}

export function MultiSeriesLineChart({
  series,
  dateCount,
  min,
  max,
  width = 640,
  height = 200,
  ariaLabel = "Multi-subnet history overlay",
}: {
  series: OverlaySeries[];
  dateCount: number;
  min: number;
  max: number;
  width?: number;
  height?: number;
  ariaLabel?: string;
}) {
  const titleId = useId();
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-labelledby={titleId}
      preserveAspectRatio="none"
      className="overflow-visible"
    >
      <title id={titleId}>{ariaLabel}</title>
      {/* Baseline (min) + top (max) guide lines, hairline. */}
      <line
        x1={PAD_X}
        y1={height - PAD_Y}
        x2={width - PAD_X}
        y2={height - PAD_Y}
        stroke="var(--border)"
        strokeWidth={1}
      />
      {series.map((line) =>
        line.hasData ? (
          <path
            key={line.netuid}
            d={linePath(line.values, min, max, width, height)}
            fill="none"
            stroke={line.color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
      {/* Single-point subnets can't draw a line; mark them with a dot so a lone
          snapshot still reads as present. */}
      {dateCount === 1
        ? series.map((line) =>
            line.hasData && line.values[0] != null ? (
              <circle
                key={`dot-${line.netuid}`}
                cx={xAt(0, 1, width)}
                cy={yAt(line.values[0], min, max, height)}
                r={2.5}
                fill={line.color}
              />
            ) : null,
          )
        : null}
    </svg>
  );
}
