import { useMemo } from "react";
import {
  AnalyticsSection,
  BrandIcon,
  DataTable,
  FilterField,
  FilterSelect,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { formatNumber } from "@/lib/metagraphed/format";
import { fmtAlpha, type DirectoryRow } from "./subnets-index-logic";

export interface DirectoryFilters {
  domain: string;
  health: string;
  api: boolean;
  q: string;
}

const HEALTH_OPTIONS = [
  { value: "", label: "Any health" },
  { value: "ok", label: "OK" },
  { value: "degraded", label: "Degraded" },
  { value: "down", label: "Down" },
  { value: "unknown", label: "Unprobed" },
];

/**
 * Section 2 — every subnet, sortable.
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
  withApi,
}: {
  rows: readonly DirectoryRow[];
  total: number;
  domains: readonly string[];
  filters: DirectoryFilters;
  onFilter: (next: Partial<DirectoryFilters>) => void;
  /** The netuids publishing an API contract, for the column and the filter. */
  withApi: ReadonlySet<number>;
}) {
  const columns = useMemo<DataTableColumn<DirectoryRow>[]>(
    () => [
      { key: "netuid", label: "UID", kind: "number", value: (row) => row.netuid, sortable: true },
      {
        key: "name",
        label: "Name",
        kind: "text",
        sortable: true,
        value: (row) => row.name ?? `Subnet ${row.netuid}`,
        render: (row) => (
          <span className="mg-dt-entity">
            <BrandIcon
              size={20}
              url={row.website}
              repoUrl={row.repo}
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
        format: (value) => (typeof value === "number" ? `${value.toFixed(3)}%` : "—"),
        definition: "Emission share",
      },
      {
        key: "price",
        label: "Price",
        kind: "number",
        sortable: true,
        value: (row) => row.alpha_price_tao ?? null,
        format: (value) => (typeof value === "number" ? `${value.toFixed(4)} τ` : "—"),
      },
      {
        key: "priceChange",
        label: "Δ 7d",
        kind: "delta",
        sortable: true,
        value: (row) => row.alpha_price_change_7d ?? null,
        format: (value) =>
          typeof value === "number" ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%` : "—",
      },
      {
        key: "stake",
        label: "Total stake",
        kind: "number",
        sortable: true,
        value: (row) => row.total_stake_alpha ?? null,
        format: (value) => (typeof value === "number" ? `${fmtAlpha(value)} α` : "—"),
      },
      { key: "health", label: "Health", kind: "status", value: (row) => row.health ?? "unknown" },
      {
        key: "volume",
        label: "Volume",
        kind: "number",
        demote: true,
        sortable: true,
        value: (row) => row.subnet_volume_tao ?? null,
        format: (value) => (typeof value === "number" ? `${fmtAlpha(value)} τ` : "—"),
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
        label: "API",
        kind: "status",
        demote: true,
        value: (row) => (withApi.has(row.netuid) ? "yes" : "no"),
      },
    ],
    [withApi],
  );

  return (
    <AnalyticsSection
      id="directory"
      name="Directory"
      question="Every subnet, sortable."
      visual={
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(row) => String(row.netuid)}
          // The table appends the row count itself; the caption says what was
          // filtered OUT, which the count alone cannot.
          caption={
            rows.length === total
              ? "Every subnet"
              : `${formatNumber(rows.length)} of ${formatNumber(total)} subnets`
          }
          rowHref={(row) => `/subnets/${row.netuid}`}
          link={RouterLink}
          // Every row in the server-rendered bytes -- see the note above.
          paginate={false}
          source="subnet-row"
          storageKey="subnets-directory-columns"
          mobile="cards"
          search={{
            value: filters.q,
            onChange: (q) => onFilter({ q }),
            placeholder: "Find a subnet",
          }}
          filters={
            <>
              <FilterField label="Domain">
                <FilterSelect
                  value={filters.domain}
                  onChange={(event) => onFilter({ domain: event.target.value })}
                >
                  <option value="">Any domain</option>
                  {domains.map((domain) => (
                    <option key={domain} value={domain}>
                      {domain}
                    </option>
                  ))}
                </FilterSelect>
              </FilterField>
              <FilterField label="Health">
                <FilterSelect
                  value={filters.health}
                  onChange={(event) => onFilter({ health: event.target.value })}
                >
                  {HEALTH_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </FilterSelect>
              </FilterField>
              <FilterField label="API">
                <FilterSelect
                  value={filters.api ? "1" : ""}
                  onChange={(event) => onFilter({ api: event.target.value === "1" })}
                >
                  <option value="">Any surface</option>
                  <option value="1">Has an API</option>
                </FilterSelect>
              </FilterField>
            </>
          }
        />
      }
    />
  );
}
