import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, BrandIcon, LeaderCards, RangeControl } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { economicsQuery, subnetMoversQuery } from "@/lib/metagraphed/queries";
import {
  METRIC_OPTIONS,
  MOVERS_LIMIT,
  MOVERS_SORT,
  rankSubnets,
  resolveWindow,
  windowsFor,
  type RankMetric,
  type RankWindow,
} from "./subnets-index-logic";

/** Cards shown before "Show all". */
const FEATURED = 3;

const FOOTNOTE: Record<RankMetric, string> = {
  emission: "ranked by share of daily emission, changed over the window",
  stake: "Choose emission, price change, or validator count above.",
  price: "ranked by price CHANGE — one subnet's alpha price is not another's",
  validators: "ranked by validators holding a permit, changed over the window",
};

/**
 * Section 1 — the subnets that carry the network.
 *
 * Two controls, and every option in both does something: the window list is
 * derived from the metric, because price change is published for 7d and 1m
 * only and offering it a 90d button would be a control that lies.
 */
export function RankingsSection({
  metric,
  window,
  onMetric,
  onWindow,
  nameOf,
  domainOf,
}: {
  metric: RankMetric;
  window: RankWindow;
  onMetric: (next: RankMetric) => void;
  onWindow: (next: RankWindow) => void;
  nameOf: (netuid: number) => string;
  domainOf: (netuid: number) => string | undefined;
}) {
  const stakeUnavailable = metric === "stake";
  const resolved = resolveWindow(metric, window);
  const { ref, nearViewport } = useNearViewport("0px 0px");
  // The movers slice is aligned with the metric so the deltas that DO land
  // are the ones the ranking is about; the levels come from economics, which
  // covers every subnet. Price has no movers dimension -- its change is an
  // economics field -- so it asks for the stake slice and ignores it.
  const movers = useQuery({
    ...subnetMoversQuery({
      window: resolved,
      sort: metric === "price" ? "stake" : MOVERS_SORT[metric],
      limit: MOVERS_LIMIT,
    }),
    // The directory is the route's opening answer. Movers provide a separate
    // comparative reading below it, so wait until that evidence region is
    // actually approached instead of competing with the first result list.
    enabled: nearViewport && !stakeUnavailable,
    retry: 0,
  });
  const economics = useQuery({ ...economicsQuery({ fields: "directory" }), retry: 0 });

  const [expanded, setExpanded] = useState(false);
  const loading = movers.isPending || economics.isPending;
  const error = movers.isError ? movers.error : economics.isError ? economics.error : null;
  const ranked = rankSubnets(
    metric,
    resolved,
    movers.data?.data.movers ?? [],
    economics.data?.data ?? [],
    nameOf,
    domainOf,
  );
  // Three cards at rest, eighteen on request. The directory is the section a
  // reader scrolls TO, and a full leaderboard above it pushed the first
  // subnet row 1,590px down the document -- past the fold on every laptop.
  const shown = expanded ? ranked : ranked.slice(0, FEATURED);

  return (
    <AnalyticsSection
      id="rankings"
      name="Rankings"
      question="The subnets that carry the network."
      visualRef={ref}
      controls={
        <>
          <RangeControl
            label="Rank by"
            options={METRIC_OPTIONS}
            value={metric}
            onChange={(next) => onMetric(next as RankMetric)}
          />
          {!stakeUnavailable ? (
            <RangeControl
              label="Window"
              options={windowsFor(metric)}
              value={resolved}
              onChange={onWindow}
            />
          ) : null}
        </>
      }
      visual={
        stakeUnavailable ? (
          <EmptyState
            title="Stake ranking is unavailable"
            description="The available figures describe voting weight, not token holdings. Comparable stake values are unavailable; choose another ranking above."
          />
        ) : !nearViewport || loading ? (
          <LeaderCards
            items={[]}
            featured={FEATURED}
            loading
            loadingItems={FEATURED}
            ariaLabel={`Subnets ranked by ${metric} over ${resolved}`}
            source="subnet-rank"
          />
        ) : error ? (
          <ErrorState
            error={error}
            onRetry={() => {
              void movers.refetch();
              void economics.refetch();
            }}
            context="subnet rankings"
          />
        ) : shown.length > 0 ? (
          <LeaderCards
            items={shown.map((row) => ({
              key: String(row.netuid),
              name: row.name,
              sub: row.domain ?? `SN${row.netuid}`,
              value: row.value,
              delta: row.delta,
              href: `/subnets/${row.netuid}`,
              avatar: <BrandIcon size={20} name={row.name} netuid={row.netuid} decorative />,
              initials: String(row.netuid),
            }))}
            featured={3}
            ariaLabel={`Subnets ranked by ${metric} over ${resolved}`}
            source="subnet-rank"
          />
        ) : null
      }
      footnote={
        stakeUnavailable ? (
          FOOTNOTE.stake
        ) : !nearViewport ? (
          `${resolved} · ${FOOTNOTE[metric]} · chain-direct`
        ) : loading ? (
          `loading ${resolved} subnet rankings by ${metric}`
        ) : error ? (
          "subnet ranking data could not be loaded"
        ) : expanded || ranked.length <= FEATURED ? (
          `${resolved} · ${FOOTNOTE[metric]} · chain-direct`
        ) : (
          <button type="button" className="mg-section-more" onClick={() => setExpanded(true)}>
            Show all {ranked.length}
          </button>
        )
      }
    />
  );
}
