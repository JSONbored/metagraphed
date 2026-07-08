import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { chainWeightsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, classNames } from "@/lib/metagraphed/format";

export const Route = createFileRoute("/leaderboards")({
  head: () => ({
    meta: [
      { title: "Leaderboards — Metagraphed" },
      {
        name: "description",
        content: "Network-wide activity leaderboards computed live from chain-indexed events.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
      {
        property: "og:description",
        content: "Network-wide activity leaderboards computed live from chain-indexed events.",
      },
    ],
  }),
  component: LeaderboardsPage,
});

function LeaderboardsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Network"
        live
        title="Leaderboards"
        description="Network-wide activity boards computed live from chain-indexed events — ranked by subnet."
      />
      <WeightsLeaderboard />
      <ApiSourceFooter paths={["/api/v1/chain/weights"]} />
    </AppShell>
  );
}

const WINDOWS = ["7d", "30d"] as const;
type Win = (typeof WINDOWS)[number];

// #3469: network-wide weight-setting leaderboard — the per-subnet ranking, network
// rollup, and update-intensity distribution from GET /api/v1/chain/weights. First
// section on the new /leaderboards route; siblings (#3465, #3466, #3470, #3473)
// extend this same route with their own boards.
function WeightsLeaderboard() {
  const [win, setWin] = useState<Win>("7d");
  const { data: res, isPending, isError, error, refetch } = useQuery(chainWeightsQuery(win));
  const data = res?.data;

  const toggle = (
    <div className="inline-flex rounded-md border border-border bg-surface/40 p-0.5">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => setWin(w)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            w === win ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );

  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold text-ink-strong">
          Weight-setting activity
        </h2>
        {toggle}
      </div>

      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <ErrorState
          error={error}
          context="weight-setting activity"
          onRetry={() => void refetch()}
        />
      ) : !data || data.subnets.length === 0 ? (
        <EmptyState
          title="No weight-setting activity yet"
          description="No WeightsSet events were recorded on chain for this window."
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile
              eyebrow="Distinct setters"
              value={formatNumber(data.network.distinct_setters)}
            />
            <StatTile
              eyebrow="Weight-sets"
              value={formatNumber(data.network.weight_sets)}
              hint={data.window ? `over ${data.window}` : undefined}
            />
            <StatTile
              eyebrow="Sets per setter"
              value={
                data.network.sets_per_setter != null ? data.network.sets_per_setter.toFixed(1) : "—"
              }
            />
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface/50 text-ink-muted">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                      #
                    </th>
                    <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                      Subnet
                    </th>
                    <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                      Distinct setters
                    </th>
                    <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                      Weight-sets
                    </th>
                    <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                      Sets per setter
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.subnets.map((s, i) => (
                    <tr key={s.netuid} className="hover:bg-surface/40">
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">{i + 1}</td>
                      <td className="px-3 py-2.5">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: s.netuid }}
                          className="inline-flex items-center gap-2 hover:underline"
                        >
                          <BrandIcon
                            size={18}
                            name={`Subnet ${s.netuid}`}
                            fallback={s.netuid}
                            netuid={s.netuid}
                          />
                          <span className="font-medium text-ink-strong">SN{s.netuid}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                        {formatNumber(s.distinct_setters)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                        {formatNumber(s.weight_sets)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {s.sets_per_setter != null ? s.sets_per_setter.toFixed(1) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
