import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { PageHero, SectionHeading, StatTile, TableState } from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { domainSummaryQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao, formatPercent } from "@/lib/metagraphed/format";

export const Route = createFileRoute("/domains/$tag")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.tag} domain — Metagraphed` },
      {
        name: "description",
        content: `Subnets in the ${params.tag} capability domain — member count, total stake, emission share, and within-domain emission concentration.`,
      },
    ],
  }),
  component: DomainDetailPage,
});

function DomainDetailPage() {
  const { tag } = Route.useParams();
  return (
    <AppShell>
      <PageHero
        eyebrow="Registry · Domain"
        live
        title={tag}
        description={`Subnets tagged to the ${tag} capability domain, with combined stake, emission share, and how concentrated that emission is across the domain's members.`}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <DomainDetailContent tag={tag} />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={[`/api/v1/domains/${tag}/summary`]}
        artifacts={[`/metagraph/domains/${tag}/summary.json`]}
      />
    </AppShell>
  );
}

function DomainDetailContent({ tag }: { tag: string }) {
  const { data: res } = useSuspenseQuery(domainSummaryQuery(tag));
  const domain = res.data;

  if (!domain) {
    return (
      <TableState
        variant="empty"
        title="Domain not found"
        description={`No rollup exists for "${tag}". It may not be a recognized capability-domain tag.`}
      />
    );
  }

  const c = domain.emission_concentration;

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-3 [&>*]:grow [&>*]:basis-[160px]">
        <StatTile eyebrow="Member subnets" value={formatNumber(domain.subnet_count)} />
        <StatTile eyebrow="Total stake" value={formatTao(domain.total_stake_tao)} tone="accent" />
        <StatTile eyebrow="Emission share" value={formatPercent(domain.total_emission_share)} />
      </div>

      <SectionHeading title="Emission concentration" />
      <p className="mb-4 max-w-2xl text-sm text-ink-muted">
        How evenly emission is spread across this domain&apos;s member subnets — a low Gini / high
        Nakamoto coefficient means emission is broadly shared, a high Gini / low Nakamoto means it
        clusters in a few subnets.
      </p>
      <div className="mb-8 flex flex-wrap gap-3 [&>*]:grow [&>*]:basis-[150px]">
        <StatTile
          eyebrow="Gini"
          value={c?.gini != null ? c.gini.toFixed(3) : "—"}
          hint="0 = even, 1 = concentrated"
        />
        <StatTile
          eyebrow="Nakamoto"
          value={formatNumber(c?.nakamoto_coefficient)}
          hint="subnets holding >50%"
        />
        <StatTile eyebrow="HHI" value={c?.hhi != null ? c.hhi.toFixed(3) : "—"} />
        <StatTile eyebrow="Top 1 share" value={formatPercent(c?.top_1pct_share)} />
        <StatTile eyebrow="Top 5 share" value={formatPercent(c?.top_5pct_share)} />
        <StatTile eyebrow="Top 10 share" value={formatPercent(c?.top_10pct_share)} />
      </div>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <SectionHeading title={`Member subnets (${formatNumber(domain.netuids.length)})`} />
        <Link
          to="/subnets"
          search={{ domain: domain.domain }}
          className="font-mono text-xs text-accent hover:underline"
        >
          View in subnets table →
        </Link>
      </div>
      {domain.netuids.length === 0 ? (
        <TableState
          variant="empty"
          title="No member subnets"
          description="This domain currently has no subnets tagged to it."
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {domain.netuids.map((netuid) => (
            <Link
              key={netuid}
              to="/subnets/$netuid"
              params={{ netuid }}
              className="rounded-md border border-border bg-card px-2.5 py-1 font-mono text-[12px] tabular-nums text-ink hover:border-accent/40 hover:text-ink-strong"
            >
              SN{netuid}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
