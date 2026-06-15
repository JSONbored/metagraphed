import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { ArrowUpRight, Network, Activity, Server, FileCode2, Radio } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { RegistryPulse } from "@/components/metagraphed/charts/registry-pulse";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import { KpiCard } from "@/components/metagraphed/kpi-card";
import { HeroOrnament } from "@/components/metagraphed/hero-ornament";
import {
  coverageQuery,
  freshnessQuery,
  healthQuery,
  subnetsQuery,
  adapterQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
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
      <HomeHero />
      <KpiStrip />
      <RegistryPulse />

      <section className="mt-10">
        <SectionEyebrow>Featured pilots</SectionEyebrow>
        <h2 className="font-display text-xl font-semibold tracking-tight text-ink-strong mt-1 mb-3">
          Adapter-backed subnets
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <QueryErrorBoundary
            fallback={() => <PilotCardFallback netuid={7} title="Allways" subtitle="SN7" />}
          >
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <PilotCard slug="allways" netuid={7} title="Allways" subtitle="SN7" />
            </Suspense>
          </QueryErrorBoundary>
          <QueryErrorBoundary
            fallback={() => <PilotCardFallback netuid={74} title="Gittensor" subtitle="SN74" />}
          >
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <PilotCard slug="gittensor" netuid={74} title="Gittensor" subtitle="SN74" />
            </Suspense>
          </QueryErrorBoundary>
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <SectionEyebrow live>Live registry</SectionEyebrow>
            <h2 className="font-display text-xl font-semibold tracking-tight text-ink-strong mt-1">
              Active subnets
            </h2>
          </div>
          <Link
            to="/subnets"
            className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink-strong group"
          >
            View full registry
            <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        </div>
        <QueryErrorBoundary>
          <Suspense fallback={<TableSkeleton />}>
            <SubnetPreviewTable />
          </Suspense>
        </QueryErrorBoundary>
      </section>

      <PoweredByFooter />
    </AppShell>
  );
}

/* ----------------------------- hero ----------------------------- */

function HomeHero() {
  return (
    <section className="mg-hero-slab relative overflow-hidden mb-8 px-6 py-10 md:px-10 md:py-14">
      <div className="relative z-10 grid gap-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0 max-w-2xl">
          <div className="mg-fade-in font-mono text-[10px] uppercase tracking-widest text-ink-muted inline-flex items-center gap-2">
            <span className="mg-live-dot" />
            Unofficial · Public · Read-only
          </div>
          <h1 className="mg-fade-in mg-fade-in-delay-1 mt-3 font-display text-3xl sm:text-4xl md:text-5xl font-semibold leading-[1.05] tracking-tight text-ink-strong">
            The public-interface registry for <span className="text-accent">Bittensor</span>.
          </h1>
          <p className="mg-fade-in mg-fade-in-delay-2 mt-4 max-w-xl text-sm md:text-base text-ink-muted leading-relaxed">
            A builder-facing index of subnet APIs, schemas, docs, endpoints, providers, freshness,
            and registry gaps. Not a block explorer.
          </p>
          <div className="mg-fade-in mg-fade-in-delay-3 mt-6 flex flex-wrap items-center gap-3">
            <Link
              to="/subnets"
              className="inline-flex items-center gap-1.5 rounded-full bg-ink-strong px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition-opacity"
            >
              Browse subnets
              <ArrowUpRight className="size-3.5" />
            </Link>
            <Link
              to="/schemas"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-ink hover:border-ink/30 transition-colors"
            >
              Open API reference
            </Link>
            <div className="hidden sm:block">
              <CopyableCode label="API" value={`${API_BASE}/api/v1`} />
            </div>
          </div>
        </div>
        <div className="hidden md:block size-[320px] lg:size-[380px] shrink-0">
          <HeroOrnament className="size-full" />
        </div>
      </div>
    </section>
  );
}

function SectionEyebrow({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted inline-flex items-center gap-2">
      {live ? <span className="mg-live-dot" /> : null}
      {children}
    </div>
  );
}

/* ----------------------------- KPI strip ----------------------------- */

