import { useMemo, type ReactNode } from "react";
import { AnalyticsSection, BrandIcon, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { SubnetDirectoryControls } from "./directory-controls";
import { RouterLink } from "@/components/metagraphed/router-link";
import { SubnetCompareBar } from "@/components/metagraphed/compare-bar";
import { CompareToggle } from "@/components/metagraphed/compare-toggle";
import { formatDecimal, formatNumber, formatPct } from "@/lib/metagraphed/format";
import { fmtAlpha, type DirectoryRow } from "./subnets-index-logic";

export interface DirectoryFilters {
  domain: string;
  health: string;
  api: boolean;
  q: string;
}

/**
 * Every subnet, sortable, with filter controls available during secondary read failures.
 *
 * `paginate={false}`: this table is the only internal link most subnet pages
 * have, and a crawler does not run our JavaScript, so every row must be in
 * the bytes the server sends (#11204, pinned by crawlable-subnet-index).
 * The viewport still bounds the box, so a reader scrolls a table rather than
 * a document.
 *
 * The price change is the economics snapshot's own 7-day field, not a
 * per-row history fetch. The previous table issued one query PER VISIBLE ROW
 * to compute a sparkline and a percentage -- up to 129 requests to decorate a
 * column -- and the API publishes the number directly.
 */
export function DirectorySection({
  rows,
  total,
  domains,
  filters,
  onFilter,
  unknownApiCount = 0,
  filterState = "ready",
  status,
}: {
  rows: readonly DirectoryRow[];
  total: number;
  domains: readonly string[];
  filters: DirectoryFilters;
  onFilter: (next: Partial<DirectoryFilters>) => void;
  unknownApiCount?: number;
  filterState?: "ready" | "pending" | "unavailable";
  status?: ReactNode;
}) {
  const columns = useMemo<DataTableColumn<DirectoryRow>[]>(
    () => [
      { key: "netuid", label: "UID", kind: "number", value: (row) => row.netuid, sortable: true },
      {
        key: "name",
        label: "Name",
        kind: "text",
        lead: true,
        sortable: true,
        value: (row) => row.name ?? `Subnet ${row.netuid}`,
        render: (row) => (
          <span className="mg-dt-entity">
            <BrandIcon
              size={20}
              // The directory can render every subnet at once. Only use the
              // registry's curated icon here; probing website favicons and
              // repository avatars for every iconless row creates a fan-out
              // of doomed proxy requests before reaching the same monogram.
              // Detail pages keep the richer candidate ladder, where it costs
              // at most one entity-sized fallback chain.
              iconUrl={row.icon_url}
              netuid={row.netuid}
              name={row.name}
              fallback={row.netuid}
              decorative
            />
            <span className="truncate">{row.name ?? `Subnet ${row.netuid}`}</span>
          </span>
        ),
      },
      { key: "domain", label: "Domain", kind: "text", value: (row) => row.domain ?? "—" },
      {
        key: "emission",
        label: "Emission",
        kind: "number",
        sortable: true,
        value: (row) => (row.emission_share == null ? null : row.emission_share * 100),
        format: (value) => (typeof value === "number" ? `${formatDecimal(value, 3)}%` : "—"),
        definition: "Emission share",
      },
      {
        key: "price",
        label: "Price",
        kind: "number",
        sortable: true,
        value: (row) => row.alpha_price_tao ?? null,
        format: (value) => (typeof value === "number" ? `${formatDecimal(value, 4)}τ` : "—"),
      },
      {
        key: "priceChange",
        label: "Δ 7d",
        kind: "delta",
        sortable: true,
        value: (row) => row.alpha_price_change_7d ?? null,
        format: (value) =>
          typeof value === "number" ? `${value >= 0 ? "+" : ""}${formatPct(value, 1)}` : "—",
      },
      { key: "health", label: "Health", kind: "status", value: (row) => row.health ?? "unknown" },
      {
        key: "volume",
        label: "Volume",
        kind: "number",
        demote: true,
        sortable: true,
        value: (row) => row.subnet_volume_tao ?? null,
        format: (value) => (typeof value === "number" ? `${fmtAlpha(value)}τ` : "—"),
      },
      {
        key: "surfaces",
        label: "Surfaces",
        kind: "number",
        demote: true,
        sortable: true,
        value: (row) => row.surfaces_count ?? null,
      },
      {
        key: "readiness",
        label: "Readiness",
        kind: "number",
        demote: true,
        sortable: true,
        value: (row) => row.integration_readiness ?? null,
        format: (value) => (typeof value === "number" ? `${value}/100` : "—"),
      },
      {
        key: "curation",
        label: "Curation",
        kind: "text",
        demote: true,
        value: (row) => row.curation_level ?? "—",
      },
      {
        key: "api",
        label: "API spec",
        kind: "status",
        demote: true,
        value: (row) => row.api_spec ?? "unknown",
      },
      {
        // #11613 rebuilt this table and dropped the compare selection #11611
        // had put here; #11616 restores it as a cell rather than a table mode.
        key: "compare",
        label: "Compare",
        kind: "text",
        value: () => "",
        render: (row) => <CompareToggle netuid={row.netuid} />,
        definition: "Compare",
      },
    ],
    [],
  );

  return (
    <AnalyticsSection
      id="directory"
      name="Directory"
      question="Search and compare every subnet."
      className="mg-directory-section mg-directory-section--table-first"
      visual={
        <>
          <SubnetDirectoryControls filters={filters} domains={domains} onChange={onFilter} />
          {status}
          {unknownApiCount > 0 ? (
            <p className="mb-4 text-13 text-ink-muted">
              API spec coverage is unknown for {formatNumber(unknownApiCount)} indexed
              {unknownApiCount === 1 ? " subnet" : " subnets"}.
            </p>
          ) : null}
          {filterState !== "ready" ? (
            <p role="status" className="border-y border-border py-8 text-13 text-ink-muted">
              {filterState === "pending"
                ? "Loading the data needed for these filters…"
                : "These filters need data that is currently unavailable. Retry the source or reset the filters."}
            </p>
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(row) => String(row.netuid)}
              // The table appends the row count itself; the caption says what was
              // filtered OUT, which the count alone cannot.
              caption={
                rows.length === total
                  ? "Every application subnet, plus root"
                  : `${formatNumber(rows.length)} of ${formatNumber(total)} chain netuids`
              }
              rowHref={(row) => `/subnets/${row.netuid}`}
              link={RouterLink}
              // Every row in the server-rendered bytes -- see the note above.
              paginate={false}
              source="subnet-row"
              storageKey="subnets-directory-columns"
              mobile="cards"
              compactMobileLabels
              className="max-lg:[&_td[data-mobile-lead=true]]:before:hidden [&_.mg-dt-status]:self-start [&_.mg-dt-menu-trigger]:min-h-11 [&_.mg-dt-menu-trigger]:min-w-11"
              empty="No subnets match these filters."
            />
          )}
          <SubnetCompareBar />
        </>
      }
    />
  );
}
