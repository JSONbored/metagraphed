/**
 * The derivations behind the merged /health page (#11625). Pure, so the page
 * stays one screen of wiring and every rule below is testable without a
 * browser.
 */

import { TRAILING_WINDOWS, type TrailingWindow } from "@/lib/metagraphed/url-state";

/**
 * The range control's options, DERIVED from the vocabulary's owner rather than
 * restated: `TRAILING_WINDOWS` is the single source (#11614), and a hand-typed
 * copy is how the control and the query end up offering different sets.
 */
export const TREND_WINDOWS = TRAILING_WINDOWS.map((value) => ({ value, label: value }));
export type TrendWindow = TrailingWindow;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export interface IncidentRow {
  key: string;
  netuid: number | null;
  surfaceId: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  failedSamples: number | null;
  open: boolean;
}

/**
 * One row per INCIDENT, not per surface.
 *
 * /api/v1/incidents groups by surface and nests the incidents inside, which
 * answers "which surfaces had trouble" — but the page's question is "what is
 * broken", and a surface with three separate outages is three answers. Open
 * first, then newest: an incident still running is the only kind anyone can
 * act on.
 */
export function incidentRows(
  surfaces: readonly Record<string, unknown>[] | null | undefined,
): IncidentRow[] {
  const rows: IncidentRow[] = [];
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    const surfaceId = str(surface.surface_id) ?? "unknown";
    const netuid = num(surface.netuid);
    const list = Array.isArray(surface.incidents)
      ? (surface.incidents as Record<string, unknown>[])
      : [];
    list.forEach((incident, i) => {
      const started = num(incident.started_at);
      const ended = num(incident.ended_at);
      rows.push({
        key: `${surfaceId}-${i}`,
        netuid,
        surfaceId,
        startedAt: started == null ? null : new Date(started).toISOString(),
        endedAt: ended == null ? null : new Date(ended).toISOString(),
        durationMs: num(incident.duration_ms),
        failedSamples: num(incident.failed_samples),
        open: ended == null,
      });
    });
  }
  return rows.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

/** `2h 15m`, `45s`, or an em-dash. Never a raw millisecond count. */
export function humaniseDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface SubnetHealthRow {
  netuid: number;
  name: string;
  status: string | null;
  surfaces: number;
  ok: number;
  degraded: number;
  failed: number;
  /** 0–100, from the trends window; null when the window has no sample. */
  uptimePct: number | null;
  lastChecked: string | null;
}

/**
 * Per-subnet health, joined to the trend window's uptime ratio.
 *
 * Worst first, and a subnet with no trend sample sorts LAST rather than first:
 * `null` is "we have not measured this", and ordering it beside the genuinely
 * broken ones would put the unknown at the top of a page whose whole job is
 * naming what is broken.
 */
export function subnetHealthRows(
  subnets: readonly Record<string, unknown>[] | null | undefined,
  trend: readonly Record<string, unknown>[] | null | undefined,
): SubnetHealthRow[] {
  const uptime = new Map<number, number>();
  for (const row of Array.isArray(trend) ? trend : []) {
    const netuid = num(row.netuid);
    const ratio = num(row.uptime_ratio);
    if (netuid != null && ratio != null) uptime.set(netuid, Math.round(ratio * 1000) / 10);
  }
  return (Array.isArray(subnets) ? subnets : [])
    .map((row) => {
      const netuid = num(row.netuid) ?? 0;
      return {
        netuid,
        name: str(row.name) ?? `sn-${netuid}`,
        status: str(row.status),
        surfaces: num(row.surface_count) ?? 0,
        ok: num(row.ok_count) ?? 0,
        degraded: num(row.degraded_count) ?? 0,
        failed: num(row.failed_count) ?? 0,
        uptimePct: uptime.get(netuid) ?? null,
        lastChecked: str(row.last_checked),
      };
    })
    .sort((a, b) => {
      if ((a.uptimePct == null) !== (b.uptimePct == null)) return a.uptimePct == null ? 1 : -1;
      return (a.uptimePct ?? 0) - (b.uptimePct ?? 0) || a.netuid - b.netuid;
    });
}

