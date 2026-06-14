import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { Donut, DonutLegend } from "@/components/metagraphed/charts/donut";
import { AnimatedNumber } from "@/components/metagraphed/animated-number";
import { healthQuery, globalIncidentsQuery } from "@/lib/metagraphed/queries";
import { classNames, humaniseSeconds } from "@/lib/metagraphed/format";
import type { GlobalIncidentSurface } from "@/lib/metagraphed/types";

const REFRESH_MS = 60_000;
const SURFACES_INITIAL = 10;
const WINDOWS = ["7d", "30d"] as const;
type IncidentWindow = (typeof WINDOWS)[number];

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "Status — Metagraphed" },
      {
        name: "description",
        content:
          "Live system status for the metagraphed registry: overall operational health and recent cross-subnet incidents.",
      },
      { property: "og:title", content: "Status — Metagraphed" },
      {
        property: "og:description",
        content:
          "Live system status for the metagraphed registry: overall operational health and recent cross-subnet incidents.",
      },
    ],
  }),
  component: StatusPage,
});

function StatusPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Status"
        title="System status"
        description="Live operational status across every monitored subnet surface. Probe-derived — user submissions cannot set health or incident state."
      />
      <div className="space-y-8">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-28 w-full" />}>
            <Verdict />
          </Suspense>
        </QueryErrorBoundary>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Recent incidents
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <RecentIncidents />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter paths={["/api/v1/health", "/api/v1/incidents"]} />
    </AppShell>
  );
}

/** Overall verdict banner + status mix, derived from /api/v1/health status counts. */
function Verdict() {
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval: REFRESH_MS });
  const h = hRes.data;
  const ok = h?.ok ?? 0;
  const warn = h?.warn ?? 0;
  const down = h?.down ?? 0;
  const unknown = h?.unknown ?? 0;
  const total = h?.total ?? ok + warn + down + unknown;

  const verdict =
    down > 0
      ? {
          word: "Partial outage",
          tone: "down" as const,
          Icon: XCircle,
          blurb: `${down} ${down === 1 ? "surface is" : "surfaces are"} down`,
        }
      : warn > 0
        ? {
            word: "Degraded performance",
            tone: "warn" as const,
            Icon: AlertTriangle,
            blurb: `${warn} ${warn === 1 ? "surface is" : "surfaces are"} degraded`,
          }
        : {
            word: "All systems operational",
            tone: "ok" as const,
            Icon: CheckCircle2,
            blurb: `${ok} of ${total} surfaces healthy`,
          };

  const toneText = {
    ok: "text-health-ok",
    warn: "text-health-warn",
    down: "text-health-down",
  }[verdict.tone];
  const toneBorder = {
    ok: "border-health-ok/40",
    warn: "border-health-warn/40",
    down: "border-health-down/40",
  }[verdict.tone];

  const segs = [
    { label: "OK", value: ok, color: "var(--health-ok, #22c55e)" },
    { label: "Degraded", value: warn, color: "var(--health-warn, #f59e0b)" },
    { label: "Down", value: down, color: "var(--health-down, #ef4444)" },
    { label: "Unknown", value: unknown, color: "var(--ink-muted, #94a3b8)" },
  ].filter((s) => s.value > 0);
  const uptimePct = h?.uptime_24h != null ? (h.uptime_24h * 100).toFixed(2) + "%" : "—";

  return (
    <div className="space-y-4">
      <div
        className={classNames("flex items-center gap-4 rounded-lg border bg-card p-5", toneBorder)}
        role="status"
      >
        <verdict.Icon className={classNames("size-9 shrink-0", toneText)} aria-hidden="true" />
        <div className="min-w-0">
          <div className={classNames("font-display text-2xl font-semibold", toneText)}>
            {verdict.word}
          </div>
          <div className="text-sm text-ink-muted">
            {verdict.blurb} · snapshot <TimeAgo at={hRes.meta?.generated_at} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded border border-border bg-card p-3 flex items-center gap-4">
          <Donut
            segments={segs}
            size={96}
            strokeWidth={12}
            centerLabel={uptimePct}
            centerSub="uptime 24h"
          />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1">
              Status mix
            </div>
            <DonutLegend segments={segs} />
          </div>
        </div>
        <div className="rounded border border-border bg-card p-3 grid grid-cols-2 gap-2 md:col-span-2">
          <Kpi label="Healthy" num={ok} accent="text-health-ok" />
          <Kpi label="Degraded" num={warn} accent="text-health-warn" />
          <Kpi label="Down" num={down} accent="text-health-down" />
          <Kpi label="Monitored" num={total} />
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  num,
  accent,
}: {
  label: string;
  num: number | null | undefined;
  accent?: string;
}) {
  return (
    <div className="bg-card p-3 mg-kpi">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div
        className={`mg-kpi-num font-display text-xl font-semibold tabular-nums ${accent ?? "text-ink-strong"}`}
      >
        <AnimatedNumber value={num} />
      </div>
    </div>
  );
}

