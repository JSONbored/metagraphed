import { useQuery } from "@tanstack/react-query";
import { subnetDeregistrationStandingQuery, subnetLifecycleQuery } from "@/lib/metagraphed/queries";
import type { DeregistrationStanding, SubnetLifecycleEntry } from "@/lib/metagraphed/types";
import { StatTile, TimeAgo } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * When this subnet registered, and how close it is to being deregistered.
 *
 * Two routes that were published and rendered nowhere (#10300): the lifecycle
 * timeline (#10262) and the chain's own pruning order (#10285). They belong
 * together — "when did it arrive" and "is it at risk" are the same question
 * asked from either end, and neither is legible alone.
 *
 * ## Three distinctions this panel exists to preserve
 *
 * A naive rendering collapses each of them, and each collapse states something
 * false:
 *
 *   1. `predates_capture` is NOT "registered at block 0". Every subnet alive
 *      when the lane first ran was registered before we were watching, so its
 *      block is null. Printing 0 would claim it launched at genesis.
 *
 *   2. IMMUNE IS NOT RANK 0. An immune subnet has `rank: null` — it is not
 *      near the top of the pruning order, it is not IN the order at all, and it
 *      cannot be deregistered until its window lapses. Showing it as "#1" or
 *      "#0" inverts the meaning entirely.
 *
 *   3. `comparison_price` is what the pallet compares; `moving_price` is the
 *      raw read. They differ only for a Stable-mechanism subnet, where the
 *      pallet substitutes a flat 1.0 — which moves it from the top of a price
 *      order to near the bottom. Showing one number hides that substitution;
 *      #10285 exists because ordering on the raw price gets position one wrong.
 */
export function SubnetLifecyclePanel({ netuid }: { netuid: number }) {
  const lifecycleQ = useQuery(subnetLifecycleQuery(netuid));
  const standingQ = useQuery(subnetDeregistrationStandingQuery(netuid));

  return (
    <div className="space-y-6">
      <StandingCard
        isLoading={standingQ.isLoading}
        isError={standingQ.isError}
        error={standingQ.error}
        onRetry={() => standingQ.refetch()}
        standing={standingQ.data?.data.standing ?? null}
        rankedCount={standingQ.data?.data.ranked_count ?? null}
      />
      <TimelineSection
        isLoading={lifecycleQ.isLoading}
        isError={lifecycleQ.isError}
        error={lifecycleQ.error}
        onRetry={() => lifecycleQ.refetch()}
        entries={lifecycleQ.data?.data ?? []}
      />
    </div>
  );
}

function StandingCard({
  isLoading,
  isError,
  error,
  onRetry,
  standing,
  rankedCount,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  standing: DeregistrationStanding | null;
  rankedCount: number | null;
}) {
  if (isError) {
    return <ErrorState error={error} onRetry={onRetry} context="deregistration standing" />;
  }
  if (isLoading) return <Skeleton className="h-32 w-full" />;

  // In NEITHER list. Root is the obvious case — it is never a pruning
  // candidate — and saying "not a candidate" is a different statement from
  // "rank unknown", so it gets its own branch rather than an empty rank.
  if (!standing) {
    return (
      <Panel title="Deregistration standing">
        <EmptyState
          title="Not a pruning candidate"
          description="This subnet does not appear in the chain's deregistration order. Root is never a candidate."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Deregistration standing"
      caption="The pallet's own order, not a price sort — immunity and the Stable-mechanism substitution both change it."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {standing.immune ? (
          <>
            {/* Deliberately NOT a rank. An immune subnet is outside the
                ranking, and a number here would read as a position in it. */}
            <StatTile eyebrow="Status" value="Immune" />
            <StatTile
              eyebrow="Until block"
              value={
                standing.immune_until_block === null
                  ? "—"
                  : formatNumber(standing.immune_until_block)
              }
            />
            <StatTile
              eyebrow="Blocks remaining"
              value={
                standing.blocks_until_prunable === null
                  ? "—"
                  : formatNumber(standing.blocks_until_prunable)
              }
            />
          </>
        ) : (
          <>
            <StatTile
              eyebrow="Rank"
              value={standing.rank === null ? "—" : `#${standing.rank}`}
              hint={rankedCount === null ? undefined : `of ${formatNumber(rankedCount)} prunable`}
            />
            <StatTile eyebrow="Status" value="Prunable" />
          </>
        )}
        <StatTile
          eyebrow="Comparison price"
          value={formatAlphaPrice(standing.comparison_price)}
          hint={
            standing.comparison_price !== null &&
            standing.moving_price !== null &&
            standing.comparison_price !== standing.moving_price
              ? `moving price ${formatAlphaPrice(standing.moving_price)} — Stable substitution`
              : undefined
          }
        />
      </div>
      {standing.subnet_mechanism === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          This is a Stable subnet (mechanism 0). The pallet compares a flat 1.0 for it rather than
          reading its moving price, which is why the two figures above differ.
        </p>
      ) : null}
    </Panel>
  );
}

function TimelineSection({
  isLoading,
  isError,
  error,
  onRetry,
  entries,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  entries: SubnetLifecycleEntry[];
}) {
  if (isError) {
    return <ErrorState error={error} onRetry={onRetry} context="subnet lifecycle" />;
  }
  if (isLoading) return <Skeleton className="h-24 w-full" />;

  if (entries.length === 0) {
    return (
      <Panel title="Lifecycle">
        <EmptyState
          title="No recorded transitions"
          description="No registration or deregistration has been observed for this subnet since capture began."
        />
      </Panel>
    );
  }

  return (
    <Panel title="Lifecycle" caption="Registration and deregistration, newest first.">
      <ul className="divide-y divide-border">
        {entries.map((entry, i) => (
          <li
            key={`${entry.event}-${entry.observed_at ?? i}`}
            className="flex flex-wrap items-baseline justify-between gap-2 py-2"
          >
            <span className="mg-type-label uppercase text-ink-strong">{entry.event}</span>
            <span className="text-xs text-ink-muted">
              {/* THE DISTINCTION. A null block with predates_capture means the
                  transition is older than our record, which is a different
                  claim from "at block 0" and must not render as one. */}
              {entry.predates_capture
                ? "before capture began"
                : entry.block_number === null
                  ? "block unattributed"
                  : `block ${formatNumber(entry.block_number)}`}
              {entry.observed_at ? (
                <>
                  {" · observed "}
                  <TimeAgo at={entry.observed_at} />
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Alpha prices run to eight significant figures; a 2dp format shows 0.00. */
function formatAlphaPrice(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(8);
}
