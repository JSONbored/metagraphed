import { Suspense, useMemo, useState } from "react";
import type { StatusSearch } from "@/routes/status";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  healthHistoryQuery,
  sourceHealthProvidersQuery,
  healthQuery,
} from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { DataTable, RankedRails, type DataTableColumn } from "@jsonbored/ui-kit";
import { SelectFilter, ResetFiltersButton } from "@/components/metagraphed/table-controls";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { Panel } from "@/components/metagraphed/primitives";
import type { HealthHistorySurface, SourceHealthProvider } from "@/lib/metagraphed/types";
import { railItems } from "@/lib/metagraphed/rails";

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

// The column keys ARE the URL's sort vocabulary (#3977), so a header click and
// a shared `?sort=` link cannot describe different orderings.
const SURFACE_COLUMNS: Array<DataTableColumn<HealthHistorySurface>> = [
  {
    key: "netuid",
    label: "SN",
    align: "left",
    sortable: true,
    value: (s) => s.netuid ?? null,
    render: (s) =>
      s.netuid != null ? (
        <Link
          to="/subnets/$netuid"
          params={{ netuid: s.netuid }}
          className="tabular-nums hover:text-ink-strong"
        >
          {String(s.netuid).padStart(3, "0")}
        </Link>
      ) : (
        "—"
      ),
  },
  { key: "surface", label: "Surface", value: (s) => s.surface_id ?? null },
  { key: "provider", label: "Provider", sortable: true, value: (s) => s.provider ?? null },
  { key: "kind", label: "Kind", sortable: true, value: (s) => s.kind ?? null },
  {
    key: "status",
    label: "Status",
    kind: "status",
    sortable: true,
    value: (s) => s.status ?? null,
  },
  { key: "classification", label: "Classification", value: (s) => s.classification ?? null },
  {
    key: "latency_ms",
    label: "Latency",
    kind: "number",
    sortable: true,
    value: (s) => s.latency_ms ?? null,
    format: (v) => (typeof v === "number" ? `${v} ms` : "—"),
  },
  { key: "last_ok", label: "Last OK", kind: "time", value: (s) => s.last_ok ?? null },
];

export function HealthHistoryDrilldown() {
  // Default to the most-recent probe date from /api/v1/health (UTC day).
  const { data: hRes } = useSuspenseQuery(healthQuery());
  const latest = hRes.meta?.generated_at ?? hRes.data.generated_at;
  const defaultDate = (latest ?? new Date().toISOString()).slice(0, 10);
  // #3977: URL-backed so a picked date survives reload + is shareable. An empty
  // `date` param means "most recent", so we omit it from the URL in that case.
  const search = useSearch({ from: "/status" }) as StatusSearch;
  const navigate = useNavigate({ from: "/status" });
  const date = search.date || defaultDate;
  const setDate = (next: string) =>
    navigate({ search: (prev) => ({ ...prev, date: next === defaultDate ? "" : next }) });

  return (
    <div className="space-y-3">
      <Panel bodyClassName="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-10 text-ink-muted">Probe date</div>
          <div className="font-display text-13 font-semibold text-ink-strong">{date}</div>
        </div>
        <label className="ml-auto inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-13">
          <span className="text-13 text-ink-muted">date</span>
          <input
            type="date"
            value={date}
            max={defaultDate}
            onChange={(e) => setDate(e.target.value || defaultDate)}
            className="bg-transparent text-13 text-ink-strong focus:outline-none"
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
  const search = useSearch({ from: "/status" }) as StatusSearch;
  const navigate = useNavigate({ from: "/status" });
  const kind = search.kind;
  const status = search.status;
  const sort: SurfaceSortField = search.sort;
  const order = search.order;
  const setKind = (next: string) => navigate({ search: (prev) => ({ ...prev, kind: next }) });
  const setStatus = (next: string) => navigate({ search: (prev) => ({ ...prev, status: next }) });

  const classData: Array<{ label: string; value: number }> = useMemo(
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
      <EmptyState
        title="No probe history for this date"
        description="The health-history artifact has no surfaces recorded for the selected day — pick a more recent date."
        lastChecked={res.meta?.generated_at}
      />
    );
  }

  const okCount = summary.status_counts.ok ?? 0;
  const degraded = summary.status_counts.degraded ?? 0;
  const failed = summary.status_counts.failed ?? 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <div className="mb-1 text-10 text-ink-muted">Status counts</div>
          <div className="flex items-center gap-4 font-mono text-13 tabular-nums">
            <span className="text-health-ok">{okCount} ok</span>
            <span className="text-health-warn">{degraded} degraded</span>
            <span className="text-health-down">{failed} failed</span>
            <span className="text-ink-muted">{summary.surface_count ?? rows.length} probed</span>
          </div>
        </Panel>
        <Panel>
          <div className="mb-1.5 text-10 text-ink-muted">Classification mix</div>
          <RankedRails
            items={railItems(classData)}
            formatValue={(v) => formatNumber(v)}
            ariaLabel="Classification mix"
          />
        </Panel>
      </div>

      <DataTable
        rows={rows}
        columns={SURFACE_COLUMNS}
        rowKey={(s) => s.surface_id ?? `${s.netuid}-${s.kind}-${s.provider}`}
        caption="Probed surfaces"
        link={RouterLink}
        source="health-history"
        storageKey="health-history-surfaces"
        sort={{ key: sort, dir: order }}
        onSort={(next) =>
          navigate({
            search: (previous) => {
              // #8628: a search middleware collapses `prev` to `{}` in the
              // reducer's type. validateSearch still applies every default when
              // parsing, so the value really does carry all fields at runtime.
              const prev = previous as StatusSearch;
              return {
                ...prev,
                sort: (next?.key ?? "netuid") as SurfaceSortField,
                order: next?.dir ?? "asc",
              };
            },
          })
        }
        filters={
          <>
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
            {/* Scoped to the two keys this row owns. `date` has its own control
                in the header above, and sort/order/window are set from other
                parts of /status -- clearing them from here would drop state the
                reader never touched from this row. */}
            <ResetFiltersButton
              active={Boolean(kind || status)}
              onReset={() => navigate({ search: (prev) => ({ ...prev, kind: "", status: "" }) })}
            />
          </>
        }
      />
      <p className="text-10 text-ink-muted">
        {rows.length} of {res.data.surfaces.length} surfaces
      </p>
    </div>
  );
}

