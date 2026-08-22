import { useQuery } from "@tanstack/react-query";
import { subnetTreasuryQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";

/**
 * What a subnet's own source says it allocates to a treasury (#10933).
 *
 * THE EMPTY STATE IS THE MOST IMPORTANT THING THIS CARD RENDERS. Today almost
 * every subnet has `repos_read: 0`, and the one rendering that must never be
 * made is "no treasury cut". Nobody has looked. The card says so in those
 * words, because a blank panel reads as a clean bill of health.
 *
 * Three rules the render holds:
 *
 * 1. `repos_read: 0` renders as "not yet read", never as an absence of a cut.
 * 2. `declared_matches_observed: null` renders as "not compared", never as a
 *    mismatch. Only `false` is a divergence, and even then it is stated
 *    neutrally — a disclosed allocation is a business model.
 * 3. A `candidate` reading shows its read status and NOT its finding. A
 *    machine's summary of source code is not evidence, and rendering one
 *    before review would publish exactly what the review gate exists to hold.
 */
export function SubnetTreasuryPanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(subnetTreasuryQuery(netuid));

  if (isLoading) return <Skeleton className="h-[140px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const card = data?.data ?? null;
  if (!card || card.repos_read === 0) {
    return (
      <EmptyState
        title="No source reading yet"
        description="None of this subnet's registered repositories has been read for a declared treasury allocation. That is not a finding of 'no treasury cut' — nobody has looked."
      />
    );
  }

  return (
    <Panel as="section">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Figure
          label="repos read"
          value={`${card.reviewed_count} of ${card.repos_read}`}
          hint={
            card.pending_review_count > 0
              ? `${card.pending_review_count} reading(s) pending review — findings withheld until checked.`
              : "Every reading has been reviewed."
          }
        />
        <Figure
          label="declared"
          value={shareLabel(card.declared_share)}
          hint="Allocation the subnet's own source declares, taken from miner emission."
        />
        <Figure
          label="declared vs observed"
          value={matchLabel(card.declared_matches_observed)}
          hint="Agreement is the expected result. 'Not compared' means one side is unread — it is not a mismatch."
        />
      </div>

      <ul className="mt-4 space-y-1 border-t border-border/60 pt-3">
        {card.readings.map((r) => (
          <li
            key={`${r.evidence.source_url}-${r.evidence.read_at_sha}`}
            className="text-13 text-ink-muted"
          >
            <span className="text-ink-strong">
              {r.review_state === "reviewed"
                ? r.found
                  ? "allocation declared"
                  : "read, none declared"
                : "pending review"}
            </span>
            {" · "}
            {r.evidence.read_at_sha
              ? `@ ${r.evidence.read_at_sha.slice(0, 7)}`
              : "no commit recorded"}
            {r.evidence.observed_at ? ` · ${r.evidence.observed_at.slice(0, 10)}` : ""}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** A share as a percentage, or an em dash. Never 0% for a null. */
export function shareLabel(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

/**
 * The tri-state, in words. NULL IS NOT A MISMATCH — rendering it as one would
 * accuse a team over a repo nobody opened.
 */
export function matchLabel(value: boolean | null | undefined): string {
  if (value == null) return "not compared";
  return value ? "agrees" : "differs";
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-13 text-ink-muted">{label}</div>
      <div className="text-13 text-ink-strong">{value}</div>
      <div className="text-13 text-ink-muted">{hint}</div>
    </div>
  );
}
