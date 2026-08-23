import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { DataTable, TimeAgo } from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { NetworkParametersPanel } from "@/components/metagraphed/network-parameters-panel";
import { orderRuntimeUpgradesNewestFirst } from "@/components/metagraphed/runtime-upgrade-card-list";
import { networkParametersQuery, runtimeVersionHistoryQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { RuntimeVersionHistory } from "@/lib/metagraphed/types";

export function RuntimePage() {
  return (
    <>
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
      <DataTable
        rows={rows}
        rowKey={(row) => `${row.spec_version}-${row.block_number}`}
        caption="Runtime upgrades"
        source="runtime-upgrades"
        link={RouterLink}
        empty={
          <EmptyState
            title="No runtime upgrades observed yet"
            description="This tracks forward from when spec_version capture began — an upgrade before that point won't appear here."
            lastChecked={history.coverage_from_at ?? undefined}
          />
        }
        columns={[
          {
            key: "spec_version",
            label: "Spec Version",
            kind: "number",
            sortable: true,
            value: (row) => row.spec_version ?? null,
            format: (value) => formatNumber(typeof value === "number" ? value : null),
          },
          {
            key: "block_number",
            label: "Block",
            kind: "link",
            sortable: true,
            align: "right",
            value: (row) => row.block_number ?? null,
            format: (value) => (typeof value === "number" ? `#${formatNumber(value)}` : "—"),
            href: (row) => (row.block_number != null ? `/blocks/${row.block_number}` : undefined),
          },
          {
            key: "observed_at",
            label: "Observed",
            kind: "time",
            sortable: true,
            value: (row) => row.observed_at ?? null,
          },
        ]}
      />
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
    <Panel flush>
      <div className="px-4 py-3">
        <div className="text-13 text-ink-muted">{label}</div>
        <div className="mt-1 font-mono text-16 text-ink-strong tabular-nums">{value}</div>
        {hint ? <div className="mt-0.5 text-13 text-ink-muted">{hint}</div> : null}
      </div>
    </Panel>
  );
}
