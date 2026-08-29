import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, MarkerRail, type DataTableColumn } from "@jsonbored/ui-kit";
import { subnetSurfacesQuery, subnetUptimeQuery } from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ErrorState } from "@/components/metagraphed/states";
import type { Surface } from "@/lib/metagraphed/types";
import { surfaceRail, uptimeBySurface } from "./subnet-detail-logic";

const COLUMNS: DataTableColumn<Surface & { uptime: number | null }>[] = [
  { key: "kind", label: "Kind", kind: "text", value: (row) => row.kind ?? "—" },
  { key: "name", label: "Surface", kind: "text", value: (row) => row.name ?? row.kind ?? "—" },
  {
    key: "url",
    label: "URL",
    kind: "link",
    value: (row) => row.url ?? "",
    href: (row) => row.url ?? undefined,
  },
  {
    key: "uptime",
    label: "Uptime 90d",
    kind: "number",
    value: (row) => row.uptime,
    format: (v) => (typeof v === "number" ? `${formatDecimal(v, 1)}%` : "—"),
    definition: "Uptime",
  },
  {
    key: "authority",
    label: "Authority",
    kind: "text",
    value: (row) => row.authority ?? "—",
    demote: true,
  },
  {
    key: "provider",
    label: "Provider",
    kind: "text",
    value: (row) => row.provider ?? "—",
    demote: true,
  },
];

/**
 * Section 4 — what the subnet publishes, and whether it answers.
 *
 * A rail rather than a table, because the reading is comparative: one
 * surface at 62% next to five at 100% is the whole finding, and a column of
 * percentages makes you compute it yourself.
 */
export function SurfacesSection({ netuid, name }: { netuid: number; name?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { ref, nearViewport } = useNearViewport();
  const surfaces = useQuery({
    ...subnetSurfacesQuery(netuid),
    enabled: nearViewport,
    retry: 0,
  });
  const uptime = useQuery({
    ...subnetUptimeQuery(netuid, "90d"),
    enabled: nearViewport,
    retry: 0,
  });
  const hydrated = useHydrated();

  const rows = surfaces.data?.data ?? [];
  const byId = uptimeBySurface(uptime.data?.data.surfaces ?? []);
  const rail = surfaceRail(rows, byId, name);
  const measured = rail.filter((row) => row.value !== null).length;
  const isPending = surfaces.isPending || uptime.isPending;
  const loading = nearViewport && (!hydrated || isPending);
  const showLoading = nearViewport && hydrated && isPending;
  const tableRows = rows.map((row: Surface) => ({
    ...row,
    uptime: row.id ? (byId.get(row.id) ?? null) : null,
  }));

  return (
    <AnalyticsSection
      id="surfaces"
      name="Surfaces"
      question="What this subnet publishes and whether it is up."
      visualRef={ref}
      visual={
        !nearViewport || showLoading ? (
          <MarkerRail
            max={100}
            formatValue={(v) => `${formatDecimal(v, 1)}%`}
            columns={{ ratio: "Uptime", name: "Surface", scale: "0–100%" }}
            ariaLabel={`Subnet ${netuid} surface uptime over 90 days`}
            source={`sn-${netuid}-surface`}
            loading
            loadingRows={8}
          />
        ) : surfaces.isError ? (
          <ErrorState
            error={surfaces.error}
            onRetry={() => void surfaces.refetch()}
            context="published subnet surfaces"
          />
        ) : uptime.isError ? (
          <div className="flex flex-col gap-3">
            {rail.length > 0 ? (
              <MarkerRail
                items={rail.slice(0, 12)}
                max={100}
                formatValue={(v) => `${formatDecimal(v, 1)}%`}
                columns={{ ratio: "Uptime", name: "Surface", scale: "0–100%" }}
                ariaLabel={`Subnet ${netuid} published surfaces`}
                source={`sn-${netuid}-surface`}
              />
            ) : null}
            <ErrorState
              error={uptime.error}
              onRetry={() => void uptime.refetch()}
              context="90-day surface uptime"
            />
          </div>
        ) : rail.length > 0 ? (
          <MarkerRail
            items={rail.slice(0, 12)}
            max={100}
            formatValue={(v) => `${formatDecimal(v, 1)}%`}
            columns={{ ratio: "Uptime", name: "Surface", scale: "0–100%" }}
            ariaLabel={`Subnet ${netuid} surface uptime over 90 days`}
            source={`sn-${netuid}-surface`}
          />
        ) : null
      }
      footnote={
        !nearViewport ? (
          "published surfaces · 90d probe uptime · registry"
        ) : loading ? (
          "Loading surfaces and 90d uptime · registry"
        ) : surfaces.isError ? (
          "registry · retry the affected record above"
        ) : uptime.isError ? (
          `${formatNumber(rows.length)} published surfaces · retry the affected record above`
        ) : rows.length > 12 && !expanded ? (
          <button type="button" className="mg-section-more" onClick={() => setExpanded(true)}>
            Show all {formatNumber(rows.length)} surfaces
          </button>
        ) : (
          `90d · ${formatNumber(measured)} of ${formatNumber(rows.length)} probed`
        )
      }
    >
      {expanded ? (
        <DataTable
          rows={tableRows}
          columns={COLUMNS}
          rowKey={(row) => row.id ?? row.url ?? row.name ?? ""}
          caption={`Subnet ${netuid} surfaces`}
          source={`sn-${netuid}-surface`}
          loading={surfaces.isPending}
          pageSize={25}
          storageKey="subnet-surfaces-columns"
          mobile="cards"
        />
      ) : null}
    </AnalyticsSection>
  );
}
