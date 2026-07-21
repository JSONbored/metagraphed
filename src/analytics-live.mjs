// Shared live analytics loaders for MCP/GraphQL/REST parity (#1958).
//
// D1 fully eliminated (2026-07-17): these loaders no longer read D1 -- every
// route (REST/GraphQL/MCP) tries the Postgres tier first, and a miss falls
// through to the schema-stable empty shape built here. Pure orchestration
// over registry projections only now.

import {
  formatGlobalIncidents,
  formatIncidents,
  formatLeaderboards,
  formatPercentiles,
  formatTrends,
  formatUptime,
} from "./health-serving.mjs";
import {
  ANALYTICS_WINDOWS,
  HEALTH_TREND_WINDOWS,
  MAX_INCIDENT_ROWS,
  SS58_ADDRESS_PATTERN,
  UPTIME_WINDOWS,
} from "../workers/config.ts";
import { composeCompareData } from "../workers/request-handlers/analytics-routes.mjs";

export { composeCompareData };
export const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const COMPARE_NETUIDS_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;

export function profilesProjectionFromRows(profiles) {
  const subnetMeta = new Map();
  const mostComplete = [];
  for (const profile of profiles || []) {
    if (!Number.isInteger(profile.netuid)) continue;
    subnetMeta.set(profile.netuid, {
      slug: profile.slug ?? null,
      name: profile.name ?? null,
    });
    mostComplete.push({
      netuid: profile.netuid,
      slug: profile.slug ?? null,
      name: profile.name ?? null,
      completeness_score: profile.completeness_score ?? null,
      surface_count: profile.surface_count ?? 0,
      operational_interface_count: profile.operational_interface_count ?? 0,
    });
  }
  return { subnetMeta, mostComplete };
}

export function growthRowsFromSamples(growthSamples) {
  const growthByNetuid = new Map();
  for (const row of growthSamples || []) {
    // D1 can hand the INTEGER netuid back as a numeric string on this GROUP BY
    // read path; the emitted netuid keys the integer-keyed subnetMeta map in
    // formatLeaderboards, so a raw string netuid drops the fastest-growing entry's
    // slug/name metadata. Accept only a real number or an all-digits string so a
    // blank/null/false cell is dropped, never read as subnet 0.
    const netuid =
      typeof row.netuid === "number"
        ? row.netuid
        : typeof row.netuid === "string" && /^\d+$/.test(row.netuid)
          ? Number(row.netuid)
          : null;
    if (netuid == null || !Number.isInteger(netuid) || netuid < 0) continue;
    const entry = growthByNetuid.get(netuid) || {
      first: null,
      last: null,
    };
    // Latch the window's first and last *non-null* completeness scores. Rows
    // arrive ordered by (netuid, snapshot_date), so a subnet whose earliest
    // in-window snapshot has no score yet (completeness_score is a nullable
    // INTEGER) must not have `first` pinned to null: the old `=== undefined`
    // guard fired on the first row regardless, so a leading NULL froze `first`
    // at null for the whole subnet, collapsing its delta to null. That silently
    // dropped a genuinely fast-growing subnet from the "fastest-growing"
    // leaderboard, which filters out null deltas. Skipping NULL scores here
    // makes `first`/`last` the first/last real scores (a trailing NULL no
    // longer poisons `last` either); an all-NULL subnet still yields null.
    const score = row.completeness_score ?? null;
    if (score != null) {
      if (entry.first == null) entry.first = score;
      entry.last = score;
    }
    growthByNetuid.set(netuid, entry);
  }
  return [...growthByNetuid.entries()].map(([netuid, entry]) => ({
    netuid,
    delta:
      entry.first != null && entry.last != null
        ? Number(entry.last) - Number(entry.first)
        : null,
  }));
}

export function parseCompareNetuids(netuidsRaw) {
  if (!netuidsRaw || !COMPARE_NETUIDS_PATTERN.test(netuidsRaw)) return null;
  const requestedNetuids = [];
  const seenNetuids = new Set();
  for (const part of netuidsRaw.split(",")) {
    const netuid = Number(part);
    if (seenNetuids.has(netuid)) continue;
    seenNetuids.add(netuid);
    requestedNetuids.push(netuid);
  }
  return requestedNetuids;
}

export function parseCompareNetuidList(netuids) {
  if (!Array.isArray(netuids) || netuids.length === 0) return null;
  const requestedNetuids = [];
  const seenNetuids = new Set();
  for (const value of netuids) {
    if (!Number.isInteger(value) || value < 0) return null;
    if (seenNetuids.has(value)) continue;
    seenNetuids.add(value);
    requestedNetuids.push(value);
  }
  if (requestedNetuids.length > 128) return null;
  return requestedNetuids;
}

