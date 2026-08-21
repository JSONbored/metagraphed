import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQueries } from "@tanstack/react-query";
import { Skeleton } from "@jsonbored/ui-kit";
import type { AnalyticsSearch } from "./chain.analytics";
import {
  AsyncPanel,
  DataPageCanvas,
  DataPageHero,
  DataPageModule,
  DataPageStage,
  DataPageWindowTabs,
} from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainStakeFlowSankey } from "@/components/metagraphed/chain-stake-flow-sankey";
import { ChainConcentrationSnapshot } from "@/components/metagraphed/chain-concentration-snapshot";
import { ChainIdleStakeSnapshot } from "@/components/metagraphed/chain-idle-stake-snapshot";
import { ChainEmissionTrend } from "@/components/metagraphed/chain-emission-trend";
import { ChainRegistrationEconomics } from "@/components/metagraphed/chain-registration-economics";
import { ChainNetworkConcentration } from "@/components/metagraphed/chain-network-concentration";
import {
  chainStakeFlowQuery,
  validatorsQuery,
  chainConcentrationQuery,
  chainIdleStakeQuery,
  economicsTrendsQuery,
  economicsQuery,
} from "@/lib/metagraphed/queries";

const WINDOW_OPTIONS = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;

/**
 * This route intentionally holds the core view to six requests: root →
 * subnet uses real windowed movement while subnet → validator uses current
 * holdings from the global leaderboard. The visual hierarchy makes that
 * distinction clear rather than pretending both hops are the same measure.
 */
function AnalyticsBody() {
  const search = useSearch({ from: "/chain/analytics" }) as AnalyticsSearch;
  const win = search.window;

  const [
    { data: stakeFlowRes },
    { data: validatorsRes },
    { data: concentrationRes },
    { data: idleStakeRes },
    { data: trendsRes },
    { data: economicsRes },
  ] = useSuspenseQueries({
    queries: [
      chainStakeFlowQuery(win),
      validatorsQuery({ sort: "total_stake", limit: 20 }),
      chainConcentrationQuery(),
      chainIdleStakeQuery(),
      economicsTrendsQuery(win),
      economicsQuery(),
    ],
  });

  return (
    <div className="contents">
      <ChainStakeFlowSankey
        stakeFlow={stakeFlowRes.data}
        validators={validatorsRes.data}
        window={win}
      />
      <ChainIdleStakeSnapshot idleStake={idleStakeRes.data} />
      <ChainEmissionTrend days={trendsRes.data.days} window={win} />
      <ChainConcentrationSnapshot concentration={concentrationRes.data} />
      <DataPageModule
        id="analytics-registration"
        title="Registration economics"
        caption="The spread of current cost to open a subnet, from the least to the most expensive."
        kind="question"
      >
        <ChainRegistrationEconomics subnets={economicsRes.data} />
      </DataPageModule>
    </div>
  );
}

export function ChainAnalyticsPage() {
  const search = useSearch({ from: "/chain/analytics" }) as AnalyticsSearch;
  const navigate = useNavigate({ from: "/chain/analytics" });

  return (
    <DataPageStage>
      <DataPageHero
        id="network-data-title"
        variant="analytics"
        eyebrow="live chain data"
        live
        title="Network Data."
        description="Follow where stake moves, where alpha concentrates, and what it costs to enter — one clean question at a time."
        actions={
          <DataPageWindowTabs
            label="Analytics time window"
            options={WINDOW_OPTIONS}
            value={search.window}
            onValueChange={(window) =>
              navigate({
                search: (prev: Record<string, unknown>) => ({ ...prev, window }),
                resetScroll: false,
              })
            }
          />
        }
      />

      <DataPageCanvas>
        <AsyncPanel context="chain analytics" fallback={<AnalyticsSkeleton />}>
          <AnalyticsBody />
        </AsyncPanel>

        {/* #10300: these network-wide surfaces fetch independently from the
            six-request core above, so a slow concentration query never holds
            back the movement view. They share the same data canvas rather than
            becoming a second wall of dashboard cards. */}
        <ChainNetworkConcentration />
      </DataPageCanvas>

      <ApiSourceFooter
        paths={[
          "/api/v1/chain/stake-flow",
          "/api/v1/validators",
          "/api/v1/chain/concentration",
          "/api/v1/chain/idle-stake",
          "/api/v1/economics/trends",
          "/api/v1/economics",
          "/api/v1/chain/burn",
          "/api/v1/chain/holders",
          "/api/v1/chain/concentration/subnets",
          "/api/v1/chain/concentration/history",
        ]}
      />
    </DataPageStage>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="mg-data-loading" aria-label="Loading chain analytics">
      <Skeleton className="h-[30rem] w-full" />
      <Skeleton className="mt-6 h-56 w-full" />
      <Skeleton className="mt-6 h-48 w-full" />
    </div>
  );
}
