import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { PageHero, TableState } from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { domainsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao, formatPercent } from "@/lib/metagraphed/format";
import type { Domain } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/domains/")({
  head: () => ({
    meta: [
      { title: "Domains — Metagraphed" },
      {
        name: "description",
        content:
          "Browse Bittensor subnets by capability domain — member count, total stake, emission share, and within-domain emission concentration for every taxonomy tag.",
      },
      { property: "og:title", content: "Domains — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse Bittensor subnets by capability domain — member count, total stake, emission share, and emission concentration for every taxonomy tag.",
      },
    ],
  }),
  component: DomainsPage,
});

/** Emission share desc, then subnet count desc — biggest domains first. */
function orderDomains(domains: Domain[]): Domain[] {
  return [...domains].sort(
    (a, b) =>
      (b.total_emission_share ?? 0) - (a.total_emission_share ?? 0) ||
      (b.subnet_count ?? 0) - (a.subnet_count ?? 0) ||
      a.domain.localeCompare(b.domain),
  );
}

function DomainsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Registry"
        live
        title="Domains"
        description="Every capability domain in the taxonomy — the subnets tagged to it, their combined stake and emission share, and how concentrated that emission is within the domain. Pick one to drill into its members or filter the subnets table by it."
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <DomainsContent />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/domains"]} artifacts={["/metagraph/domains/index.json"]} />
    </AppShell>
  );
}

function DomainsContent() {
  const { data: res } = useSuspenseQuery(domainsQuery());
  const rows = orderDomains(res.data);

  if (rows.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No domains available"
        description="The domain rollup has no entries right now — this reflects the live /api/v1/domains response."
      />
    );
  }

  return (
    <>
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile label="Domains" value={formatNumber(rows.length)} />
        <KpiTile
          label="Subnets tagged"
          value={formatNumber(rows.reduce((n, d) => n + (d.subnet_count ?? 0), 0))}
        />
        <KpiTile
          label="Total stake"
          value={formatTao(rows.reduce((n, d) => n + (d.total_stake_tao ?? 0), 0))}
        />
        <KpiTile
          label="Emission share"
          value={formatPercent(rows.reduce((n, d) => n + (d.total_emission_share ?? 0), 0))}
        />
      </div>

      <div className="hidden md:block rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
              <tr>
                <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                  Domain
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Subnets
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Total Stake
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Emission Share
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Gini
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Nakamoto
                </th>
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  <span className="sr-only">Filter subnets</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.domain} className="mg-row-hover border-t border-border/60">
                  <td className="px-3 py-2.5">
                    <Link
                      to="/domains/$tag"
                      params={{ tag: d.domain }}
                      className="font-medium text-ink-strong hover:underline"
                    >
                      {d.domain}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                    {formatNumber(d.subnet_count)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums">
                    {formatTao(d.total_stake_tao)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums">
                    {formatPercent(d.total_emission_share)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                    {d.emission_concentration?.gini != null
                      ? d.emission_concentration.gini.toFixed(3)
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                    {formatNumber(d.emission_concentration?.nakamoto_coefficient)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      to="/subnets"
                      search={{ domain: d.domain }}
                      className="font-mono text-[11px] text-accent hover:underline"
                    >
                      Filter →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:hidden">
        {rows.map((d) => (
          <div key={d.domain} className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between">
              <Link
                to="/domains/$tag"
                params={{ tag: d.domain }}
                className="font-medium text-ink-strong hover:underline"
              >
                {d.domain}
              </Link>
              <span className="font-mono text-[11px] text-ink-muted">
                {formatNumber(d.subnet_count)} subnets
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums text-ink-muted">
              <span>Stake {formatTao(d.total_stake_tao)}</span>
              <span>Emission {formatPercent(d.total_emission_share)}</span>
              <span>
                Gini{" "}
                {d.emission_concentration?.gini != null
                  ? d.emission_concentration.gini.toFixed(3)
                  : "—"}
              </span>
              <span>Nakamoto {formatNumber(d.emission_concentration?.nakamoto_coefficient)}</span>
            </div>
            <Link
              to="/subnets"
              search={{ domain: d.domain }}
              className="mt-2 inline-block font-mono text-[11px] text-accent hover:underline"
            >
              Filter subnets →
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className="mt-1 font-mono text-lg text-ink-strong tabular-nums">{value}</div>
    </div>
  );
}
