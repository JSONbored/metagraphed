import { useEffect, useMemo, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AnalyticsPage,
  AnalyticsSection,
  CompositionBreakdown,
  CopyableCode,
  FactStrip,
  LineWithWindow,
  MarkerRail,
  RangeControl,
  RankedRails,
  type FactCells,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { LIVE_BLOCK_LIMIT, LiveBlockRail } from "@/components/metagraphed/live-block-rail";
import { SearchBox } from "@/components/metagraphed/search-box";
import { ErrorState } from "@/components/metagraphed/states";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import {
  CHAIN_METRICS,
  chainPoints,
  emissionRails,
  fmtAlpha,
  fmtCount,
  fmtShare,
  healthRail,
  lastCompleteDay,
  valueSegments,
  type ChainMetric,
  type EmissionWindow,
} from "@/components/metagraphed/home/home-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  blocksQuery,
  blocksSummaryQuery,
  bulkHealthTrendsQuery,
  chainActivityQuery,
  economicsQuery,
  subnetMoversQuery,
} from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";

const SECTIONS = [
  { id: "emission", name: "Emission movement" },
  { id: "chain", name: "Chain activity" },
  { id: "health", name: "Surface health" },
] as const;

const API_PATHS = [
  "/api/v1/economics",
  "/api/v1/subnets/movers",
  "/api/v1/chain/activity",
  "/api/v1/blocks",
  "/api/v1/blocks/summary",
  "/api/v1/health/trends",
];

const EMISSION_WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

const HERO_BLOCK_RAIL_MEDIA_QUERY = "(min-width: 640px)";
const MCP_INSTALL_COMMAND =
  "claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp/core";

/**
 * The live block rail is intentionally absent from the compact phone hero.
 * Match its data work to that visual decision: the lower chain fact strip
 * still obtains the current head from the summary query, but a phone does not
 * download an invisible 12-row feed. Listens for resizing so an open page can
 * gain or lose the desktop instrument without a reload.
 */
function useHeroBlockRailEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(HERO_BLOCK_RAIL_MEDIA_QUERY);
    const update = () => setEnabled(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return enabled;
}

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/** A quiet structural field, deliberately separate from the network data. */
function HomeDotField() {
  return (
    <svg
      className="mg-home-dot-field"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1200 460"
      preserveAspectRatio="none"
    >
      <defs>
        <pattern id="mg-home-dot-pattern" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="1.25" cy="1.25" r="0.8" />
        </pattern>
      </defs>
      <rect width="1200" height="460" fill="url(#mg-home-dot-pattern)" />
    </svg>
  );
}