/** Global, cross-subnet incident ledger from /api/v1/incidents (7d / 30d window). */
function RecentIncidents() {
  const [window, setWindow] = useState<IncidentWindow>("7d");
  const [showAll, setShowAll] = useState(false);
  const { data } = useSuspenseQuery({
    ...globalIncidentsQuery(window),
    refetchInterval: REFRESH_MS,
  });
  const ledger = data.data;
  const surfaces = useMemo(() => {
    const list = [...(ledger?.surfaces ?? [])];
    list.sort((a, b) => b.incident_count - a.incident_count || b.downtime_ms - a.downtime_ms);
    return list;
  }, [ledger]);
  const summary = ledger?.summary;
  const affected = summary?.affected_surface_count ?? surfaces.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-card p-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Incidents · {window}
          </div>
          <div className="font-display text-lg font-semibold text-ink-strong tabular-nums">
            <AnimatedNumber value={summary?.incident_count} />
          </div>
        </div>
        <div className="text-[11px] font-mono text-ink-muted">
          across {affected} {affected === 1 ? "surface" : "surfaces"}
        </div>
        <div className="ml-auto inline-flex items-center overflow-hidden rounded-md border border-border bg-card text-[11px]">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => {
                setWindow(w);
                setShowAll(false);
              }}
              className={classNames(
                "px-2.5 py-1 font-mono uppercase tracking-widest transition-colors",
                window === w ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink",
              )}
              aria-pressed={window === w}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {surfaces.length === 0 ? (
        <EmptyState title="No incidents in this window" />
      ) : (
        <>
          <ul className="space-y-2">
            {(showAll ? surfaces : surfaces.slice(0, SURFACES_INITIAL)).map((s) => (
              <SurfaceRow key={`${s.netuid}/${s.surface_id}`} surface={s} />
            ))}
          </ul>
          {surfaces.length > SURFACES_INITIAL ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="block w-full rounded border border-border bg-card px-3 py-2 text-[11px] font-medium text-ink-muted hover:border-ink/30 hover:text-ink-strong min-h-9"
            >
              {showAll ? "Show fewer" : `Show all ${surfaces.length} affected surfaces`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function SurfaceRow({ surface }: { surface: GlobalIncidentSurface }) {
  const latest = surface.incidents.reduce((max, i) => Math.max(max, i.ended_at || 0), 0);
  const downtime = humaniseSeconds(surface.downtime_ms / 1000);
  return (
    <li className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2.5">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted shrink-0">
        SN{surface.netuid}
      </span>
      <span className="font-mono text-[12px] text-ink-strong truncate">{surface.surface_id}</span>
      <span className="ml-auto inline-flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-ink-muted shrink-0">
        <span className="text-health-down tabular-nums">
          {surface.incident_count} {surface.incident_count === 1 ? "incident" : "incidents"}
        </span>
        <span className="tabular-nums" title="total downtime in window">
          {downtime} down
        </span>
        <span>
          last <TimeAgo at={latest ? new Date(latest).toISOString() : undefined} />
        </span>
      </span>
    </li>
  );
}
