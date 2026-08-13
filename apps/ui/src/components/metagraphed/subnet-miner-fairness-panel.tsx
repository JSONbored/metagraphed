import { useQuery } from "@tanstack/react-query";
import { subnetMinerFairnessQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";

/**
 * If you register a miner here, do you earn? (#10931)
 *
 * THE CARD EXISTS BECAUSE THE MINER COUNT IS THE MISLEADING NUMBER. Every
 * dashboard shows "240 miners"; on SN64 fourteen of them earn. So the earning
 * count renders beside the population, never alone.
 *
 * THREE RULES THIS RENDER HOLDS.
 *
 * 1. NO SCORE, NO GRADE, NO COLOUR-CODING BY SEVERITY. A high Gini on a subnet
 *    whose task genuinely has one best answer is not misconduct, and a red
 *    badge would make that judgement for the reader. Every figure is neutral
 *    type.
 * 2. `days_covered` RENDERS BESIDE THE DISTRIBUTION. A Gini over 3 days and one
 *    over 31 are not the same claim.
 * 3. THE ENTITY LENS LEADS. A subnet with three operators behind 256 UIDs is
 *    not diverse, and the per-UID figure alone hides exactly that — so it is
 *    labelled as the secondary reading rather than shown on its own.
 */
export function SubnetMinerFairnessPanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    subnetMinerFairnessQuery(netuid, "30d"),
  );

  if (isLoading) return <Skeleton className="h-[180px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const card = data?.data ?? null;
  if (!card || card.points.length === 0) {
    return (
      <EmptyState
        title="No miner-fairness reading yet"
        description="The daily per-UID rollup has not been captured for this subnet over the selected window."
      />
    );
  }

  const latest = card.points[0];
  const entity = card.concentration?.entity ?? null;
  const uid = card.concentration?.uid ?? null;

  return (
    <Panel as="section" dense>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure
          label="miner UIDs"
          value={String(latest.miner_count)}
          hint="Registered non-validator UIDs on the newest day — the number most dashboards publish."
        />
        <Figure
          label="earning"
          value={String(latest.earning_miner_count)}
          hint="How many of them recorded emission above zero that day."
        />
        <Figure
          label="never earned"
          value={card.persistence ? String(card.persistence.never_earned_count) : "—"}
          hint={`Earned on zero of ${card.days_covered} days covered. Distinct from missing a single tempo.`}
        />
        <Figure
          label="UIDs per operator"
          value={card.uids_per_entity == null ? "—" : card.uids_per_entity.toFixed(2)}
          hint="1.0 = every UID a distinct coldkey; higher = fewer operators running many."
        />
      </div>

      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="mg-type-caption text-ink-muted">
          Emission concentration · {card.days_covered} days covered
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Figure
            label="by operator (headline)"
            value={giniLabel(entity?.gini)}
            hint="Gini across controlling coldkeys, each one's UIDs summed."
          />
          <Figure
            label="by UID (secondary)"
            value={giniLabel(uid?.gini)}
            hint="The same measure per UID. Where the two differ, several UIDs share an operator."
          />
          <Figure
            label="nakamoto"
            value={entity?.nakamoto_coefficient == null ? "—" : String(entity.nakamoto_coefficient)}
            hint="Operators needed to reach half the emission."
          />
        </div>
      </div>
    </Panel>
  );
}

/** A Gini, or an em dash. NEVER 0 for a null: an unmeasured distribution and a
 * perfectly equal one are opposite claims. */
export function giniLabel(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(3);
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="mg-type-caption text-ink-muted">{label}</div>
      <div className="mg-type-body text-ink-strong">{value}</div>
      <div className="mg-type-caption text-ink-muted">{hint}</div>
    </div>
  );
}
