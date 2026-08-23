import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
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

  const health = useSuspenseQuery(healthSubnetsQuery()).data;
  const trends = useQuery({ ...bulkHealthTrendsQuery(), retry: 0 });
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
        name="Health"
        sentence={
          <FactSentence>
            What is broken, across every probed surface and this site itself.{" "}
            {healthFacts(
              health.data.global as Parameters<typeof healthFacts>[0],
              openRows.length,
              (self.data?.data?.verdict as string | undefined) ?? null,
              { count: formatNumber },
            ).map((fact) => (
              <Fact key={fact.key}>
                {fact.label} {fact.value}
              </Fact>
            ))}
          </FactSentence>
        }
        live={{
          updatedAt: health.data.observed_at ?? null,
          source: "probed every 15 min",
          onRefresh: () => void incidents.refetch(),
          refreshing: incidents.isFetching,
        }}
      />

      <AnalyticsSection
        id="incidents"
        name="Incidents"
        question="What is down now, and what was."
        visual={
          <DataTable
            id="incidents"
            rows={shownIncidents}
            columns={incidentColumns}
            rowKey={(row) => row.key}
            caption="Surface incidents"
            link={RouterLink}
            source="incident"
            storageKey="mg-health-incidents-columns"
            loading={incidents.isPending}
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
            empty="Nothing is down in this window."
          />
        }
        // One row per INCIDENT, not per surface: /api/v1/incidents groups by
        // surface, which answers "which surfaces had trouble" -- but a surface
        // with three separate outages is three answers to "what is broken".
        footnote={`${formatNumber(openRows.length)} open of ${formatNumber(
          rows.length,
        )} in ${window} · probe-derived`}
      />

      <AnalyticsSection
        id="by-subnet"
        name="By subnet"
        question="Uptime over the window, worst first."
        controls={
          <RangeControl
            label="Window"
            options={TREND_WINDOWS}
            value={window}
            onChange={(next) => setSearch({ window: next })}
          />
        }
        visual={
          subnets.some((row) => row.uptimePct != null) ? (
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
            empty="No subnet has been probed in this window."
          />
        }
        // A subnet with no trend sample sorts LAST: `null` is "we have not
        // measured this", and ordering it beside the genuinely broken ones
        // would put the unknown at the top of a page whose job is naming what
        // is broken.
        footnote={`${formatNumber(subnets.length)} probed subnets · ${window} · probe-derived`}
      />

      <AnalyticsSection
        id="trend"
        name="Trend"
        question="What share of probes answered, day by day."
        visual={
          points.length > 1 ? (
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
        footnote={`${window} · sample-weighted across subnets · probe-derived`}
      />

      <AnalyticsSection
        id="self-health"
        name="Self-health"
        question="Whether the thing telling you this is itself up."
        visual={
          components.length > 0 ? (
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
          self.isError
            ? "self-health is unavailable — this section cannot tell you whether the site is up"
            : "over the days each component reports · self-probed"
        }
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
