import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Skeleton } from "@jsonbored/ui-kit";
import type { AnalyticsSearch } from "./chain.analytics";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainStakeFlowSankey } from "@/components/metagraphed/chain-stake-flow-sankey";
import { ChainConcentrationSnapshot } from "@/components/metagraphed/chain-concentration-snapshot";
import { ChainIdleStakeSnapshot } from "@/components/metagraphed/chain-idle-stake-snapshot";
import { ChainEmissionTrend } from "@/components/metagraphed/chain-emission-trend";
import { ChainRegistrationEconomics } from "@/components/metagraphed/chain-registration-economics";
import { ChainNetworkConcentration } from "@/components/metagraphed/chain-network-concentration";
import { classNames } from "@/lib/metagraphed/format";
import {
  chainStakeFlowQuery,
  validatorsQuery,
  chainConcentrationQuery,
  chainIdleStakeQuery,
  economicsTrendsQuery,
  economicsQuery,
} from "@/lib/metagraphed/queries";

type Window = "7d" | "30d";
const WINDOWS: Window[] = ["7d", "30d"];

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
      <DataModule
        id="analytics-registration"
        title="Registration economics"
        caption="The spread of current cost to open a subnet, from the least to the most expensive."
      >
        <ChainRegistrationEconomics subnets={economicsRes.data} />
      </DataModule>
    </div>
  );
}

export function ChainAnalyticsPage() {
  const search = useSearch({ from: "/chain/analytics" }) as AnalyticsSearch;
  const navigate = useNavigate({ from: "/chain/analytics" });

  return (
    <div className="mg-data-stage">
      <section className="mg-data-hero" aria-labelledby="network-data-title">
        <div className="mg-data-hero-field" aria-hidden="true" />
        <div className="mg-data-hero-content">
          <div>
            <span className="mg-data-kicker">
              <span className="mg-data-kicker-dot" aria-hidden="true" />
              live chain data
            </span>
            <h1 id="network-data-title">Network Data.</h1>
          </div>
          <div className="mg-data-hero-detail">
            <p>
              Follow where stake moves, where alpha concentrates, and what it costs to enter — one
              clean question at a time.
            </p>
            <div role="tablist" aria-label="Analytics time window" className="mg-data-window">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  role="tab"
                  aria-selected={w === search.window}
                  onClick={() =>
                    navigate({
                      search: (prev: Record<string, unknown>) => ({ ...prev, window: w }),
                      resetScroll: false,
                    })
                  }
                  className={classNames(
                    "mg-data-window-button mg-focus-ring",
                    w === search.window && "is-active",
                  )}
                >
                  {w === "7d" ? "7 days" : "30 days"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="mg-data-canvas">
        <AsyncPanel context="chain analytics" fallback={<AnalyticsSkeleton />}>
          <AnalyticsBody />
        </AsyncPanel>

        {/* #10300: these network-wide surfaces fetch independently from the
            six-request core above, so a slow concentration query never holds
            back the movement view. They share the same data canvas rather than
            becoming a second wall of dashboard cards. */}
        <ChainNetworkConcentration />
      </div>

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
    </div>
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

function DataModule({
  id,
  title,
  caption,
  children,
}: {
  id?: string;
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mg-data-module">
      <header className="mg-data-module-heading">
        <h2 className="mg-data-module-title">
          <strong>{title}.</strong>
          <span>{caption}</span>
        </h2>
      </header>
      <div className="mg-data-module-body">{children}</div>
    </section>
  );
}
