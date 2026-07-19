import { Link } from "@tanstack/react-router";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import { EmptyState } from "@/components/metagraphed/states";
import { classNames } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";
import { buildSubnetBubblePoints } from "./subnet-bubble-data";

// #6884: bubble/radar alternate view for /subnets. Position encodes two axes,
// bubble size a third metric, color a fourth — see subnet-bubble-data.ts for
// why these four were picked (and why raw values are rank-normalized, not
// linearly scaled). Takes the SAME already-filtered/sorted `rows`
// SubnetGrid/SubnetMatrix render, so the table's category/health/etc. filters
// carry over automatically; no separate filter surface.

type SubnetBubbleRow = Subnet & {
  health?: string;
  emission_share?: number;
  candidates_count?: number;
};

const HEALTH_DOT: Record<string, string> = {
  ok: "bg-health-ok/80 hover:bg-health-ok",
  warn: "bg-health-warn/75 hover:bg-health-warn",
  down: "bg-health-down/80 hover:bg-health-down",
  unknown: "bg-health-unknown/40 hover:bg-health-unknown/70",
};

function Legend({ colorClass, label }: { colorClass: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={classNames("size-2 rounded-full", colorClass)} />
      {label}
    </span>
  );
}

function formatEmission(share: number): string {
  return `${(share * 100).toFixed(3)}%`;
}

export function SubnetBubbleView({ rows }: { rows: SubnetBubbleRow[] }) {
  const points = buildSubnetBubblePoints(rows);

  if (points.length === 0) {
    return (
      <EmptyState
        title="Nothing to plot"
        description="No subnets in the current filter have both an emission share and a surface count."
      />
    );
  }

  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Bubble view · {points.length} subnets
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-ink-muted">
          <Legend colorClass="bg-health-ok" label="ok" />
          <Legend colorClass="bg-health-warn" label="warn" />
          <Legend colorClass="bg-health-down" label="down" />
          <Legend colorClass="bg-health-unknown" label="unknown" />
          <span className="text-ink-subtle">size = candidate surfaces</span>
        </div>
      </div>

      <div className="flex items-stretch gap-2">
        <div
          className="flex w-4 shrink-0 flex-col items-center justify-between py-1 font-mono text-[9px] uppercase tracking-widest text-ink-subtle"
          aria-hidden
          style={{ writingMode: "vertical-rl" }}
        >
          <span>more surfaces</span>
          <span>fewer surfaces</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative h-[360px] w-full overflow-visible rounded border border-border/70 bg-paper/40 sm:h-[440px] md:h-[520px]"
            role="img"
            aria-label={`Bubble chart of ${points.length} subnets: x axis emission share (percentile rank), y axis surface count (percentile rank), bubble size candidate-surface count, color health state`}
          >
            {points.map((p) => (
              <EntityHoverCard key={p.netuid} kind="subnet" netuid={p.netuid}>
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: p.netuid }}
                  aria-label={`Subnet ${p.netuid}${p.name ? ` — ${p.name}` : ""} · emission ${formatEmission(p.emissionShare)} · ${p.surfacesCount} surfaces · ${p.candidatesCount} candidates · ${p.health}`}
                  title={`#${p.netuid}${p.name ? ` · ${p.name}` : ""} · emission ${formatEmission(p.emissionShare)} · ${p.surfacesCount} surfaces · ${p.candidatesCount} candidates`}
                  className={classNames(
                    "mg-focus-ring absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 font-mono text-[9px] font-medium text-white/95 transition-transform hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:scale-110",
                    HEALTH_DOT[p.health] ?? HEALTH_DOT.unknown,
                  )}
                  style={{
                    left: `${p.xPct}%`,
                    top: `${p.yPct}%`,
                    width: `${p.diameterPx}px`,
                    height: `${p.diameterPx}px`,
                  }}
                >
                  {p.diameterPx >= 24 ? p.netuid : null}
                </Link>
              </EntityHoverCard>
            ))}
          </div>
          <div className="mt-1 text-right font-mono text-[9px] uppercase tracking-widest text-ink-subtle">
            Emission share →
          </div>
        </div>
      </div>
    </div>
  );
}
