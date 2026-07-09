import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ListShell } from "@/components/metagraphed/list-shell";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ShareButton } from "@/components/metagraphed/share-button";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { DownloadCsvButton } from "@/components/metagraphed/download-csv-button";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { chainFeesQuery, extrinsicsQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import { shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { API_BASE } from "@/lib/metagraphed/config";
import type { Extrinsic } from "@/lib/metagraphed/types";

const extrinsicsSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  // Server-side filters (#265) wired to the /api/v1/extrinsics conjunctive set.
  signer: fallback(z.string(), "").default(""),
  call_module: fallback(z.string(), "").default(""),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export const Route = createFileRoute("/extrinsics/")({
  validateSearch: zodValidator(extrinsicsSearchSchema),
  head: () => ({
    meta: [
      { title: "Extrinsics — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor extrinsics (transactions) indexed from the chain — block, call, signer, and success, newest first.",
      },
      { property: "og:title", content: "Extrinsics — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor extrinsics (transactions) indexed from the chain — block, call, signer, and success, newest first.",
      },
    ],
  }),
  component: ExtrinsicsPage,
});

type ExtrinsicsSearch = z.infer<typeof extrinsicsSearchSchema>;

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

function fmtTao(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

/** One labeled daily fee sparkline; latest value surfaced as a compact caption. */
function FeeSpark({
  label,
  days,
  values,
  color,
}: {
  label: string;
  days: string[];
  values: number[];
  color: string;
}) {
  const latest = values.length > 0 ? values[values.length - 1]! : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-strong">
          {latest == null ? "—" : fmtTao(latest)}
        </span>
      </div>
      <Sparkline
        values={values}
        points={values.map((v, i) => ({ t: days[i] ?? "", v }))}
        width={320}
        height={48}
        color={color}
        ariaLabel={`Daily ${label.toLowerCase()}`}
        formatValue={fmtTao}
      />
    </div>
  );
}

/**
 * Fees-over-time trend for the extrinsics list. Reuses `chainFeesQuery`
 * (/api/v1/chain/fees) — the same daily fee series the explorer surfaces — to
 * give the flat extrinsics table visual trend context above it. The API returns
 * newest-day-first; sparklines want chronological order.
 */
function FeesTrendCard() {
  const fees = useSuspenseQuery(chainFeesQuery("7d")).data.data;
  const chrono = [...fees.daily].reverse();
  const totalFees = chrono.reduce((acc, d) => acc + d.total_fee_tao, 0);

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Fees over time
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {fmtTao(totalFees)} · {fees.day_count} days
        </span>
      </div>
      {chrono.length > 0 ? (
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          <FeeSpark
            label="Total fees"
            days={chrono.map((d) => d.day)}
            values={chrono.map((d) => d.total_fee_tao)}
            color="var(--accent)"
          />
          <FeeSpark
            label="Avg fee"
            days={chrono.map((d) => d.day)}
            values={chrono.map((d) => d.avg_fee_tao ?? 0)}
            color="var(--chart-3)"
          />
        </div>
      ) : (
        <p className="font-mono text-[12px] text-ink-muted">
          No fee activity indexed yet — the chain poller fills this every few minutes.
        </p>
      )}
    </section>
  );
}

function ExtrinsicsPage() {
  const search = Route.useSearch();
  const extrinsicsCsvUrl = buildUrl("/api/v1/extrinsics", extrinsicsQueryParams(search));

  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Extrinsics"
        description="Recent Bittensor extrinsics (transactions) indexed directly from the chain — newest first, with call, signer, and success."
        actions={
          <>
            <DownloadCsvButton url={extrinsicsCsvUrl} />
            <ShareButton />
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <FeesTrendCard />
        </Suspense>
      </QueryErrorBoundary>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ExtrinsicsTable />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={["/api/v1/extrinsics", "/api/v1/chain/fees"]}
        artifacts={["/metagraph/extrinsics.json"]}
      />
    </AppShell>
  );
}

function SuccessBadge({ success }: { success?: boolean | null }) {
  if (success == null) return <span className="text-ink-muted">—</span>;
  return success ? (
    <span className="text-emerald-500">ok</span>
  ) : (
    <span className="text-rose-500">fail</span>
  );
}

function ExtrinsicsTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Only send filters the user actually set, so an empty bar is the plain feed.
  const queryParams = extrinsicsQueryParams(search);

  const rows = (useSuspenseQuery(extrinsicsQuery(queryParams)).data.data ?? []) as Extrinsic[];

  // Offset pagination: the API returns newest-first pages with no total. A full
  // page (rows === limit) implies more may exist; a short page is the tail.
  const hasPrev = search.offset > 0;
  const hasNext = rows.length === search.limit;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const goPrev = () => setSearch({ offset: Math.max(0, search.offset - search.limit) });
  const goNext = () => setSearch({ offset: search.offset + search.limit });

  const rowKey = (x: Extrinsic) =>
    x.extrinsic_hash || `${x.block_number ?? "?"}-${x.extrinsic_index ?? "?"}`;

  const filtersActive = Boolean(
    search.signer || search.call_module || search.call_function || search.success,
  );

  const filters = (
    <>
      <SearchInput
        value={search.signer}
        onChange={(v) => setSearch({ signer: v, offset: 0 })}
        placeholder="Signer ss58…"
      />
      <SearchInput
        value={search.call_module}
        onChange={(v) => setSearch({ call_module: v, offset: 0 })}
        placeholder="Call module…"
      />
      <SearchInput
        value={search.call_function}
        onChange={(v) => setSearch({ call_function: v, offset: 0 })}
        placeholder="Call function…"
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
      <PageSizeSelect
        value={search.limit}
        onChange={(n) => setSearch({ limit: n, offset: 0 })}
        options={[10, 25, 50, 100]}
      />
      <ResetFiltersButton
        active={filtersActive}
        onReset={() =>
          setSearch({
            signer: "",
            call_module: "",
            call_function: "",
            success: "",
            offset: 0,
          })
        }
      />
    </>
  );

  const emptyNode = (
    <EmptyState
      title="No extrinsics indexed yet"
      description="The chain poller fills this every few minutes — check back shortly, or open the API directly."
      action={{
        label: "Open /api/v1/extrinsics",
        href: `${API_BASE}/api/v1/extrinsics`,
        external: true,
      }}
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
        <HashCardOrLink key={rowKey(x)} x={x} />
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="sticky top-sticky-offset z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
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
                      <CopyButton value={x.extrinsic_hash} label="extrinsic hash" />
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

function HashCardOrLink({ x }: { x: Extrinsic }) {
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
                <CopyButton value={x.extrinsic_hash} label="extrinsic hash" />
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
