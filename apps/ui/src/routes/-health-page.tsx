import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  LineWithWindow,
  MarkerRail,
  RangeControl,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { factCells } from "@/lib/metagraphed/facts";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  bulkHealthTrendsQuery,
  bulkTrendDays,
  globalIncidentsQuery,
  healthSubnetsQuery,
  selfHealthQuery,
} from "@/lib/metagraphed/queries";
import {
  TREND_WINDOWS,
  healthFacts,
  humaniseDuration,
  incidentRows,
  selfComponents,
  subnetHealthRows,
  trendPoints,
  type IncidentRow,
  type SubnetHealthRow,
  type TrendWindow,
} from "@/components/metagraphed/health/health-logic";
import { Route } from "./health";

const API_PATHS = [
  "/api/v1/health",
  "/api/v1/health/trends",
  "/api/v1/incidents",
  "/api/v1/self-health",
];

function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/**
 * Health (#11625) — the merged /health and /status, four sections.
 *
 * /status was a separate page for one question — is metagraphed itself up —
 * asked by the same reader, in the same breath, as "is anything else". It is
 * the fourth section now and /status is a permanent redirect.
 *
 * What went with them: the health matrix mosaic and the coverage matrix (a
 * 129-chip grid that said what the by-subnet rail says in order), three
 * incident-timeline components, the trend panels, the status page's card
 * stack, and the global incident banner's last data consumer.
 */
