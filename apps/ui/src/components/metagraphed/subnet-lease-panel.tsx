import { useQuery } from "@tanstack/react-query";
import { subnetLeaseHistoryQuery, subnetLeaseQuery } from "@/lib/metagraphed/queries";
import type { SubnetLeaseEvent, SubnetLeaseTerms } from "@/lib/metagraphed/types";
import { CopyableCode, StatTile, TimeAgo } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";

/**
 * Live lease state + lease-created/terminated history for one subnet (#6993).
 * Sibling of SubnetOwnershipHistory / SubnetConvictionLeaderboard for the
 * leasing epic (#6717). Three distinct live states:
 *   - leased: true  → terms + dividend accrual
 *   - leased: false → confirmed not currently leased
 *   - leased: null  → RPC failure (must not look like "not leased")
 * When leased:true but lease terms are null, show a retry notice — transient
 * decode/race, not "no lease".
 */
export function SubnetLeasePanel({ netuid }: { netuid: number }) {
  const leaseQ = useQuery(subnetLeaseQuery(netuid));
  const histQ = useQuery(subnetLeaseHistoryQuery(netuid));

  if (leaseQ.isError) {
    return (
      <ErrorState
        error={leaseQ.error}
        onRetry={() => leaseQ.refetch()}
        context="subnet lease state"
      />
    );
  }

  if (leaseQ.isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  const state = leaseQ.data?.data;
  const leased = state?.leased ?? null;
  const lease = state?.lease ?? null;

  return (
    <div className="space-y-6">
      <LeaseStatusCard
        netuid={netuid}
        leased={leased}
        lease={lease}
        queriedAt={state?.queried_at ?? null}
        onRetry={() => leaseQ.refetch()}
      />
      <LeaseHistorySection
        netuid={netuid}
        isLoading={histQ.isLoading}
        isError={histQ.isError}
        error={histQ.error}
        onRetry={() => histQ.refetch()}
        events={histQ.data?.data.lease_events ?? []}
      />
    </div>
  );
}

function RetryNotice({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded border border-dashed border-ink-subtle bg-surface/30 p-6 text-center">
      <div className="font-display text-sm font-medium text-ink-strong">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">{description}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded border border-border bg-card px-2.5 py-1 mg-type-label uppercase text-ink hover:border-ink/30"
      >
        Retry
      </button>
    </div>
  );
}

function LeaseStatusCard({
  netuid,
  leased,
  lease,
  queriedAt,
  onRetry,
}: {
  netuid: number;
  leased: boolean | null;
  lease: SubnetLeaseTerms | null;
  queriedAt: string | null;
  onRetry: () => void;
}) {
  if (leased === null) {
    return (
      <RetryNotice
        title="Lease status unavailable"
        description={`Live RPC for SN${netuid} lease state failed — this is not the same as "not leased". Retry to re-query SubnetUidToLeaseId.`}
        onRetry={onRetry}
      />
    );
  }

  if (leased === false) {
    return (
      <EmptyState
        title="Not currently leased"
        description="This subnet has no active lease on-chain right now. Past lease-created/terminated events (if any) appear in the history below."
      />
    );
  }

  if (!lease) {
    return (
      <RetryNotice
        title="Lease terms unavailable"
        description="A lease is active, but its details couldn't be decoded this request (transient RPC failure or a race against termination). Retry — do not treat this as unleased."
        onRetry={onRetry}
      />
    );
  }

  return (
    <Panel as="div" dense bodyClassName="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 mg-type-micro text-accent-text">
            Leased
          </span>
          <span className="font-mono text-[11px] text-ink-muted">lease #{lease.lease_id}</span>
        </div>
        {queriedAt ? (
          <span className="font-mono text-[11px] text-ink-muted">
            queried <TimeAgo at={queriedAt} />
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3 [&>*]:grow [&>*]:basis-[160px]">
        <StatTile
          eyebrow="Emissions share"
          tone="accent"
          value={`${lease.emissions_share_percent}%`}
        />
        <StatTile eyebrow="Cost" value={formatTao(lease.cost_tao)} />
        <StatTile
          eyebrow="End block"
          value={lease.end_block != null ? `#${formatNumber(lease.end_block)}` : "perpetual"}
        />
        <StatTile
          eyebrow="Accumulated α"
          value={
            lease.accumulated_dividends_alpha == null
              ? "—"
              : formatAlpha(lease.accumulated_dividends_alpha)
          }
          hint="undistributed"
        />
      </div>

      <dl className="grid gap-2 border-t border-border pt-3 sm:grid-cols-3">
        <KeySs58 label="Beneficiary" value={lease.beneficiary} />
        <KeySs58 label="Coldkey" value={lease.coldkey} />
        <KeySs58 label="Hotkey" value={lease.hotkey} />
      </dl>
    </Panel>
  );
}

function KeySs58({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mg-type-micro text-ink-muted">{label}</dt>
      <dd className="mt-1">
        <CopyableCode value={value} className="max-w-full" />
      </dd>
    </div>
  );
}

function formatAlpha(whole: number): string {
  if (!Number.isFinite(whole)) return "—";
  const magnitude = Math.abs(whole);
  if (magnitude >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M α`;
  if (magnitude >= 1_000) return `${(whole / 1_000).toFixed(1)}k α`;
  if (magnitude >= 1) return `${whole.toFixed(2)} α`;
  if (whole === 0) return "0 α";
  return `${whole.toFixed(4)} α`;
}

function LeaseHistorySection({
  netuid,
  isLoading,
  isError,
  error,
  onRetry,
  events,
}: {
  netuid: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  events: SubnetLeaseEvent[];
}) {
  return (
    <div>
      <h3 className="mb-3 mg-type-label uppercase text-ink-muted">Lease history</h3>
      {isError ? (
        <ErrorState error={error} onRetry={onRetry} context="subnet lease history" />
      ) : isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : events.length === 0 ? (
        <EmptyState
          title="No lease events"
          description={`SN${netuid} has no SubnetLeaseCreated / SubnetLeaseTerminated events in the captured window — the common case for never-leased subnets.`}
        />
      ) : (
        <ol className="space-y-2">
          {events.map((ev, i) => (
            <li
              key={`${ev.block_number ?? i}-${ev.event_kind ?? i}-${ev.observed_at ?? i}`}
              className="rounded-lg border border-border bg-card p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={
                      ev.event_kind === "SubnetLeaseTerminated"
                        ? "rounded-full border border-border px-2 py-0.5 mg-type-micro text-ink-muted"
                        : "rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 mg-type-micro text-accent-text"
                    }
                  >
                    {ev.event_kind === "SubnetLeaseTerminated"
                      ? "Terminated"
                      : ev.event_kind === "SubnetLeaseCreated"
                        ? "Created"
                        : (ev.event_kind ?? "event")}
                  </span>
                  {ev.beneficiary ? (
                    <CopyableCode value={ev.beneficiary} className="max-w-full" />
                  ) : (
                    <span className="font-mono text-[11px] text-ink-muted">no beneficiary</span>
                  )}
                </div>
                <span className="shrink-0 font-mono text-[11px] text-ink-muted">
                  {ev.block_number != null ? `block #${formatNumber(ev.block_number)} · ` : ""}
                  {ev.observed_at ? <TimeAgo at={ev.observed_at} /> : "unknown time"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
