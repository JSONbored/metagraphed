import { useQuery } from "@tanstack/react-query";
import { subnetSurfaceHistoryQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";
import type { SubnetSurfaceChange } from "@/lib/metagraphed/types";

const MAX_SHOWN = 12;

/**
 * A subnet's surface audit trail (#10300).
 *
 * `/api/v1/subnets/{netuid}/surface-history` was published and rendered
 * nowhere, which is the odd one out in this repo: the whole registry rests on
 * the claim that a surface was added because someone could prove the subnet
 * publishes it, and this is the only route that shows the record of those
 * decisions. An audit trail no one can read is not an audit trail.
 *
 * `change_count` and `surface_count` are shown as two numbers because one
 * surface can change many times. Collapsing them would let a single surface
 * edited twelve times read as twelve surfaces.
 */
export function SubnetSurfaceHistoryPanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(subnetSurfaceHistoryQuery(netuid));

  if (isLoading) return <Skeleton className="h-[160px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const h = data?.data ?? null;
  if (!h || h.changes.length === 0) {
    return (
      <EmptyState
        title="No recorded surface changes"
        description="Nothing has been added, updated or removed for this subnet since the audit trail began."
      />
    );
  }

  const shown = h.changes.slice(0, MAX_SHOWN);

  return (
    <Panel as="section">
      <p className="mb-3 text-10 text-ink-muted">
        {formatNumber(h.change_count)} recorded change
        {h.change_count === 1 ? "" : "s"}
        {h.surface_count == null
          ? ""
          : ` across ${formatNumber(h.surface_count)} surface${h.surface_count === 1 ? "" : "s"}`}
        {h.latest_change_at ? ` · latest ${formatRelative(h.latest_change_at)}` : ""}
      </p>

      <ul className="space-y-2">
        {shown.map((c) => (
          <li key={`${c.surface_id}-${c.recorded_at ?? ""}-${c.action}`} className="flex gap-3">
            <span className="text-11 w-16 shrink-0 text-ink-muted">{c.action}</span>
            <span className="min-w-0 flex-1">
              <span className="text-10 text-ink">{c.name ?? c.surface_id}</span>
              {c.kind ? <span className="ml-2 text-11 text-ink-muted">{c.kind}</span> : null}
              {/* The commit is what makes this auditable rather than anecdotal:
                  a claim about a surface traces to the change that made it. */}
              {c.source_commit ? (
                <span
                  className="ml-2 text-11 text-ink-muted"
                  title={`Recorded by commit ${c.source_commit}`}
                >
                  {c.source_commit.slice(0, 7)}
                </span>
              ) : null}
            </span>
            <span className="text-11 shrink-0 text-ink-muted">
              {c.recorded_at ? formatRelative(c.recorded_at) : "—"}
            </span>
          </li>
        ))}
      </ul>

      {h.changes.length > MAX_SHOWN ? (
        <p className="mt-3 text-11 text-ink-muted">
          Showing the {MAX_SHOWN} most recent of {formatNumber(h.changes.length)} returned.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * How many DISTINCT surfaces a change list touches.
 *
 * Exported for the panel's own copy and unit-tested, because "12 changes" and
 * "12 surfaces changed" are different claims and the API publishes both counts
 * precisely so a reader is not left to assume they are the same.
 */
export function distinctSurfaces(changes: readonly SubnetSurfaceChange[]): number {
  return new Set(changes.map((c) => c.surface_id)).size;
}
