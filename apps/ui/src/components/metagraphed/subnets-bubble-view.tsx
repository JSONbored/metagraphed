import { useMemo } from "react";
import { EmptyState } from "@/components/metagraphed/states";
import { healthColorVar } from "@/lib/health-tokens";
import { formatNumber } from "@/lib/metagraphed/format";
import type { HealthState, Subnet } from "@/lib/metagraphed/types";

// #6884: an alternate "bubble" scan of /subnets over the SAME filtered list the
// table renders — position/size/colour encoding instead of sorted rows, to spot
// outliers a table hides (e.g. a young subnet that already has many participants).
//
// Axis defaults, all from fields the subnet LIST already carries (the table shows
// them too; the list has no stake/emission — those are detail-only):
//   x = age in days (established-ness)   y = verified surfaces (integration depth)
//   bubble size = participants (active UIDs)
//   colour = health state (operational traffic-light)
// age×surfaces spreads better than age×participants (most subnets max UIDs at 256,
// which bunches a participants axis at the top); it also tells a sharper story —
// an old subnet low on the surface axis is under-integrated relative to its age.
// Rendered as a fixed-viewBox SVG (no client measurement) so it draws server-side
// and is URL-addressable via ?view=bubble, like the table/grid/matrix views.

const FINNEY_BLOCK_SECONDS = 12;
const SECONDS_PER_DAY = 86_400;

function ageDays(s: Subnet): number | null {
  const reg = s.registered_at_block;
  const now = s.block;
  if (typeof reg !== "number" || typeof now !== "number") return null;
  const elapsed = now - reg;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return Math.floor((elapsed * FINNEY_BLOCK_SECONDS) / SECONDS_PER_DAY);
}

const VB = { w: 900, h: 460 };
const PAD = { top: 20, right: 24, bottom: 44, left: 56 };
const R_MIN = 4;
const R_MAX = 15;

type Point = {
  netuid: number;
  name: string;
  x: number;
  y: number;
  r: number;
  color: string;
  age: number;
  participants: number;
  surfaces: number;
  health: HealthState;
};

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

export function SubnetsBubbleView({ rows }: { rows: Subnet[] }) {
  const { points, xMax, yMax } = useMemo(() => {
    const raw = rows
      .map((s) => {
        const age = ageDays(s);
        const participants = typeof s.participants === "number" ? s.participants : null;
        if (age == null || participants == null) return null;
        return {
          netuid: s.netuid,
          name: s.name ?? `Subnet ${s.netuid}`,
          age,
          participants,
          surfaces: typeof s.surfaces_count === "number" ? s.surfaces_count : 0,
          health: (s.health ?? "unknown") as HealthState,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const xMax = niceMax(Math.max(1, ...raw.map((p) => p.age)));
    const yMax = niceMax(Math.max(1, ...raw.map((p) => p.surfaces)));
    const pMax = Math.max(1, ...raw.map((p) => p.participants));
    const innerW = VB.w - PAD.left - PAD.right;
    const innerH = VB.h - PAD.top - PAD.bottom;

    const points: Point[] = raw.map((p) => ({
      ...p,
      x: PAD.left + (p.age / xMax) * innerW,
      y: PAD.top + (1 - p.surfaces / yMax) * innerH,
      r: R_MIN + (p.participants / pMax) * (R_MAX - R_MIN),
      color: healthColorVar(
        p.health === "ok"
          ? "ok"
          : p.health === "warn"
            ? "warn"
            : p.health === "down"
              ? "down"
              : "unknown",
      ),
    }));
    return { points, xMax, yMax };
  }, [rows]);

  if (points.length === 0) {
    return (
      <EmptyState
        title="Nothing to plot"
        description="No subnets in the current filter have both an age and a participant count yet. Adjust the filters or switch back to the table."
      />
    );
  }

  const axisY = VB.h - PAD.bottom;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card p-3">
        <svg
          viewBox={`0 0 ${VB.w} ${VB.h}`}
          className="block w-full aspect-[900/460]"
          role="img"
          aria-label="Subnets by age in days (x) and verified surface count (y); bubble size is participant count, colour is health state"
        >
          {/* axes */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={axisY} stroke="var(--border)" />
          <line x1={PAD.left} y1={axisY} x2={VB.w - PAD.right} y2={axisY} stroke="var(--border)" />
          {/* axis labels */}
          <text
            x={PAD.left}
            y={axisY + 28}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
          >
            0
          </text>
          <text
            x={VB.w - PAD.right}
            y={axisY + 28}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="end"
          >
            {formatNumber(xMax)}d
          </text>
          <text
            x={(PAD.left + VB.w - PAD.right) / 2}
            y={VB.h - 6}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="middle"
          >
            Age (days) →
          </text>
          <text
            x={PAD.left - 10}
            y={PAD.top + 4}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="end"
          >
            {formatNumber(yMax)}
          </text>
          <text
            x={16}
            y={(PAD.top + axisY) / 2}
            fill="var(--ink-muted)"
            fontSize="12"
            fontFamily="monospace"
            textAnchor="middle"
            transform={`rotate(-90 16 ${(PAD.top + axisY) / 2})`}
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
