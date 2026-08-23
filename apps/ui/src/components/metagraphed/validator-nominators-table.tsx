import { useSuspenseQuery } from "@tanstack/react-query";
import { DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import { RouterLink } from "@/components/metagraphed/router-link";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { formatNumber } from "@/lib/metagraphed/format";
import type { validatorNominatorsQuery } from "@/lib/metagraphed/queries";
import type { ValidatorNominatorEntry } from "@/lib/metagraphed/types";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";

// The route's own published windows (#10994).
const WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/validators/{hotkey}/nominators"].window;
const SORTS = [
  { value: "net_staked", label: "Net staked" },
  { value: "gross_staked", label: "Gross staked" },
  { value: "last_activity", label: "Last activity" },
] as const;

const tao = (value: unknown) => taoCompact(typeof value === "number" ? value : null);

const COLUMNS: Array<DataTableColumn<ValidatorNominatorEntry>> = [
  { key: "coldkey", label: "Coldkey", kind: "identifier", value: (n) => n.coldkey },
  {
    key: "net_staked",
    label: "Net staked",
    kind: "number",
    value: (n) => n.net_staked_tao,
    format: tao,
  },
  {
    key: "gross_staked",
    label: "Gross staked",
    kind: "number",
    value: (n) => n.gross_staked_tao,
    format: tao,
  },
  { key: "unstaked", label: "Unstaked", kind: "number", value: (n) => n.unstaked_tao, format: tao },
  {
    key: "events",
    label: "Events",
    kind: "number",
    value: (n) => n.event_count,
    format: (v) => formatNumber(typeof v === "number" ? v : null),
  },
  { key: "last_activity", label: "Last activity", kind: "time", value: (n) => n.last_observed_at },
];

export interface ValidatorNominatorsSearch {
  window: "7d" | "30d" | "90d";
  sort: "net_staked" | "gross_staked" | "last_activity";
  limit: number;
  offset: number;
  coldkey: string;
}

interface Props {
  queryOptions: ReturnType<typeof validatorNominatorsQuery>;
  search: ValidatorNominatorsSearch;
  setSearch: (patch: Partial<ValidatorNominatorsSearch>) => void;
}

/** Nominator list + search for a validator (#4336/7.2) — derived from
 * stake-delegation account_events, no new capture. Embedded within
 * /validators/$hotkey, mirroring how /sudo embeds CallModuleExtrinsicsTable. */
export function ValidatorNominatorsTable({ queryOptions, search, setSearch }: Props) {
  const rows = useSuspenseQuery(queryOptions).data.data ?? [];

  // Offset pagination against a route that publishes no total: a full page
  // implies at least one more, a short page is the tail. That is exactly the
  // bound the pager needs, so it is stated as one rather than as prev/next.
  const hasNext = rows.length === search.limit;
  const total = search.offset + rows.length + (hasNext ? 1 : 0);
  const page = Math.floor(search.offset / search.limit) + 1;

  const filtersActive = Boolean(search.coldkey);

  return (
    <DataTable
      rows={rows}
      columns={COLUMNS}
      rowKey={(n) => n.coldkey}
      caption="Nominators"
      link={RouterLink}
      storageKey="validator-nominators"
      search={{
        value: search.coldkey,
        onChange: (v) => setSearch({ coldkey: v, offset: 0 }),
        placeholder: "Coldkey ss58…",
      }}
      filters={
        <>
          <SelectFilter
            label="Window"
            value={search.window}
            onChange={(v) =>
              setSearch({ window: v as ValidatorNominatorsSearch["window"], offset: 0 })
            }
            options={WINDOWS.map((w) => ({ value: w, label: w }))}
          />
          <SelectFilter
            label="Sort"
            value={search.sort}
            onChange={(v) => setSearch({ sort: v as ValidatorNominatorsSearch["sort"], offset: 0 })}
            options={[...SORTS]}
          />
          <PageSizeSelect
            value={search.limit}
            onChange={(n) => setSearch({ limit: n, offset: 0 })}
            options={[10, 20, 50, 100]}
          />
          <ResetFiltersButton
            active={filtersActive}
            onReset={() => setSearch({ coldkey: "", offset: 0 })}
          />
        </>
      }
      total={total}
      page={page}
      pageSize={search.limit}
      onPage={(next) => setSearch({ offset: Math.max(0, (next - 1) * search.limit) })}
      empty={
        <EmptyState
          title="No nominators in this window"
          description="Nominators are derived from stake-delegation events — widen the window or check back once new delegations land."
        />
      }
    />
  );
}
