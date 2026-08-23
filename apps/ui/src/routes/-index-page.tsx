import { useMemo, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsPage,
  AnalyticsSection,
  CompositionBreakdown,
  CopyableCode,
  FactStrip,
  LeaderCards,
  LineWithWindow,
  MarkerRail,
  RangeControl,
  RankedRails,
  TimeAgo,
  type FactCells,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { SearchBox } from "@/components/metagraphed/search-box";
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
  blocksSummaryQuery,
  bulkHealthTrendsQuery,
  chainActivityQuery,
  economicsQuery,
  subnetMoversQuery,
} from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";

const SECTIONS = [
  { id: "value", name: "Value" },
  { id: "emission", name: "Emission" },
  { id: "chain", name: "Chain" },
  { id: "health", name: "Health" },
  { id: "agents", name: "Agents" },
] as const;

const API_PATHS = [
  "/api/v1/economics",
  "/api/v1/subnets/movers",
  "/api/v1/chain/activity",
  "/api/v1/blocks/summary",
  "/api/v1/health/trends",
];

const EMISSION_WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

/** The three ways an agent points at this registry. */
const AGENT_SNIPPETS = [
  {
    value: "claude",
    label: "Claude",
    code: "claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp/core",
  },
  {
    value: "chatgpt",
    label: "ChatGPT",
    code: "https://api.metagraph.sh/mcp/core",
  },
  {
    value: "curl",
    label: "curl",
    code: "curl -s https://api.metagraph.sh/api/v1/subnets | jq '.data.subnets[0]'",
  },
] as const;

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function OverviewPage() {
  const [emissionWindow, setEmissionWindow] = useState<EmissionWindow>("30d");
  const [chainMetric, setChainMetric] = useState<ChainMetric>("extrinsics");
  const [agent, setAgent] = useState<(typeof AGENT_SNIPPETS)[number]["value"]>("claude");

  const { data: economics } = useSuspenseQuery(economicsQuery({ fields: "identity" }));
  const movers = useQuery({
    ...subnetMoversQuery({ window: emissionWindow, sort: "emission", limit: 100 }),
    retry: 0,
  });
  const activity = useQuery({ ...chainActivityQuery("30d"), retry: 0 });
  const blocks = useQuery({ ...blocksSummaryQuery(), retry: 0 });
  const health = useQuery({ ...bulkHealthTrendsQuery(), retry: 0 });

  // Names come from the economics rows this page already holds. Fetching the
  // registry list too would be a second 129-row payload for one string field.
  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of economics.data) map.set(row.netuid, row.name ?? `Subnet ${row.netuid}`);
    return (netuid: number) => map.get(netuid) ?? `SN${netuid}`;
  }, [economics.data]);

  const rows = economics.data;
  const { segments, accounted } = useMemo(() => valueSegments(rows, 10), [rows]);
  const rails = useMemo(
    () => emissionRails(movers.data?.data.movers ?? [], nameOf),
    [movers.data, nameOf],
  );
  const days = activity.data?.data.days ?? [];
  const points = chainPoints(days, chainMetric);
  const complete = lastCompleteDay(days);
  const healthSubnets = health.data?.data.windows?.["7d"]?.subnets ?? [];
  const worst = healthRail(healthSubnets, nameOf);
  const healthy = healthSubnets.filter((subnet) => (subnet.uptime_ratio ?? 0) >= 0.99).length;

  const chainCells: FactCells = [
    { label: "Blocks", value: fmtCount(complete?.block_count) },
    { label: "Extrinsics", value: fmtCount(complete?.extrinsic_count) },
    { label: "Events", value: fmtCount(complete?.event_count) },
    {
      label: "Head block",
      value: blocks.data?.data.last_block ? formatNumber(blocks.data.data.last_block) : "—",
    },
  ];

  const healthCells: FactCells = [
    {
      label: "Subnets at 99%+",
      value: `${formatNumber(healthy)} / ${formatNumber(healthSubnets.length)}`,
    },
    { label: "Probed", value: formatNumber(healthSubnets.length) },
    {
      label: "Lowest uptime",
      value: worst[0]?.value != null ? `${formatDecimal(worst[0].value, 1)}%` : "—",
    },
  ];

  const agentCells: FactCells = [
    { label: "Tools", value: "243" },
    { label: "Key", value: "none" },
    { label: "Transport", value: "streamable-http" },
  ];

  return (
    <AppShell>
      <ApiSources />
      <AnalyticsPage
        sections={SECTIONS}
        hero={
          <header className="mg-landing">
            <span className="mg-landing-meta">
              Updated <TimeAgo at={economics.meta?.generated_at ?? null} />
            </span>
            <h1>Bittensor, measured.</h1>
            <p className="mg-landing-lede">
              Every subnet, validator and account on one chain-direct index — the numbers, where
              they came from, and the API that serves them.
            </p>
            <SearchBox />
          </header>
        }
      >
        <AnalyticsSection
          id="value"
          name="Value"
          question="How the network's emission is distributed across subnets."
          visual={
            segments.length > 0 ? (
              <CompositionBreakdown
                segments={segments}
                formatValue={(value) => fmtShare(value, 3)}
                legendCols={5}
                ariaLabel="Daily emission share by subnet"
                source="home-subnet"
              />
            ) : null
          }
          legend={
            segments.length > 0 ? (
              <LeaderCards
                items={segments
                  .filter((segment) => Boolean(segment.href))
                  .slice(0, 12)
                  .map((segment) => ({
                    key: segment.key,
                    name: segment.label,
                    sub: `SN${segment.key}`,
                    value: fmtShare(segment.value, 3),
                    href: segment.href!,
                    initials: segment.key,
                  }))}
                featured={3}
                ariaLabel="Subnets by emission share"
                source="home-subnet"
              />
            ) : null
          }
          // Today's composition, not 56 days of it: no route serves a
          // per-subnet daily price or emission series, and assembling one
          // from 129 per-subnet reads would be 129 requests for one chart.
          footnote={`${formatNumber(rows.length)} subnets · ${fmtShare(
            accounted,
            1,
          )} of daily emission accounted for · a snapshot, not a series · chain-direct`}
        />
        <AnalyticsSection
          id="emission"
          name="Emission"
          question="Who earns the daily emission."
          controls={
            <RangeControl
              label="Window"
              options={EMISSION_WINDOWS}
              value={emissionWindow}
              onChange={(next) => setEmissionWindow(next as EmissionWindow)}
            />
          }
          visual={
            rails.length > 0 ? (
              <RankedRails
                items={rails}
                formatValue={(value) => fmtAlpha(value)}
                scale="sqrt"
                columns={{ value: "Emission", name: "Subnet", track: "Share of the top 15" }}
                ariaLabel={`Subnets by emission over ${emissionWindow}`}
                source="home-subnet"
              />
            ) : null
          }
          footnote={`${emissionWindow} · alpha emitted on the last day of the window · chain-direct`}
        />
        <AnalyticsSection
          id="chain"
          name="Chain"
          question="What the chain has been doing."
          controls={
            <RangeControl
              label="Metric"
              options={CHAIN_METRICS}
              value={chainMetric}
              onChange={(next) => setChainMetric(next as ChainMetric)}
            />
          }
          visual={
            points.length > 1 ? (
              <LineWithWindow
                id="home-chain"
                points={points}
                window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
                unit={chainMetric}
                formatValue={(value) => fmtCount(value)}
                ariaLabel={`Daily ${chainMetric}, 30 days`}
                source="home-chain"
              />
            ) : null
          }
          legend={<FactStrip cells={chainCells} />}
          // The newest row is the day in progress -- 1,588 blocks against a
          // full day's 7,200 when read at 05:17 UTC -- and quoting it reads
          // as a collapse in throughput rather than a clock.
          footnote={`30d · the strip reads ${complete?.day ?? "—"}, the last complete day · chain-direct`}
        />
        <AnalyticsSection
          id="health"
          name="Health"
          question="Which subnets' public surfaces are answering."
          visual={
            worst.length > 0 ? (
              <MarkerRail
                items={worst}
                max={100}
                formatValue={(value) => `${formatDecimal(value, 1)}%`}
                columns={{ ratio: "Uptime", name: "Subnet", scale: "0–100%" }}
                ariaLabel="The ten lowest subnet uptimes over 7 days"
                source="home-subnet"
              />
            ) : null
          }
          legend={<FactStrip cells={healthCells} />}
          footnote="7d · the ten LOWEST, because those are the ones worth acting on · live prober"
        />
        <AnalyticsSection
          id="agents"
          name="Agents"
          question="Point any agent at this registry."
          controls={
            <RangeControl
              label="Client"
              options={AGENT_SNIPPETS.map((snippet) => ({
                value: snippet.value,
                label: snippet.label,
              }))}
              value={agent}
              onChange={(next) => setAgent(next as typeof agent)}
            />
          }
          visual={
            <CopyableCode
              label={AGENT_SNIPPETS.find((snippet) => snippet.value === agent)!.label}
              value={AGENT_SNIPPETS.find((snippet) => snippet.value === agent)!.code}
            />
          }
          legend={<FactStrip cells={agentCells} />}
          footnote="/mcp/core lists 23 tools at a ninth of the tokens and can still call all 243"
        />
      </AnalyticsPage>
    </AppShell>
  );
}
