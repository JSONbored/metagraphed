import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { ShareButton, DownloadCsvButton, ActionBar, TableState, TimeAgo } from "@jsonbored/ui-kit";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import {
  RuntimeUpgradeCardList,
  orderRuntimeUpgradesNewestFirst,
} from "@/components/metagraphed/runtime-upgrade-card-list";
import { NetworkParametersPanel } from "@/components/metagraphed/network-parameters-panel";
import { runtimeVersionHistoryQuery, networkParametersQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { formatNumber } from "@/lib/metagraphed/format";
import type { RuntimeVersionHistory } from "@/lib/metagraphed/types";
import { ChainTabActions } from "./-chain-hub";

export function RuntimePage() {
  const runtimeCsvUrl = buildUrl("/api/v1/runtime", { format: "csv" });
  return (
    <>
      <ChainTabActions>
        <ActionBar>
          {/* /api/v1/runtime is a single whole-window aggregate with no
              filters to carry, so the export needs no query params beyond
              format -- unlike the filtered feeds' <page>QueryParams(search). */}
          <DownloadCsvButton url={runtimeCsvUrl} bare />
          <ShareButton bare />
        </ActionBar>
      </ChainTabActions>
      <AsyncPanel
        context="network parameters"
        height="sm"
        retryQueryKeys={[networkParametersQuery().queryKey]}
      >
        <NetworkParametersPanel />
      </AsyncPanel>
      <AsyncPanel
        context="runtime upgrades"
        fallback={<Skeleton className="h-96 w-full" />}
        retryQueryKeys={[runtimeVersionHistoryQuery().queryKey]}
      >
        <RuntimeContent />
      </AsyncPanel>
      <ApiSourceFooter
        paths={["/api/v1/runtime", "/api/v1/network/parameters"]}
        artifacts={["/metagraph/runtime.json"]}
      />
    </>
  );
}

function RuntimeContent() {
  const { data: res } = useSuspenseQuery(runtimeVersionHistoryQuery());
  const history = res.data;
  const rows = orderRuntimeUpgradesNewestFirst(history.transitions);

  return (
    <>
      <PageHeroKpis history={history} />
      {rows.length === 0 ? (
        <TableState
          variant="empty"
          title="No runtime upgrades observed yet"
          description="This tracks forward from when spec_version capture began — an upgrade before that point won't appear here."
          generatedAt={history.coverage_from_at ?? undefined}
        />
      ) : (
        <>
          <Panel as="div" flush className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="mg-type-micro bg-surface/50 text-[10px] text-ink-muted">
                  <tr>
                    <th className="mg-type-micro px-3 py-2.5 text-left text-[10px]">
                      Spec Version
                    </th>
                    <th className="mg-type-micro px-3 py-2.5 text-left text-[10px]">Block</th>
                    <th className="mg-type-micro px-3 py-2.5 text-left text-[10px]">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={`${row.spec_version}-${row.block_number}`}
                      className="mg-row-hover border-t border-border/60"
                    >
                      <td className="px-3 py-2.5 font-mono mg-type-caption tabular-nums text-ink-strong">
                        {formatNumber(row.spec_version)}
                      </td>
                      <td className="px-3 py-2.5 font-mono mg-type-caption tabular-nums">
                        {row.block_number != null ? (
                          <Link
                            to="/blocks/$ref"
                            params={{ ref: String(row.block_number) }}
                            className="text-ink hover:underline"
                          >
                            #{formatNumber(row.block_number)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono mg-type-caption text-ink-muted">
                        {row.observed_at ? <TimeAgo at={row.observed_at} /> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <RuntimeUpgradeCardList rows={rows} className="grid gap-3 sm:grid-cols-2 md:hidden" />
        </>
      )}
    </>
  );
}

function PageHeroKpis({ history }: { history: RuntimeVersionHistory }) {
  return (
    <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
      <KpiTile label="Current spec version" value={formatNumber(history.current_spec_version)} />
      <KpiTile label="Transitions tracked" value={formatNumber(history.transition_count)} />
      <KpiTile
        label="Coverage from"
        value={
          history.coverage_from_block != null ? (
            <Link
              to="/blocks/$ref"
              params={{ ref: String(history.coverage_from_block) }}
              className="hover:underline"
            >
              #{formatNumber(history.coverage_from_block)}
            </Link>
          ) : (
            "—"
          )
        }
        hint={history.coverage_from_at ? <TimeAgo at={history.coverage_from_at} /> : undefined}
      />
    </div>
  );
}

function KpiTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Panel as="div" flush>
      <div className="px-4 py-3">
        <div className="mg-type-caption text-[10px] text-ink-muted">{label}</div>
        <div className="mt-1 font-mono text-lg text-ink-strong tabular-nums">{value}</div>
        {hint ? <div className="mt-0.5 text-xs text-ink-muted">{hint}</div> : null}
      </div>
    </Panel>
  );
}
