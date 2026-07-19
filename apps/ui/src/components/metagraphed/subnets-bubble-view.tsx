import { useMemo } from "react";
import { EmptyState } from "@/components/metagraphed/states";
import { healthColorVar } from "@/lib/health-tokens";
import { formatNumber } from "@/lib/metagraphed/format";
import { BUBBLE_PAD, BUBBLE_VB, buildBubbleLayout } from "@/lib/metagraphed/subnets-bubble-layout";
import type { Subnet } from "@/lib/metagraphed/types";

// #6884: an alternate "bubble" scan of /subnets over the SAME filtered list the
// table renders — position/size/colour encoding instead of sorted rows, to spot
// outliers a table hides. Encoding (all from fields the list already carries; the
// list has no stake/emission — those are detail-only):
//   x = age in days (established-ness)   y = verified surfaces (integration depth)
//   bubble size = participants (active UIDs)   colour = health state
// age×surfaces spreads better than age×participants (most subnets max UIDs at 256,
// bunching a participants axis at the top); it also tells a sharper story — an old
// subnet low on the surface axis is under-integrated for its age. The coordinate/
// scaling math lives in subnets-bubble-layout.ts (unit-tested). Rendered as a
// fixed-viewBox SVG (no client measurement) so it draws server-side and is
// URL-addressable via ?view=bubble, like the table/grid/matrix views.

export function SubnetsBubbleView({ rows }: { rows: Subnet[] }) {
  const { points, xMax, yMax } = useMemo(() => buildBubbleLayout(rows), [rows]);

  if (points.length === 0) {
    return (
      <EmptyState
        title="Nothing to plot"
        description="No subnets in the current filter have both an age and a participant count yet. Adjust the filters or switch back to the table."
      />
    );
  }

  const axisY = BUBBLE_VB.h - BUBBLE_PAD.bottom;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card p-3">
        <svg
          viewBox={`0 0 ${BUBBLE_VB.w} ${BUBBLE_VB.h}`}
          className="block w-full aspect-[900/460]"
          role="img"
          aria-label="Subnets by age in days (x) and verified surface count (y); bubble size is participant count, colour is health state"
        >
          {/* axes */}
          <line
            x1={BUBBLE_PAD.left}
            y1={BUBBLE_PAD.top}
            x2={BUBBLE_PAD.left}
            y2={axisY}
            stroke="var(--border)"
          />
          <line
            x1={BUBBLE_PAD.left}
            y1={axisY}
            x2={BUBBLE_VB.w - BUBBLE_PAD.right}
            y2={axisY}
            stroke="var(--border)"
          />
          {/* axis labels */}
          <text
            x={BUBBLE_PAD.left}
            y={axisY + 28}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
          >
            0
          </text>
          <text
            x={BUBBLE_VB.w - BUBBLE_PAD.right}
            y={axisY + 28}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="end"
          >
            {formatNumber(xMax)}d
          </text>
          <text
            x={(BUBBLE_PAD.left + BUBBLE_VB.w - BUBBLE_PAD.right) / 2}
            y={BUBBLE_VB.h - 6}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="middle"
          >
            Age (days) →
          </text>
          <text
            x={BUBBLE_PAD.left - 10}
            y={BUBBLE_PAD.top + 4}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="end"
          >
            {formatNumber(yMax)}
          </text>
          <text
            x={16}
            y={(BUBBLE_PAD.top + axisY) / 2}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="middle"
            transform={`rotate(-90 16 ${(BUBBLE_PAD.top + axisY) / 2})`}
          >
            Verified surfaces ↑
          </text>
          {/* bubbles — each links to the subnet detail (mirrors table row-click) */}
          {points.map((p) => (
            <a
              key={p.netuid}
              href={`/subnets/${p.netuid}`}
              aria-label={`${p.name}: ${p.participants} participants, ~${p.age}d old`}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={p.color}
                fillOpacity={0.55}
                stroke={p.color}
                strokeWidth={1}
              >
                <title>
                  {p.name} (#{p.netuid}) — ~{formatNumber(p.age)}d old,{" "}
                  {formatNumber(p.participants)} participants, {formatNumber(p.surfaces)} surfaces,{" "}
                  {p.health}
                </title>
              </circle>
            </a>
          ))}
        </svg>
      </div>
      {/* legend */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-ink-muted">
        {(["ok", "warn", "down", "unknown"] as const).map((h) => (
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
          <span>bubble size = participants</span>
        </li>
      </ul>
    </div>
  );
}
