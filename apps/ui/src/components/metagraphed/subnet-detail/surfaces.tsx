import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, MarkerRail, type DataTableColumn } from "@jsonbored/ui-kit";
import { subnetSurfacesQuery, subnetUptimeQuery } from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
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
  const surfaces = useQuery({ ...subnetSurfacesQuery(netuid), retry: 0 });
  const uptime = useQuery({ ...subnetUptimeQuery(netuid, "90d"), retry: 0 });

  const rows = surfaces.data?.data ?? [];
  const byId = uptimeBySurface(uptime.data?.data.surfaces ?? []);
  const rail = surfaceRail(rows, byId, name);
  const measured = rail.filter((row) => row.value !== null).length;
  const tableRows = rows.map((row: Surface) => ({
    ...row,
    uptime: row.id ? (byId.get(row.id) ?? null) : null,
  }));

  return (
    <AnalyticsSection
      id="surfaces"
      name="Surfaces"
      question="What this subnet publishes and whether it is up."
      visual={
        rail.length > 0 ? (
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
        rows.length > 12 && !expanded ? (
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
