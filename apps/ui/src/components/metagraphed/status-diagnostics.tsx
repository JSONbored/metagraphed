import { Suspense, useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  healthHistoryQuery,
  sourceHealthProvidersQuery,
  healthQuery,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { HealthPill, TimeAgo, TableState, BarMini, type BarMiniDatum } from "@jsonbored/ui-kit";
import {
  SortHeader,
  ariaSort,
  SelectFilter,
  ResetFiltersButton,
} from "@/components/metagraphed/table-controls";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { Panel } from "@/components/metagraphed/primitives";
import type { HealthHistorySurface, SourceHealthProvider } from "@/lib/metagraphed/types";

/* ================================================================== *
 * #8a — /health/history/{date} date-picker drill-down
 * ================================================================== */

// Map probe status → the HealthPill state vocabulary.
function statusState(status?: string): string {
  if (status === "ok") return "ok";
  if (status === "degraded") return "warn";
  if (status === "failed") return "down";
  return "unknown";
}

// Classification → token colour for the distribution bars.
const CLASSIFICATION_COLOR: Record<string, string> = {
  live: "var(--health-ok)",
  redirected: "var(--chart-3)",
  "auth-required": "var(--chart-1)",
  transient: "var(--health-warn)",
  timeout: "var(--health-warn)",
  unsupported: "var(--ink-muted)",
  dead: "var(--health-down)",
};

type SurfaceSortField = "netuid" | "provider" | "kind" | "status" | "latency_ms";

export function HealthHistoryDrilldown() {
  // Default to the most-recent probe date from /api/v1/health (UTC day).
  const { data: hRes } = useSuspenseQuery(healthQuery());
  const latest = hRes.meta?.generated_at ?? hRes.data.generated_at;
  const defaultDate = (latest ?? new Date().toISOString()).slice(0, 10);
  // #3977: URL-backed so a picked date survives reload + is shareable. An empty
  // `date` param means "most recent", so we omit it from the URL in that case.
  const search = useSearch({ from: "/status" });
  const navigate = useNavigate({ from: "/status" });
  const date = search.date || defaultDate;
  const setDate = (next: string) =>
    navigate({ search: (prev) => ({ ...prev, date: next === defaultDate ? "" : next }) });

  return (
    <div className="space-y-3">
      <Panel dense bodyClassName="flex flex-wrap items-center gap-3">
        <div>
          <div className="mg-label">Probe date</div>
          <div className="font-display text-sm font-semibold text-ink-strong">{date}</div>
        </div>
        <label className="ml-auto inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            date
          </span>
          <input
            type="date"
            value={date}
            max={defaultDate}
            onChange={(e) => setDate(e.target.value || defaultDate)}
            className="bg-transparent text-ink-strong text-xs focus:outline-none"
            aria-label="Probe history date"
          />
        </label>
      </Panel>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <HealthHistoryBody date={date} />
        </Suspense>
      </QueryErrorBoundary>
    </div>
  );
}

function HealthHistoryBody({ date }: { date: string }) {
  const { data: res } = useSuspenseQuery(healthHistoryQuery(date));
  const summary = res.data.summary;
  // #3977: the table's kind/status filters + sort are URL-backed alongside the
  // date so the whole drill-down state is shareable and reload-stable.
  const search = useSearch({ from: "/status" });
  const navigate = useNavigate({ from: "/status" });
  const kind = search.kind;
  const status = search.status;
  const sort: SurfaceSortField = search.sort;
  const order = search.order;
  const setKind = (next: string) => navigate({ search: (prev) => ({ ...prev, kind: next }) });
  const setStatus = (next: string) => navigate({ search: (prev) => ({ ...prev, status: next }) });

  const onSort = (field: string) => {
    const f = field as SurfaceSortField;
    navigate({
      search: (prev) =>
        f === prev.sort
          ? { ...prev, order: prev.order === "asc" ? "desc" : "asc" }
          : { ...prev, sort: f, order: "asc" },
    });
  };

  const classData: BarMiniDatum[] = useMemo(
    () =>
      Object.entries(summary.classification_counts)
        .sort(([, a], [, b]) => b - a)
        .map(([label, value]) => ({
          label,
          value,
          color: CLASSIFICATION_COLOR[label] ?? "var(--accent)",
        })),
    [summary.classification_counts],
  );

  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of res.data.surfaces) if (s.kind) set.add(s.kind);
    return [...set].sort().map((k) => ({ value: k, label: k }));
  }, [res.data.surfaces]);

  const rows = useMemo(() => {
    const filtered = res.data.surfaces.filter((s) => {
      if (kind && s.kind !== kind) return false;
      if (status && statusState(s.status) !== status) return false;
      return true;
    });
    const mul = order === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = a[sort];
      const vb = b[sort];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [res.data.surfaces, kind, status, sort, order]);

  if (res.data.surfaces.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No probe history for this date"
        description="The health-history artifact has no surfaces recorded for the selected day — pick a more recent date."
        generatedAt={res.meta?.generated_at}
      />
    );
  }

  const okCount = summary.status_counts.ok ?? 0;
  const degraded = summary.status_counts.degraded ?? 0;
  const failed = summary.status_counts.failed ?? 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Panel as="div" dense>
          <div className="mg-label mb-1">Status counts</div>
          <div className="flex items-center gap-4 font-mono text-[12px] tabular-nums">
            <span className="text-health-ok">{okCount} ok</span>
            <span className="text-health-warn">{degraded} degraded</span>
            <span className="text-health-down">{failed} failed</span>
            <span className="text-ink-muted">{summary.surface_count ?? rows.length} probed</span>
          </div>
        </Panel>
        <Panel as="div" dense>
          <div className="mg-label mb-1.5">Classification mix</div>
          <BarMini data={classData} showValue />
        </Panel>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SelectFilter label="kind" value={kind} onChange={setKind} options={kindOptions} />
        <SelectFilter
          label="status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "ok", label: "ok" },
            { value: "warn", label: "degraded" },
            { value: "down", label: "failed" },
            { value: "unknown", label: "unknown" },
          ]}
        />
        {/* Scoped to the two keys this row owns. `date` has its own control in
            the header above, and sort/order/window are set from other parts of
            /status -- clearing them from here would drop state the reader never
            touched from this row. */}
        <ResetFiltersButton
          active={Boolean(kind || status)}
          onReset={() => navigate({ search: (prev) => ({ ...prev, kind: "", status: "" }) })}
        />
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          {rows.length} of {res.data.surfaces.length} surfaces
        </span>
      </div>

      <Panel flush className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "netuid", order)}>
                <SortHeader
                  label="SN"
                  field="netuid"
                  active={sort === "netuid"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th className="px-3 py-2.5">Surface</th>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "provider", order)}>
                <SortHeader
                  label="Provider"
                  field="provider"
                  active={sort === "provider"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "kind", order)}>
                <SortHeader
                  label="Kind"
                  field="kind"
                  active={sort === "kind"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "status", order)}>
                <SortHeader
                  label="Status"
                  field="status"
                  active={sort === "status"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th
                className="px-3 py-2.5 text-right"
                aria-sort={ariaSort(sort === "latency_ms", order)}
              >
                <SortHeader
                  label="Latency"
                  field="latency_ms"
                  active={sort === "latency_ms"}
                  order={order}
                  onSort={onSort}
                  align="right"
                />
              </th>
              <th className="px-3 py-2.5 text-right">Last OK</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((s, i) => (
              <SurfaceHistoryRow key={`${s.surface_id ?? i}`} surface={s} />
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function SurfaceHistoryRow({ surface }: { surface: HealthHistorySurface }) {
  return (
    <tr className="mg-row-hover">
      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
        {surface.netuid != null ? (
          <Link
            to="/subnets/$netuid"
            params={{ netuid: surface.netuid }}
            className="hover:text-ink-strong"
          >
            {String(surface.netuid).padStart(3, "0")}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-strong">
        <span className="truncate" title={surface.surface_id}>
          {surface.surface_id ?? "—"}
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
        {surface.provider ?? "—"}
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">{surface.kind ?? "—"}</td>
      <td className="px-3 py-2.5">
        <span className="inline-flex items-center gap-1.5">
          <HealthPill state={statusState(surface.status)} />
          {surface.classification ? (
            <span className="font-mono text-[10px] text-ink-muted">{surface.classification}</span>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
        {surface.latency_ms != null ? `${surface.latency_ms} ms` : "—"}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[11px] text-ink-muted">
        {surface.last_ok ? <TimeAgo at={surface.last_ok} /> : "—"}
      </td>
    </tr>
  );
}

/* ================================================================== *
 * #8b — /source-health provider table
 * ================================================================== */

type ProviderSortField =
  "name" | "kind" | "status" | "endpoint_count" | "candidate_count" | "verification_result_count";

export function SourceHealthTable() {
  const { data: res } = useSuspenseQuery(sourceHealthProvidersQuery());
  const summary = res.data.summary;
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<ProviderSortField>("verification_result_count");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const onSort = (field: string) => {
    const f = field as ProviderSortField;
    if (f === sort) setOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(f);
      setOrder(f === "name" || f === "kind" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const filtered = res.data.providers.filter((p) => !status || statusState(p.status) === status);
    const mul = order === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = a[sort];
      const vb = b[sort];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [res.data.providers, status, sort, order]);

  if (res.data.providers.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No providers recorded"
        description="The source-health artifact returned no providers."
        generatedAt={res.meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Panel
        dense
        bodyClassName="flex flex-wrap items-center gap-4 font-mono text-[12px] tabular-nums"
      >
        <span className="text-health-ok">{summary.status_counts.ok ?? 0} ok</span>
        <span className="text-health-warn">{summary.status_counts.degraded ?? 0} degraded</span>
        <span className="text-health-down">{summary.status_counts.failed ?? 0} failed</span>
        <span className="text-ink-muted">{summary.status_counts.unknown ?? 0} unknown</span>
        <span className="ml-auto text-ink-muted">
          {summary.provider_count ?? rows.length} providers · {summary.endpoint_count ?? 0}{" "}
          endpoints
        </span>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <SelectFilter
          label="status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "ok", label: "ok" },
            { value: "warn", label: "degraded" },
            { value: "down", label: "failed" },
            { value: "unknown", label: "unknown" },
          ]}
        />
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          {rows.length} of {res.data.providers.length} providers
        </span>
      </div>

      <Panel flush className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "name", order)}>
                <SortHeader
                  label="Provider"
                  field="name"
                  active={sort === "name"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "kind", order)}>
                <SortHeader
                  label="Kind"
                  field="kind"
                  active={sort === "kind"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "status", order)}>
                <SortHeader
                  label="Status"
                  field="status"
                  active={sort === "status"}
                  order={order}
                  onSort={onSort}
                />
              </th>
              <th
                className="px-3 py-2.5 text-right"
                aria-sort={ariaSort(sort === "endpoint_count", order)}
              >
                <SortHeader
                  label="Endpoints"
                  field="endpoint_count"
                  active={sort === "endpoint_count"}
                  order={order}
                  onSort={onSort}
                  align="right"
                />
              </th>
              <th
                className="px-3 py-2.5 text-right"
                aria-sort={ariaSort(sort === "candidate_count", order)}
              >
                <SortHeader
                  label="Candidates"
                  field="candidate_count"
                  active={sort === "candidate_count"}
                  order={order}
                  onSort={onSort}
                  align="right"
                />
              </th>
              <th className="px-3 py-2.5">Verification mix</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// dead / redirected / live classification counts → a compact failure-reason cell.
function ProviderRow({ provider }: { provider: SourceHealthProvider }) {
  const cls = provider.classifications ?? {};
  const order = ["live", "redirected", "auth-required", "transient", "timeout", "dead"];
  const entries = Object.entries(cls)
    .sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .filter(([, v]) => v > 0);
  return (
    <tr className="mg-row-hover">
      <td className="px-3 py-2.5">
        <span className="font-medium text-ink-strong">{provider.name ?? provider.id}</span>
        {provider.authority ? (
          <span className="ml-1.5 font-mono text-[10px] text-ink-muted">{provider.authority}</span>
        ) : null}
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">{provider.kind ?? "—"}</td>
      <td className="px-3 py-2.5">
        <HealthPill state={statusState(provider.status)} />
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
        {provider.endpoint_count ?? 0}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
        {provider.candidate_count ?? 0}
      </td>
      <td className="px-3 py-2.5">
        {entries.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {entries.map(([label, value]) => (
              <span
                key={label}
                className={classNames(
                  "inline-flex items-center gap-1 rounded border px-1 py-0.5 font-mono text-[9px]",
                  label === "dead"
                    ? "border-health-down/40 text-health-down"
                    : label === "live"
                      ? "border-health-ok/40 text-health-ok"
                      : "border-border text-ink-muted",
                )}
              >
                {label} {value}
              </span>
            ))}
          </div>
        ) : (
          <span className="font-mono text-[10px] text-ink-muted">—</span>
        )}
      </td>
    </tr>
  );
}
