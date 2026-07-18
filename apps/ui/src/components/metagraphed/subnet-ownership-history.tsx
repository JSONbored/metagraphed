import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { subnetOwnershipHistoryQuery } from "@/lib/metagraphed/queries";
import { CopyableCode, TimeAgo } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * Ownership-change history for one subnet (#6637, frontend companion #6715):
 * every automatic ownership transfer decoded from the chain_events
 * SubnetOwnerChanged stream, oldest first. See
 * docs/conviction-lock-mechanism.md -- transfers happen automatically once a
 * challenger's rolled conviction overtakes the incumbent owner's, no vote
 * required. A subnet that has never changed hands is the common case,
 * rendered as an EmptyState, not an error.
 */
export function SubnetOwnershipHistory({ netuid }: { netuid: number }) {
  const {
    data: res,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetOwnershipHistoryQuery(netuid));
  const data = res?.data;

  if (isError) {
    return (
      <ErrorState error={error} onRetry={() => refetch()} context="subnet ownership history" />
    );
  }

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const changes = data?.ownership_changes ?? [];

  if (changes.length === 0) {
    return (
      <EmptyState
        title="Never changed hands"
        description="This subnet has undergone no automatic ownership transfer since chain-events capture began -- the common case."
      />
    );
  }

  return (
    <ol className="space-y-2">
      {changes.map((change, i) => (
        <li
          key={`${change.block_number ?? i}-${change.new_coldkey ?? i}`}
          className="rounded-lg border border-border bg-card p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {change.old_coldkey ? (
                <CopyableCode value={change.old_coldkey} className="max-w-full" />
              ) : (
                <span className="font-mono text-[11px] text-ink-muted">unknown</span>
              )}
              <ArrowRight aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
              {change.new_coldkey ? (
                <CopyableCode value={change.new_coldkey} className="max-w-full" />
              ) : (
                <span className="font-mono text-[11px] text-ink-muted">unknown</span>
              )}
            </div>
            <span className="shrink-0 font-mono text-[11px] text-ink-muted">
              {change.block_number != null ? `block #${formatNumber(change.block_number)} · ` : ""}
              {change.observed_at ? <TimeAgo at={change.observed_at} /> : "unknown time"}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
