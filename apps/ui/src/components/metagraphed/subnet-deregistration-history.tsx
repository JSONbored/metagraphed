import { Definition } from "@jsonbored/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { subnetDeregistrationHistoryQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";
import type {
  SubnetDeregistrationHistory,
  SubnetDeregistrationHistoryPoint,
} from "@/lib/metagraphed/types";

/**
 * The deregistration standing over time (#10296).
 *
 * The panel above this one already shows where the subnet sits TODAY. #10285's
 * own argument for why that is not enough:
 *
 *   > a single day's rank is noise, a trend is a warning
 *
 * So this states the DIRECTION, which is the only part an owner can act on.
 *
 * ## Three things it refuses to smooth
 *
 * **A null rank is not a missing rank.** While the subnet is immune it holds no
 * position in the prunable order at all, and rendering that as "—" beside a
 * number would read as a failed measurement. It is rendered as `immune`, with
 * how far the protection still reaches.
 *
 * **A rank without its field size is not a fact.** 94 of 100 and 94 of 128 are
 * different standings, so `ranked_count` is never dropped.
 *
 * **A rank that was not re-measured looks exactly like a rank that held
 * steady**, and the second is reassuring where the first is not. The route
 * publishes `point_count` and `distinct_observations` separately for that, and
 * the gap is stated in words rather than charted away.
 */
export function SubnetDeregistrationHistoryPanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    subnetDeregistrationHistoryQuery(netuid, "30d"),
  );

  if (isLoading) return <Skeleton className="h-[160px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const h = data?.data ?? null;
  if (!h || h.points.length === 0) {
    return (
      <EmptyState
        title="No deregistration history yet"
        description="The daily lane has not written a ranking for this subnet over the selected window."
      />
    );
  }

  const latest = h.points[h.points.length - 1] ?? null;
  const oldest = h.points[0] ?? null;
  const carried = countCarriedForward(h);
  const move = rankMovement(h);

  return (
    <Panel as="section">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure
          label="standing"
          value={describeStanding(latest)}
          hint="Where this subnet sits in the pallet's pruning order on the newest measured day. An immune subnet holds no position at all, which is why that reads as a word rather than a number."
        />
        <Figure label="direction" value={move.label} hint={move.hint} />
        <Figure
          label="days"
          value={formatNumber(h.point_count)}
          hint="Days in the window that carry a ranking for this subnet."
        />
        <Figure
          label="distinct readings"
          value={h.distinct_observations == null ? "—" : formatNumber(h.distinct_observations)}
          hint="How many of those days were independently observed. Fewer than the day count means some days repeat the previous reading."
        />
      </div>

      {latest && latest.immune === false && latest.next_to_deregister != null ? (
        <p className="mt-4 text-10 text-ink-muted">
          {latest.next_to_deregister === netuid
            ? "This subnet is the one the chain would prune next."
            : `Subnet ${latest.next_to_deregister} would be pruned first.`}
          {latest.comparison_price != null &&
          latest.next_to_deregister_comparison_price != null &&
          latest.next_to_deregister !== netuid
            ? ` The compared price here is ${formatNumber(latest.comparison_price)} against ${formatNumber(latest.next_to_deregister_comparison_price)} at rank 1.`
            : null}
        </p>
      ) : null}

      {/* THE CARRIED-FORWARD WARNING, in words rather than drawn: a chart
          cannot distinguish a rank that held from a rank nobody re-read, and
          only one of those is good news. */}
      {carried > 0 ? (
        <p className="mt-2 text-10 text-ink-muted">
          {carried} of {h.point_count} day{h.point_count === 1 ? "" : "s"} repeat the previous
          observation rather than a fresh one — a flat stretch here is not evidence the standing
          held.
        </p>
      ) : null}

      {h.first_captured_day ? (
        <p className="mt-2 text-10 text-ink-muted">
          Capture begins {h.first_captured_day}
          {oldest ? `; this window covers from ${oldest.day}` : ""}. Anything earlier is unwatched,
          not empty.
        </p>
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

/**
 * The newest day's standing, as a phrase.
 *
 * `immune` outranks `rank`, because while immune there is no rank to report --
 * not an unknown one. A day that says neither is rendered as unknown, which is
 * the honest answer for a payload that could not describe itself.
 */
export function describeStanding(point: SubnetDeregistrationHistoryPoint | null): string {
  if (!point) return "—";
  if (point.immune === true) return "immune";
  if (point.rank == null) return "—";
  return point.ranked_count == null
    ? `#${formatNumber(point.rank)}`
    : `#${formatNumber(point.rank)} of ${formatNumber(point.ranked_count)}`;
}

/**
 * How the rank moved across the window, and what that means.
 *
 * A LOWER rank number is WORSE -- rank 1 is next to be pruned -- so the wording
 * is spelled out rather than left to a plus or a minus, which reads backwards
 * for exactly the person this panel is for.
 *
 * Compares only days where the subnet actually HELD a rank. A window that
 * starts or ends immune has no movement to report, because a position and the
 * absence of one cannot be subtracted.
 */
export function rankMovement(history: SubnetDeregistrationHistory): {
  label: string;
  hint: string;
} {
  const ranked = history.points.filter((p) => typeof p.rank === "number");
  const first = ranked[0];
  const last = ranked[ranked.length - 1];
  if (!first || !last || first === last) {
    return {
      label: "—",
      hint: "Not enough ranked days in this window to say which way the standing moved. A day spent immune holds no position, so it cannot be compared against one.",
    };
  }
  const delta = (last.rank as number) - (first.rank as number);
  if (delta === 0) {
    return {
      label: "unchanged",
      hint: `Rank ${formatNumber(first.rank as number)} on ${first.day} and on ${last.day}. Check the distinct-readings count before reading that as stability.`,
    };
  }
  // Up the list means CLOSER to being pruned. Naming the consequence rather
  // than the arithmetic, because "rank fell" is ambiguous and "closer to the
  // bar" is not.
  const safer = delta > 0;
  return {
    label: `${safer ? "safer" : "closer to the bar"} by ${formatNumber(Math.abs(delta))}`,
    hint: `Rank ${formatNumber(first.rank as number)} on ${first.day}, ${formatNumber(last.rank as number)} on ${last.day}. Rank 1 is next to be pruned, so a HIGHER number is further from deregistration.`,
  };
}

/**
 * How many days carried the previous observation forward.
 *
 * Counts only days that SAY they repeat. A null flag is not counted: the API
 * declining to say is not the same as saying no, and inflating the warning with
 * unknowns makes it untrustworthy in the direction that matters.
 */
export function countCarriedForward(history: SubnetDeregistrationHistory): number {
  return history.points.filter((p) => p.repeats_previous_observation === true).length;
}
