import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { ShareButton, DownloadCsvButton, ActionBar, CopyButton, TimeAgo } from "@jsonbored/ui-kit";
import { AsyncPanel, PageMasthead } from "@/components/metagraphed/primitives";
import { CallModuleExtrinsicsTable } from "@/components/metagraphed/call-module-extrinsics-table";
import { sudoCallsQuery, sudoKeyQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { API_BASE } from "@/lib/metagraphed/config";
import { shortHash } from "@/lib/metagraphed/blocks";

const sudoSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export const Route = createFileRoute("/sudo/")({
  validateSearch: zodValidator(sudoSearchSchema),
  head: () => ({
    meta: [
      { title: "Sudo — Metagraphed" },
      {
        name: "description",
        content:
          "Root-origin (Sudo) calls on the Bittensor chain and the account currently holding the Sudo key.",
      },
      { property: "og:title", content: "Sudo — Metagraphed" },
      {
        property: "og:description",
        content:
          "Root-origin (Sudo) calls on the Bittensor chain and the account currently holding the Sudo key.",
      },
    ],
  }),
  component: SudoPage,
});

type SudoSearch = z.infer<typeof sudoSearchSchema>;

function sudoQueryParams(search: SudoSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {
    limit: search.limit,
    offset: search.offset,
  };
  if (search.call_function) queryParams.call_function = search.call_function;
  if (search.success) queryParams.success = search.success;
  return queryParams;
}

function SudoPage() {
  const search = Route.useSearch();
  const sudoCsvUrl = buildUrl("/api/v1/sudo", sudoQueryParams(search));

  // Live-RPC lookup, fetched non-blocking so a slow/failed RPC never stalls
  // or errors the table below (mirrors accounts.$ss58.tsx's balance fetch).
  const keyResult = useQuery(sudoKeyQuery());
  const hotkey = keyResult.data?.data.hotkey;
  const queriedAt = keyResult.data?.data.queried_at;

  const keyValue = keyResult.isPending ? (
    <span className="text-ink-muted">…</span>
  ) : hotkey ? (
    <span className="inline-flex items-center gap-1.5">
      {shortHash(hotkey, 8)}
      <CopyButton value={hotkey} label="sudo key" />
    </span>
  ) : (
    <span>Unset</span>
  );

  return (
    <AppShell>
      <PageMasthead
        eyebrow="Explorer"
        live
        title="Sudo"
        description="Root-origin (Sudo) calls on the Bittensor chain — subtensor has no Council or Senate, so Sudo is the whole root-origin surface, plus the account currently holding the Sudo key."
        actions={
          <>
            <ActionBar>
              <DownloadCsvButton url={sudoCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
        kpis={[
          {
            label: "Current Sudo key",
            value: keyValue,
            hint: queriedAt ? (
              <>
                queried <TimeAgo at={queriedAt} />
              </>
            ) : undefined,
          },
        ]}
      />
      <div className="min-w-0">
        <AsyncPanel context="sudo calls" fallback={<Skeleton className="h-96 w-full" />}>
          <SudoTable />
        </AsyncPanel>
      </div>
      <ApiSourceFooter
        paths={["/api/v1/sudo", "/api/v1/sudo/key"]}
        artifacts={["/metagraph/sudo.json"]}
      />
    </AppShell>
  );
}

function SudoTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryParams = sudoQueryParams(search);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  return (
    <CallModuleExtrinsicsTable
      queryOptions={sudoCallsQuery(queryParams)}
      search={{
        limit: search.limit,
        offset: search.offset,
        call_function: search.call_function,
        success: search.success,
      }}
      setSearch={setSearch}
      emptyTitle="No Sudo calls indexed yet"
      emptyDescription="Root-origin calls are rare (zero in a typical two-week window) — check back later, or open the API directly."
      emptyApiPath={`${API_BASE}/api/v1/sudo`}
    />
  );
}
