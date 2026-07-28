import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQueries } from "@tanstack/react-query";
import { SectionLabel, Skeleton } from "@jsonbored/ui-kit";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ChainTabActions } from "./-chain-hub";
import { ChainStakeFlowSankey } from "@/components/metagraphed/chain-stake-flow-sankey";
import { ChainConcentrationSnapshot } from "@/components/metagraphed/chain-concentration-snapshot";
import { ChainIdleStakeSnapshot } from "@/components/metagraphed/chain-idle-stake-snapshot";
import { ChainEmissionTrend } from "@/components/metagraphed/chain-emission-trend";
import { ChainRegistrationEconomics } from "@/components/metagraphed/chain-registration-economics";
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
 * Chain hub Analytics tab (#8378). Own route (`/chain/analytics`), not a
 * client-side sub-tab — the hub's tabs are each a real router match, which
 * is what makes "only fetch when this tab is activated" free: the six
 * queries below only run once this route mounts.
 *
 * Deliberately six requests, not the sankey's full theoretical data need:
 * root->subnet uses windowed stake-flow (real flow); subnet->validator uses
 * the global validator leaderboard's CURRENT per-subnet stake (no endpoint
 * gives windowed flow at validator granularity — see chain-analytics.ts).
 * Two deliverables from the issue are scoped out rather than faked: bulk
 * "recycled totals" and a true registration-count trend have no bulk/
 * chain-level source in the current API without exceeding the 6-request
 * budget (either needs ~129 per-subnet calls). Posted as a scope note on
 * #8378 alongside the PR.
 */
function AnalyticsBody() {
  const search = useSearch({ from: "/chain/analytics" });
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
    <>
      <ChainStakeFlowSankey
        stakeFlow={stakeFlowRes.data}
        validators={validatorsRes.data}
        window={win}
      />

      <div id="analytics-trends" className="mt-6">
        <SectionLabel as="h2">Trends</SectionLabel>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChainConcentrationSnapshot concentration={concentrationRes.data} />
          <ChainIdleStakeSnapshot idleStake={idleStakeRes.data} />
          <ChainEmissionTrend days={trendsRes.data.days} window={win} />
        </div>
      </div>

      <div id="analytics-registration" className="mt-6">
        <SectionLabel as="h2">Registration economics</SectionLabel>
        <div className="mt-3">
          <ChainRegistrationEconomics subnets={economicsRes.data} />
        </div>
      </div>
    </>
  );
}

export function ChainAnalyticsPage() {
  const search = useSearch({ from: "/chain/analytics" });
  const navigate = useNavigate({ from: "/chain/analytics" });

  return (
    <>
      <ChainTabActions>
        <div
          role="tablist"
          aria-label="Window"
          className="mr-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface p-0.5"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={w === search.window}
              onClick={() =>
                navigate({
                  search: (prev: Record<string, unknown>) => ({ ...prev, window: w }) as never,
                  resetScroll: false,
                })
              }
              className={classNames(
                "rounded px-2.5 py-1 mg-type-caption font-medium transition-colors mg-focus-ring",
                w === search.window
                  ? "bg-card text-ink-strong"
                  : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </ChainTabActions>

      <p className="mb-6 max-w-3xl mg-type-caption-lg text-ink-muted">
        Stake flow, concentration, idle stake, and registration economics — the questions analysts
        currently script against the API, in one view.
      </p>

      <AsyncPanel context="chain analytics" fallback={<AnalyticsSkeleton />}>
        <AnalyticsBody />
      </AsyncPanel>

      <ApiSourceFooter
        paths={[
          "/api/v1/chain/stake-flow",
          "/api/v1/validators",
          "/api/v1/chain/concentration",
          "/api/v1/chain/idle-stake",
          "/api/v1/economics/trends",
          "/api/v1/economics",
        ]}
      />
    </>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-80 w-full" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    </div>
  );
}