/* ================================================================== *
 * #8b — /source-health provider table
 * ================================================================== */

// dead / redirected / live classification counts → a compact failure-reason cell.
const CLASSIFICATION_ORDER = [
  "live",
  "redirected",
  "auth-required",
  "transient",
  "timeout",
  "dead",
];

function classificationEntries(provider: SourceHealthProvider): Array<[string, number]> {
  return Object.entries(provider.classifications ?? {})
    .sort(([a], [b]) => {
      const ia = CLASSIFICATION_ORDER.indexOf(a);
      const ib = CLASSIFICATION_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .filter(([, v]) => v > 0);
}

const PROVIDER_COLUMNS: Array<DataTableColumn<SourceHealthProvider>> = [
  {
    key: "name",
    label: "Provider",
    sortable: true,
    value: (p) => p.name ?? p.id,
    render: (p) => (
      <>
        <span className="font-medium text-ink-strong">{p.name ?? p.id}</span>
        {p.authority ? <span className="ml-1.5 text-10 text-ink-muted">{p.authority}</span> : null}
      </>
    ),
  },
  { key: "kind", label: "Kind", sortable: true, value: (p) => p.kind ?? null },
  {
    key: "status",
    label: "Status",
    kind: "status",
    sortable: true,
    value: (p) => p.status ?? null,
  },
  {
    key: "endpoint_count",
    label: "Endpoints",
    kind: "number",
    sortable: true,
    value: (p) => p.endpoint_count ?? 0,
  },
  {
    key: "candidate_count",
    label: "Candidates",
    kind: "number",
    sortable: true,
    value: (p) => p.candidate_count ?? 0,
  },
  {
    key: "verification_mix",
    label: "Verification mix",
    sortable: true,
    value: (p) => p.verification_result_count ?? 0,
    render: (p) => {
      const entries = classificationEntries(p);
      if (entries.length === 0) return <span className="text-10 text-ink-muted">—</span>;
      return (
        <span className="flex flex-wrap gap-1">
          {entries.map(([label, value]) => (
            <span
              key={label}
              className={classNames(
                "inline-flex items-center gap-1 rounded border px-1 py-0.5 text-10",
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
        </span>
      );
    },
  },
];

export function SourceHealthTable() {
  const { data: res } = useSuspenseQuery(sourceHealthProvidersQuery());
  const summary = res.data.summary;
  const [status, setStatus] = useState("");

  // The busiest provider first, which is the order a reader wants before they
  // touch a header; the table owns every re-sort from there.
  const rows = useMemo(() => {
    const filtered = res.data.providers.filter((p) => !status || statusState(p.status) === status);
    return [...filtered].sort(
      (a, b) => (b.verification_result_count ?? 0) - (a.verification_result_count ?? 0),
    );
  }, [res.data.providers, status]);

  if (res.data.providers.length === 0) {
    return (
      <EmptyState
        title="No providers recorded"
        description="The source-health artifact returned no providers."
        lastChecked={res.meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Panel bodyClassName="flex flex-wrap items-center gap-4 font-mono text-13 tabular-nums">
        <span className="text-health-ok">{summary.status_counts.ok ?? 0} ok</span>
        <span className="text-health-warn">{summary.status_counts.degraded ?? 0} degraded</span>
        <span className="text-health-down">{summary.status_counts.failed ?? 0} failed</span>
        <span className="text-ink-muted">{summary.status_counts.unknown ?? 0} unknown</span>
        <span className="ml-auto text-ink-muted">
          {summary.provider_count ?? rows.length} providers · {summary.endpoint_count ?? 0}{" "}
          endpoints
        </span>
      </Panel>

      <DataTable
        rows={rows}
        columns={PROVIDER_COLUMNS}
        rowKey={(p) => p.id}
        caption="Source providers"
        link={RouterLink}
        source="source-health"
        storageKey="source-health-providers"
        filters={
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
        }
      />
      <p className="text-10 text-ink-muted">
        {rows.length} of {res.data.providers.length} providers
      </p>
    </div>
  );
}
