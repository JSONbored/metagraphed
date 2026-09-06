import type { Endpoint, EndpointIncident, RpcPool } from "@/lib/metagraphed/types";

/**
 * The derivations behind /apis/endpoints (#11623). Pure, so the page stays
 * one screen of wiring and every rule below is testable without a browser.
 */

export interface EndpointRow {
  id: string;
  provider: string | null;
  kind: string | null;
  url: string | null;
  netuid: number | null;
  subnet: string | null;
  status: string | null;
  latencyMs: number | null;
  lastChecked: string | null;
  lastOk: string | null;
  archive: boolean | null;
  poolEligible: boolean | null;
  authRequired: boolean | null;
  [key: string]: unknown;
}

export interface PoolRow {
  id: string;
  kind: string | null;
  members: number;
  eligible: number;
  readiness: number;
  archive: number;
  bestId: string | null;
  p50: number | null;
}

export interface IncidentRow {
  id: string;
  endpointId: string | null;
  /**
   * The surface the incident is against, e.g. `opentensor-finney-rpc`.
   *
   * The table had no column naming the endpoint, so three simultaneous
   * opentensor RPC incidents rendered as three byte-identical rows -- provider,
   * kind, subnet, reason, severity and state all equal -- and a reader could
   * not tell whether that was three endpoints or one row drawn three times
   * (#11693). Twelve incidents, twelve distinct surfaces.
   */
  surface: string | null;
  provider: string | null;
  kind: string | null;
  netuid: number | null;
  severity: string | null;
  /** Lifecycle: open while the incident has no end. */
  open: boolean;
  /** The probe's health reading — `down`, `warn`, `unknown`. */
  health: string | null;
  reason: string | null;
  detectedAt: string | null;
  lastChecked: string | null;
  lastOk: string | null;
}

/** How many endpoints the latency rail shows. */
export const LATENCY_LIMIT = 15;

/**
 * The three readings of the latency rail.
 *
 * `archive` is a filter rather than a sort: an archive node is the one an
 * indexer must use, and "how slow is the slowest archive node" is a different
 * question from "how slow is the slowest endpoint" only because the set is
 * different. Sorting it slowest-first keeps the reading consistent.
 */
export const LATENCY_VIEWS = [
  { value: "slowest", label: "Slowest" },
  { value: "fastest", label: "Fastest" },
  { value: "archive", label: "Archive" },
] as const;
export type LatencyView = (typeof LATENCY_VIEWS)[number]["value"];

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Flatten one /api/v1/endpoints row to what the page draws.
 *
 * Takes `Endpoint`, which is what `endpointsInfiniteQuery` returns. Its index
 * signature carries the probe fields the normalizer spreads through untouched,
 * so no cast is needed at the call site -- and a `Record<string, unknown>[]`
 * parameter would have forced one through `unknown`, erasing every
 * relationship the compiler could have checked.
 */
export function endpointRows(raw: readonly Endpoint[] | null | undefined): EndpointRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row, i) => ({
    ...row,
    id: str(row.id) ?? `endpoint-${i}`,
    provider: str(row.provider) ?? str(row.operator),
    kind: str(row.kind),
    url: str(row.url),
    netuid: num(row.netuid),
    subnet: str(row.subnet_name) ?? str(row.subnet_slug),
    status: str(row.status),
    latencyMs: num(row.latency_ms),
    lastChecked: str(row.last_checked) ?? str(row.observed_at),
    lastOk: str(row.last_ok),
    archive: flag(row.archive_support),
    poolEligible: flag(row.pool_eligible),
    authRequired: flag(row.auth_required),
  }));
}

/**
 * The managed pools, with readiness as eligible ÷ members.
 *
 * Readiness, not health: a pool member can be up and still be ineligible —
 * behind on blocks, missing an RPC method, rate-limited — and the number a
 * caller needs before pointing a client at a pool is how many members it can
 * actually be routed to, which is what `pool_eligible` counts.
 *
 * p50 is the MEDIAN of the members that reported a latency, not the mean: one
 * unreachable member reporting a 30-second timeout would drag a mean across
 * the whole pool and describe none of it.
 */
export function poolRows(raw: readonly RpcPool[] | null | undefined): PoolRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((pool, i) => {
      const members = Array.isArray(pool.endpoints)
        ? (pool.endpoints as Record<string, unknown>[])
        : [];
      const count = num(pool.endpoint_count) ?? members.length;
      const eligible =
        num(pool.eligible_count) ?? members.filter((m) => m.pool_eligible === true).length;
      return {
        id: str(pool.id) ?? `pool-${i}`,
        kind: str(pool.kind),
        members: count,
        eligible,
        readiness: count > 0 ? Math.round((eligible / count) * 1000) / 10 : 0,
        archive: members.filter((m) => m.archive_support === true).length,
        bestId: str(pool.best_endpoint_id),
        p50: median(members.map((m) => num(m.latency_ms)).filter((v): v is number => v != null)),
      };
    })
    .sort((a, b) => b.readiness - a.readiness || a.id.localeCompare(b.id));
}

/** The middle value, or null for nothing. Averages a pair on an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

export interface LatencyRail {
  key: string;
  label: string;
  value: number;
  href?: string;
  detail: { key: string; label: string; value: string }[];
}

/**
 * The latency rail for one view.
 *
 * Only endpoints that REPORTED a latency are ranked. An endpoint with
 * `latency_ms: null` was not measured — it is unreachable, or it is one of the
 * 2,770 the prober does not monitor — and ranking it as 0 ms would put every
 * dead endpoint at the top of "fastest".
 */
