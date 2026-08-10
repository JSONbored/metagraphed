import { useQuery } from "@tanstack/react-query";
import { chainSubnetLifecycleQuery, domainSummaryQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatTao, formatRelative } from "@/lib/metagraphed/format";

const SHOWN = 20;

/**
 * `/api/v1/chain/subnet-lifecycle` (#10300), published and rendered nowhere.
 *
 * Registration and deregistration across every subnet — the network-wide
 * sibling of the per-subnet lifecycle log. It carries the same
 * `predates_capture` flag for the same reason: every subnet alive when the lane
 * first ran was registered before we were watching, so its row has no block.
 * Rendering that NULL as block 0 would date the whole founding cohort to
 * genesis, which is the single most common way this dataset gets misread.
 */
export function NetworkSubnetLifecycle() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainSubnetLifecycleQuery());

  if (isLoading) return <Skeleton className="h-[200px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const l = data?.data;
  if (!l || l.entries.length === 0) {
    return (
      <EmptyState
        title="No lifecycle events"
        description="No subnet registration or deregistration has been recorded."
      />
    );
  }

  return (
    <Panel as="section" dense>
      <p className="mb-3 mg-type-data-sm text-ink-muted">
        {formatNumber(l.entry_count)} recorded transition
        {l.entry_count === 1 ? "" : "s"}
        {l.subnet_count == null ? "" : ` across ${formatNumber(l.subnet_count)} subnets`}
      </p>

      <ul className="space-y-1">
        {l.entries.slice(0, SHOWN).map((e, i) => (
          <li
            key={`${e.netuid}-${e.event}-${e.observed_at ?? i}`}
            className="flex gap-3 mg-type-data-sm"
          >
            <span className="w-16 shrink-0 text-ink">SN{e.netuid}</span>
            <span className="w-28 shrink-0 text-ink-muted">{e.event}</span>
            <span className="flex-1 tabular-nums text-ink-muted">
              {/* NULL block means "before we were watching", NOT block 0. */}
              {e.predates_capture
                ? "before capture"
                : e.block_number != null
                  ? `#${formatNumber(e.block_number)}`
                  : "—"}
            </span>
            <span className="shrink-0 mg-type-label text-ink-muted">
              {e.observed_at ? formatRelative(e.observed_at) : ""}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * `/api/v1/domains/{tag}/summary` (#10300), published and rendered nowhere.
 *
 * The per-domain detail behind the rollup table: how much stake a domain holds,
 * what share of emission it draws, and how concentrated that emission is within
 * it. The last one is the reason this is worth a request — a domain drawing 6%
 * of emission across thirteen subnets and one drawing 6% through a single
 * subnet are very different things, and only the concentration figures tell
 * them apart.
 */
export function DomainSummaryCard({ tag }: { tag: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery(domainSummaryQuery(tag));

  if (isLoading) return <Skeleton className="h-[90px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const d = data?.data;
  if (!d) {
    return <EmptyState title="No domain summary" description={`No rollup recorded for ${tag}.`} />;
  }

  return (
    <Panel as="section" dense>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure
          label="subnets"
          value={formatNumber(d.subnet_count)}
          hint={`Subnets classified under ${d.domain}.`}
        />
        <Figure
          label="stake"
          value={formatTao(d.total_stake_tao)}
          hint="Total stake across the domain's subnets."
        />
        <Figure
          label="emission share"
          value={
            d.total_emission_share == null ? "—" : `${formatNumber(d.total_emission_share * 100)}%`
          }
          hint="This domain's combined share of network emission."
        />
        <Figure
          label="emission gini"
          value={formatNumber(d.emission_gini)}
          hint="How unevenly that emission is spread WITHIN the domain. A domain drawing 6% across thirteen subnets and one drawing 6% through a single subnet are different things, and this is what tells them apart."
        />
      </div>
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div title={hint}>
      <div className="mg-type-label text-ink-muted">{label}</div>
      <div className="mg-type-data tabular-nums text-ink">{value}</div>
    </div>
  );
}