export function OverviewPage() {
  const [emissionWindow, setEmissionWindow] = useState<EmissionWindow>("30d");
  const [chainMetric, setChainMetric] = useState<ChainMetric>("extrinsics");
  const heroBlockRailEnabled = useHeroBlockRailEnabled();

  const { data: economics } = useSuspenseQuery(economicsQuery({ fields: "identity" }));
  const movers = useQuery({
    ...subnetMoversQuery({ window: emissionWindow, sort: "emission", limit: 100 }),
    retry: 0,
  });
  const activity = useQuery({ ...chainActivityQuery("30d"), retry: 0 });
  const blocks = useQuery({ ...blocksSummaryQuery(), retry: 0 });
  // The block rail polls only while this tab is visible. It advances the
  // explorer reading without holding a permanent stream connection open.
  const blockRefetchInterval = useRefetchInterval(15_000, heroBlockRailEnabled);
  const blockFeed = useQuery({
    ...blocksQuery({ limit: LIVE_BLOCK_LIMIT }),
    enabled: heroBlockRailEnabled,
    refetchInterval: blockRefetchInterval,
    retry: 0,
  });
  const health = useQuery({ ...bulkHealthTrendsQuery(), retry: 0 });

  // Names come from the economics rows this page already holds. Fetching the
  // registry list too would be a second 129-row payload for one string field.
  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of economics.data) map.set(row.netuid, row.name ?? `Subnet ${row.netuid}`);
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [economics.data]);

  const rows = economics.data;
  // The masthead tells the first, immediate story: the leading five named
  // subnet shares plus the rest of the network. Keeping that in the same
  // economics projection as the rest of the page avoids making a second,
  // duplicate request just to decorate the landing view.
  const { segments, accounted } = useMemo(() => valueSegments(rows, 5), [rows]);
  const rails = useMemo(
    () => emissionRails(movers.data?.data.movers ?? [], nameOf),
    [movers.data, nameOf],
  );
  const days = activity.data?.data.days ?? [];
  const activityAsOfDay = activity.data?.meta.generated_at?.slice(0, 10);
  const points = chainPoints(days, chainMetric, activityAsOfDay);
  const complete = lastCompleteDay(days, activityAsOfDay);
  const healthSubnets = health.data?.data.windows?.["7d"]?.subnets ?? [];
  const worst = healthRail(healthSubnets, nameOf);
  const healthy = healthSubnets.filter((subnet) => (subnet.uptime_ratio ?? 0) >= 0.99).length;
  const lowestUptime =
    health.isError || worst[0]?.value == null ? "—" : `${formatDecimal(worst[0].value, 1)}%`;
  const latestBlock = blockFeed.data?.data[0] ?? null;
  const headBlock = latestBlock?.block_number ?? blocks.data?.data.last_block ?? null;
  const headBlockLoading = blockFeed.isPending && blocks.isPending;

  const chainCells: FactCells = [
    {
      label: "Blocks",
      value: activity.isError ? "—" : fmtCount(complete?.block_count),
      loading: activity.isPending,
    },
    {
      label: "Extrinsics",
      value: activity.isError ? "—" : fmtCount(complete?.extrinsic_count),
      loading: activity.isPending,
    },
    {
      label: "Events",
      value: activity.isError ? "—" : fmtCount(complete?.event_count),
      loading: activity.isPending,
    },
    {
      label: "Head block",
      value: typeof headBlock === "number" ? formatNumber(headBlock) : "—",
      loading: headBlockLoading,
    },
  ];

  const healthCells: FactCells = [
    {
      label: "Subnets at 99%+",
      value: health.isError
        ? "—"
        : `${formatNumber(healthy)} / ${formatNumber(healthSubnets.length)}`,
      loading: health.isPending,
    },
    {
      label: "Probed",
      value: health.isError ? "—" : formatNumber(healthSubnets.length),
      loading: health.isPending,
    },
    {
      label: "Lowest uptime",
      value: lowestUptime,
      loading: health.isPending,
    },
  ];

  return (
    <AppShell>
      <ApiSources />
      <AnalyticsPage
        className="mg-home"
        sections={SECTIONS}
        hero={
          <header className="mg-home-hero" data-mg-home-hero="">
            <div className="mg-home-command-grid">
              <div className="mg-home-intro">
                <h1>Bittensor, measured.</h1>
                <p className="mg-home-lede">
                  Public, source-linked Bittensor data for people—and the same registry for agents.
                </p>
                <SearchBox variant="landing" />
                <aside className="mg-home-mcp-install" aria-labelledby="home-mcp-title">
                  <div className="mg-home-mcp-head">
                    <div className="mg-home-mcp-identity">
                      <span className="mg-home-mcp-mark" aria-hidden="true">
                        MCP
                      </span>
                      <div>
                        <p id="home-mcp-title">Metagraphed MCP</p>
                        <p>Bittensor in a box.</p>
                      </div>
                    </div>
                    <Link to="/agents">
                      Setup <span aria-hidden="true">→</span>
                    </Link>
                  </div>
                  <CopyableCode
                    label="Install"
                    value={MCP_INSTALL_COMMAND}
                    className="mg-home-mcp-command"
                  />
                </aside>
              </div>
              <section id="value" className="mg-home-pulse" aria-labelledby="home-allocation-title">
                <HomeDotField />
                <div className="mg-home-pulse-head">
                  <div>
                    <p>Network allocation</p>
                    <h2 id="home-allocation-title">Latest daily emission.</h2>
                  </div>
                  <span>Source-linked economics</span>
                </div>
                {segments.length > 0 ? (
                  <CompositionBreakdown
                    segments={segments}
                    formatValue={(value) => fmtShare(value, 3)}
                    legendCols={3}
                    ariaLabel="Latest indexed daily emission share across the five largest subnets"
                    source="home-subnet"
                    className="mg-home-pulse-composition"
                  />
                ) : (
                  <p className="mg-home-pulse-empty">
                    No current emission composition is available.
                  </p>
                )}
                <LiveBlockRail
                  compact
                  blocks={blockFeed.data?.data ?? []}
                  loading={blockFeed.isPending}
                  error={blockFeed.isError}
                  updatedAt={latestBlock?.observed_at ?? null}
                />
                <div className="mg-home-pulse-foot">
                  <span>{fmtShare(accounted, 1)} of latest daily emission accounted for</span>
                  <Link to="/subnets">
                    Compare every subnet <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </section>
            </div>
            <nav className="mg-home-aux-links" aria-label="More ways to explore">
              <Link to="/validators">Inspect validators</Link>
              <Link to="/chain">Read chain activity</Link>
              <Link to="/apis">Browse APIs and surfaces</Link>
            </nav>
          </header>
        }
      >
        <AnalyticsSection
          id="emission"
          name="Emission movement"
          question="Where daily alpha moved after the comparison opened."
          className="mg-home-story mg-home-story--emission"
          controls={
            <RangeControl
              label="Compare"
              options={EMISSION_WINDOWS}
              value={emissionWindow}
              onChange={(next) => setEmissionWindow(next as EmissionWindow)}
            />
          }
          visual={
            movers.isPending ? (
              <RankedRails
                items={[]}
                loading
                loadingRows={10}
                formatValue={(value) => fmtAlpha(value)}
                scale="sqrt"
                columns={{
                  value: "Daily emission",
                  name: "Subnet",
                  track: "Relative to the top 15",
                }}
                ariaLabel={`Daily subnet emission at the end of the ${emissionWindow} comparison`}
                source="home-subnet"
              />
            ) : movers.isError ? (
              <ErrorState
                error={movers.error}
                context="the emission comparison"
                onRetry={() => void movers.refetch()}
              />
            ) : rails.length > 0 ? (
              <RankedRails
                items={rails}
                formatValue={(value) => fmtAlpha(value)}
                scale="sqrt"
                columns={{
                  value: "Daily emission",
                  name: "Subnet",
                  track: "Relative to the top 15",
                }}
                ariaLabel={`Daily subnet emission at the end of the ${emissionWindow} comparison`}
                source="home-subnet"
              />
            ) : (
              <p className="text-13 text-ink-muted">No current emission comparison is available.</p>
            )
          }
          footnote={
            movers.isPending
              ? `Loading ${emissionWindow} emission comparison · chain-direct`
              : movers.isError
                ? "Emission comparison unavailable · chain-direct"
                : `${emissionWindow} comparison · bars show end-date daily alpha; tooltips show change from the start · chain-direct`
          }
        />
        <AnalyticsSection
          id="chain"
          name="Chain"
          question="What moved after the final UTC day closed."
          className="mg-home-story mg-home-story--chain"
          controls={
            <RangeControl
              label="Metric"
              options={CHAIN_METRICS}
              value={chainMetric}
              onChange={(next) => setChainMetric(next as ChainMetric)}
            />
          }
          visual={
            activity.isPending ? (
              <LineWithWindow
                id="home-chain"
                points={[]}
                window={{ from: 0, to: 0 }}
                unit={chainMetric}
                formatValue={(value) => fmtCount(value)}
                ariaLabel={`Complete-day ${chainMetric}, trailing 30 days`}
                source="home-chain"
                loading
              />
            ) : activity.isError ? (
              <ErrorState
                error={activity.error}
                context="complete-day chain activity"
                onRetry={() => void activity.refetch()}
              />
            ) : points.length > 1 ? (
              <LineWithWindow
                id="home-chain"
                points={points}
                window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
                unit={chainMetric}
                formatValue={(value) => fmtCount(value)}
                ariaLabel={`Complete-day ${chainMetric}, trailing 30 days`}
                source="home-chain"
              />
            ) : (
              <p className="text-13 text-ink-muted">No complete-day chain activity is available.</p>
            )
          }
          legend={<FactStrip cells={chainCells} />}
          // Chart and strip deliberately share the same complete-day cutoff.
          // Letting the chart include today's partial value while the strip
          // excludes it makes the two summaries contradict one another.
          footnote={
            activity.isPending
              ? "Loading 30d complete-day chain activity · chain-direct"
              : activity.isError
                ? "Complete-day chain activity unavailable · chain-direct"
                : `30d · chart and strip end ${complete?.day ?? "—"}, the last complete UTC day · chain-direct`
          }
        />
        <AnalyticsSection
          id="health"
          name="Health"
          question="Which public surfaces need attention."
          className="mg-home-story mg-home-story--health"
          visual={
            health.isPending ? (
              <MarkerRail
                loading
                loadingRows={10}
                max={100}
                formatValue={(value) => `${formatDecimal(value, 1)}%`}
                columns={{ ratio: "Uptime", name: "Subnet", scale: "0–100%" }}
                ariaLabel="The ten lowest subnet uptimes over 7 days"
                source="home-subnet"
              />
            ) : health.isError ? (
              <ErrorState
                error={health.error}
                context="surface health"
                onRetry={() => void health.refetch()}
              />
            ) : worst.length > 0 ? (
              <MarkerRail
                items={worst}
                max={100}
                formatValue={(value) => `${formatDecimal(value, 1)}%`}
                columns={{ ratio: "Uptime", name: "Subnet", scale: "0–100%" }}
                ariaLabel="The ten lowest subnet uptimes over 7 days"
                source="home-subnet"
              />
            ) : (
              <p className="text-13 text-ink-muted">No surface health readings are available.</p>
            )
          }
          legend={<FactStrip cells={healthCells} />}
          footnote={
            health.isPending
              ? "Loading 7d surface health · live prober"
              : health.isError
                ? "Surface health unavailable · live prober"
                : "7d · the ten LOWEST, because those are the ones worth acting on · live prober"
          }
        />
        <HubSections path="/" />
      </AnalyticsPage>
    </AppShell>
  );
}
