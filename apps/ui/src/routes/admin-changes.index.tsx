import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { PageHero, ShareButton, DownloadCsvButton } from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { CallModuleExtrinsicsTable } from "@/components/metagraphed/call-module-extrinsics-table";
import { governanceConfigChangesQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { API_BASE } from "@/lib/metagraphed/config";

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
      <PageHero
        eyebrow="Explorer"
        live
        title="Admin changes"
        description="AdminUtils root-origin config changes — subtensor's own admin pallet for subnet hyperparameters and network-wide config, newest first."
        actions={
          <>
            <DownloadCsvButton url={adminChangesCsvUrl} />
            <ShareButton />
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <AdminChangesTable />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={["/api/v1/governance/config-changes"]}
        artifacts={["/metagraph/governance/config-changes.json"]}
      />
    </AppShell>
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
