import { useQuery } from "@tanstack/react-query";
import {
  subnetValidatorEconomicsQuery,
  subnetValidatorEconomicsHistoryQuery,
} from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * What it costs to validate on this subnet (#10300).
 *
 * `/api/v1/subnets/{netuid}/validator-economics` and its `/history` were
 * published and rendered nowhere. The card exists because the three numbers a
 * would-be validator actually needs are not interchangeable, and a single
 * "cost to validate" figure would flatten them:
 *
 * PERMIT AND EARNING ARE DIFFERENT THRESHOLDS. Holding a validator permit does
 * not mean earning from it -- the earning floor sits above the permit floor,
 * and `permit_to_earning_multiple` is how far above. Publishing only one would
 * tell a reader they can validate for a price that does not get them paid.
 *
 * PERMITTED, ACTIVE AND EARNING ARE THREE DIFFERENT SETS. The API publishes
 * them separately rather than collapsed because "how many validators does this
 * subnet have" has three defensible answers, and which one matters depends on
 * the question being asked.
 *
 * `cap_binding` changes what a reader should do with `validator_slots_open`:
 * open slots are meaningless when the cap, not the stake floor, is what holds
 * entry back. So the slot count is only shown as actionable when it is.
 */
export function SubnetValidatorEconomicsPanel({ netuid }: { netuid: number }) {
  const {
    data: current,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetValidatorEconomicsQuery(netuid));
  const { data: history } = useQuery(subnetValidatorEconomicsHistoryQuery(netuid, "30d"));

  if (isLoading) return <Skeleton className="h-[180px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const e = current?.data ?? null;
  if (!e) {
    return (
      <EmptyState
        title="No validator economics yet"
        description="This subnet has not reported the stake thresholds a validator permit and earning require."
      />
    );
  }

  const points = history?.data ?? [];
  const tao = (v: number | null) => (v == null ? "—" : `${formatNumber(v)} τ`);

  return (
    <Panel as="section" dense>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure
          label="permit floor"
          value={tao(e.permit_floor_cost_tao)}
          hint="Stake needed to hold a validator permit. Holding one does not mean earning from it."
        />
        <Figure
          label="earning floor"
          value={tao(e.earning_floor_cost_tao)}
          hint="Stake needed to actually earn. This is the number that matters if you intend to be paid."
        />
        <Figure
          label="earning / permit"
          value={
            e.permit_to_earning_multiple == null
              ? "—"
              : `${formatNumber(e.permit_to_earning_multiple)}×`
          }
          hint="How far above the permit floor the earning floor sits. A permit bought at the lower number earns nothing."
        />
        <Figure
          label="median take"
          value={e.median_take == null ? "—" : `${formatNumber(e.median_take * 100)}%`}
          hint="Median commission across permit-holders on this subnet."
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {/* Three DIFFERENT sets, shown as three numbers. Collapsing them would
            answer a question the reader did not ask. */}
        <Figure
          label="permitted"
          value={formatNumber(e.permitted ?? 0)}
          hint="Hold a validator permit."
        />
        <Figure
          label="active"
          value={formatNumber(e.active ?? 0)}
          hint="Permitted AND currently serving."
        />
        <Figure
          label="earning"
          value={formatNumber(e.earning ?? 0)}
          hint="Active AND above the earning floor."
        />
        <Figure
          label="slots"
          value={
            e.max_validators == null
              ? "—"
              : `${formatNumber(e.validator_slots_open ?? 0)} / ${formatNumber(e.max_validators)}`
          }
          hint={
            e.cap_binding
              ? "The validator CAP is what holds entry back here, not the stake floor — open slots are not the constraint."
              : "Open slots against the cap. The stake floor is the binding constraint, not the cap."
          }
        />
      </div>

      {/* The trend, only when there is more than one point to compare. A
          single day is not a direction, and rendering it as one would invent
          movement that has not been observed. */}
      {points.length > 1 ? (
        <p className="mt-4 mg-type-data-sm text-ink-muted">
          {points.length} days of history · earning floor{" "}
          {trendWord(
            points[points.length - 1]?.earning_floor_alpha,
            points[0]?.earning_floor_alpha,
          )}{" "}
          over the window
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
 * Which way a figure moved, or that it did not move at all.
 *
 * Returns "unchanged" rather than a direction when the two ends are equal --
 * "rose" on an identical pair would be a claim about movement that did not
 * happen. Null at either end means no comparison exists, which is not the same
 * as no change.
 */
export function trendWord(
  latest: number | null | undefined,
  oldest: number | null | undefined,
): string {
  if (latest == null || oldest == null) return "not comparable";
  if (latest === oldest) return "unchanged";
  return latest > oldest ? "rose" : "fell";
}
