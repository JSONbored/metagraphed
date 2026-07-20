import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { Layers, Coins, Percent } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { PageHero, ShareButton, ActionBar, StatTile } from "@jsonbored/ui-kit";
import { domainsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { DomainSummary, DomainTag } from "@/lib/metagraphed/types";
import { DOMAIN_TAGS } from "@/lib/metagraphed/types";

const DOMAIN_TAG_SET = new Set<string>(DOMAIN_TAGS);

function asDomainTag(tag: string): DomainTag {
  if (!DOMAIN_TAG_SET.has(tag)) {
    // Overview rows always come from the fixed taxonomy; fall back defensively
    // so a stale/unknown tag still links rather than failing the render.
    return tag as DomainTag;
  }
  return tag as DomainTag;
}

export const Route = createFileRoute("/domains/")({
  head: () => ({
    meta: [
      { title: "Domains — Metagraphed" },
      {
        name: "description",
        content:
          "Browse Bittensor subnets by capability domain — stake, emission share, and within-domain concentration for each of the 14 taxonomy tags.",
      },
      { property: "og:title", content: "Domains — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse Bittensor subnets by capability domain — stake, emission share, and within-domain concentration for each of the 14 taxonomy tags.",
      },
    ],
  }),
  component: DomainsPage,
});

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

function DomainsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Registry"
        live
        title="Domains"
        description="Capability-tag rollups across the fixed 14-tag taxonomy — member count, stake, emission share, and within-domain concentration."
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<DomainsSkeleton />}>
          <DomainsOverview />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={["/api/v1/domains", "/api/v1/domains/{tag}/summary"]}
        artifacts={["/metagraph/domains.json"]}
      />
    </AppShell>
  );
}

function DomainsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

function pctShare(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function DomainsOverview() {
  const { data: res } = useSuspenseQuery(domainsQuery());
  const overview = res.data;
  const ranked = useMemo(
    () =>
      [...overview.domains].sort(
        (a, b) => (b.total_emission_share ?? -1) - (a.total_emission_share ?? -1),
      ),
    [overview.domains],
  );

  const taggedSubnets = useMemo(
    () => ranked.reduce((sum, d) => sum + (d.subnet_count ?? 0), 0),
    [ranked],
  );
  const totalEmission = useMemo(
    () => ranked.reduce((sum, d) => sum + (d.total_emission_share ?? 0), 0),
    [ranked],
  );

  if (ranked.length === 0) {
    return (
      <EmptyState
        title="No domain rollups"
        description="Domain aggregation will appear here once the subnets index and economics tier are available."
      />
    );
  }

  return (
    <div className="space-y-6" id="domains-overview">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile icon={Layers} eyebrow="Domains" value={formatNumber(overview.domain_count)} />
        <StatTile
          icon={Coins}
          eyebrow="Tagged memberships"
          value={formatNumber(taggedSubnets)}
          hint="a subnet may appear in several domains"
        />
        <StatTile
          icon={Percent}
          eyebrow="Emission covered"
          value={pctShare(totalEmission)}
          hint="sum of per-domain shares (overlap possible)"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface/60">
            <tr>
              <th className={TH}>Domain</th>
              <th className={`${TH} text-right`}>Subnets</th>
              <th className={`${TH} text-right`}>Stake</th>
              <th className={`${TH} text-right`}>Emission</th>
              <th className={`${TH} text-right`}>Gini</th>
              <th className={`${TH} text-right`}>Nakamoto</th>
              <th className={`${TH} text-right`}>Browse</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((d) => (
              <DomainRow key={d.domain} domain={d} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DomainRow({ domain: d }: { domain: DomainSummary }) {
  const gini = d.emission_concentration?.gini;
  const nakamoto = d.emission_concentration?.nakamoto_coefficient;
  return (
    <tr className="border-b border-border/70 last:border-0 hover:bg-surface/40">
      <td className="px-4 py-3">
        <Link
          to="/domains/$tag"
          params={{ tag: asDomainTag(d.domain) }}
          className="font-medium text-ink-strong hover:text-accent-text"
        >
          {d.domain}
        </Link>
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
        {formatNumber(d.subnet_count)}
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
        {formatTao(d.total_stake_tao)}
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
        {pctShare(d.total_emission_share)}
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-muted">
        {gini != null && Number.isFinite(gini) ? gini.toFixed(3) : "—"}
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-muted">
        {nakamoto != null ? formatNumber(nakamoto) : "—"}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to="/subnets"
          search={{ domain: d.domain }}
          className="font-mono text-[11px] uppercase tracking-widest text-accent-text hover:underline"
        >
          Subnets
        </Link>
      </td>
    </tr>
  );
}
