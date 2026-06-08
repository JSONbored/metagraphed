import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useIsFetching } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { RefreshCw, Pause, Play, EyeOff } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { FreshnessIndicator } from "@/components/metagraphed/freshness";
import {
  healthQuery,
  freshnessQuery,
  sourceHealthQuery,
  endpointIncidentsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatRelative, isStaleFreshness } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";

const INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 5 * 60_000 },
];

export const Route = createFileRoute("/health")({
  head: () => ({
    meta: [
      { title: "Health — Metagraphed" },
      {
        name: "description",
        content:
          "Global health, freshness, source health, and recent incidents across the registry.",
      },
    ],
  }),
  component: HealthPage,
});

/** Returns true when the document is visible (or true in SSR). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function HealthPage() {
  const [enabled, setEnabled] = useState(true);
  const [intervalMs, setIntervalMs] = useState(30_000);
  const visible = usePageVisible();
  const effectiveInterval = enabled && visible ? intervalMs : false;

  return (
    <AppShell>
      <PageHeading
        eyebrow="Operations"
        title="Health & freshness"
        description="Probe-derived health. User submissions cannot set uptime, latency, or incident state."
        right={
          <AutoRefreshControl
            enabled={enabled}
            visible={visible}
            intervalMs={intervalMs}
            onToggle={() => setEnabled((v) => !v)}
            onIntervalChange={setIntervalMs}
          />
        }
      />
      <div className="space-y-8">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <GlobalHealth interval={effectiveInterval} />
          </Suspense>
        </QueryErrorBoundary>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Source health
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <SourceHealth interval={effectiveInterval} />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Incidents
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <Incidents interval={effectiveInterval} />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
    </AppShell>
  );
}

function AutoRefreshControl({
  enabled,
  visible,
  intervalMs,
  onToggle,
  onIntervalChange,
}: {
  enabled: boolean;
  visible: boolean;
  intervalMs: number;
  onToggle: () => void;
  onIntervalChange: (ms: number) => void;
}) {
  const fetching = useIsFetching({ queryKey: ["metagraphed"] });
  const active = enabled && visible;
  const [secondsLeft, setSecondsLeft] = useState(Math.round(intervalMs / 1000));

  // Restart the countdown whenever the interval, the enabled state, or visibility flips.
  useEffect(() => {
    setSecondsLeft(Math.round(intervalMs / 1000));
    if (!active) return;
    const total = Math.round(intervalMs / 1000);
    const i = window.setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? total : s - 1));
    }, 1000);
    return () => window.clearInterval(i);
  }, [active, intervalMs]);

  // Quiet aria-live: only announce meaningful state transitions, never the
  // per-second countdown. Screen readers read at human cadence, not 1Hz.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!enabled) {
      setAnnouncement("Auto-refresh paused.");
      return;
    }
    if (!visible) {
      setAnnouncement("Auto-refresh paused while tab is hidden.");
      return;
    }
    setAnnouncement(`Auto-refresh on, every ${Math.round(intervalMs / 1000)} seconds.`);
  }, [enabled, visible, intervalMs]);


  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="health-interval">
        Auto-refresh interval
      </label>
      <select
        id="health-interval"
        value={intervalMs}
        onChange={(e) => onIntervalChange(Number(e.target.value))}
        disabled={!enabled}
        className="rounded border border-border bg-card px-2 py-1 text-[11px] font-medium text-ink disabled:opacity-60"
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            every {opt.label}
          </option>
        ))}
      </select>

      <button
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors"
        title={enabled ? "Pause auto-refresh" : "Resume auto-refresh"}
        aria-pressed={enabled}
      >
        {enabled ? <Pause className="size-3" /> : <Play className="size-3" />}
        {!enabled
          ? "Paused"
          : !visible
            ? "Tab hidden"
            : `Next sync · ${secondsLeft}s`}
      </button>

      {enabled && !visible ? (
        <span
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted"
          title="Auto-refresh pauses while this tab is in the background."
        >
          <EyeOff className="size-3" /> auto-paused
        </span>
      ) : null}

      <span
        className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted"
        title={fetching ? "Refreshing…" : "Idle"}
      >
        <RefreshCw className={`size-3 ${fetching ? "animate-spin text-ink-strong" : "text-ink-muted"}`} />
        {fetching ? "syncing" : "idle"}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {fetching ? "Refreshing health data" : ""}
      </span>
    </div>
  );
}

function GlobalHealth({ interval }: { interval: number | false }) {
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval: interval });
  const { data: fRes } = useSuspenseQuery({ ...freshnessQuery(), refetchInterval: interval });
  const h = hRes.data;
  const f = fRes.data;
  const stale = isStaleFreshness(hRes.meta?.generated_at);
  return (
    <div className="space-y-3">
      {stale ? <StaleBanner generatedAt={hRes.meta?.generated_at} /> : null}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border border border-border rounded overflow-hidden">
        <Cell label="OK" value={formatNumber(h?.ok)} accent="text-health-ok" />
        <Cell label="Warn" value={formatNumber(h?.warn)} accent="text-health-warn" />
        <Cell label="Down" value={formatNumber(h?.down)} accent="text-health-down" />
        <Cell label="Unknown" value={formatNumber(h?.unknown)} accent="text-ink-muted" />
        <Cell label="Uptime 24h" value={h?.uptime_24h != null ? `${(h.uptime_24h * 100).toFixed(2)}%` : "—"} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-border border border-border rounded overflow-hidden">
        <Cell label="Avg age" value={f?.avg_age_seconds != null ? `${Math.round(f.avg_age_seconds)}s` : "—"} />
        <Cell label="Max age" value={f?.max_age_seconds != null ? `${Math.round(f.max_age_seconds)}s` : "—"} />
        <Cell label="Stale sources" value={formatNumber(f?.stale_count)} />
      </div>
      <div className="text-[11px] font-mono text-ink-muted">
        snapshot {formatRelative(hRes.meta?.generated_at)}
      </div>
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className={`font-display text-xl font-semibold tabular-nums ${accent ?? "text-ink-strong"}`}>{value}</div>
    </div>
  );
}

function SourceHealth({ interval }: { interval: number | false }) {
  const { data } = useSuspenseQuery({ ...sourceHealthQuery(), refetchInterval: interval });
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="No source health" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Freshness</th>
            <th className="px-3 py-2 text-right">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((s) => (
            <tr key={s.name}>
              <td className="px-3 py-2 font-medium">{s.name}</td>
              <td className="px-3 py-2"><HealthPill state={s.ok === false ? "down" : s.ok ? "ok" : "unknown"} /></td>
              <td className="px-3 py-2"><FreshnessIndicator at={s.last_seen} dotOnly /></td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{formatRelative(s.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Incidents({ interval }: { interval: number | false }) {
  const { data } = useSuspenseQuery({ ...endpointIncidentsQuery(), refetchInterval: interval });
  const rows = (data.data ?? []) as EndpointIncident[];
  if (rows.length === 0) return <EmptyState title="No recent incidents" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Endpoint</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2 text-left">Message</th>
            <th className="px-3 py-2 text-right">Started</th>
            <th className="px-3 py-2 text-right">Ended</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2 font-mono text-[11px]">{i.endpoint_id ?? "—"}</td>
              <td className="px-3 py-2"><HealthPill state={i.state} /></td>
              <td className="px-3 py-2 text-[12px] text-ink-muted">{i.message ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{formatRelative(i.started_at)}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">{i.ended_at ? formatRelative(i.ended_at) : "ongoing"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
