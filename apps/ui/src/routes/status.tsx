import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRegistryEvents } from "@/hooks/use-registry-events";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { Suspense, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { SectionHeading } from "@/components/metagraphed/section-heading";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { Donut, DonutLegend } from "@/components/metagraphed/charts/donut";
import { AnimatedNumber } from "@/components/metagraphed/animated-number";
import { healthQuery, globalIncidentsQuery } from "@/lib/metagraphed/queries";
import { classNames, humaniseSeconds, isStaleFreshness } from "@/lib/metagraphed/format";
import { healthStatusSegments } from "@/lib/metagraphed/health-segments";
import type { GlobalIncidentSurface } from "@/lib/metagraphed/types";
import {
  HealthHistoryDrilldown,
  SourceHealthTable,
} from "@/components/metagraphed/status-diagnostics";
import { NetworkDecentralizationPanel } from "@/components/metagraphed/network-decentralization-panel";

const SURFACES_INITIAL = 10;
// A downtime event whose last failure is within this of the latest snapshot is
// treated as still-ongoing (probe cadence is ~2 min, so ~5 cycles).
const ONGOING_MS = 10 * 60_000;
const WINDOWS = ["7d", "30d"] as const;
type IncidentWindow = (typeof WINDOWS)[number];

function isGlobalIncidentOngoing(s: GlobalIncidentSurface, observedAt?: string | null): boolean {
  const observedMs = observedAt ? Date.parse(observedAt) : Date.now();
  const latest = s.incidents.reduce((max, i) => Math.max(max, i.ended_at || 0), 0);
  return latest > 0 && observedMs - latest < ONGOING_MS;
}

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
  // #1117: refresh on registry publish in addition to the poll interval.
  useRegistryEvents();
  return (
    <AppShell>
      <PageHeading
        eyebrow="Status"
        title="System status"
        description="Live operational status across every monitored subnet surface. Probe-derived — user submissions cannot set health or incident state."
      />
      <div className="space-y-section">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-28 w-full" />}>
            <Verdict />
          </Suspense>
        </QueryErrorBoundary>
        <section>
          <SectionHeading title="Recent incidents" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <RecentIncidents />
            </Suspense>
          </QueryErrorBoundary>
        </section>

        {/* #3471: network-scope decentralization scorecard — stake &
            emission concentration (Gini / HHI / Nakamoto / entropy / top-1%)
            plus the trust/consensus score spread, mirroring the per-subnet
            concentration panel at chain scope. */}
        <section>
          <SectionHeading
            title="Network decentralization"
            intro="Chain-wide stake & emission concentration (Gini, HHI, Nakamoto coefficient, entropy, top-1% share) and the trust/consensus score spread, computed across every subnet from the metagraph snapshot."
          />
          <QueryErrorBoundary>
            <NetworkDecentralizationPanel />
          </QueryErrorBoundary>
        </section>

        {/* #8: operational diagnostics — a per-day probe drill-down and a
            provider verification rollup, both probe-derived. */}
        <section>
          <SectionHeading
            title="Probe history"
            intro="Per-surface probe results for any captured day. Pick a date to inspect."
          />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <HealthHistoryDrilldown />
            </Suspense>
          </QueryErrorBoundary>
        </section>

        <section>
          <SectionHeading
            title="Source health"
            intro="Per-provider verification status, endpoint counts, and classification mix."
          />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <SourceHealthTable />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter
        paths={[
          "/api/v1/health",
          "/api/v1/incidents",
          "/api/v1/health/history/{date}",
          "/api/v1/source-health",
          "/api/v1/chain/concentration",
          "/api/v1/chain/performance",
        ]}
      />
    </AppShell>
  );
}

