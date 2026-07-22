import { useMemo, useState } from "react";
import { EmptyState } from "@/components/metagraphed/states";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { healthColorVar } from "@/lib/health-tokens";
import type { HealthState } from "@/lib/metagraphed/types";

/**
 * One plotted subnet. Kept deliberately flat (no reference back to the full
 * Subnet row) so the chart is a pure presentational component: the /subnets
 * route maps its already-filtered+sorted rows into these points, so the bubble
 * view renders the exact same subset the table shows (#6884).
 */
export interface SubnetBubblePoint {
  netuid: number;
  name: string;
  /** X — surface completeness (surfaces_count). Always populated by the list API. */
  surfaces: number;
  /** Y — total stake in TAO (economics). Undefined when no snapshot exists. */
  stakeTao?: number;
  /** Size — participant/neuron count. */
  participants: number;
  /** Color — probe health tier (ok/warn/down/unknown). */
  health: HealthState;
}

// Axis / plot geometry in the SVG's own viewBox units. The SVG scales to its
// container width (w-full, h-auto) so these are fixed design-space coordinates,
// never device pixels — the whole thing shrinks cleanly at 375/768/1280 without
// horizontal overflow. Percent-based tooltip placement (below) rides the same
// uniform scale.
const VB_W = 800;
const VB_H = 460;
const M = { top: 20, right: 18, bottom: 42, left: 60 };
const PX0 = M.left;
const PX1 = VB_W - M.right;
const PY0 = M.top;
const PY1 = VB_H - M.bottom;

const R_MIN = 4;
const R_MAX = 24;

const HEALTH_ORDER: HealthState[] = ["ok", "warn", "down", "unknown"];
const HEALTH_LABEL: Record<HealthState, string> = {
  ok: "ok",
  warn: "warn",
  down: "down",
  unknown: "unknown",
};

/** log10 with a small floor so a stake of 0/undefined never blows up the scale. */
function niceLogTicks(minPow: number, maxPow: number): number[] {
  const ticks: number[] = [];
  for (let p = minPow; p <= maxPow; p++) ticks.push(p);
  return ticks;
}

/**
 * SVG bubble/scatter view of the /subnets list (#6884). Encodings — all four
 * are dimensions already sortable in the table, so the view is a spatial re-cut
 * of the same data rather than a new lens:
 *   - X  = surface completeness (surfaces_count) — how built-out the subnet's
 *          public surface coverage is; always populated, so the plot stays dense.
 *   - Y  = total stake in TAO, log-scaled — stake spans several orders of
 *          magnitude (root + megacap subnets vs. fresh ones), so a linear axis
 *          would collapse the low end into the baseline.
 *   - size = participant count — a natural area encoding for "how big is the
 *            neuron set", sqrt-scaled so area (not radius) tracks the value.
 *   - color = health tier — a reserved status palette (ok/warn/down/unknown),
 *            the same tokens the matrix view uses, leg/label-backed so identity
 *            is never color-alone and it reads in both themes.
 * Subnets with no stake snapshot can't sit on the log axis and are omitted with
 * an honest caption (no zero-fill), mirroring the codebase's no-synthesis rule.
 */
