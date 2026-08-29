import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankGrid, RankedRails, type RankGridItem } from "@jsonbored/ui-kit";
import { subnetEventSummaryQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatPct } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ErrorState } from "@/components/metagraphed/states";
import { activityKindRail, categoryTotals } from "./subnet-detail-logic";

/**
 * Section 5 — what actually happens on this subnet.
 *
 * A ranked rail, not a stacked column chart. The window publishes per-kind
 * TOTALS, not a per-day series, so there is no time axis to draw; and the
 * distribution is extreme (21,088 consensus events against 51 registrations
 * on SN19), which a stacked column renders as one full bar beside three
 * empty ones. Ranked rails on a square-root scale show the whole tail, and
 * they are the same geometry the validators and surfaces sections use.
 */
export function ActivitySection({ netuid }: { netuid: number }) {
  const { ref, nearViewport } = useNearViewport();
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetEventSummaryQuery(netuid, "30d"),
    enabled: nearViewport,
    retry: 0,
  });
  const hydrated = useHydrated();
  const loading = nearViewport && (!hydrated || isPending);
  const showLoading = nearViewport && hydrated && isPending;
  const summary = data?.data;
  const rail = activityKindRail(summary?.event_kinds ?? []);
  const categories = categoryTotals(summary?.categories ?? []);

  const legend: RankGridItem[] = categories.map((category) => ({
    key: category.key,
    label: category.label,
    value: formatNumber(category.value),
    share: `${formatPct(category.share, 1)}`,
  }));

  return (
    <AnalyticsSection
      id="activity"
      name="Activity"
      question="On-chain events by kind, last 30 days."
      visualRef={ref}
      visual={
        !nearViewport || showLoading ? (
          <RankedRails
            items={[]}
            formatValue={(v) => formatNumber(v)}
            scale="sqrt"
            columns={{ value: "Events", name: "Kind", track: "Share of events" }}
            ariaLabel={`Subnet ${netuid} events by kind, 30 days`}
            source={`sn-${netuid}-event`}
            loading
            loadingRows={10}
          />
        ) : isError ? (
          <ErrorState
            error={error}
            onRetry={() => void refetch()}
            context="30-day subnet event activity"
          />
        ) : rail.length > 0 ? (
          <RankedRails
            items={rail}
            formatValue={(v) => formatNumber(v)}
            scale="sqrt"
            columns={{ value: "Events", name: "Kind", track: "Share of events" }}
            ariaLabel={`Subnet ${netuid} events by kind, 30 days`}
            source={`sn-${netuid}-event`}
          />
        ) : null
      }
      legend={
        !nearViewport || showLoading ? (
          <RankGrid
            items={[]}
            cols={4}
            ariaLabel="Events by category"
            source={`sn-${netuid}-event-category`}
            loading
            loadingItems={4}
          />
        ) : legend.length > 0 ? (
          <RankGrid
            items={legend}
            cols={4}
            ariaLabel="Events by category"
            source={`sn-${netuid}-event-category`}
          />
        ) : null
      }
      footnote={
        !nearViewport
          ? "30d event mix by kind · chain-direct"
          : loading
            ? "Loading 30d event activity · chain-direct"
            : isError
              ? "chain-direct · retry the affected record above"
              : `30d · ${formatNumber(summary?.total_events ?? 0)} events across ${formatNumber(
                  summary?.kind_count ?? 0,
                )} kinds · chain-direct`
      }
    />
  );
}
