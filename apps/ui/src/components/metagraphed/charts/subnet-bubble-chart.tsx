import { Link } from "@tanstack/react-router";
import { Tooltip, TooltipContent, TooltipTrigger } from "@jsonbored/ui-kit";
import { classNames, formatNumber, formatSubnetAge, subnetAgeDays } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";
import { bubbleDomain, layoutBubbles, type BubbleInput } from "./subnet-bubble-layout";

// Reuse the exact health tokens the rest of the app tints subnets by
// (subnets.index.tsx's matrix, HealthPill, SubnetPulseGrid) so a bubble's color
// means the same thing everywhere.
const HEALTH_FILL: Record<string, string> = {
  ok: "var(--health-ok)",
  warn: "var(--health-warn)",
  down: "var(--health-down)",
  unknown: "var(--health-unknown)",
};

const HEALTH_ORDER = ["ok", "warn", "down", "unknown"] as const;

const MIN_R = 6;
const MAX_R = 20;

type Row = Subnet & { health?: string };

/**
 * Alternate "outlier map" view for /subnets (#6884): the same filtered subnet
 * rows as the table, encoded on four channels instead of sorted into rows —
 * x = subnet age, y = manifested surfaces, bubble size = participant count,
 * color = health. Age × surfaces is the pair that makes the registry's own
 * "how complete is this subnet for how long it has existed" outliers pop
 * (young-but-well-surfaced, or old-but-sparse) the way a single sort column
 * can't — the same completeness/health dimensions get_registry_leaderboards
 * ranks by. Clicking a bubble opens /subnets/{netuid}, mirroring a table row.
 */
export function SubnetBubbleChart({ rows }: { rows: Row[] }) {
  const inputs: BubbleInput[] = rows.map((s) => ({
    netuid: s.netuid,
    name: s.name,
    x: subnetAgeDays(s.registered_at_block, s.block) ?? 0,
    y: s.surfaces_count ?? 0,
    size: s.participants ?? 0,
    health: s.health ?? "unknown",
  }));
  const xDomain = bubbleDomain(inputs.map((d) => d.x));
  const yDomain = bubbleDomain(inputs.map((d) => d.y));
  const nodes = layoutBubbles(inputs, { minR: MIN_R, maxR: MAX_R });

  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Outlier map · {rows.length} subnets
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-ink-subtle-text">size</span>
            <span className="inline-block size-1.5 rounded-full bg-ink-muted/50" />
            <span className="inline-block size-3 rounded-full bg-ink-muted/50" />
            <span>participants</span>
          </span>
          <span className="inline-flex items-center gap-2">
            {HEALTH_ORDER.map((h) => (
              <span key={h} className="inline-flex items-center gap-1">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: HEALTH_FILL[h] }}
                />
                {h}
              </span>
            ))}
          </span>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex shrink-0 items-center justify-center">
          <span className="[writing-mode:vertical-rl] rotate-180 font-mono text-[9px] uppercase tracking-widest text-ink-muted whitespace-nowrap">
            Surfaces · {formatNumber(yDomain.min)}–{formatNumber(yDomain.max)} ↑
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative aspect-square w-full overflow-hidden rounded-sm border border-border/60 bg-surface/40 sm:aspect-[5/2]"
            role="group"
            aria-label={`Subnet outlier map: ${rows.length} subnets plotted by age, surfaces, participants, and health`}
          >
            {/* Quiet quartile gridlines so position is readable without a full axis. */}
            {[25, 50, 75].map((p) => (
              <span
                key={`v${p}`}
                className="absolute inset-y-0 w-px bg-border/40"
                style={{ left: `${p}%` }}
              />
            ))}
            {[25, 50, 75].map((p) => (
              <span
                key={`h${p}`}
                className="absolute inset-x-0 h-px bg-border/40"
                style={{ top: `${p}%` }}
              />
            ))}
            {/* Inset the plotting band by the max radius (in px, so it holds at
                every viewport) — a bubble at a domain extreme then just touches
                the frame instead of being clipped by overflow-hidden. */}
            <div className="absolute" style={{ inset: MAX_R }}>
              {nodes.map((n) => (
                <Tooltip key={n.netuid} delayDuration={120}>
                  <TooltipTrigger asChild>
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: n.netuid }}
                      aria-label={`Subnet ${n.netuid}${n.name ? ` — ${n.name}` : ""} · ${formatNumber(n.y)} surfaces · ${formatNumber(n.size)} participants · health ${n.health}`}
                      className="absolute rounded-full opacity-80 outline-none transition-transform hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:scale-110 focus-visible:ring-2 focus-visible:ring-accent"
                      style={{
                        left: `${n.cx}%`,
                        top: `${n.cy}%`,
                        width: n.r * 2,
                        height: n.r * 2,
                        marginLeft: -n.r,
                        marginTop: -n.r,
                        backgroundColor: HEALTH_FILL[n.health] ?? HEALTH_FILL.unknown,
                        // A ring in the surface color "cuts out" overlapping
                        // bubbles so a dense cluster still reads as distinct marks.
                        border: "1.5px solid var(--card)",
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      netuid {n.netuid}
                    </div>
                    <div className="font-display text-sm font-semibold text-ink-strong">
                      {n.name ?? `Subnet ${n.netuid}`}
                    </div>
                    <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[11px] text-ink-muted">
                      <dt>age</dt>
                      <dd className="text-right font-mono text-ink">{formatSubnetAge(n.x)}</dd>
                      <dt>surfaces</dt>
                      <dd className="text-right font-mono text-ink">{formatNumber(n.y)}</dd>
                      <dt>participants</dt>
                      <dd className="text-right font-mono text-ink">{formatNumber(n.size)}</dd>
                      <dt>health</dt>
                      <dd className="text-right font-mono text-ink">{n.health}</dd>
                    </dl>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
          <div className="mt-1 text-center font-mono text-[9px] uppercase tracking-widest text-ink-muted">
            Subnet age · {formatNumber(xDomain.min)}–{formatNumber(xDomain.max)} days →
          </div>
        </div>
      </div>
    </div>
  );
}