function KpiStrip() {
  // At-a-glance widget; partial loading is fine, so useQuery (not useSuspenseQuery)
  // keeps a single failed stat from blocking the whole strip.
  const coverage = useQuery(coverageQuery()).data?.data;
  const freshness = useQuery(freshnessQuery()).data?.data;
  const health = useQuery(healthQuery()).data?.data;

  const total = coverage?.netuids_total ?? coverage?.netuids_active;
  const active = coverage?.netuids_active;
  const adapter = coverage?.adapter_backed;
  const avgAge = freshness?.avg_age_seconds;
  const ok = health?.ok;
  const totalHealth = health?.total;
  const uptime = health?.uptime_24h;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        icon={Network}
        eyebrow="Active subnets"
        value={active != null ? formatNumber(active) : "—"}
        hint={total != null ? `of ${formatNumber(total)}` : undefined}
        to="/subnets"
        cta="Browse"
      />
      <KpiCard
        icon={Radio}
        eyebrow="Adapter-backed"
        value={adapter != null ? formatNumber(adapter) : "—"}
        hint="pilots"
        to="/providers"
        cta="Providers"
        tone="accent"
      />
      <KpiCard
        icon={Server}
        eyebrow="Avg freshness"
        value={avgAge != null ? humaniseSeconds(avgAge) : "—"}
        hint="poll lag"
        to="/health"
        cta="Health"
      />
      <KpiCard
        icon={Activity}
        eyebrow="Health"
        value={
          uptime != null
            ? `${(uptime * 100).toFixed(uptime < 0.999 ? 1 : 2)}%`
            : ok != null && totalHealth
              ? `${ok}/${totalHealth}`
              : "—"
        }
        hint="24h"
        to="/health"
        cta="Incidents"
      />
    </div>
  );
}

/* ----------------------------- pilot ----------------------------- */

type PilotProps = {
  slug: string;
  netuid: number;
  title: string;
  subtitle: string;
};

// Rendered by the QueryErrorBoundary when the adapter snapshot fails to load —
// the card still links through to the subnet page instead of erroring the row.
function PilotCardFallback({ netuid, title, subtitle }: Omit<PilotProps, "slug">) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid }}
      className="mg-hover-lift block rounded-xl border border-border bg-card p-4"
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

function PilotCard({ slug, netuid, title, subtitle }: PilotProps) {
  // useSuspenseQuery must run unconditionally (no try/catch — that breaks the
  // Rules of Hooks and swallows the Suspense promise). Loading is handled by the
  // wrapping <Suspense>, errors by the wrapping <QueryErrorBoundary>.
  const snapshot = useSuspenseQuery(adapterQuery(slug)).data;

  // The adapter payload carries generated_at on the data object (the envelope
  // meta is a fallback). There is no `metrics` map on the adapter snapshot, so
  // the grid renders nothing rather than fabricating values.
  const generated =
    (snapshot.data as { generated_at?: string } | undefined)?.generated_at ??
    snapshot.meta?.generated_at;
  const metrics = (snapshot.data?.metrics ?? {}) as Record<string, unknown>;
  const metricEntries = Object.entries(metrics).slice(0, 4);

  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid }}
      className="mg-hover-lift block rounded-xl border border-border bg-card p-4"
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
    <div className="rounded-xl border border-border bg-card overflow-hidden">
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
  // Non-blocking: a /api/v1/health failure must not error the whole table —
  // useQuery (not useSuspenseQuery) so the per-subnet overlay degrades gracefully.
  const health = useQuery(healthQuery()).data?.data;
  const coverage = useQuery(coverageQuery()).data?.data;
  const subnets = (data.data ?? []) as Subnet[];
  const healthBySubnet = new Map<number, "ok" | "warn" | "down" | "unknown">();
  const hsubs = (health as { subnets?: Array<{ netuid: number; status?: string }> } | undefined)
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

  const total = coverage?.netuids_active ?? coverage?.netuids_total;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
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
              <tr key={s.netuid} className="mg-row-hover">
                <td className="px-4 py-2.5 font-mono text-[12px] text-ink-muted">
                  <EntityHoverCard kind="subnet" netuid={s.netuid}>
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="hover:text-ink-strong"
                    >
                      {String(s.netuid).padStart(3, "0")}
                    </Link>
                  </EntityHoverCard>
                </td>
                <td className="px-4 py-2.5">
                  <EntityHoverCard kind="subnet" netuid={s.netuid}>
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="inline-flex items-center gap-2 font-medium text-ink-strong hover:underline"
                    >
                      <BrandIcon
                        size={20}
                        name={s.name ?? `Subnet ${s.netuid}`}
                        fallback={s.netuid}
                        url={s.website}
                        netuid={s.netuid}
                      />
                      <span className="truncate">{s.name ?? `Subnet ${s.netuid}`}</span>
                    </Link>
                  </EntityHoverCard>
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
        <span>
          Showing {Math.min(12, subnets.length)}
          {total ? ` of ${formatNumber(total)}` : ""} ·{" "}
          <Link to="/subnets" className="hover:text-ink-strong underline underline-offset-2">
            view all
          </Link>
        </span>
        <button onClick={() => refetch()} className="hover:text-ink-strong">
          refresh
        </button>
      </div>
    </div>
  );
}

function PoweredByFooter() {
  return (
    <div className="mt-12 border-t border-border pt-4 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
      <span className="inline-flex items-center gap-2">
        <FileCode2 className="size-3" />
        Powered by Cloudflare Workers · Static Assets · R2
      </span>
      <span>JSON-Schema canonical · OpenAPI projected</span>
    </div>
  );
}

export function ErrorBoundaryFallback({ error }: { error: unknown }) {
  return <ErrorState error={error} />;
}
