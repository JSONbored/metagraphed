import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { PageHero, ShareButton, ActionBar, TableState, TimeAgo } from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  RuntimeUpgradeCardList,
  orderRuntimeUpgradesNewestFirst,
} from "@/components/metagraphed/runtime-upgrade-card-list";
import { runtimeVersionHistoryQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { RuntimeVersionHistory } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/runtime/")({
  head: () => ({
    meta: [
      { title: "Runtime — Metagraphed" },
      {
        name: "description",
        content:
          "Spec-version upgrade history for the Bittensor chain — every runtime upgrade observed, newest first.",
      },
      { property: "og:title", content: "Runtime — Metagraphed" },
      {
        property: "og:description",
        content:
          "Spec-version upgrade history for the Bittensor chain — every runtime upgrade observed, newest first.",
      },
    ],
  }),
  component: RuntimePage,
});

function RuntimePage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Runtime"
        description="Spec-version upgrade history for the Bittensor chain, tracked from the first-party blocks tier — every observed runtime upgrade, newest first."
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <RuntimeContent />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/runtime"]} artifacts={["/metagraph/runtime.json"]} />
    </AppShell>
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
          <div className="hidden md:block rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                    Spec Version
                  </th>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                    Block
                  </th>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                    Observed
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.spec_version}-${row.block_number}`}
                    className="mg-row-hover border-t border-border/60"
                  >
                    <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink-strong">
                      {formatNumber(row.spec_version)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums">
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
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-muted">
                      {row.observed_at ? <TimeAgo at={row.observed_at} /> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <RuntimeUpgradeCardList
            rows={rows}
            className="grid gap-3 sm:grid-cols-2 md:hidden"
          />
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
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className="mt-1 font-mono text-lg text-ink-strong tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-ink-muted">{hint}</div> : null}
    </div>
  );
}