/** Overall verdict banner + status mix, derived from /api/v1/health status counts. */
function Verdict() {
  const refetchInterval = useRefetchInterval(60_000);
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval });
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

  const segs = healthStatusSegments({ ok, warn, down, unknown });
  // /api/v1/health carries no real 24h uptime series — this is the share of
  // surfaces healthy in the latest snapshot (ok / total), so label it as such.
  const healthyRatio = total > 0 ? ok / total : null;
  const healthyPct = healthyRatio != null ? (healthyRatio * 100).toFixed(2) + "%" : "—";

  const stale = isStaleFreshness(hRes.meta?.generated_at);

  return (
    <div className="space-y-4">
      {stale ? (
        <StaleBanner
          generatedAt={hRes.meta?.generated_at}
          refreshQueryKeys={[healthQuery().queryKey, globalIncidentsQuery("7d").queryKey]}
          refreshLabel="Refresh health now"
        />
      ) : null}
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
            centerLabel={healthyPct}
            centerSub="healthy now"
          />
          <div className="min-w-0 flex-1">
            <div className="mg-label mb-1">Status mix</div>
            <div className="mb-1 font-mono text-[11px] tabular-nums text-ink-muted">
              {ok} of {total} healthy
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
      <div className="mg-label">{label}</div>
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
  const refetchInterval = useRefetchInterval(60_000);
  const { data } = useSuspenseQuery({
    ...globalIncidentsQuery(window),
    refetchInterval,
  });
  const ledger = data.data;
  // A surface is still failing ("ongoing") when its most recent downtime event
  // ends within a few probe cycles of the latest snapshot; everything else is a
  // resolved past event. This separates "what's down right now" from "what's
  // flapped over the window", so the window count never reads as a live outage.
  const { surfaces, ongoingCount } = useMemo(() => {
    const list = [...(ledger?.surfaces ?? [])];
    list.sort(
      (a, b) =>
        Number(isGlobalIncidentOngoing(b, ledger?.observed_at)) -
          Number(isGlobalIncidentOngoing(a, ledger?.observed_at)) ||
        b.incident_count - a.incident_count ||
        b.downtime_ms - a.downtime_ms,
    );
    return {
      surfaces: list,
      ongoingCount: list.filter((s) => isGlobalIncidentOngoing(s, ledger?.observed_at)).length,
    };
  }, [ledger]);
  const summary = ledger?.summary;
  const affected = summary?.affected_surface_count ?? surfaces.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-card p-3">
        <div>
          <div className="mg-label">
            {ongoingCount > 0 ? "Active now" : "Downtime events · " + window}
          </div>
          <div
            className={classNames(
              "font-display text-lg font-semibold tabular-nums",
              ongoingCount > 0 ? "text-health-down" : "text-health-ok",
            )}
          >
            {ongoingCount > 0 ? <>{ongoingCount} ongoing</> : "All clear"}
          </div>
        </div>
        <div className="text-[11px] font-mono text-ink-muted">
          <AnimatedNumber value={summary?.incident_count} /> sustained event
          {summary?.incident_count === 1 ? "" : "s"} · {window} · across {affected}{" "}
          {affected === 1 ? "surface" : "surfaces"}
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
        <EmptyState title="No sustained downtime in this window" />
      ) : (
        <>
          <ul className="space-y-2">
            {(showAll ? surfaces : surfaces.slice(0, SURFACES_INITIAL)).map((s) => (
              <SurfaceRow
                key={`${s.netuid}/${s.surface_id}`}
                surface={s}
                ongoing={isGlobalIncidentOngoing(s, ledger?.observed_at)}
              />
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

function SurfaceRow({ surface, ongoing }: { surface: GlobalIncidentSurface; ongoing?: boolean }) {
  const latest = surface.incidents.reduce((max, i) => Math.max(max, i.ended_at || 0), 0);
  const downtime = humaniseSeconds(surface.downtime_ms / 1000);
  return (
    <li className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2.5">
      <span
        className={classNames(
          "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest shrink-0",
          ongoing
            ? "border-health-down/40 bg-health-down/5 text-health-down"
            : "border-border bg-paper text-ink-muted",
        )}
        title={ongoing ? "Still failing as of the latest probe" : "Recovered"}
      >
        {ongoing ? "Ongoing" : "Resolved"}
      </span>
      <span className="mg-label shrink-0">SN{surface.netuid}</span>
      <span className="font-mono text-[12px] text-ink-strong truncate">{surface.surface_id}</span>
      <span className="ml-auto inline-flex items-center gap-3 mg-label shrink-0">
        <span className="text-ink-muted tabular-nums">
          {surface.incident_count} {surface.incident_count === 1 ? "event" : "events"}
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
