import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Maximize2 } from "lucide-react";
import { economicsQuery, subnetUptimeQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { Skeleton } from "@/components/metagraphed/states";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { Donut, DonutLegend } from "@/components/metagraphed/charts/donut";
import type { SurfaceUptime } from "@/lib/metagraphed/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface Props {
  netuid: number;
}

// Economics pool fields arrive via the index signature (unknown) — coerce.
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Subnet-wide daily uptime % meaned across tracked surfaces, chronological.
// Honest by construction: days with no probe simply don't appear (no zero-fill,
// no synthesis).
function dailyUptimeSeries(surfaces: SurfaceUptime[] | undefined): number[] {
  if (!surfaces || surfaces.length === 0) return [];
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const s of surfaces) {
    for (const d of s.days ?? []) {
      if (!d.day || typeof d.uptime_ratio !== "number") continue;
      const cur = byDay.get(d.day) ?? { sum: 0, n: 0 };
      byDay.set(d.day, { sum: cur.sum + d.uptime_ratio * 100, n: cur.n + 1 });
    }
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v.sum / v.n);
}

/**
 * Compact economics card for the subnet hero strip. Shows the current alpha
 * price and pool composition from /api/v1/economics — a point-in-time snapshot,
 * not a time-series (the API exposes no historical price/pool series, so none is
 * synthesized). When the subnet has no economics row it falls back to the real
 * probe-derived uptime sparkline so the slot never collapses into a blank card.
 */
