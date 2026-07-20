import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { ArrowLeft, Coins, Layers, Percent, Scale, Users, BarChart3 } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { PageHero, ShareButton, ActionBar, StatTile, BarMini } from "@jsonbored/ui-kit";
import { domainSummaryQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { DOMAIN_TAGS, type ConcentrationMetrics, type DomainTag } from "@/lib/metagraphed/types";

const DOMAIN_TAG_SET = new Set<string>(DOMAIN_TAGS);

function isDomainTag(tag: string): tag is DomainTag {
  return DOMAIN_TAG_SET.has(tag);
}

export const Route = createFileRoute("/domains/$tag")({
  parseParams: ({ tag }) => {
    const normalized = decodeURIComponent(tag).trim().toLowerCase();
    if (!isDomainTag(normalized)) throw notFound();
    return { tag: normalized };
  },
  head: ({ params }) => {
    const title = `${params.tag} — Domains — Metagraphed`;
    const description = `Capability-domain rollup for ${params.tag}: member subnets, total stake, emission share, and within-domain concentration.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: DomainDetailPage,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading title="Domain not found" />
      <EmptyState
        title="Unknown domain tag"
        description={`Valid tags: ${DOMAIN_TAGS.join(", ")}.`}
        action={{ label: "Back to domains", href: "/domains" }}
      />
    </AppShell>
  ),
});

function DomainDetailPage() {
  const { tag } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DomainDetailSkeleton />}>
          <DomainDetail tag={tag} />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={[`/api/v1/domains/${tag}/summary`, "/api/v1/domains"]}
        artifacts={[`/metagraph/domains/${tag}/summary.json`]}
      />
    </AppShell>
  );
}

function DomainDetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function pctShare(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function giniTone(g?: number | null): "ok" | "warn" | "down" | "default" {
  if (g == null) return "default";
  if (g >= 0.85) return "down";
  if (g >= 0.6) return "warn";
  return "ok";
}

function nakamotoTone(n?: number | null): "ok" | "warn" | "down" | "default" {
  if (n == null) return "default";
  if (n <= 1) return "down";
  if (n <= 3) return "warn";
  return "ok";
}

function DomainDetail({ tag }: { tag: DomainTag }) {
  const { data: res } = useSuspenseQuery(domainSummaryQuery(tag));
  const d = res.data;
  const conc = d.emission_concentration;

  return (
    <div className="space-y-8" id="domain-detail">
      <PageHero
        eyebrow="Domain"
        live
        title={d.domain}
        description="Live rollup over member subnets in this capability tag — stake, emission share, and emission concentration within the domain."
        actions={
          <ActionBar>
            <Link
              to="/domains"
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
            >
              <ArrowLeft className="size-3" aria-hidden />
              All domains
            </Link>
            <Link
              to="/subnets"
              search={{ domain: d.domain }}
              className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 py-1 min-h-8 font-mono text-[11px] uppercase tracking-widest text-accent-text hover:border-accent/60 transition-colors"
            >
              Browse subnets
            </Link>
            <ShareButton bare />
          </ActionBar>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Layers} eyebrow="Member subnets" value={formatNumber(d.subnet_count)} />
        <StatTile icon={Coins} eyebrow="Total stake" value={formatTao(d.total_stake_tao)} />
        <StatTile
          icon={Percent}
          eyebrow="Emission share"
          value={pctShare(d.total_emission_share)}
        />
        <StatTile
          icon={Scale}
          eyebrow="Emission Gini"
          value={conc?.gini != null ? conc.gini.toFixed(3) : "—"}
          tone={giniTone(conc?.gini)}
          hint={
            conc?.nakamoto_coefficient != null
              ? `Nakamoto ${conc.nakamoto_coefficient}`
              : "within-domain"
          }
        />
      </div>

      {conc ? <ConcentrationStrip metrics={conc} /> : null}

      <MemberSubnets netuids={d.netuids} tag={tag} />
    </div>
  );
}

function ConcentrationStrip({ metrics }: { metrics: ConcentrationMetrics }) {
  const bars = [
    { label: "Top 1%", value: pctToBar(metrics.top_1pct_share) },
    { label: "Top 5%", value: pctToBar(metrics.top_5pct_share) },
    { label: "Top 10%", value: pctToBar(metrics.top_10pct_share) },
    { label: "Top 20%", value: pctToBar(metrics.top_20pct_share) },
  ];
  const allEmpty = bars.every((b) => b.value === 0);
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 space-y-4"
      id="domain-concentration"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Emission concentration
        </h2>
        <p className="text-[12px] text-ink-muted">
          Across {formatNumber(metrics.holders)} emitting members in this domain
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Users}
          eyebrow="Nakamoto"
          value={metrics.nakamoto_coefficient ?? "—"}
          hint="members to 51%"
          tone={nakamotoTone(metrics.nakamoto_coefficient)}
        />
        <StatTile
          icon={BarChart3}
          eyebrow="HHI"
          value={metrics.hhi != null ? metrics.hhi.toFixed(3) : "—"}
          hint={
            metrics.hhi_normalized != null ? `norm ${metrics.hhi_normalized.toFixed(3)}` : undefined
          }
          tone={giniTone(metrics.hhi)}
        />
        <StatTile
          icon={Percent}
          eyebrow="Top 10% share"
          value={pctShare(metrics.top_10pct_share)}
        />
      </div>
      {allEmpty ? (
        <p className="font-mono text-[11px] text-ink-muted">Not enough share data yet.</p>
      ) : (
        <BarMini data={bars} max={100} />
      )}
    </div>
  );
}

function pctToBar(v?: number | null): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

function MemberSubnets({ netuids, tag }: { netuids: number[]; tag: DomainTag }) {
  const { data: subnetsRes } = useSuspenseQuery(subnetsQuery({ limit: 200 }));
  const byId = new Map((subnetsRes.data ?? []).map((s) => [s.netuid, s]));
  const ordered = netuids.slice().sort((a, b) => a - b);

  if (ordered.length === 0) {
    return (
      <EmptyState
        title="No member subnets"
        description="No active Finney subnets currently carry this capability tag."
        action={{ label: "Back to domains", href: "/domains" }}
      />
    );
  }

  return (
    <section className="space-y-3" id="domain-members">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Member subnets
        </h2>
        <Link
          to="/subnets"
          search={{ domain: tag }}
          className="font-mono text-[11px] uppercase tracking-widest text-accent-text hover:underline"
        >
          Open filtered table →
        </Link>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((netuid) => {
          const s = byId.get(netuid);
          return (
            <li key={netuid}>
              <Link
                to="/subnets/$netuid"
                params={{ netuid }}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-ink/30 hover:bg-surface transition-colors"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-strong">
                    {s?.name ?? `Subnet ${netuid}`}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    SN{netuid}
                    {s?.symbol ? ` · ${s.symbol}` : ""}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-muted">→</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
