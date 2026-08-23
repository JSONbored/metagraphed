import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { SelectFilter } from "@/components/metagraphed/table-controls";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import {
  EntityHero,
  FactSentence,
  CopyableCode,
  DataTable,
  LineWithWindow,
  truncateIdentifier,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { chainFeesQuery, extrinsicsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { API_BASE } from "@/lib/metagraphed/config";
import type { Extrinsic } from "@/lib/metagraphed/types";
import type { ExtrinsicsSearch } from "./chain.extrinsics";
import { toLinePoints } from "@/components/metagraphed/metric-history";

function extrinsicsQueryParams(search: ExtrinsicsSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {
    limit: search.limit,
    offset: search.offset,
  };
  if (search.signer) queryParams.signer = search.signer;
  if (search.call_module) queryParams.call_module = search.call_module;
  if (search.call_function) queryParams.call_function = search.call_function;
  if (search.success) queryParams.success = search.success;
  return queryParams;
}

/**
 * The chain-hub layout used to supply this page's shell: `AppShell`, the
 * `EntityHero` and the nine-tab strip all rendered once in chain.tsx, and
 * every stream page returned a bare fragment into its `<Outlet />`. #11619
 * emptied that layout -- four of the tabs are sections of /chain now, and a
 * tab strip whose tabs are anchors on the page below it is two navigations
 * for one destination -- so each remaining stream page owns its own shell.
 *
 * Self-contained rather than a smaller shared layout on purpose: three pages
 * is not enough shape to name a layer, and a layout that exists only to hold
 * a heading is the thing that just came out. The crumb back to /chain is the
 * whole of what the tab strip was actually load-bearing for.
 */
export function ExtrinsicsPage() {
  return (
    <AppShell>
      <EntityHero
        crumbs={[{ label: "Chain", href: "/chain" }]}
        name="Extrinsics"
        sentence={
          <FactSentence>
            Recent transactions indexed directly from the chain — newest first, with call, signer
            and result.
          </FactSentence>
        }
      />
      <AsyncPanel
        context="fees trend"
        fallback={<Skeleton className="mb-6 h-24 w-full" />}
        retryQueryKeys={[chainFeesQuery("7d").queryKey]}
      >
        <FeesTrendCard />
      </AsyncPanel>
      <AsyncPanel context="extrinsics" fallback={<Skeleton className="h-96 w-full" />}>
        <ExtrinsicsTable />
      </AsyncPanel>
      <ApiSourceFooter
        paths={["/api/v1/extrinsics", "/api/v1/chain/fees"]}
        artifacts={["/metagraph/extrinsics.json"]}
      />
    </AppShell>
  );
}

/**
 * Fees-over-time line (#3385) — reuses chainFeesQuery the same way
 * explorer.tsx charts "Total fees". Fixed 7d window; no ?window= toggle here.
 */
function FeesTrendCard() {
  const fees = useSuspenseQuery(chainFeesQuery("7d")).data.data;
  const feeChrono = [...fees.daily].reverse();
  const values = feeChrono.map((d) => d.total_fee_tao);
  const latest = values.length > 0 ? values[values.length - 1]! : null;
  const points = toLinePoints(
    feeChrono,
    (d) => d.day,
    (d) => d.total_fee_tao,
  );

  return (
    <Panel flush className="mb-6">
      <div className="p-4 sm:p-6">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-13 text-ink-muted">Fees, last 7d</h2>
            <span className="text-11 text-ink-muted">{fees.day_count} days</span>
          </div>
          <span className="text-11 tabular-nums text-ink-strong">
            {latest == null ? "—" : formatTao(latest)}
          </span>
        </div>
        {points.length > 1 ? (
          <LineWithWindow
            compact
            points={points}
            window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
            unit="TAO in fees"
            formatValue={formatTao}
            ariaLabel="Daily total fees"
            source="chain-fees"
          />
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Compact free-text filter, sized for the table's tools row. The retired
 * filter bar gave `call_module` / `call_function` a full-width SearchInput
 * each; the tools row is a single non-wrapping flex line, so they need a
 * bounded width to sit beside the search box and the Result select.
 */
function TextFilter({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-13">
      <span className="shrink-0 text-13 text-ink-muted">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-20 min-w-0 bg-transparent font-mono text-13 text-ink-strong placeholder:text-ink-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}

function ExtrinsicsTable() {
  const search = useSearch({ from: "/chain/extrinsics" }) as ExtrinsicsSearch;
  const navigate = useNavigate({ from: "/extrinsics/" });

  // Only send filters the user actually set, so an empty bar is the plain feed.
  const queryParams = extrinsicsQueryParams(search);

  // Extrinsics turn over as fast as blocks — poll the first page only, so
  // paging through older extrinsics (offset > 0) isn't yanked or reflowed mid-read.
  const refetchInterval = useRefetchInterval(15_000, search.offset === 0);
  const rows = (useSuspenseQuery({ ...extrinsicsQuery(queryParams), refetchInterval }).data.data ??
    []) as Extrinsic[];

  // Offset pagination: the API returns newest-first pages with no total. A full
  // page (rows === limit) implies more may exist; a short page is the tail.
  const hasNext = rows.length === search.limit;
  const page = Math.floor(search.offset / search.limit) + 1;
  // The feed has no count, so the pager is given the smallest total consistent
  // with what we know: everything read so far, plus one more page while a full
  // page says there may be one. A short page settles it exactly.
  const total = search.offset + rows.length + (hasNext ? search.limit : 0);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const rowKey = (x: Extrinsic) =>
    x.extrinsic_hash || `${x.block_number ?? "?"}-${x.extrinsic_index ?? "?"}`;

  const columns = useMemo<Array<DataTableColumn<Extrinsic>>>(
    () => [
      {
        key: "hash",
        label: "Hash",
        kind: "link",
        width: 160,
        value: (x) => x.extrinsic_hash ?? null,
        href: (x) => (x.extrinsic_hash ? `/extrinsics/${x.extrinsic_hash}` : undefined),
        format: (value) => (typeof value === "string" && value ? truncateIdentifier(value) : "—"),
      },
      {
        key: "block",
        label: "Block",
        kind: "link",
        width: 130,
        value: (x) => x.block_number ?? null,
        href: (x) => (x.block_number == null ? undefined : `/blocks/${x.block_number}`),
        format: (value, x) =>
          typeof value === "number"
            ? `#${formatNumber(value)}${x.extrinsic_index == null ? "" : `·${x.extrinsic_index}`}`
            : "—",
      },
      {
        key: "call",
        label: "Call",
        value: (x) => extrinsicCall(x.call_module, x.call_function),
      },
      {
        key: "signer",
        label: "Signer",
        value: (x) => x.signer ?? null,
        render: (x) => (
          <AddressDisplay
            ss58={x.signer}
            compact
            fallback={x.signer ? <CopyableCode value={x.signer} className="max-w-full" /> : "—"}
          />
        ),
      },
      {
        key: "result",
        label: "Result",
        kind: "status",
        width: 100,
        // `success == null` means the tier has no reading for this extrinsic,
        // which is not a failure — it falls through to the em-dash.
        value: (x) => (x.success == null ? null : x.success ? "ok" : "failed"),
      },
      {
        key: "observed",
        label: "Observed",
        kind: "time",
        align: "right",
        width: 120,
        value: (x) => x.observed_at ?? null,
      },
    ],
    [],
  );

  return (
    <DataTable
      caption="Extrinsics"
      rows={rows}
      columns={columns}
      rowKey={rowKey}
      link={RouterLink}
      storageKey="extrinsics"
      source="extrinsic"
      total={total}
      page={page}
      onPage={(next) => setSearch({ offset: Math.max(0, (next - 1) * search.limit) })}
      pageSize={search.limit}
      search={{
        value: search.signer,
        onChange: (v) => setSearch({ signer: v, offset: 0 }),
        placeholder: "Signer ss58…",
      }}
      filters={
        <>
          <TextFilter
            label="Module"
            value={search.call_module}
            onChange={(v) => setSearch({ call_module: v, offset: 0 })}
            placeholder="any"
          />
          <TextFilter
            label="Function"
            value={search.call_function}
            onChange={(v) => setSearch({ call_function: v, offset: 0 })}
            placeholder="any"
          />
          <SelectFilter
            label="Result"
            value={search.success}
            onChange={(v) => setSearch({ success: v, offset: 0 })}
            options={[
              { value: "true", label: "ok" },
              { value: "false", label: "fail" },
            ]}
          />
        </>
      }
      empty={
        <EmptyState
          title="No extrinsics indexed yet"
          description="The chain poller fills this every few minutes — check back shortly, or open the API directly."
          action={{
            label: "Open /api/v1/extrinsics",
            href: `${API_BASE}/api/v1/extrinsics`,
            external: true,
          }}
        />
      }
    />
  );
}
