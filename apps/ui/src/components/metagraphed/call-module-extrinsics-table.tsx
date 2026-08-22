import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CopyButton, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { SuccessBadge } from "@/components/metagraphed/success-badge";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import { RouterLink } from "@/components/metagraphed/router-link";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import type { sudoCallsQuery } from "@/lib/metagraphed/queries";
import type { Extrinsic } from "@/lib/metagraphed/types";

/** Search state shared by the /sudo and /admin-changes feeds — no signer/call_module
 * filter, since both routes hardcode call_module server-side (#4310/2.2, 2.3). */
export interface CallModuleExtrinsicsSearch {
  limit: number;
  offset: number;
  call_function: string;
  success: "" | "true" | "false";
}

interface Props {
  queryOptions: ReturnType<typeof sudoCallsQuery>;
  search: CallModuleExtrinsicsSearch;
  setSearch: (patch: Partial<CallModuleExtrinsicsSearch>) => void;
  emptyTitle: string;
  emptyDescription: string;
  emptyApiPath: string;
}

const rowKey = (x: Extrinsic) =>
  x.extrinsic_hash || `${x.block_number ?? "?"}-${x.extrinsic_index ?? "?"}`;

const COLUMNS: Array<DataTableColumn<Extrinsic>> = [
  {
    key: "hash",
    label: "Hash",
    value: (x) => x.extrinsic_hash ?? null,
    render: (x) =>
      x.extrinsic_hash ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <Link
            to="/extrinsics/$hash"
            params={{ hash: x.extrinsic_hash }}
            className="truncate font-medium text-ink-strong hover:underline"
            title={x.extrinsic_hash}
          >
            {shortHash(x.extrinsic_hash)}
          </Link>
          <CopyButton value={x.extrinsic_hash} label="extrinsic hash" compact />
        </span>
      ) : (
        "—"
      ),
  },
  {
    key: "block",
    label: "Block",
    kind: "number",
    value: (x) => x.block_number,
    render: (x) =>
      x.block_number != null ? (
        <Link
          to="/blocks/$ref"
          params={{ ref: String(x.block_number) }}
          className="text-ink hover:underline"
        >
          #{formatNumber(x.block_number)}
          {x.extrinsic_index != null ? (
            <span className="text-ink-muted">·{x.extrinsic_index}</span>
          ) : null}
        </Link>
      ) : (
        "—"
      ),
  },
  { key: "call", label: "Call", value: (x) => extrinsicCall(x.call_module, x.call_function) },
  { key: "signer", label: "Signer", kind: "identifier", value: (x) => x.signer ?? null },
  {
    key: "result",
    label: "Result",
    value: (x) => (x.success == null ? null : x.success ? "ok" : "failed"),
    render: (x) => <SuccessBadge success={x.success} />,
  },
  { key: "observed", label: "Observed", kind: "time", value: (x) => x.observed_at },
];

/** Shared paginated/filtered extrinsics table for a fixed call_module feed
 * (Sudo calls, AdminUtils config changes) — same shape and pagination as
 * /extrinsics, minus the signer/call_module filters that route fixes server-side. */
export function CallModuleExtrinsicsTable({
  queryOptions,
  search,
  setSearch,
  emptyTitle,
  emptyDescription,
  emptyApiPath,
}: Props) {
  const rows = useSuspenseQuery(queryOptions).data.data ?? [];

  // Offset pagination: the API returns newest-first pages with no total. A full
  // page (rows === limit) implies more may exist; a short page is the tail —
  // which is exactly the bound the pager needs to know how far it can go.
  const hasNext = rows.length === search.limit;
  const total = search.offset + rows.length + (hasNext ? 1 : 0);
  const page = Math.floor(search.offset / search.limit) + 1;

  const filtersActive = Boolean(search.call_function || search.success);

  return (
    <DataTable
      rows={rows}
      columns={COLUMNS}
      rowKey={rowKey}
      caption="Extrinsics"
      link={RouterLink}
      storageKey="call-module-extrinsics"
      search={{
        value: search.call_function,
        onChange: (v) => setSearch({ call_function: v, offset: 0 }),
        placeholder: "Call function…",
      }}
      filters={
        <>
          <SelectFilter
            label="Result"
            value={search.success}
            onChange={(v) =>
              setSearch({ success: v as CallModuleExtrinsicsSearch["success"], offset: 0 })
            }
            options={[
              { value: "true", label: "ok" },
              { value: "false", label: "fail" },
            ]}
          />
          <PageSizeSelect
            value={search.limit}
            onChange={(n) => setSearch({ limit: n, offset: 0 })}
            options={[10, 25, 50, 100]}
          />
          <ResetFiltersButton
            active={filtersActive}
            onReset={() => setSearch({ call_function: "", success: "", offset: 0 })}
          />
        </>
      }
      total={total}
      page={page}
      pageSize={search.limit}
      onPage={(next) => setSearch({ offset: Math.max(0, (next - 1) * search.limit) })}
      empty={
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={{ label: `Open ${emptyApiPath}`, href: emptyApiPath, external: true }}
        />
      }
    />
  );
}