export function EconomicsMini({ netuid }: Props) {
  const [open, setOpen] = useState(false);
  const { data: econRes, isLoading: ecLoading } = useQuery(economicsQuery());
  const { data: uptimeRes, isLoading: uLoading } = useQuery(subnetUptimeQuery(netuid));

  // economicsQuery already returns the per-subnet array at res.data.
  const econ = (econRes?.data ?? []).find((r) => r.netuid === netuid);
  const isLoading = ecLoading || uLoading;

  if (isLoading) return <Skeleton className="h-44 w-full" />;

  const price = numOrNull(econ?.alpha_price_tao);
  const inP = num(econ?.alpha_in_pool);
  const outP = num(econ?.alpha_out_pool);
  const hasPool = inP > 0 || outP > 0;

  if (!econ || (price == null && !hasPool)) {
    return <EconomicsFallback netuid={netuid} surfaces={uptimeRes?.data?.surfaces} />;
  }

  const ratio = inP + outP > 0 ? (inP / (inP + outP)) * 100 : null;
  const poolSegments = [
    { label: "Alpha in", value: inP, color: "var(--accent)" },
    { label: "Alpha out", value: outP, color: "var(--health-warn)" },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group w-full overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open expanded economics snapshot"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5 border-b border-border bg-paper/30">
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Alpha price
              </span>
              <span className="font-display text-base font-semibold tabular-nums text-ink-strong">
                {price != null ? `${price.toFixed(6)}` : "—"}
                <span className="ml-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  TAO
                </span>
              </span>
            </div>
            {ratio != null ? (
              <span className="inline-flex items-center gap-2 font-mono text-[10px] text-ink-muted">
                Pool {ratio.toFixed(0)}% in · {(100 - ratio).toFixed(0)}% out
                <Maximize2 className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
              </span>
            ) : null}
          </div>
          {hasPool ? (
            <div className="flex items-center gap-4 p-4">
              <Donut
                segments={poolSegments}
                size={88}
                strokeWidth={12}
                centerLabel={ratio != null ? `${ratio.toFixed(0)}%` : "—"}
                centerSub="in"
              />
              <div className="grid flex-1 grid-cols-2 gap-3">
                <div>
                  <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                    Alpha in pool
                  </div>
                  <div className="mt-1 font-display text-lg font-semibold tabular-nums text-ink-strong">
                    {formatNumber(inP)}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                    Alpha out pool
                  </div>
                  <div className="mt-1 font-display text-lg font-semibold tabular-nums text-ink-strong">
                    {formatNumber(outP)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 font-mono text-[11px] text-ink-muted">
              No AMM pool reserves recorded — price shown from the latest snapshot.
            </div>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto bg-card p-0">
        <DialogHeader className="border-b border-border bg-paper/40 p-4 pr-12">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            <BarChart3 className="size-3.5 text-accent" /> Subnet {netuid} economics
          </div>
          <DialogTitle className="font-display text-2xl text-ink-strong">
            Alpha economics snapshot
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-muted">
            Current on-chain price and pool composition from /api/v1/economics. No historical
            price/pool series is exposed by the API, so none is shown.
          </DialogDescription>
        </DialogHeader>
        <EconomicsDrilldown netuid={netuid} price={price} inP={inP} outP={outP} ratio={ratio} />
      </DialogContent>
    </Dialog>
  );
}

function EconomicsDrilldown({
  netuid,
  price,
  inP,
  outP,
  ratio,
}: {
  netuid: number;
  price: number | null;
  inP: number;
  outP: number;
  ratio: number | null;
}) {
  const poolSegments = [
    { label: "Alpha in", value: inP, color: "var(--accent)" },
    { label: "Alpha out", value: outP, color: "var(--health-warn)" },
  ];
  const hasPool = inP > 0 || outP > 0;
  return (
    <div className="p-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <DeltaTile
          label="Price"
          value={price != null ? `${price.toFixed(6)} TAO` : "—"}
          tip="Latest alpha price in TAO from /api/v1/economics."
        />
        <DeltaTile
          label="Pool ratio"
          value={ratio != null ? `${ratio.toFixed(1)}% in` : "—"}
          tip="Alpha-in as a share of (alpha-in + alpha-out) in the current liquidity pool."
        />
        <DeltaTile
          label="Pool depth"
          value={hasPool ? formatNumber(inP + outP) : "—"}
          tip="Total alpha across both sides of the AMM pool."
        />
      </div>
      <div className="mt-4 rounded-xl border border-border bg-paper/30 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          <span>Pool composition</span>
          <span>SN{netuid}</span>
        </div>
        {hasPool ? (
          <div className="flex items-center gap-6">
            <Donut
              segments={poolSegments}
              size={120}
              strokeWidth={16}
              centerLabel={ratio != null ? `${ratio.toFixed(0)}%` : "—"}
              centerSub="in"
            />
            <DonutLegend segments={poolSegments} />
          </div>
        ) : (
          <p className="font-mono text-[11px] text-ink-muted">
            No AMM pool reserves recorded for this subnet.
          </p>
        )}
      </div>
    </div>
  );
}

function DeltaTile({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div
      className="rounded-lg border border-border bg-paper/50 p-3"
      title={tip}
      aria-label={tip ? `${label}: ${value}. ${tip}` : `${label}: ${value}`}
    >
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-lg font-semibold tabular-nums text-ink-strong">
        {value}
      </div>
    </div>
  );
}

/**
 * Rendered when /economics has no row for this netuid (common for testnets and
 * freshly-registered application subnets). Falls back to the real probe-derived
 * daily uptime sparkline so the hero slot never collapses into a blank card.
 */
function EconomicsFallback({ netuid, surfaces }: { netuid: number; surfaces?: SurfaceUptime[] }) {
  const uptime = dailyUptimeSeries(surfaces);
  const lastUp = uptime[uptime.length - 1];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-border bg-paper/30 px-4 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            No alpha pool registered
          </span>
          <span className="font-display text-base font-semibold tabular-nums text-ink-strong">
            SN{netuid}
          </span>
        </div>
        <span className="font-mono text-[10px] text-ink-muted">showing probe trend instead</span>
      </div>
      {uptime.length > 1 ? (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] divide-x divide-border">
          <div className="p-3">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Uptime trend · {uptime.length} days
            </div>
            <div className="h-[88px] w-full">
              <Sparkline
                values={uptime}
                color="var(--health-ok)"
                height={88}
                width={520}
                ariaLabel="Uptime trend"
                formatValue={(v) => `${v.toFixed(2)}%`}
              />
            </div>
          </div>
          <div className="grid grid-rows-1 divide-y divide-border">
            <div className="p-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Latest uptime
              </div>
              <div className="mt-1 font-display text-lg font-semibold tabular-nums text-ink-strong">
                {lastUp != null ? `${lastUp.toFixed(2)}%` : "—"}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-6 text-center font-mono text-[11px] text-ink-muted">
          No probe samples yet — economics + health series will populate as the registry runs more
          probes.
        </div>
      )}
    </div>
  );
}
