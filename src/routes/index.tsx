import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, ErrorState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import {
  coverageQuery,
  freshnessQuery,
  healthQuery,
  subnetsQuery,
  adapterQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Metagraphed — Bittensor public-interface registry" },
      {
        name: "description",
        content:
          "Unofficial registry and explorer for Bittensor subnet APIs, schemas, docs, endpoints, providers, and health.",
      },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Overview"
        title="Bittensor public-interface registry"
        description="A builder-facing index of subnet APIs, schemas, docs, endpoints, providers, freshness, and registry gaps. Unofficial — not a block explorer."
        right={<CopyableCode label="API" value={`${API_BASE}/api/v1`} truncate={false} />}
      />

      <Suspense fallback={<StatStripSkeleton />}>
        <StatStrip />
      </Suspense>

      <section className="mt-8">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-3">
          Featured adapter-backed pilots
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <PilotCard slug="allways" netuid={7} title="Allways" subtitle="SN7" />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <PilotCard slug="gittensor" netuid={74} title="Gittensor" subtitle="SN74" />
          </Suspense>
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
            Active subnets
          </h2>
          <Link
            to="/subnets"
            className="text-xs text-ink-muted hover:text-ink-strong underline underline-offset-2"
          >
            View full registry →
          </Link>
        </div>
        <Suspense fallback={<TableSkeleton />}>
          <SubnetPreviewTable />
        </Suspense>
      </section>
    </AppShell>
  );
}

function StatStripSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded overflow-hidden">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-card p-4">
          <Skeleton className="h-3 w-24 mb-2" />
          <Skeleton className="h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

function StatCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card p-4 mg-kpi">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="mg-kpi-num font-display text-2xl font-semibold tracking-tight text-ink-strong tabular-nums">
          {value}
        </span>
        {hint ? <span className="font-mono text-[10px] text-ink-muted">{hint}</span> : null}
      </div>
    </div>
  );
}

function StatStrip() {
  let coverage, freshness, health;
  try {
    coverage = useSuspenseQuery(coverageQuery()).data.data;
  } catch {
    /* tolerate */
  }
  try {
    freshness = useSuspenseQuery(freshnessQuery()).data.data;
  } catch {
    /* tolerate */
  }
  try {
    health = useSuspenseQuery(healthQuery()).data.data;
  } catch {
    /* tolerate */
  }

  const total = coverage?.netuids_total ?? coverage?.netuids_active;
  const active = coverage?.netuids_active;
  const adapter = coverage?.adapter_backed;
  const avgAge = freshness?.avg_age_seconds;
  const ok = health?.ok;
  const totalHealth = health?.total;
  const uptime = health?.uptime_24h;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded overflow-hidden">
      <StatCell
        label="Active subnets"
        value={active != null ? formatNumber(active) : "—"}
        hint={total != null ? `of ${formatNumber(total)}` : undefined}
      />
      <StatCell
        label="Adapter-backed"
        value={adapter != null ? formatNumber(adapter) : "—"}
        hint="pilots"
      />
      <StatCell
        label="Avg freshness"
        value={avgAge != null ? `${Math.round(avgAge)}s` : "—"}
        hint="poll lag"
      />
      <StatCell
        label="Health"
        value={
          uptime != null
            ? `${(uptime * 100).toFixed(uptime < 0.999 ? 1 : 2)}%`
            : ok != null && totalHealth
              ? `${ok}/${totalHealth}`
              : "—"
        }
        hint="24h"
      />
    </div>
  );
}

