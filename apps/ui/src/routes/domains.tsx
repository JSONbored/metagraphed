import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo, useState } from "react";
import { ChevronRight, Boxes, Coins, Layers } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { PageHero, BrandIcon, StatTile, ShareButton, ActionBar } from "@jsonbored/ui-kit";
import { domainsQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, classNames } from "@/lib/metagraphed/format";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import type { DomainRollup, Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/domains")({
  head: () => ({
    meta: [
      { title: "Domains — Metagraphed" },
      {
        name: "description",
        content:
          "Bittensor subnets rolled up by capability domain — member count, total stake, emission share, and within-domain emission concentration for every tag in the 14-tag taxonomy, computed live.",
      },
      { property: "og:title", content: "Domains — Metagraphed" },
      {
        property: "og:description",
        content: "Bittensor capability-domain rollups — stake, emission share, and concentration.",
      },
    ],
  }),
  component: DomainsPage,
});

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

// Tags arrive as lowercase slugs ("agents", "data-scraping"); render them as
// spaced Title Case for headings without losing the raw slug used as the key.
function domainLabel(domain: string): string {
  return domain
    .split(/[-_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const pct = (v: number | undefined) =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";

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

function DomainsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Domains"
        description="Bittensor subnets rolled up by capability domain — member count, total stake, emission share, and within-domain emission concentration, computed live from the registry taxonomy and economics snapshot."
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
      <ApiSourceFooter paths={["/api/v1/domains"]} />
    </AppShell>
  );
}

// Shared subnet lookup so an expanded domain can render each member's brand icon
// + name for its netuid. subnetsQuery is cached per key, so mounting it here is a
// single shared fetch rather than a per-domain waterfall.
function useSubnetById(): Map<number, Subnet> {
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  return useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);
}