export interface TrendPoint {
  t: number;
  v: number;
}

/**
 * The fleet's daily healthy share, from the existing `bulkTrendDays`.
 *
 * Not a second aggregator: `bulkTrendDays` already collapses every subnet's
 * `points[]` into one sample-weighted series and is unit-tested, and a page
 * that computed the same number a different way would give the site two
 * answers to one question. This only turns its ratios into the percentages the
 * chart plots.
 */
export function trendPoints(
  days: readonly { date: string; uptime_ratio: number }[] | null | undefined,
): TrendPoint[] {
  return (Array.isArray(days) ? days : [])
    .map((day) => ({
      t: Date.parse(`${day.date}T00:00:00Z`),
      v: Math.round(day.uptime_ratio * 1000) / 10,
    }))
    .filter((point) => Number.isFinite(point.t))
    .sort((a, b) => a.t - b.t);
}

export interface SelfComponent {
  key: string;
  label: string;
  /** 0–100 over the published day series. */
  uptimePct: number | null;
  currentOk: boolean | null;
  latencyMs: number | null;
  points: TrendPoint[];
}

/**
 * metagraphed's own components, each with its day series.
 *
 * The headline ratio is computed over the DAYS the component reports, not
 * assumed to be 90: a component that has only been measured for a week must
 * not read as 8% available because the other 83 days are missing.
 */
export function selfComponents(
  components: readonly Record<string, unknown>[] | null | undefined,
): SelfComponent[] {
  return (Array.isArray(components) ? components : []).map((component, i) => {
    const days = Array.isArray(component.days) ? (component.days as Record<string, unknown>[]) : [];
    const ratios = days.map((day) => num(day.uptime_ratio)).filter((r): r is number => r != null);
    return {
      key: str(component.component) ?? `component-${i}`,
      label: str(component.component) ?? `component ${i}`,
      uptimePct:
        ratios.length > 0
          ? Math.round((ratios.reduce((sum, r) => sum + r, 0) / ratios.length) * 1000) / 10
          : null,
      currentOk: typeof component.current_ok === "boolean" ? component.current_ok : null,
      latencyMs: num(component.latency_ms),
      points: days
        .map((day) => ({
          t: Date.parse(`${str(day.day)}T00:00:00Z`),
          // Rounded, not raw: 0.57 * 100 is 56.99999999999999 in binary
          // floating point, and a tooltip reading "56.99999999999999%" is a
          // bug the chart cannot hide.
          v: Math.round((num(day.uptime_ratio) ?? 0) * 1000) / 10,
        }))
        .filter((point) => Number.isFinite(point.t))
        .sort((a, b) => a.t - b.t),
    };
  });
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * The hero.
 *
 * The three status counts are of PROBED surfaces — /api/v1/health's `global`
 * block counts only what the prober watches, which is the set this page is
 * about. The self-health verdict rides at the end because "is the thing
 * telling me what is broken itself broken" is the one question a status page
 * must answer before any of its own numbers mean anything.
 */
export function healthFacts(
  global: { surface_count?: number; status_counts?: Record<string, number> } | null | undefined,
  openIncidents: number,
  verdict: string | null,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (!global) return [];
  const counts = global.status_counts ?? {};
  const facts: Fact[] = [];
  if (typeof global.surface_count === "number") {
    facts.push({ key: "probed", label: "Probed surfaces", value: fmt.count(global.surface_count) });
  }
  for (const [key, label] of [
    ["ok", "ok"],
    ["degraded", "degraded"],
    ["failed", "down"],
  ] as const) {
    if (typeof counts[key] === "number") {
      facts.push({ key, label, value: fmt.count(counts[key]) });
    }
  }
  facts.push({ key: "incidents", label: "Open incidents", value: fmt.count(openIncidents) });
  if (verdict) facts.push({ key: "self", label: "Metagraphed itself", value: verdict });
  return facts;
}