export function SubnetBubbleChart({
  points,
  onSelect,
}: {
  points: SubnetBubblePoint[];
  onSelect: (netuid: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const model = useMemo(() => {
    const plotted = points.filter((p) => typeof p.stakeTao === "number" && (p.stakeTao ?? 0) > 0);
    const xMax = Math.max(1, ...plotted.map((p) => p.surfaces));
    const stakes = plotted.map((p) => p.stakeTao as number);
    const logMin = stakes.length ? Math.log10(Math.min(...stakes)) : 0;
    const logMax = stakes.length ? Math.log10(Math.max(...stakes)) : 1;
    const loSpan = Math.floor(logMin);
    const hiSpan = Math.ceil(logMax);
    const logLo = Math.min(loSpan, hiSpan - 1);
    const logHi = Math.max(hiSpan, logLo + 1);
    const pMax = Math.max(1, ...plotted.map((p) => p.participants));

    const xScale = (v: number) => PX0 + (Math.max(0, v) / xMax) * (PX1 - PX0);
    const yScale = (v: number) => {
      const t = (Math.log10(v) - logLo) / (logHi - logLo || 1);
      return PY1 - t * (PY1 - PY0);
    };
    const rScale = (v: number) => R_MIN + Math.sqrt(Math.max(0, v) / pMax) * (R_MAX - R_MIN);

    // Draw larger bubbles first so smaller ones stay clickable on top.
    const marks = plotted
      .map((p) => ({
        p,
        cx: xScale(p.surfaces),
        cy: yScale(p.stakeTao as number),
        r: rScale(p.participants),
      }))
      .sort((a, b) => b.r - a.r);

    return {
      marks,
      xMax,
      xTicks: [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * xMax)),
      yTicks: niceLogTicks(logLo, logHi),
      xScale,
      yScale,
      omitted: points.length - plotted.length,
    };
  }, [points]);

  if (model.marks.length === 0) {
    return (
      <EmptyState
        title="Nothing to plot"
        description="None of the subnets in the current filter have a total-stake snapshot to position on the stake axis. Switch back to the table view, or broaden the filters."
      />
    );
  }

  const active = model.marks.find((m) => m.p.netuid === hovered) ?? null;

  return (
    <div className="rounded border border-border bg-card p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Stake × completeness · {model.marks.length} subnets
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-ink-muted">
          {HEALTH_ORDER.map((h) => (
            <span key={h} className="inline-flex items-center gap-1">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: healthColorVar(h) }}
              />
              {HEALTH_LABEL[h]}
            </span>
          ))}
        </div>
      </div>

      {/* overflow-hidden pins the tooltip inside the chart card so an
          edge-anchored label can never widen the page (the responsive-overflow
          e2e gate). The SVG is w-full so it never overflows on its own. */}
      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block h-auto w-full"
          role="img"
          aria-label={`Bubble chart of ${model.marks.length} subnets. Horizontal axis: surface completeness. Vertical axis: total stake in TAO, log-scaled. Bubble size: participant count. Bubble color: health status. Use the table view for the same data in a sortable list.`}
        >
          {/* Y gridlines + labels (log ticks, powers of 10) */}
          {model.yTicks.map((pow) => {
            const y = model.yScale(Math.pow(10, pow));
            return (
              <g key={`y${pow}`}>
                <line
                  x1={PX0}
                  x2={PX1}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
                <text
                  x={PX0 - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-ink-muted font-mono"
                  fontSize={10}
                >
                  {formatTao(Math.pow(10, pow))}
                </text>
              </g>
            );
          })}
          {/* X ticks + labels */}
          {model.xTicks.map((tick, i) => {
            const x = model.xScale(tick);
            return (
              <g key={`x${i}`}>
                <line x1={x} x2={x} y1={PY0} y2={PY1} stroke="var(--border)" strokeWidth={1} />
                <text
                  x={x}
                  y={PY1 + 16}
                  textAnchor="middle"
                  className="fill-ink-muted font-mono"
                  fontSize={10}
                >
                  {formatNumber(tick)}
                </text>
              </g>
            );
          })}
          {/* Axis titles */}
          <text
            x={(PX0 + PX1) / 2}
            y={VB_H - 6}
            textAnchor="middle"
            className="fill-ink-muted font-mono"
            fontSize={10}
          >
            Surfaces (completeness) →
          </text>
          <text
            x={-(PY0 + PY1) / 2}
            y={14}
            textAnchor="middle"
            transform="rotate(-90)"
            className="fill-ink-muted font-mono"
            fontSize={10}
          >
            Total stake · TAO (log) →
          </text>

          {/* Bubbles */}
          {model.marks.map((m) => {
            const isActive = m.p.netuid === hovered;
            return (
              <circle
                key={m.p.netuid}
                cx={m.cx}
                cy={m.cy}
                r={m.r}
                fill={healthColorVar(m.p.health)}
                fillOpacity={isActive ? 0.9 : 0.6}
                stroke={isActive ? "var(--accent)" : "var(--card)"}
                strokeWidth={isActive ? 2 : 1.5}
                tabIndex={0}
                role="button"
                aria-label={`Subnet ${m.p.netuid}${m.p.name ? ` — ${m.p.name}` : ""}. Stake ${formatTao(m.p.stakeTao)} TAO, ${formatNumber(m.p.surfaces)} surfaces, ${formatNumber(m.p.participants)} participants, health ${m.p.health}. Activate to open the subnet.`}
                className="cursor-pointer outline-none focus-visible:stroke-accent"
                style={{ transition: "fill-opacity 120ms" }}
                onMouseEnter={() => setHovered(m.p.netuid)}
                onMouseLeave={() => setHovered((h) => (h === m.p.netuid ? null : h))}
                onFocus={() => setHovered(m.p.netuid)}
                onBlur={() => setHovered((h) => (h === m.p.netuid ? null : h))}
                onClick={() => onSelect(m.p.netuid)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(m.p.netuid);
                  }
                }}
              />
            );
          })}
        </svg>

        {/* Hover/focus tooltip — positioned by the mark's fractional coordinate
            so it tracks the same uniform SVG scale at any viewport width. */}
        {active ? (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[220px] rounded border border-border bg-paper px-2.5 py-1.5 text-[11px] shadow-none"
            style={{
              left: `${(active.cx / VB_W) * 100}%`,
              top: `${(active.cy / VB_H) * 100}%`,
              transform:
                active.cy / VB_H < 0.28
                  ? "translate(-50%, 12px)"
                  : "translate(-50%, calc(-100% - 12px))",
            }}
          >
            <div className="flex items-center gap-1.5 font-medium text-ink-strong">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: healthColorVar(active.p.health) }}
              />
              <span className="truncate">{active.p.name || `Subnet ${active.p.netuid}`}</span>
              <span className="font-mono text-[10px] text-ink-muted">#{active.p.netuid}</span>
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px] text-ink-muted">
              <dt>stake</dt>
              <dd className="text-right tabular-nums text-ink">{formatTao(active.p.stakeTao)} τ</dd>
              <dt>surfaces</dt>
              <dd className="text-right tabular-nums text-ink">
                {formatNumber(active.p.surfaces)}
              </dd>
              <dt>participants</dt>
              <dd className="text-right tabular-nums text-ink">
                {formatNumber(active.p.participants)}
              </dd>
              <dt>health</dt>
              <dd className="text-right text-ink">{active.p.health}</dd>
            </dl>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[10px] text-ink-muted">
        <span>Bubble size ∝ participant count · click a bubble to open its subnet</span>
        {model.omitted > 0 ? (
          <span>
            {formatNumber(model.omitted)} hidden · no stake snapshot to plot on the log axis
          </span>
        ) : null}
      </div>
    </div>
  );
}
