import { useQuery } from "@tanstack/react-query";
import { subnetEmissionSplitHistoryQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";
import type { EmissionSplitPoint } from "@/lib/metagraphed/types";

/**
 * Where a subnet's emission actually goes (#10928).
 *
 * The pipeline surfaces answer WHICH SUBNET receives what. This one answers who
 * inside it got the money, which is the denominator every fairness and capture
 * question needs.
 *
 * TWO THINGS THIS CARD REFUSES TO BLUR.
 *
 * 1. The owner leg is NOT in the per-UID rows -- it is paid outside the UID set
 *    and reconstructed from the protocol cut. It is rendered as reconstructed,
 *    with the measured validator/miner ratio stated separately, because a
 *    reader who cannot tell them apart will quote the wrong one.
 * 2. `earning_miner_count` against `miner_count` is the fact a miner count
 *    alone hides. On the median subnet almost none of the registered miners
 *    earn anything, and "240 miners" read as 240 earners is the single most
 *    misleading number in this ecosystem.
 *
 * A null share is rendered as an em dash, never as 0% -- a day that emitted
 * nothing and a day where one class received nothing are different facts.
 */
export function SubnetEmissionSplitPanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    subnetEmissionSplitHistoryQuery(netuid, "30d"),
  );

  if (isLoading) return <Skeleton className="h-[160px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const history = data?.data ?? null;
  if (!history || history.points.length === 0) {
    return (
      <EmptyState
        title="No emission split yet"
        description="The daily per-UID rollup has not been captured for this subnet over the selected window."
      />
    );
  }

  // Points arrive newest-first from the route.
  const latest = history.points[0];

  return (
    <Panel as="section" dense>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Share
          label="owner"
          value={latest.owner_share}
          hint="The protocol's 18% owner cut. Reconstructed — it is paid outside the UID set, so no per-UID row carries it."
        />
        <Share
          label="validators"
          value={latest.validator_share}
          hint="Share of the whole day, owner leg included. Reconstructed."
        />
        <Share
          label="miners"
          value={latest.miner_share}
          hint="Share of the whole day, owner leg included. Reconstructed."
        />
        <Figure
          label="miners earning"
          value={earningLabel(latest)}
          hint="How many registered miner UIDs recorded emission above zero. Against the miner count, this is how much of the population actually earns."
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Measured validator/miner split of observed per-UID emission:{" "}
        <strong>{percent(latest.validator_share_of_uid)}</strong> /{" "}
        <strong>{percent(latest.miner_share_of_uid)}</strong> — exact, and the only figures here
        that are a reading rather than a reconstruction.{" "}
        {formatNumber(history.point_count ?? history.points.length)} day(s) in the window, newest{" "}
        {latest.snapshot_date}.
      </p>
    </Panel>
  );
}

function earningLabel(point: EmissionSplitPoint): string {
  const earning = point.earning_miner_count;
  const total = point.miner_count;
  if (earning == null || total == null) return "—";
  return `${formatNumber(earning)} / ${formatNumber(total)}`;
}

/** A percentage, or an em dash. NEVER 0% for a null — see the header. */
function percent(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function Share({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  hint: string;
}) {
  return <Figure label={label} value={percent(value)} hint={hint} />;
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div title={hint}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
    </div>
  );
}