function PilotCard({
  slug,
  netuid,
  title,
  subtitle,
}: {
  slug: string;
  netuid: number;
  title: string;
  subtitle: string;
}) {
  let snapshot;
  try {
    snapshot = useSuspenseQuery(adapterQuery(slug)).data;
  } catch (e) {
    return (
      <Link
        to="/subnets/$netuid"
        params={{ netuid: String(netuid) }}
        className="block rounded border border-border bg-card p-4 hover:border-ink/30 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {subtitle}
            </div>
            <div className="font-display text-lg font-semibold text-ink-strong">{title}</div>
          </div>
          <CurationChip level="adapter-backed" />
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Pilot adapter — open the subnet page for surfaces, endpoints, and evidence.
        </p>
      </Link>
    );
  }

  const generated = snapshot.meta?.generated_at;
  const metrics = (snapshot.data?.metrics ?? {}) as Record<string, unknown>;
  const metricEntries = Object.entries(metrics).slice(0, 4);

  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: String(netuid) }}
      className="block rounded border border-border bg-card p-4 hover:border-ink/30 transition-colors"
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {subtitle}
          </div>
          <div className="font-display text-lg font-semibold text-ink-strong">{title}</div>
        </div>
        <CurationChip level="adapter-backed" />
      </div>
      {metricEntries.length > 0 ? (
        <dl className="grid grid-cols-2 gap-2">
          {metricEntries.map(([k, v]) => (
            <div key={k} className="rounded border border-border bg-paper px-2 py-1.5">
              <dt className="font-mono text-[9px] uppercase tracking-widest text-ink-muted truncate">
                {k}
              </dt>
              <dd className="font-mono text-[12px] text-ink-strong truncate">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-ink-muted">Adapter connected. Open subnet for detail.</p>
      )}
      {generated ? (
        <div className="mt-2 font-mono text-[10px] text-ink-muted">
          updated <TimeAgo at={generated} />
        </div>
      ) : null}
    </Link>
  );
}

function TableSkeleton() {
  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="border-b border-border last:border-b-0 px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

function SubnetPreviewTable() {
  const { data, refetch } = useSuspenseQuery(subnetsQuery({ limit: 12 }));
  const { data: healthRes } = useSuspenseQuery(healthQuery());
  const subnets = (data.data ?? []) as Subnet[];
  const healthBySubnet = new Map<number, "ok" | "warn" | "down" | "unknown">();
  const hsubs = (healthRes.data as { subnets?: Array<{ netuid: number; status?: string }> })
    ?.subnets;
  if (Array.isArray(hsubs)) {
    for (const s of hsubs) {
      const st = s.status;
      const mapped: "ok" | "warn" | "down" | "unknown" =
        st === "ok" ? "ok" : st === "degraded" ? "warn" : st === "failed" ? "down" : "unknown";
      healthBySubnet.set(s.netuid, mapped);
    }
  }

  if (!Array.isArray(subnets) || subnets.length === 0) {
    return (
      <EmptyState
        title="No subnets returned"
        description="The API responded but returned an empty list."
      />
    );
  }

  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">UID</th>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Symbol</th>
              <th className="px-4 py-2.5 font-medium text-right">Participants</th>
              <th className="px-4 py-2.5 font-medium">Curation</th>
              <th className="px-4 py-2.5 font-medium text-right">Surfaces</th>
              <th className="px-4 py-2.5 font-medium">Health</th>
              <th className="px-4 py-2.5 font-medium text-right">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {subnets.slice(0, 12).map((s) => (
              <tr key={s.netuid} className="hover:bg-surface/40 transition-colors">
                <td className="px-4 py-2.5 font-mono text-[12px] text-ink-muted">
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: String(s.netuid) }}
                    className="hover:text-ink-strong"
                  >
                    {String(s.netuid).padStart(3, "0")}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: String(s.netuid) }}
                    className="font-medium text-ink-strong hover:underline"
                  >
                    {s.name ?? `Subnet ${s.netuid}`}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {s.symbol ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] text-ink">
                  {formatNumber(s.participants)}
                </td>
                <td className="px-4 py-2.5">
                  <CurationChip level={s.curation_level} />
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px]">
                  {s.surfaces_count ?? "—"}
                </td>
                <td className="px-4 py-2.5">
                  <HealthPill state={s.health ?? healthBySubnet.get(s.netuid) ?? "unknown"} />
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={s.updated_at ?? s.freshness} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border bg-surface/30 px-4 py-2 flex justify-between text-[11px] font-mono text-ink-muted">
        <span>Showing first {Math.min(12, subnets.length)} of {subnets.length}</span>
        <button onClick={() => refetch()} className="hover:text-ink-strong">refresh</button>
      </div>
    </div>
  );
}

export function ErrorBoundaryFallback({ error }: { error: unknown }) {
  return <ErrorState error={error} />;
}