export function latencyRails(
  rows: readonly EndpointRow[],
  view: LatencyView,
  limit = LATENCY_LIMIT,
): LatencyRail[] {
  const measured = rows.filter((row) => row.latencyMs != null && row.latencyMs > 0);
  const pool = view === "archive" ? measured.filter((row) => row.archive) : measured;
  const sorted = [...pool].sort((a, b) =>
    view === "fastest" ? a.latencyMs! - b.latencyMs! : b.latencyMs! - a.latencyMs!,
  );
  return sorted.slice(0, limit).map((row) => ({
    key: row.provider ?? row.id,
    label: [row.provider, row.kind].filter(Boolean).join(" · ") || row.id,
    value: row.latencyMs!,
    href: row.netuid == null ? undefined : `/subnets/${row.netuid}`,
    detail: [
      { key: "status", label: "Status", value: row.status ?? "unknown" },
      {
        key: "archive",
        label: "Archive",
        value: row.archive == null ? "unknown" : row.archive ? "yes" : "no",
      },
      {
        key: "pool",
        label: "Pool-eligible",
        value: row.poolEligible == null ? "unknown" : row.poolEligible ? "yes" : "no",
      },
    ],
  }));
}

/**
 * Flatten one /api/v1/endpoint-incidents row.
 *
 * OPEN is read from `ended_at`, not from `state`. The API publishes a
 * lifecycle `state` of `active` / `resolved`, but `normalizeIncident` rewrites
 * that field into a HEALTH state (`down` / `warn` / `unknown`) before this
 * ever sees it -- so a filter comparing `state === "active"` matches nothing,
 * and the page reported 0 open incidents against a feed of 131. `ended_at` is
 * where the normalizer preserves the lifecycle, and an incident with no end is
 * by definition still open.
 */
export function incidentRows(raw: readonly EndpointIncident[] | null | undefined): IncidentRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row, i) => ({
    id: str(row.id) ?? `incident-${i}`,
    endpointId: str(row.endpoint_id),
    surface: str(row.surface_id) ?? str(row.surface_key) ?? str(row.endpoint_id),
    provider: str(row.provider) ?? str(row.operator),
    kind: str(row.kind),
    netuid: num(row.netuid),
    severity: str(row.severity),
    open: str(row.ended_at) === null,
    health: str(row.state),
    reason: str(row.message) ?? str(row.reason) ?? str(row.classification),
    detectedAt: str(row.started_at) ?? str(row.detected_at),
    lastChecked: str(row.last_checked) ?? str(row.observed_at),
    lastOk: str(row.last_ok),
  }));
}

export interface Fact {
  key: string;
  label: string;
  value: string;
  loading?: boolean;
}

/**
 * The hero.
 *
 * The healthy share is over the MONITORED endpoints, not over all of them.
 * `by_status` counts 507 ok, 107 degraded, 7 failed and 2,770 unknown, and
 * "unknown" is 82% of the catalogue — surfaces the prober does not watch.
 * Dividing 507 by 3,391 would report 15% healthy for a fleet that is 83%
 * healthy where it is measured, which is a claim about coverage dressed up as
 * a claim about health.
 */
export function endpointFacts(
  summary:
    | { endpoint_count?: number; monitored_count?: number; by_status?: Record<string, number> }
    | null
    | undefined,
  pools: number | null,
  openIncidents: number | null,
  fmt: { count: (n: number) => string },
  pending: { pools?: boolean; incidents?: boolean } = {},
): Fact[] {
  if (!summary) return [];
  const status = summary.by_status ?? {};
  const ok = status.ok ?? 0;
  const degraded = status.degraded ?? 0;
  const failed = status.failed ?? 0;
  const measured = ok + degraded + failed;
  const facts: Fact[] = [];
  if (typeof summary.endpoint_count === "number") {
    facts.push({ key: "tracked", label: "Tracked", value: fmt.count(summary.endpoint_count) });
  }
  if (measured > 0) {
    // The denominator moves into the VALUE. As a chip the label could carry
    // it ("healthy of 112 probed 95%"); as a 10px cell label over a 28px
    // number it was the longest label in the strip and the only one that
    // changed length with the data (#11696).
    facts.push({
      key: "healthy",
      label: "Healthy",
      value: `${Math.round((ok / measured) * 100)}% of ${fmt.count(measured)}`,
    });
  }
  if (pools != null || pending.pools) {
    facts.push({
      key: "pools",
      label: "RPC pools",
      value: pools == null ? "—" : fmt.count(pools),
      ...(pending.pools ? { loading: true } : {}),
    });
  }
  if (degraded > 0)
    facts.push({ key: "degraded", label: "Degraded now", value: fmt.count(degraded) });
  if (openIncidents != null || pending.incidents) {
    facts.push({
      key: "incidents",
      label: "Open incidents",
      value: openIncidents == null ? "—" : fmt.count(openIncidents),
      ...(pending.incidents ? { loading: true } : {}),
    });
  }
  return facts;
}

/** The distinct values of one field, sorted, for a filter select. */
export function facet<Row>(
  rows: readonly Row[],
  of: (row: Row) => string | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = of(row)?.trim();
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** The API measures its bound before trimming, using JavaScript string length. */
export const ENDPOINT_SEARCH_MAX_LENGTH = 200;

/** Only a recorded non-negative integer is an exact matched-result count. */
export function endpointMatchCount(total: unknown): number | null {
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null;
}
