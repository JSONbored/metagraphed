import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankGrid, StackedColumns, type RankGridItem } from "@jsonbored/ui-kit";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
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
  const { ref, nearViewport } = useNearViewport("0px 0px");
  const query = useQuery({
    ...chainSubnetLifecycleQuery(500),
    // Lifecycle history is a fourth, distinct analysis after the crawlable
    // directory. Its empty/error states remain truthful once it is reached.
    enabled: nearViewport,
    retry: 0,
  });
  const { data } = query;
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
      visualRef={ref}
      visual={
        !nearViewport || query.isPending ? (
          <StackedColumns
            columns={[]}
            seriesOrder={["registered", "deregistered"]}
            formatValue={(value) => formatNumber(value)}
            ariaLabel="Subnet registrations and deregistrations by day"
            columnSource="subnet-churn-day"
            loading
            loadingColumns={14}
          />
        ) : query.isError ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            context="subnet lifecycle history"
          />
        ) : columns.length > 0 ? (
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
        !nearViewport || query.isPending ? (
          <RankGrid
            items={[]}
            cols={5}
            ariaLabel="The ten most recent lifecycle transitions"
            source="subnet-churn"
            loading
            loadingItems={5}
          />
        ) : recent.length > 0 ? (
          <RankGrid
            items={recent}
            cols={5}
            ariaLabel="The ten most recent lifecycle transitions"
            source="subnet-churn"
          />
        ) : null
      }
      footnote={
        !nearViewport
          ? "registration and deregistration history · chain-direct"
          : query.isPending
            ? "loading captured subnet lifecycle history"
            : query.isError
              ? "subnet lifecycle history could not be loaded"
              : window
                ? `${window[0]} → ${window[1]} · ${formatNumber(entries.length)} transitions · the whole captured history, chain-direct`
                : "no lifecycle transitions captured yet"
      }
    />
  );
}
