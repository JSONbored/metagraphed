import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { crowdloansQuery, crowdloanQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { Crowdloan } from "@/lib/metagraphed/types";

/**
 * `/api/v1/crowdloans` and `/api/v1/crowdloans/{crowdloan_id}` (#10300), both
 * published and rendered nowhere.
 *
 * MET THE CAP AND SETTLED ARE DIFFERENT STATES. A crowdloan at 100% that has
 * not been finalized has raised its target but not closed out — the funds are
 * committed and the outcome is not yet decided. Collapsing `percent_raised`
 * and `finalized` into one "done" badge would tell a contributor their money
 * had settled when it has not, so the two are shown separately.
 *
 * Expanding a row reads the by-id route, which is the authoritative per-loan
 * record and is where `exists` lives.
 */
export function CrowdloansPanel() {
  const { data, isLoading, isError, error, refetch } = useQuery(crowdloansQuery());
  const [openId, setOpenId] = useState<number | null>(null);

  if (isLoading) return <Skeleton className="h-[200px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const c = data?.data;
  if (!c || c.crowdloans.length === 0) {
    return (
      <EmptyState
        title="No crowdloans"
        description="No crowdloan has been created on this network."
      />
    );
  }

  return (
    <Panel as="section" dense>
      <p className="mb-3 mg-type-data-sm text-ink-muted">
        {formatNumber(c.crowdloan_count)} crowdloan{c.crowdloan_count === 1 ? "" : "s"}
      </p>

      <ul className="divide-y divide-border/50">
        {c.crowdloans.map((l) => (
          <li key={l.crowdloan_id}>
            <button
              type="button"
              onClick={() => setOpenId((cur) => (cur === l.crowdloan_id ? null : l.crowdloan_id))}
              aria-expanded={openId === l.crowdloan_id}
              className="flex w-full items-center gap-3 py-2 text-left mg-type-data-sm"
            >
              <span className="w-10 shrink-0 text-ink">#{l.crowdloan_id}</span>
              <span className="flex-1 tabular-nums text-ink">
                {formatTao(l.raised_tao)} / {formatTao(l.cap_tao)}
              </span>
              <span className="shrink-0 tabular-nums text-ink-muted">
                {l.percent_raised == null ? "—" : `${formatNumber(l.percent_raised)}%`}
              </span>
              {/* Two states, two badges. Raised is not settled. */}
              <span className="w-24 shrink-0 mg-type-label text-ink-muted" title={statusHint(l)}>
                {settlementLabel(l)}
              </span>
            </button>
            {openId === l.crowdloan_id ? <CrowdloanDetail id={l.crowdloan_id} /> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The authoritative per-loan record, read only when a row is opened. */
function CrowdloanDetail({ id }: { id: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(crowdloanQuery(id));

  if (isLoading) return <Skeleton className="mb-2 h-16 w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const d = data?.data;
  // `exists: false` at 200 is an ANSWER about the chain, not a failed request.
  if (!d?.exists || !d.crowdloan) {
    return (
      <p className="pb-2 mg-type-data-sm text-ink-muted">
        No crowdloan {id} exists on chain — a fact about the chain, not a failed lookup.
      </p>
    );
  }

  const l = d.crowdloan;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 pb-3 sm:grid-cols-4">
      <Detail label="contributors" value={formatNumber(l.contributors_count)} />
      <Detail label="ends at block" value={l.end == null ? "—" : `#${formatNumber(l.end)}`} />
      <Detail label="settled" value={l.finalized ? "yes" : "no"} />
      <Detail
        label="dispatches"
        value={l.has_dispatch_call ? "yes" : "no"}
        hint="Whether the raised funds execute a call on release. A crowdloan that dispatches is doing something a plain transfer is not."
      />
    </dl>
  );
}

function Detail({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="mg-type-label text-ink-muted">{label}</dt>
      <dd className="mg-type-data-sm tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/**
 * What state a crowdloan is actually in.
 *
 * Returns FOUR states, not two, because "raised its cap" and "settled" are
 * independent: a loan can be full and unsettled (committed, outcome pending),
 * or settled without ever filling. A single "done" badge would tell a
 * contributor their money had settled when it had not.
 */
export function settlementLabel(l: Crowdloan): string {
  const full = l.percent_raised != null && l.percent_raised >= 100;
  if (l.finalized) return full ? "settled" : "settled short";
  return full ? "full, unsettled" : "raising";
}

/** The same distinction spelled out, for the row's tooltip. */
export function statusHint(l: Crowdloan): string {
  if (l.finalized) {
    return l.percent_raised != null && l.percent_raised >= 100
      ? "Reached its cap and has been finalized."
      : "Finalized without reaching its cap.";
  }
  return l.percent_raised != null && l.percent_raised >= 100
    ? "Has reached its cap but is NOT finalized — the funds are committed and the outcome is not yet settled."
    : "Still raising.";
}
