import { Definition } from "@jsonbored/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { subnetEmissionPipelineHistoryQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";
import type { SubnetEmissionPipelineHistory } from "@/lib/metagraphed/types";

/**
 * The emission pipeline over time (#10300).
 *
 * `/api/v1/subnets/{netuid}/emission-pipeline/history` was published and
 * rendered nowhere. The card exists for one reason the current snapshot cannot
 * give: WHETHER THE SERIES IS MEASUREMENT OR REPETITION.
 *
 * The route publishes `point_count` and `distinct_observations` separately, and
 * marks each day with `repeats_previous_observation`. A day that repeats
 * carried the previous reading forward rather than taking a new one -- so a
 * flat stretch means either "the pipeline did not move" or "the lane did not
 * run", and those look identical on a chart that treats every point as a
 * measurement. This panel states the gap rather than smoothing it, because the
 * second reading is a data-collection failure being displayed as stability.
 */
export function SubnetEmissionPipelineHistoryPanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    subnetEmissionPipelineHistoryQuery(netuid, "30d"),
  );

  if (isLoading) return <Skeleton className="h-[160px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const h = data?.data ?? null;
  if (!h || h.points.length === 0) {
    return (
      <EmptyState
        title="No pipeline history yet"
        description="The emission pipeline has not been captured for this subnet over the selected window."
      />
    );
  }

  const carried = countCarriedForward(h);
  const latest = h.points[h.points.length - 1];

  return (
    <Panel>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure label="days" value={formatNumber(h.point_count)} hint="Days in the window." />
        <Figure
          label="distinct readings"
          value={h.distinct_observations == null ? "—" : formatNumber(h.distinct_observations)}
          hint="How many of those days were independently observed. Fewer than the day count means some days repeat the previous reading."
        />
        <Figure
          label="emission share"
          value={
            latest?.emission_share == null ? "—" : `${formatNumber(latest.emission_share * 100)}%`
          }
          hint="This subnet's share of network emission on the newest day."
        />
        <Figure
          label="gate"
          value={latest?.emission_enabled == null ? "—" : latest.emission_enabled ? "open" : "shut"}
          hint="Whether emission was enabled for this subnet on the newest day."
        />
      </div>

      {/* THE CARRIED-FORWARD WARNING. Said in words rather than drawn, because
          a chart cannot distinguish a flat line that was measured from one that
          was copied -- and this is the difference between "stable" and "we
          stopped looking". */}
      {carried > 0 ? (
        <p className="mt-4 text-10 text-ink-muted">
          {carried} of {h.point_count} day{h.point_count === 1 ? "" : "s"} repeat the previous
          reading rather than a fresh observation — a flat stretch here is not evidence the pipeline
          held steady.
        </p>
      ) : null}

      {h.first_captured_day ? (
        <p className="mt-2 text-10 text-ink-muted">
          Capture begins {h.first_captured_day}. Anything earlier is unwatched, not empty.
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
 * How many days carried the previous reading forward.
 *
 * Counts only days that SAY they repeat. A null flag is not counted as a
 * repeat: the API declining to say is not the same as saying no, and inflating
 * the warning count with unknowns would make the warning untrustworthy in the
 * direction that matters -- a reader who learns it over-reports stops reading
 * it.
 */
export function countCarriedForward(history: SubnetEmissionPipelineHistory): number {
  return history.points.filter((p) => p.repeats_previous_observation === true).length;
}
