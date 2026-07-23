import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Scale, Coins, Timer } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { ShareButton, DownloadCsvButton, ActionBar, StatTile } from "@jsonbored/ui-kit";
import { PageMasthead, TableSkeleton } from "@/components/metagraphed/primitives";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { CallModuleExtrinsicsTable } from "@/components/metagraphed/call-module-extrinsics-table";
import { governanceConfigChangesQuery, networkParametersQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";

const adminChangesSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export const Route = createFileRoute("/admin-changes/")({
  validateSearch: zodValidator(adminChangesSearchSchema),
  head: () => ({
    meta: [
      { title: "Admin changes — Metagraphed" },
      {
        name: "description",
        content:
          "AdminUtils root-origin config changes — subtensor's hyperparameter and network-config admin pathway, newest first.",
      },
      { property: "og:title", content: "Admin changes — Metagraphed" },
      {
        property: "og:description",
        content:
          "AdminUtils root-origin config changes — subtensor's hyperparameter and network-config admin pathway, newest first.",
      },
    ],
  }),
  component: AdminChangesPage,
});

type AdminChangesSearch = z.infer<typeof adminChangesSearchSchema>;

function adminChangesQueryParams(search: AdminChangesSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {
    limit: search.limit,
    offset: search.offset,
  };
  if (search.call_function) queryParams.call_function = search.call_function;
  if (search.success) queryParams.success = search.success;
  return queryParams;
}

function AdminChangesPage() {
  const search = Route.useSearch();
  const adminChangesCsvUrl = buildUrl(
    "/api/v1/governance/config-changes",
    adminChangesQueryParams(search),
  );

  return (
    <AppShell>
      <PageMasthead
        eyebrow="Explorer"
        live
        title="Admin changes"
        description="AdminUtils root-origin config changes — subtensor's own admin pallet for subnet hyperparameters and network-wide config, newest first."
        actions={
          <>
            <ActionBar>
              <DownloadCsvButton url={adminChangesCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      {/* #6997: the change-log below is a history of governance config-change
          events -- it never showed the *current* live values of the three
          key protocol/governance parameters those changes actually move.
          Own QueryErrorBoundary/Suspense so a slow/failed RPC read never
          blocks the (unrelated, artifact-backed) change-log table below. */}
      <QueryErrorBoundary>
        <Suspense
          fallback={
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          }
        >
          <NetworkParametersCard />
        </Suspense>
      </QueryErrorBoundary>
      <div className="min-w-0">
        <QueryErrorBoundary>
          <Suspense fallback={<TableSkeleton rows={10} columns={6} />}>
            <AdminChangesTable />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter
        paths={["/api/v1/governance/config-changes", "/api/v1/network/parameters"]}
        artifacts={["/metagraph/governance/config-changes.json"]}
      />
    </AppShell>
  );
}

// #6997: current values of the three global Subtensor protocol/governance
// parameters the change-log table below is a *history* of. Each field is
// independently null on its own RPC failure (never coerced to 0), so
// StatTile's own "—" empty-value rendering is what a viewer sees on a
// per-field failure -- distinct from a real zero (e.g. tao_weight at 0%).
function NetworkParametersCard() {
  const { data: res } = useSuspenseQuery(networkParametersQuery());
  const p = res.data;
  const taoWeightPct = p.tao_weight != null ? `${(p.tao_weight * 100).toFixed(2)}%` : "—";

  return (
    <div className="mb-6">
      <div className="mg-type-micro mb-2 text-[10px] text-ink-muted">
        Current network parameters
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile
          icon={Scale}
          eyebrow="TaoWeight"
          value={taoWeightPct}
          hint="root-weight ratio in consensus"
        />
        <StatTile
          icon={Coins}
          eyebrow="StakeThreshold"
          value={formatTao(p.stake_threshold_tao)}
          hint="min stake to register a hotkey"
        />
        <StatTile
          icon={Timer}
          eyebrow="PendingChildKeyCooldown"
          value={formatNumber(p.pending_childkey_cooldown_blocks)}
          hint="blocks before a pending child key activates"
        />
      </div>
    </div>
  );
}

function AdminChangesTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryParams = adminChangesQueryParams(search);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  return (
    <CallModuleExtrinsicsTable
      queryOptions={governanceConfigChangesQuery(queryParams)}
      search={{
        limit: search.limit,
        offset: search.offset,
        call_function: search.call_function,
        success: search.success,
      }}
      setSearch={setSearch}
      emptyTitle="No admin config changes indexed yet"
      emptyDescription="AdminUtils calls set subnet hyperparameters and network config — check back shortly, or open the API directly."
      emptyApiPath={`${API_BASE}/api/v1/governance/config-changes`}
    />
  );
}