export function HealthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/health" });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  const healthQuery = useSuspenseQuery(healthSubnetsQuery());
  const health = healthQuery.data;
  const { ref: trendsRef, nearViewport: trendsNearViewport } = useNearViewport("0px 0px");
  // The page opens with recorded incidents, while the bulk trend payload feeds
  // the later uptime rail, table, and chart. Keep those stable sections in the
  // document but wait until their first visual is actually in view before
  // asking for all trend windows.
  const trends = useQuery({
    ...bulkHealthTrendsQuery(),
    enabled: trendsNearViewport,
    retry: 0,
  });
  const incidents = useQuery({ ...globalIncidentsQuery(search.window), retry: 0 });
  const self = useQuery({ ...selfHealthQuery(), retry: 0 });

  const window = search.window as TrendWindow;
  const rows = useMemo(
    () => incidentRows(incidents.data?.data.surfaces as Record<string, unknown>[] | undefined),
    [incidents.data],
  );
  const openRows = useMemo(() => rows.filter((row) => row.open), [rows]);
  const shownIncidents = search.incidents === "open" ? openRows : rows;

  const trendWindow = trends.data?.data.windows?.[window];
  const subnets = useMemo(
    () =>
      subnetHealthRows(
        health.data.subnets,
        trendWindow?.subnets as Record<string, unknown>[] | undefined,
      ),
    [health.data.subnets, trendWindow],
  );
  const points = useMemo(() => trendPoints(bulkTrendDays(trendWindow)), [trendWindow]);
  const components = useMemo(
    () => selfComponents(self.data?.data?.components as Record<string, unknown>[] | undefined),
    [self.data],
  );

  const incidentColumns: DataTableColumn<IncidentRow>[] = [
    { key: "started", label: "Started", kind: "time", width: 130, value: (row) => row.startedAt },
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 110,
      value: (row) => row.netuid,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    { key: "surface", label: "Surface", kind: "identifier", value: (row) => row.surfaceId },
    {
      key: "duration",
      label: "Down for",
      kind: "text",
      align: "right",
      width: 120,
      value: (row) => humaniseDuration(row.durationMs),
    },
    {
      key: "failed",
      label: "Failed probes",
      kind: "number",
      align: "right",
      width: 130,
      value: (row) => row.failedSamples,
    },
    {
      key: "state",
      label: "State",
      kind: "status",
      width: 110,
      value: (row) => (row.open ? "open" : "resolved"),
    },
    {
      key: "ended",
      label: "Ended",
      kind: "time",
      width: 130,
      demote: true,
      value: (row) => row.endedAt,
    },
  ];

  const subnetColumns: DataTableColumn<SubnetHealthRow>[] = [
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 200,
      value: (row) => row.netuid,
      href: (row) => `/subnets/${row.netuid}`,
      format: (value, row) => (typeof value === "number" ? `SN${value} ${row.name}` : row.name),
    },
    {
      key: "uptime",
      label: `Uptime ${window}`,
      kind: "number",
      align: "right",
      width: 120,
      value: (row) => row.uptimePct,
      format: (value) => (typeof value === "number" ? `${value}%` : "—"),
    },
    { key: "status", label: "Status", kind: "status", width: 120, value: (row) => row.status },
    {
      key: "surfaces",
      label: "Surfaces",
      kind: "number",
      align: "right",
      width: 100,
      value: (row) => row.surfaces,
    },
    { key: "ok", label: "ok", kind: "number", align: "right", width: 80, value: (row) => row.ok },
    {
      key: "degraded",
      label: "degraded",
      kind: "number",
      align: "right",
      width: 110,
      value: (row) => row.degraded,
    },
    {
      key: "failed",
      label: "down",
      kind: "number",
      align: "right",
      width: 90,
      value: (row) => row.failed,
    },
    {
      key: "checked",
      label: "Last probe",
      kind: "time",
      width: 130,
      demote: true,
      value: (row) => row.lastChecked,
    },
  ];

  const rawRows: RawRow[] = [
    ...API_PATHS.map((path) => ({
      label: path.replace("/api/v1/", ""),
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
    {
      label: "incidents feed",
      value: `${API_BASE}/api/v1/feeds/incidents.json`,
      href: `${API_BASE}/api/v1/feeds/incidents.json`,
    },
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--operational mg-hero--health"
        name="Health"
        sentence={
          <FactSentence>
            What is broken, across every probed surface and this site itself.
          </FactSentence>
        }
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={
          factCells(
            healthFacts(
              health.data.global as Parameters<typeof healthFacts>[0],
              incidents.isPending || incidents.isError ? null : openRows.length,
              (self.data?.data?.verdict as string | undefined) ?? null,
              { count: formatNumber },
              incidents.isPending ? "pending" : incidents.isError ? "error" : "ready",
            ),
          ) ?? undefined
        }
        live={{
          updatedAt: health.data.observed_at ?? null,
          source: "probed every 15 min",
          onRefresh: () =>
            void Promise.all([
              healthQuery.refetch(),
              incidents.refetch(),
              self.refetch(),
              ...(trendsNearViewport ? [trends.refetch()] : []),
            ]),
          refreshing:
            healthQuery.isFetching || incidents.isFetching || trends.isFetching || self.isFetching,
        }}
      />

      <AnalyticsSection
        className="mg-health-incidents"
        id="incidents"
        name="Incidents"
        question="Recorded outage events in this window."
        visual={
          <DataTable
            id="incidents"
            rows={shownIncidents}
            columns={incidentColumns}
            rowKey={(row) => row.key}
            caption="Recorded surface incidents"
            link={RouterLink}
            source="incident"
            storageKey="mg-health-incidents-columns"
            loading={incidents.isPending}
            error={
              incidents.isError ? (
                <ErrorState
                  error={incidents.error}
                  onRetry={() => void incidents.refetch()}
                  context="recorded incidents"
                />
              ) : undefined
            }
            filters={
              <FilterField label="State">
                <FilterSelect
                  value={search.incidents}
                  onChange={(event) => setSearch({ incidents: event.target.value })}
                >
                  <option value="open">Open now</option>
                  <option value="all">All in window</option>
                </FilterSelect>
              </FilterField>
            }
            empty="No incident records are currently open in this window."
          />
        }
        // One row per INCIDENT, not per surface: /api/v1/incidents groups by
        // surface, which answers "which surfaces had trouble" -- but a surface
        // with three separate outages is three answers to "what is broken".
        footnote={
          incidents.isPending
            ? "Loading recorded incidents · probe-derived"
            : incidents.isError
              ? "Recorded incidents are temporarily unavailable · probe-derived"
              : `${formatNumber(openRows.length)} open of ${formatNumber(
                  rows.length,
                )} in ${window} · probe-derived`
        }
      />

      <AnalyticsSection
        id="by-subnet"
        name="By subnet"
        question="Uptime over the window, worst first."
        visualRef={trendsRef}
        controls={
          <RangeControl
            label="Window"
            options={TREND_WINDOWS}
            value={window}
            onChange={(next) => setSearch({ window: next })}
          />
        }
        visual={
          !trendsNearViewport || trends.isPending ? (
            <MarkerRail
              loading
              loadingRows={8}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Uptime", name: "Subnet", scale: "Share of probes that answered" }}
              ariaLabel="Subnet uptime, worst first"
              source="subnet-health"
            />
          ) : trends.isError ? (
            <ErrorState
              error={trends.error}
              onRetry={() => void trends.refetch()}
              context="subnet uptime"
            />
          ) : subnets.some((row) => row.uptimePct != null) ? (
            <MarkerRail
              items={subnets
                .filter((row) => row.uptimePct != null)
                .slice(0, 20)
                .map((row) => ({
                  key: `sn-${row.netuid}`,
                  label: `SN${row.netuid} ${row.name}`,
                  value: row.uptimePct as number,
                  detail: `${formatNumber(row.surfaces)} surfaces · ${formatNumber(row.failed)} down`,
                }))}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Uptime", name: "Subnet", scale: "Share of probes that answered" }}
              ariaLabel="Subnet uptime, worst first"
              source="subnet-health"
            />
          ) : null
        }
        legend={
          !trends.isError ? (
            <DataTable
              id="subnet-health"
              rows={subnets}
              columns={subnetColumns}
              rowKey={(row) => String(row.netuid)}
              caption="Every probed subnet"
              rowHref={(row) => `/subnets/${row.netuid}`}
              link={RouterLink}
              source="subnet-health"
              storageKey="mg-health-subnets-columns"
              loading={!trendsNearViewport || trends.isPending}
              empty="No subnet has been probed in this window."
            />
          ) : null
        }
        // A subnet with no trend sample sorts LAST: `null` is "we have not
        // measured this", and ordering it beside the genuinely broken ones
        // would put the unknown at the top of a page whose job is naming what
        // is broken.
        footnote={
          !trendsNearViewport
            ? `${window} subnet uptime · probe-derived`
            : trends.isPending
              ? `Loading ${window} uptime · probe-derived`
              : trends.isError
                ? "Uptime trend is temporarily unavailable · probe-derived"
                : `${formatNumber(subnets.length)} probed subnets · ${window} · probe-derived`
        }
      />

      <AnalyticsSection
        id="trend"
        name="Trend"
        question="What share of probes answered, day by day."
        visual={
          !trendsNearViewport || trends.isPending ? (
            <LineWithWindow
              points={[]}
              window={{ from: 0, to: 0 }}
              unit="% of probes answered"
              formatValue={(value) => `${value}%`}
              ariaLabel={`Healthy share over ${window}`}
              source="health-trend"
              loading
            />
          ) : trends.isError ? (
            <p className="text-13 leading-relaxed text-ink-muted">
              Health trend unavailable. Retry the uptime reading above.
            </p>
          ) : points.length > 1 ? (
            <LineWithWindow
              points={points}
              window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
              unit="% of probes answered"
              formatValue={(value) => `${value}%`}
              ariaLabel={`Healthy share over ${window}`}
              source="health-trend"
            />
          ) : null
        }
        footnote={
          !trendsNearViewport
            ? `${window} · sample-weighted across subnets · probe-derived`
            : trends.isPending
              ? `Loading ${window} trend · probe-derived`
              : trends.isError
                ? "Health trend is temporarily unavailable · probe-derived"
                : `${window} · sample-weighted across subnets · probe-derived`
        }
      />

      <AnalyticsSection
        id="self-health"
        name="Self-health"
        question="Whether the thing telling you this is itself up."
        visual={
          self.isPending ? (
            <MarkerRail
              loading
              loadingRows={4}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Uptime", name: "Component", scale: "Share of checks that passed" }}
              ariaLabel="metagraphed's own component uptime"
              source="self-health"
            />
          ) : self.isError ? (
            <ErrorState
              error={self.error}
              onRetry={() => void self.refetch()}
              context="self-health"
            />
          ) : components.length > 0 ? (
            <MarkerRail
              items={components.map((component) => ({
                key: component.key,
                label: component.label,
                value: component.uptimePct ?? 0,
                detail: `${component.currentOk === null ? "unknown" : component.currentOk ? "ok now" : "down now"}${
                  component.latencyMs == null ? "" : ` · ${formatNumber(component.latencyMs)} ms`
                } · ${formatNumber(component.points.length)} days measured`,
              }))}
              max={100}
              formatValue={(value) => `${value}%`}
              columns={{ ratio: "Uptime", name: "Component", scale: "Share of checks that passed" }}
              ariaLabel="metagraphed's own component uptime"
              source="self-health"
            />
          ) : null
        }
        // The ratio is over the days a component REPORTS, not assumed to be 90:
        // a component measured for a week must not read as 8% available because
        // the other 83 days are missing.
        footnote={
          self.isPending
            ? "Loading self-health · self-probed"
            : self.isError
              ? "self-health is unavailable — this section cannot tell you whether the site is up"
              : components.length === 0
                ? "No self-health components are published"
                : "over the days each component reports · self-probed"
        }
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
