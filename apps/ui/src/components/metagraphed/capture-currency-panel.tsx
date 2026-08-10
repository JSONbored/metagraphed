import { useQuery } from "@tanstack/react-query";
import { chainIndexerLagQuery, healthFailureReasonsQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatRelative, humaniseSeconds } from "@/lib/metagraphed/format";
import type { FailureReason } from "@/lib/metagraphed/types";

/**
 * `/api/v1/chain/indexer-lag` and `/api/v1/health/failure-reasons` (#10300),
 * both published and rendered nowhere.
 *
 * Paired because they are the two halves of "can you trust what this API just
 * told you": how current the capture is, and what is going wrong with the
 * probes behind it.
 *
 * FAST IS NOT CURRENT. The lag route publishes write latency percentiles AND a
 * head age, and they measure different things -- a lane that stopped an hour
 * ago still reports excellent latency for the blocks it did write. Showing
 * latency alone would let a dead lane read as a healthy one, which is exactly
 * the failure this repo keeps finding, so the age leads and the percentiles
 * are labelled as what they are.
 */
export function CaptureCurrencyPanel() {
  return (
    <div className="space-y-6">
      <IndexerLagCard />
      <FailureMixCard />
    </div>
  );
}

function IndexerLagCard() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainIndexerLagQuery());
  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const l = data?.data;
  if (!l) return <EmptyState title="No lag reading" description="Capture lag has not been measured." />;

  return (
    <Panel as="section" dense>
      <h3 className="mb-3 mg-type-label text-ink-muted">Capture currency</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure
          label="behind head"
          value={l.head_age_ms == null ? "—" : humaniseSeconds(l.head_age_ms / 1000)}
          hint="How far behind the chain head our capture is. THIS is the number that says whether the data is current — write latency does not."
        />
        <Figure
          label="write p50"
          value={l.latency_p50_ms == null ? "—" : `${formatNumber(l.latency_p50_ms)} ms`}
          hint="How long a block takes to land once we start writing it. A stopped lane still reports a good figure here."
        />
        <Figure
          label="write p99"
          value={l.latency_p99_ms == null ? "—" : `${formatNumber(l.latency_p99_ms)} ms`}
          hint="The slow tail of the same measurement."
        />
        <Figure
          label="blocks in window"
          value={formatNumber(l.block_count)}
          hint={
            l.oldest_block != null && l.newest_block != null
              ? `Blocks ${formatNumber(l.oldest_block)}–${formatNumber(l.newest_block)}.`
              : "Blocks measured in this window."
          }
        />
      </div>
      {l.measured_at ? (
        <p className="mt-3 mg-type-label text-ink-muted">Measured {formatRelative(l.measured_at)}.</p>
      ) : null}
    </Panel>
  );
}

function FailureMixCard() {
  const { data, isLoading, isError, error, refetch } = useQuery(healthFailureReasonsQuery("30d"));
  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const f = data?.data;
  if (!f || f.reasons.length === 0) {
    return <EmptyState title="No probe classifications" description="Nothing classified in this window." />;
  }

  const failing = rankedFailures(f.reasons);

  return (
    <Panel as="section" dense>
      <h3 className="mb-3 mg-type-label text-ink-muted">Why probes fail · {f.window}</h3>
      <div className="grid grid-cols-3 gap-x-6 gap-y-3">
        <Figure label="checks" value={formatNumber(f.total_checks)} hint="Probe checks run in this window." />
        <Figure label="failing" value={formatNumber(f.failing_checks)} hint="Of those, how many failed." />
        <Figure
          label="failure rate"
          value={f.failure_rate == null ? "—" : `${formatNumber(f.failure_rate * 100)}%`}
          hint="Failing checks as a share of all checks."
        />
      </div>

      {/* Only the classifications that ARE failures, ranked by their share OF
          THE FAILURES. `share` (of all checks) and `failure_share` (of the
          failing ones) have different denominators, and mixing them is how a
          classification that is 2% of traffic reads as 2% of the problem. */}
      <ul className="mt-4 space-y-1">
        {failing.map((r) => (
          <li key={r.classification} className="flex justify-between mg-type-data-sm">
            <span className="text-ink-muted">{r.classification}</span>
            <span
              className="tabular-nums text-ink"
              title={`${formatNumber(r.checks)} checks — ${r.failure_share == null ? "—" : `${formatNumber(r.failure_share * 100)}% of failures`}, ${r.share == null ? "—" : `${formatNumber(r.share * 100)}% of all checks`}`}
            >
              {r.failure_share == null ? "—" : `${formatNumber(r.failure_share * 100)}%`}
            </span>
          </li>
        ))}
      </ul>
      {failing.length === 0 ? (
        <p className="mt-3 mg-type-label text-ink-muted">
          Every classification in this window is a non-failure outcome.
        </p>
      ) : null}
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

/**
 * The classifications that are actually failures, worst first.
 *
 * Filters on `is_failure` rather than assuming every classification is one --
 * the route marks non-failure outcomes explicitly, and listing them among the
 * failures would report a working probe as a broken one. Ranked by
 * `failure_share`, the share OF THE FAILURES, because that is the question
 * "why do probes fail" actually asks.
 */
export function rankedFailures(reasons: readonly FailureReason[]): FailureReason[] {
  return reasons
    .filter((r) => r.is_failure)
    .slice()
    .sort((a, b) => (b.failure_share ?? 0) - (a.failure_share ?? 0));
}
