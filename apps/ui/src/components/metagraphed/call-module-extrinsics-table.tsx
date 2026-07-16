import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TimeAgo, ListShell, CopyableCode, CopyButton } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
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

function SuccessBadge({ success }: { success?: boolean | null }) {
  if (success == null) return <span className="text-ink-muted">—</span>;
  return success ? (
    <span className="text-emerald-500">ok</span>
  ) : (
    <span className="text-rose-500">fail</span>
  );
}

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
  // page (rows === limit) implies more may exist; a short page is the tail.
  const hasPrev = search.offset > 0;
  const hasNext = rows.length === search.limit;

  const goPrev = () => setSearch({ offset: Math.max(0, search.offset - search.limit) });
  const goNext = () => setSearch({ offset: search.offset + search.limit });

  const rowKey = (x: Extrinsic) =>
    x.extrinsic_hash || `${x.block_number ?? "?"}-${x.extrinsic_index ?? "?"}`;

  const filtersActive = Boolean(search.call_function || search.success);

  const filters = (
    <>
      <SearchInput
        value={search.call_function}
        onChange={(v) => setSearch({ call_function: v, offset: 0 })}
        placeholder="Call function…"
      />
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
  );

  const emptyNode = (
    <EmptyState
      title={emptyTitle}
      description={emptyDescription}
      action={{ label: `Open ${emptyApiPath}`, href: emptyApiPath, external: true }}
    />
  );

  const footerNode = (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted">
      <span>
        {rows.length
          ? `${formatNumber(search.offset + 1)}–${formatNumber(search.offset + rows.length)}`
          : "0"}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goPrev}
          disabled={!hasPrev}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed min-h-9"
        >
          <ChevronLeft className="size-3" /> Newer
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={!hasNext}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed min-h-9"
        >
          Older <ChevronRight className="size-3" />
        </button>
      </div>
    </div>
  );

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      empty={emptyNode}
      cards={rows.map((x) => (
        <RowCard key={rowKey(x)} x={x} />
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
            <tr>
              <th className="px-4 py-2.5">Hash</th>
              <th className="px-4 py-2.5">Block</th>
              <th className="px-4 py-2.5">Call</th>
              <th className="px-4 py-2.5">Signer</th>
              <th className="px-4 py-2.5">Result</th>
              <th className="px-4 py-2.5 text-right">Observed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((x) => (
              <tr key={rowKey(x)} className="mg-row-accent hover:bg-surface/40">
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {x.extrinsic_hash ? (
                    <span className="inline-flex items-center gap-1 min-w-0">
                      <Link
                        to="/extrinsics/$hash"
                        params={{ hash: x.extrinsic_hash }}
                        className="font-medium text-ink-strong hover:underline truncate"
                        title={x.extrinsic_hash}
                      >
                        {shortHash(x.extrinsic_hash)}
                      </Link>
                      <CopyButton value={x.extrinsic_hash} label="extrinsic hash" compact />
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[12px]">
                  {x.block_number != null ? (
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
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink">
                  {extrinsicCall(x.call_module, x.call_function)}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {x.signer ? <CopyableCode value={x.signer} className="max-w-full" /> : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px]">
                  <SuccessBadge success={x.success} />
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={x.observed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      footer={footerNode}
    />
  );
}

function RowCard({ x }: { x: Extrinsic }) {
  const className = "block rounded border border-border bg-card p-3 min-h-11 active:bg-surface";
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {x.extrinsic_hash ? (
            <>
              <span className="font-mono text-[12px] font-medium text-ink-strong truncate">
                {shortHash(x.extrinsic_hash)}
              </span>
              <span
                role="presentation"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <CopyButton value={x.extrinsic_hash} label="extrinsic hash" compact />
              </span>
            </>
          ) : (
            <span className="font-mono text-[12px] font-medium text-ink-strong">(no hash)</span>
          )}
        </div>
        <span className="font-mono text-[11px] text-ink-muted shrink-0">
          <TimeAgo at={x.observed_at} />
        </span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-ink truncate">
        {extrinsicCall(x.call_module, x.call_function)}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] font-mono text-ink-muted">
        <span className="shrink-0">
          {x.block_number != null ? `#${formatNumber(x.block_number)}` : "—"}
        </span>
        {x.signer ? (
          <span
            role="presentation"
            className="min-w-0 max-w-[55%]"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <CopyableCode value={x.signer} className="w-full" />
          </span>
        ) : (
          <span>no signer</span>
        )}
        <SuccessBadge success={x.success} />
      </div>
    </>
  );
  return x.extrinsic_hash ? (
    <Link to="/extrinsics/$hash" params={{ hash: x.extrinsic_hash }} className={className}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}
