import { Definition } from "@jsonbored/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { emissionChangesQuery, networkRandomnessQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";

const MAX_SHOWN = 15;

/**
 * `/api/v1/chain/governance/emission-changes` and `/api/v1/network/randomness`
 * (#10300), both published and rendered nowhere.
 *
 * Together on the governance tab because both are consensus mechanics a reader
 * of the change log needs: what has moved the emission gate, and whether the
 * randomness a commit-reveal was timelocked against is still verifiable.
 */
export function EmissionGateChanges() {
  return (
    <div className="space-y-6">
      <ChangeLog />
      <RandomnessCard />
    </div>
  );
}

function ChangeLog() {
  const { data, isLoading, isError, error, refetch } = useQuery(emissionChangesQuery());
  if (isLoading) return <Skeleton className="h-[160px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const c = data?.data;
  if (!c || c.changes.length === 0) {
    return (
      <EmptyState
        title="No emission-gate changes"
        description="Nothing has moved the emission gate in the recorded window."
      />
    );
  }

  return (
    <Panel as="section">
      <h3 className="mb-3 text-11 text-ink-muted">Emission gate changes</h3>
      <p className="mb-3 text-10 text-ink-muted">
        {formatNumber(c.change_count)} recorded change{c.change_count === 1 ? "" : "s"}
        {c.latest_change_at ? ` · latest ${formatRelative(c.latest_change_at)}` : ""}
      </p>

      <ul className="space-y-1">
        {c.changes.slice(0, MAX_SHOWN).map((ch, i) => (
          <li
            key={`${ch.kind}-${ch.observed_at ?? i}-${ch.param ?? ""}`}
            className="flex gap-3 text-10"
          >
            <span className="w-40 shrink-0 truncate text-ink-muted">{ch.param ?? ch.kind}</span>
            <span className="min-w-0 flex-1 tabular-nums text-ink">
              {ch.previous_value != null ? `${ch.previous_value} → ` : ""}
              {ch.value ?? "—"}
            </span>
            {/* A change older than capture has NO block. Rendering it as block 0
                would date it to genesis, so it is labelled instead. */}
            <span className="shrink-0 text-11 text-ink-muted">
              {ch.predates_capture
                ? "pre-capture"
                : ch.block_number != null
                  ? `#${formatNumber(ch.block_number)}`
                  : "—"}
            </span>
          </li>
        ))}
      </ul>

      {c.predates_capture_count != null && c.predates_capture_count > 0 ? (
        <p className="mt-3 text-11 text-ink-muted">
          {formatNumber(c.predates_capture_count)} of these predate our capture and carry no block —
          they happened before we were watching, which is not the same as happening at genesis.
        </p>
      ) : null}
    </Panel>
  );
}

function RandomnessCard() {
  const { data, isLoading, isError, error, refetch } = useQuery(networkRandomnessQuery());
  if (isLoading) return <Skeleton className="h-[100px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const r = data?.data;
  if (!r) return <EmptyState title="No randomness reading" description="Round storage not read." />;

  return (
    <Panel as="section">
      <h3 className="mb-3 text-11 text-ink-muted">Stored randomness rounds</h3>
      <div className="grid grid-cols-3 gap-x-6 gap-y-3">
        {/* THE SPAN LEADS, not the newest round. Commit-reveal verifies a
            reveal against the round it was timelocked to, so how far BACK
            storage reaches is what decides whether an old reveal can still be
            checked — the newest round says nothing about that. */}
        <Figure
          label="rounds retained"
          value={formatNumber(r.stored_round_span)}
          hint="How many rounds are still stored. A reveal timelocked to a round that has aged out can no longer be verified — this is the number that decides that, not the newest round."
        />
        <Figure
          label="oldest"
          value={formatNumber(r.oldest_stored_round)}
          hint="The furthest back verification can reach."
        />
        <Figure
          label="newest"
          value={formatNumber(r.last_stored_round)}
          hint="The most recent round stored."
        />
      </div>
      {r.queried_at ? (
        <p className="mt-3 text-11 text-ink-muted">Read {formatRelative(r.queried_at)}.</p>
      ) : null}
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-11 text-ink-muted">
        {label}
        <Definition term={label} sentence={hint} />
      </div>
      <div className="text-11 tabular-nums text-ink">{value}</div>
    </div>
  );
}
