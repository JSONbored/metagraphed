import { useMemo } from "react";
import { EmptyState } from "@/components/metagraphed/states";
import { healthColorVar } from "@/lib/health-tokens";
import {
  formatShare,
  packBubbles,
  type PackedBubble,
} from "@/lib/metagraphed/subnets-bubble-layout";
import type { HealthState, Subnet } from "@/lib/metagraphed/types";

// #6884: cryptobubbles-style PACKED bubble map of /subnets over the same filtered
// list the table renders — bubble AREA = emission share (network weight), COLOUR =
// health, each labelled with its symbol + emission % so you read the registry at a
// glance (which subnets carry the emission, and whether they're healthy) instead
// of scanning sorted rows. Packing + sizing math is in subnets-bubble-layout.ts
// (unit-tested); rendered as a fixed-viewBox SVG so it draws server-side and is
// URL-addressable via ?view=bubble, like the table/grid/matrix views.

const HEALTH_STATES: HealthState[] = ["ok", "warn", "down", "unknown"];

function BubbleLabel({ b }: { b: PackedBubble }) {
  // Only label bubbles big enough to carry legible text; tiny ones stay dots.
  if (b.r < 24) return null;
  const symbolSize = Math.min(b.r * 0.62, 34);
  const shareSize = Math.min(b.r * 0.34, 17);
  return (
    <>
      <text
        x={b.x}
        y={b.y - b.r * 0.06}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={symbolSize}
        fontWeight={600}
        fill="var(--ink-strong)"
        style={{ pointerEvents: "none" }}
      >
        {b.symbol.length > 6 ? `${b.symbol.slice(0, 5)}…` : b.symbol}
      </text>
      <text
        x={b.x}
        y={b.y + b.r * 0.4}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={shareSize}
        fontFamily="monospace"
        fill="var(--ink-muted)"
        style={{ pointerEvents: "none" }}
      >
        {formatShare(b.emissionShare)}
      </text>
    </>
  );
}

export function SubnetsBubbleView({ rows }: { rows: Subnet[] }) {
  const { bubbles, width, height } = useMemo(() => packBubbles(rows), [rows]);

  if (bubbles.length === 0) {
    return (
      <EmptyState
        title="Nothing to plot"
        description="No subnets match the current filter. Adjust the filters or switch back to the table."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block w-full"
          style={{ maxHeight: "70vh" }}
          role="img"
          aria-label="Subnets as bubbles sized by emission share and coloured by health; each labelled with its symbol and emission percent"
        >
          <defs>
            {HEALTH_STATES.map((h) => (
              <radialGradient key={h} id={`bubble-${h}`} cx="50%" cy="45%" r="60%">
                <stop offset="0%" stopColor={healthColorVar(h)} stopOpacity={0.08} />
                <stop offset="100%" stopColor={healthColorVar(h)} stopOpacity={0.34} />
              </radialGradient>
            ))}
          </defs>
          {bubbles.map((b) => (
            <a
              key={b.netuid}
              href={`/subnets/${b.netuid}`}
              aria-label={`${b.name} (${b.symbol}): ${formatShare(b.emissionShare)} emission, ${b.health}`}
            >
              <circle
                cx={b.x}
                cy={b.y}
                r={b.r}
                fill={`url(#bubble-${b.health})`}
                stroke={b.color}
                strokeWidth={1.5}
                strokeOpacity={0.75}
              >
                <title>
                  {b.name} ({b.symbol}) — {formatShare(b.emissionShare)} of network emission,{" "}
                  {b.health}
                </title>
              </circle>
              <BubbleLabel b={b} />
            </a>
          ))}
        </svg>
      </div>
      {/* legend */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-ink-muted">
        {HEALTH_STATES.map((h) => (
          <li key={h} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full"
              style={{ background: healthColorVar(h) }}
            />
            <span className="uppercase tracking-wider">{h}</span>
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-3 rounded-full border border-ink-muted" />
          <span>bubble size = emission share</span>
        </li>
      </ul>
    </div>
  );
}
