import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankGrid, RankedRails, type RankGridItem } from "@jsonbored/ui-kit";
import { subnetEventSummaryQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
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
  const { data } = useQuery({ ...subnetEventSummaryQuery(netuid, "30d"), retry: 0 });
  const summary = data?.data;
  const rail = activityKindRail(summary?.event_kinds ?? []);
  const categories = categoryTotals(summary?.categories ?? []);

  const legend: RankGridItem[] = categories.map((category) => ({
    key: category.key,
    label: category.label,
    value: formatNumber(category.value),
    share: `${(category.share * 100).toFixed(1)}%`,
  }));

  return (
    <AnalyticsSection
      id="activity"
      name="Activity"
      question="On-chain events by kind, last 30 days."
      visual={
        rail.length > 0 ? (
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
        legend.length > 0 ? (
          <RankGrid
            items={legend}
            cols={4}
            ariaLabel="Events by category"
            source={`sn-${netuid}-event-category`}
          />
        ) : null
      }
      footnote={`30d · ${formatNumber(summary?.total_events ?? 0)} events across ${formatNumber(
        summary?.kind_count ?? 0,
      )} kinds · chain-direct`}
    />
  );
}
