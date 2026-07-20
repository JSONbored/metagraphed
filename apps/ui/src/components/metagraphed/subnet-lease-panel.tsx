import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { subnetLeaseQuery, subnetLeaseHistoryQuery } from "@/lib/metagraphed/queries";
import { CopyableCode, TimeAgo } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { SubnetLeaseTerms } from "@/lib/metagraphed/types";

// accumulated_dividends_alpha arrives already in display (÷1e9) alpha units.
function fmtAlpha(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const mag = Math.abs(v);
  if (mag >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M α`;
  if (mag >= 1_000) return `${(v / 1_000).toFixed(1)}k α`;
  if (mag >= 1) return `${v.toFixed(2)} α`;
  return v === 0 ? "0 α" : `${v.toFixed(4)} α`;
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</dt>
      <dd className="font-mono text-[12px] text-ink-strong">{children}</dd>
    </div>
  );
}

/**
 * Live subnet-lease state (#6993, part of the crowdfunded-leasing epic #6717):
 * whether this subnet is operated under a lease, its terms, and its lease
 * event history. `leased` is a tri-state -- true / false / null (RPC failure) --
 * rendered distinctly so an unavailable read never reads as "not leased".
 */
export function SubnetLeasePanel({ netuid }: { netuid: number }) {
  return (
    <div className="space-y-4">
      <LeaseStateBlock netuid={netuid} />
      <LeaseHistoryBlock netuid={netuid} />
    </div>
  );
}

function LeaseStateBlock({ netuid }: { netuid: number }) {
  const { data: res, isLoading, isError, error, refetch } = useQuery(subnetLeaseQuery(netuid));

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet lease" />;
  }
  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  const data = res?.data;
  const leased = data?.leased ?? null;

  // null — RPC read failed; distinct from a confirmed "not leased".
  if (leased === null) {
    return (
      <EmptyState
        title="Lease state unavailable"
        description="The on-chain lease read did not return in time. This is a transient RPC failure, not a confirmation that the subnet is unleased -- retry shortly."
      />
    );
  }

  // false — confirmed not leased (the common case).
  if (leased === false) {
    return (
      <EmptyState
        title="Not currently leased"
        description="This subnet is not operated under a crowdfunded lease. A lease appears here once one is registered on-chain."
      />
    );
  }

  // true — leased. Terms may still be null if the detail read failed this pass.
  const lease: SubnetLeaseTerms | null = data?.lease ?? null;
  if (!lease) {
    return (
      <EmptyState
        title="Lease active — details unavailable"
        description="This subnet is under an active lease, but its terms could not be decoded this request. Retry shortly."
      />
    );
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-accent-surface/40 p-4">
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accent">
        <KeyRound className="size-3" aria-hidden />
        Active lease
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Term label="Operator (beneficiary)">
          <CopyableCode value={lease.beneficiary} className="max-w-full" />
        </Term>
        <Term label="Lessor coldkey">
          <CopyableCode value={lease.coldkey} className="max-w-full" />
        </Term>
        <Term label="Lessor hotkey">
          <CopyableCode value={lease.hotkey} className="max-w-full" />
        </Term>
        <Term label="Emissions share">
          <span className="tabular-nums">{lease.emissions_share_percent}%</span>
        </Term>
        <Term label="Cost">
          <span className="tabular-nums">{formatTao(lease.cost_tao)}</span>
        </Term>
        <Term label="Accrued dividends">
          <span className="tabular-nums">{fmtAlpha(lease.accumulated_dividends_alpha)}</span>
        </Term>
        <Term label="End block">
          <span className="tabular-nums">
            {lease.end_block != null ? `#${formatNumber(lease.end_block)}` : "Perpetual"}
          </span>
        </Term>
        <Term label="Lease ID">
          <span className="tabular-nums">{formatNumber(lease.lease_id)}</span>
        </Term>
      </dl>
    </div>
  );
}

function eventLabel(kind: string): { text: string; className: string } {
  if (kind === "SubnetLeaseCreated") {
    return { text: "Created", className: "border-health-ok/40 bg-health-ok/10 text-health-ok" };
  }
  if (kind === "SubnetLeaseTerminated") {
    return {
      text: "Terminated",
      className: "border-health-down/40 bg-health-down/10 text-health-down",
    };
  }
  return { text: kind, className: "border-border bg-surface/40 text-ink-muted" };
}

function LeaseHistoryBlock({ netuid }: { netuid: number }) {
  const { data: res, isError } = useQuery(subnetLeaseHistoryQuery(netuid));
  // History is supplementary — stay quiet on load/error and when there are no
  // events (the common case), so it never clutters an unleased subnet's panel.
  if (isError) return null;
  const events = res?.data.lease_events ?? [];
  if (events.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        Lease history
      </h3>
      <ol className="space-y-2">
        {events.map((event, i) => {
          const label = eventLabel(event.event_kind);
          return (
            <li
              key={`${event.block_number ?? i}-${event.event_kind}`}
              className="rounded-lg border border-border bg-card p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={classNames(
                      "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
                      label.className,
                    )}
                  >
                    {label.text}
                  </span>
                  {event.beneficiary ? (
                    <CopyableCode value={event.beneficiary} className="max-w-full" />
                  ) : (
                    <span className="font-mono text-[11px] text-ink-muted">unknown operator</span>
                  )}
                </div>
                <span className="shrink-0 font-mono text-[11px] text-ink-muted">
                  {event.block_number != null
                    ? `block #${formatNumber(event.block_number)} · `
                    : ""}
                  {event.observed_at ? <TimeAgo at={event.observed_at} /> : "unknown time"}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
