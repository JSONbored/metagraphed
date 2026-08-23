import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankGrid, StackedColumns, type RankGridItem } from "@jsonbored/ui-kit";
import { chainSubnetLifecycleQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { churnByDay, churnWindow } from "./subnets-index-logic";

/**
 * Section 4 — subnets arriving and leaving.
 *
 * By day over the captured history, not by week over six months: the
 * lifecycle endpoint serves everything it has in one response, and everything
 * it has is under a fortnight. Weekly buckets would draw two columns and
 * present them as a trend. The footnote states the window the data actually
 * covers rather than the one the section would like to cover.
 */
export function ChurnSection() {
  const { data } = useQuery({ ...chainSubnetLifecycleQuery(500), retry: 0 });
  const entries = data?.data.entries ?? [];
  const columns = churnByDay(entries);
  const window = churnWindow(entries);

  const recent: RankGridItem[] = entries.slice(0, 10).map((entry) => ({
    key: `${entry.netuid}-${entry.block_number}`,
    label: `SN${entry.netuid}`,
    value: entry.event,
    share: entry.observed_at?.slice(5, 10),
    href: entry.block_number ? `/blocks/${entry.block_number}` : undefined,
  }));

  return (
    <AnalyticsSection
      id="churn"
      name="Churn"
      question="Subnets registering and deregistering, by day."
      visual={
        columns.length > 0 ? (
          <StackedColumns
            columns={columns}
            seriesOrder={["registered", "deregistered"]}
            formatValue={(value) => formatNumber(value)}
            ariaLabel="Subnet registrations and deregistrations by day"
            columnSource="subnet-churn-day"
          />
        ) : null
      }
      legend={
        recent.length > 0 ? (
          <RankGrid
            items={recent}
            cols={5}
            ariaLabel="The ten most recent lifecycle transitions"
            source="subnet-churn"
          />
        ) : null
      }
      footnote={
        window
          ? `${window[0]} → ${window[1]} · ${formatNumber(entries.length)} transitions · the whole captured history, chain-direct`
          : "no lifecycle transitions captured yet"
      }
    />
  );
}