// compare_validators/compare-validators (#6035/#6325) share this same cap and
// SS58 validation with parseCompareNetuids/parseCompareNetuidList above --
// one hotkey-list contract for both the REST query string and the MCP array.
export const COMPARE_VALIDATORS_MAX = 16;
const COMPARE_HOTKEYS_PATTERN =
  /^[1-9A-HJ-NP-Za-km-z]{47,48}(,[1-9A-HJ-NP-Za-km-z]{47,48}){0,15}$/;

export function parseCompareHotkeys(hotkeysRaw) {
  if (!hotkeysRaw || !COMPARE_HOTKEYS_PATTERN.test(hotkeysRaw)) return null;
  const hotkeys = [];
  const seen = new Set();
  for (const part of hotkeysRaw.split(",")) {
    if (seen.has(part)) continue;
    seen.add(part);
    hotkeys.push(part);
  }
  return hotkeys;
}

export function parseCompareHotkeyList(hotkeys) {
  if (!Array.isArray(hotkeys) || hotkeys.length === 0) return null;
  const result = [];
  const seen = new Set();
  for (const value of hotkeys) {
    if (typeof value !== "string" || !SS58_ADDRESS_PATTERN.test(value)) {
      return null;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  if (result.length > COMPARE_VALIDATORS_MAX) return null;
  return result;
}

export function parseCompareDimensions(dimensionsRaw) {
  if (dimensionsRaw === null || dimensionsRaw === undefined) {
    return COMPARE_DIMENSIONS;
  }
  return compareDimensionsFromTokens(String(dimensionsRaw).split(","));
}

export function parseCompareDimensionList(dimensions) {
  if (dimensions === undefined || dimensions === null) {
    return COMPARE_DIMENSIONS;
  }
  if (!Array.isArray(dimensions) || dimensions.length === 0) return null;
  return compareDimensionsFromTokens(dimensions);
}

function compareDimensionsFromTokens(tokens) {
  const requested = [];
  for (const token of tokens) {
    const trimmed = String(token).trim();
    if (trimmed === "") return null;
    requested.push(trimmed);
  }
  const unknown = requested.find((d) => !COMPARE_DIMENSIONS.includes(d));
  if (unknown !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => requested.includes(d));
}

// D1 fully eliminated (2026-07-17): surface_uptime_daily is Postgres-only now
// (REST/GraphQL/MCP all try the Postgres tier first) -- this loader is only
// reached on a tier miss, so it always returns the schema-stable empty shape.
export async function loadSubnetUptime(
  netuid,
  { window = "90d", observedAt = null, now = null } = {},
) {
  const windowParam = Object.hasOwn(UPTIME_WINDOWS, window) ? window : "90d";
  return formatUptime({
    netuid,
    window: windowParam,
    observedAt,
    rows: [],
    now: now || new Date().toISOString(),
  });
}

// One subnet's 7d/30d uptime + latency trend per operational surface, over the
// ranked-dedup CTE shared with the percentiles/incidents routes. The windows are
// independent reads, so they run in parallel rather than serializing an
// await-in-loop — same shape as REST's handleHealthTrends, which this mirrors.
// D1 fully eliminated (2026-07-17): surface_checks is Postgres-only now; this
// loader is only reached on a Postgres-tier miss, so every window is empty.
export async function loadSubnetHealthTrends(
  netuid,
  { observedAt = null } = {},
) {
  const windows = {};
  for (const label of Object.keys(HEALTH_TREND_WINDOWS)) {
    windows[label] = [];
  }
  return formatTrends({ netuid, observedAt, windows });
}

// p50/p95/p99 (+avg/min/max) request-latency percentiles per operational surface
// for one subnet over a 7d/30d window, from the live surface_checks history. The
// query + formatting live here so the REST handler (handleHealthPercentiles) and
// the get_subnet_health_percentiles MCP tool share one read path (mirrors
// loadSubnetHealthTrends, #2335). Defensively defaults an unknown window to 7d;
// cold/empty D1 → a schema-stable surfaces:[] payload.
// D1 fully eliminated (2026-07-17): surface_checks is Postgres-only now; this
// loader is only reached on a Postgres-tier miss, so rows are always empty.
export async function loadSubnetPercentiles(
  netuid,
  { window = "7d", observedAt = null } = {},
) {
  const windowParam = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  return formatPercentiles({
    netuid,
    window: windowParam,
    observedAt,
    rows: [],
  });
}

// Per-surface SLA + reconstructed downtime incidents for one subnet over a 7d/30d
// window, from the live surface_checks history: an SLA rollup (samples + uptime
// ratio) joined with gap-island-grouped failure incidents (consecutive failures
// within the incident gap collapse into one, capped per surface). The query +
// formatting live here so the REST handler (handleHealthIncidents) and the
// get_subnet_health_incidents MCP tool share one read path (mirrors
// loadSubnetPercentiles). Unknown window → 7d; cold/empty D1 → surfaces:[].
// D1 fully eliminated (2026-07-17): surface_checks is Postgres-only now; this
// loader is only reached on a Postgres-tier miss, so both row sets are empty.
export async function loadSubnetIncidents(
  netuid,
  { window = "7d", observedAt = null } = {},
) {
  const windowParam = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  return formatIncidents({
    netuid,
    window: windowParam,
    observedAt,
    slaRows: [],
    incidentRows: [],
    maxIncidents: MAX_INCIDENT_ROWS,
  });
}

// D1 fully eliminated (2026-07-17): surface_checks is Postgres-only now; this
// loader is only reached on a Postgres-tier miss, so incidentRows is empty.
export async function loadGlobalIncidents({
  windowLabel = "7d",
  observedAt = null,
} = {}) {
  return formatGlobalIncidents({
    window: windowLabel,
    observedAt,
    incidentRows: [],
    maxIncidents: MAX_INCIDENT_ROWS,
  });
}

// D1 fully eliminated (2026-07-17): surface_status/subnet_snapshots/
// surface_uptime_daily are Postgres-only now; the health/rpc/growth/
// reliability row sets are always empty here. `profiles`/`economicsRows`
// aren't D1 -- they come from the registry artifact + the economics tier --
// so those inputs are unchanged.
export async function loadRegistryLeaderboards({
  profiles = [],
  economicsRows = [],
  board = null,
  limit = null,
  observedAt = null,
} = {}) {
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  return formatLeaderboards({
    board,
    limit,
    observedAt,
    healthRows: [],
    rpcRows: [],
    mostComplete,
    growthRows: growthRowsFromSamples([]),
    reliabilityRows: [],
    economicsRows,
    subnetMeta,
  });
}

// D1 fully eliminated (2026-07-17): surface_status is Postgres-only now, so
// the health dimension is always empty here. `profiles`/`economicsRows`
// aren't D1, so those inputs are unchanged.
export async function loadCompareSubnets({
  profiles = [],
  economicsRows = [],
  netuids,
  dimensions = COMPARE_DIMENSIONS,
  observedAt = null,
} = {}) {
  if (!Array.isArray(netuids) || netuids.length === 0) {
    return composeCompareData({
      requestedNetuids: [],
      dimensions,
      subnetMeta: new Map(),
      structureRows: [],
      economicsRows: dimensions.includes("economics") ? economicsRows : null,
      healthRows: [],
      observedAt,
    });
  }
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  return composeCompareData({
    requestedNetuids: netuids,
    dimensions,
    subnetMeta,
    structureRows: mostComplete,
    economicsRows: dimensions.includes("economics") ? economicsRows : null,
    healthRows: dimensions.includes("health") ? [] : null,
    observedAt,
  });
}

// #4909/#4772 D1 retirement: loadChainCalls, loadChainFees, and loadNetworkActivity (all read
// the extrinsics/blocks D1 tables) were removed here — that D1 write path is
// retired and the tables are dropped in production, so a live D1 query would
// always miss. Serving now goes tryPostgresTier -> buildChainCalls([...]) /
// buildChainFees([...]) / buildChainActivity([...]) (all still exported from
// ./chain-analytics.mjs), never D1. See workers/request-handlers/analytics.mjs's
// handleChainCalls / handleChainFees / handleChainActivity and
// src/mcp-server.mjs's get_chain_calls tool for the call sites.

export function parseAnalyticsWindow(window) {
  if (window === null || window === undefined) {
    return { label: "7d", days: ANALYTICS_WINDOWS["7d"] };
  }
  if (!Object.hasOwn(ANALYTICS_WINDOWS, window)) return null;
  return { label: window, days: ANALYTICS_WINDOWS[window] };
}

export function parseUptimeWindow(window) {
  if (window === null || window === undefined) {
    return "90d";
  }
  return Object.hasOwn(UPTIME_WINDOWS, window) ? window : null;
}