function DomainsOverview() {
  const { data: res } = useSuspenseQuery(domainsQuery());
  const domains = res.data.domains;
  const subnetById = useSubnetById();
  const [expanded, setExpanded] = useState<string | null>(null);

  const totals = useMemo(() => {
    const subnets = domains.reduce((sum, d) => sum + (d.subnet_count ?? 0), 0);
    const emission = domains.reduce((sum, d) => sum + (d.total_emission_share ?? 0), 0);
    // domains are pre-sorted by stake, so the first row is the largest.
    const topByStake = domains[0];
    return { subnets, emission, topByStake };
  }, [domains]);

  if (domains.length === 0) {
    return (
      <EmptyState
        title="No domains indexed yet"
        description="The domain taxonomy rollup is empty for this network."
        action={{
          label: "Open /api/v1/domains",
          href: "/api/v1/domains",
          external: true,
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Layers}
          eyebrow="Domains"
          value={formatNumber(domains.length)}
          hint="capability tags in the taxonomy"
          tone="accent"
        />
        <StatTile
          icon={Boxes}
          eyebrow="Subnets tagged"
          value={formatNumber(totals.subnets)}
          hint="members across all domains"
        />
        <StatTile
          icon={Coins}
          eyebrow="Top domain by stake"
          value={totals.topByStake ? domainLabel(totals.topByStake.domain) : "—"}
          hint={
            totals.topByStake?.total_stake_tao != null
              ? `${taoCompact(totals.topByStake.total_stake_tao)} τ staked`
              : "no stake data"
          }
        />
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Domain rollups
          </span>
          <span className="font-mono text-[11px] text-ink-muted">
            {formatNumber(domains.length)} domains · ranked by total stake
          </span>
        </div>

        {/* < md: the 5-column table clips trailing columns behind an
            undiscoverable horizontal scroll, so narrow viewports get a stacked
            card per domain instead — mirrors the leaderboards boards' split. */}
        <div className="md:hidden space-y-2 p-3">
          {domains.map((d) => (
            <DomainCard
              key={d.domain}
              domain={d}
              subnetById={subnetById}
              open={expanded === d.domain}
              onToggle={() => setExpanded(expanded === d.domain ? null : d.domain)}
            />
          ))}
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TH}>Domain</th>
                <th className={`${TH} text-right`}>Subnets</th>
                <th className={`${TH} text-right`}>Total stake</th>
                <th className={`${TH} text-right`}>Emission share</th>
                <th className={`${TH} text-right`}>Nakamoto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {domains.map((d) => (
                <DomainRow
                  key={d.domain}
                  domain={d}
                  subnetById={subnetById}
                  open={expanded === d.domain}
                  onToggle={() => setExpanded(expanded === d.domain ? null : d.domain)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// The list of member subnets shown when a domain is expanded — each links to its
// own detail page (the issue's "linking through to" requirement), plus a
// concentration read-out the flat table row can't fit.
function DomainMembers({
  domain,
  subnetById,
}: {
  domain: DomainRollup;
  subnetById: Map<number, Subnet>;
}) {
  const conc = domain.emission_concentration;
  const netuids = domain.netuids ?? [];
  return (
    <div className="space-y-3 border-t border-border bg-surface/30 px-4 py-3">
      {conc ? (
        <p className="font-mono text-[11px] text-ink-muted">
          Emission concentration — Gini {conc.gini != null ? conc.gini.toFixed(3) : "—"} · top-20%{" "}
          {pct(conc.top_20pct_share)} · Nakamoto {conc.nakamoto_coefficient ?? "—"}
        </p>
      ) : null}
      {netuids.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {netuids.map((netuid) => {
            const subnet = subnetById.get(netuid);
            const name = subnet?.name ?? `Subnet ${netuid}`;
            return (
              <Link
                key={netuid}
                to="/subnets/$netuid"
                params={{ netuid }}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-accent/40 hover:text-accent"
              >
                <BrandIcon
                  size={14}
                  name={name}
                  fallback={netuid}
                  netuid={netuid}
                  subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                />
                <span className="truncate text-ink-strong">{name}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">No member netuids listed for this domain.</p>
      )}
    </div>
  );
}

function DomainRow({
  domain,
  subnetById,
  open,
  onToggle,
}: {
  domain: DomainRollup;
  subnetById: Map<number, Subnet>;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-surface/40" onClick={onToggle} aria-expanded={open}>
        <td className="px-4 py-2.5">
          <span className="inline-flex items-center gap-2">
            <ChevronRight
              className={classNames(
                "size-3.5 shrink-0 text-ink-muted transition-transform",
                open && "rotate-90",
              )}
              aria-hidden
            />
            <span className="text-sm text-ink-strong">{domainLabel(domain.domain)}</span>
          </span>
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
          {formatNumber(domain.subnet_count)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
          {domain.total_stake_tao != null ? `${taoCompact(domain.total_stake_tao)} τ` : "—"}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
          {pct(domain.total_emission_share)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
          {domain.emission_concentration?.nakamoto_coefficient ?? "—"}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5} className="p-0">
            <DomainMembers domain={domain} subnetById={subnetById} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DomainCard({
  domain,
  subnetById,
  open,
  onToggle,
}: {
  domain: DomainRollup;
  subnetById: Map<number, Subnet>;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-3 text-left"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <ChevronRight
            className={classNames(
              "size-3.5 shrink-0 text-ink-muted transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate text-sm text-ink-strong">{domainLabel(domain.domain)}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
          {formatNumber(domain.subnet_count)} subnets
        </span>
      </button>
      <div className="flex items-center justify-between gap-2 px-3 pb-3 font-mono text-[11px] tabular-nums text-ink-muted">
        <span>
          {domain.total_stake_tao != null ? `${taoCompact(domain.total_stake_tao)} τ` : "—"} staked
        </span>
        <span>{pct(domain.total_emission_share)} emission</span>
      </div>
      {open ? <DomainMembers domain={domain} subnetById={subnetById} /> : null}
    </div>
  );
}
