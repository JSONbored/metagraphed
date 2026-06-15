import { useSuspenseQuery } from "@tanstack/react-query";
import { Donut, DonutLegend } from "./donut";
import { Sparkline } from "./sparkline";
import { coverageQuery, healthQuery, freshnessQuery } from "@/lib/metagraphed/queries";
import { humaniseSeconds } from "@/lib/metagraphed/format";

/**
 * Home "registry pulse" strip — three small modules: curation donut, health
 * donut, freshness sparkline. useSuspenseQuery so it renders server-side (the
 * caller wraps it in Suspense + QueryErrorBoundary); a plain useQuery painted an
 * empty strip on SSR. Still degrades gracefully when individual fields are null.
 */
export function RegistryPulse() {
  const coverage = useSuspenseQuery(coverageQuery()).data?.data;
  const health = useSuspenseQuery(healthQuery()).data?.data;
  const fresh = useSuspenseQuery(freshnessQuery()).data?.data;

  const curationSegs = [
    {
      label: "Adapter-backed",
      value: coverage?.adapter_backed ?? 0,
      color: "var(--curation-adapter, #c084fc)",
    },
    {
      label: "Probed",
      value: coverage?.probed ?? 0,
      color: "var(--curation-verified, #34d399)",
    },
    {
      label: "Manifested",
      value: coverage?.manifested ?? 0,
      color: "var(--curation-machine, #60a5fa)",
    },
    {
      label: "Native only",
      value: coverage?.native_only ?? 0,
      color: "var(--ink-muted, #94a3b8)",
    },
  ].filter((s) => s.value > 0);

  const healthSegs = [
    { label: "OK", value: health?.ok ?? 0, color: "var(--health-ok, #22c55e)" },
    { label: "Warn", value: health?.warn ?? 0, color: "var(--health-warn, #f59e0b)" },
    { label: "Down", value: health?.down ?? 0, color: "var(--health-down, #ef4444)" },
    { label: "Unknown", value: health?.unknown ?? 0, color: "var(--ink-muted, #94a3b8)" },
  ].filter((s) => s.value > 0);

  // Synthesize a freshness sparkline from per-source ages (best signal we
  // have without a history endpoint). Newer-first so the line trends up
  // when sources go stale.
  const sourceAges =
    (fresh?.sources ?? [])
      .map((s) => (s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 1000 : null))
      .filter((v): v is number => typeof v === "number" && v >= 0) ?? [];

  const totalHealth = (health?.ok ?? 0) + (health?.warn ?? 0) + (health?.down ?? 0);
  const uptimePct = health?.uptime_24h != null ? (health.uptime_24h * 100).toFixed(1) + "%" : "—";

  return (
    <section className="mt-6 rounded border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
          Registry pulse
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          live · /api/v1/coverage · /health · /freshness
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <PulseCell title="Curation mix">
          <div className="flex items-center gap-4">
            <Donut
              segments={curationSegs}
              size={88}
              strokeWidth={11}
              centerLabel={String(coverage?.netuids_active ?? "—")}
              centerSub="subnets"
            />
            <div className="min-w-0 flex-1">
              <DonutLegend segments={curationSegs} />
            </div>
          </div>
        </PulseCell>

        <PulseCell title="Global health">
          <div className="flex items-center gap-4">
            <Donut
              segments={healthSegs}
              size={88}
              strokeWidth={11}
              centerLabel={uptimePct}
              centerSub="uptime 24h"
            />
            <div className="min-w-0 flex-1">
              <DonutLegend segments={healthSegs} />
              <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {totalHealth} monitored surfaces
              </div>
            </div>
          </div>
        </PulseCell>

        <PulseCell title="Source freshness">
          <div className="flex flex-col gap-2">
            <Sparkline
              values={sourceAges}
              width={240}
              height={48}
              color="var(--accent, #7aa2ff)"
              ariaLabel="Source freshness trend"
            />
            <dl className="grid grid-cols-3 gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              <Stat
                label="avg"
                value={
                  fresh?.avg_age_seconds != null ? humaniseSeconds(fresh.avg_age_seconds) : "—"
                }
              />
              <Stat
                label="max"
                value={
                  fresh?.max_age_seconds != null ? humaniseSeconds(fresh.max_age_seconds) : "—"
                }
              />
              <Stat label="stale" value={String(fresh?.stale_count ?? 0)} />
            </dl>
          </div>
        </PulseCell>
      </div>
    </section>
  );
}

function PulseCell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border/60 bg-paper/40 p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div>{label}</div>
      <div className="mt-0.5 font-display text-xs font-semibold text-ink-strong normal-case tracking-normal">
        {value}
      </div>
    </div>
  );
}
