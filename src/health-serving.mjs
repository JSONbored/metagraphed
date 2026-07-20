// Live operational-health serving helpers.
//
// Pure functions that overlay the 15-minute cron snapshot (KV health:current /
// health:rpc-pool / health:meta, written by src/health-prober.mjs) onto the 6h
// static artifacts. Every helper returns null when the live store is cold/absent
// so the caller (workers/api.mjs) falls back to the static artifact — keeping
// serving zero-downtime and regression-proof. No I/O here: callers pass parsed
// objects + D1 rows in.

import {
  computeReliability,
  scoreFromStats,
  displayUptimeRatio,
} from "./reliability.mjs";
import {
  rollupSubnetStatus,
  normalizeProbeStatus,
  okLatencyMs,
} from "./health-probe-core.mjs";
import { KV_ECONOMICS_CURRENT, KV_HEALTH_CURRENT } from "./kv-keys.mjs";
import { tryPostgresTier } from "../workers/postgres-tier.mjs";

// Must exceed the probe cadence (15 min) so a live D1 health row is never treated
// as stale just because the next probe hasn't run yet. 25 min = cadence + a
// one-missed-run buffer. (KV health:current has no TTL, so this only bounds the
// D1 fallback path.)
const D1_HEALTH_FALLBACK_MAX_AGE_MS = 25 * 60 * 1000;

// Pool-eligibility hysteresis (cosmos.directory-style "don't flap"): an RPC
// endpoint is only dropped from the proxy pool after this many CONSECUTIVE
// failed probes, so a single transient blip doesn't evict an otherwise-healthy
// node. At the 15-min probe cadence, 2 (~30 min sustained-down) removes genuinely
// dead nodes while the RPC proxy still fails over per-request in the meantime.
// Env-overridable.
const POOL_SUSTAINED_DOWN_FAILURES = Math.max(
  1,
  Number(globalThis.process?.env?.METAGRAPH_POOL_SUSTAINED_DOWN_FAILURES) || 2,
);

const OPERATIONAL_KINDS = new Set([
  "subtensor-rpc",
  "subtensor-wss",
  "archive",
  "subnet-api",
  "sse",
  "data-artifact",
]);

function isBaseLayerEndpoint(kind) {
  return kind === "subtensor-rpc" || kind === "subtensor-wss";
}

function surfaceLookupKey(row) {
  return row?.surface_key || row?.surface_id || null;
}

function addLiveSurfaceRow(map, row) {
  const key = surfaceLookupKey(row);
  if (key) map.set(key, row);
  // Fallback for pre-#1005 artifacts/caches that only carry surface_id. Do not
  // overwrite a stable-key match when an id happens to collide.
  if (row?.surface_id && !map.has(row.surface_id)) {
    map.set(row.surface_id, row);
  }
}

function liveRowForSurface(map, surface) {
  return (
    (surface?.surface_key ? map.get(surface.surface_key) : null) ||
    (surface?.surface_id ? map.get(surface.surface_id) : null) ||
    null
  );
}

function endpointPoolEligibility(endpoint) {
  const reasons = [];
  if (!isBaseLayerEndpoint(endpoint.kind)) {
    reasons.push("not-bittensor-base-layer");
  }
  if (endpoint.status !== "ok") {
    reasons.push(`status-${endpoint.status || "unknown"}`);
  }
  if (endpoint.auth_required !== false) {
    reasons.push("auth-required");
  }
  if (endpoint.public_safe !== true) {
    reasons.push("not-public-safe");
  }
  return {
    eligible: reasons.length === 0,
    reasons: reasons.length ? reasons : ["eligible"],
  };
}

function latestIso(values) {
  let best = null;
  for (const value of values) {
    if (value && (!best || value > best)) best = value;
  }
  return best;
}

// Summarize a set of serving rows ({status, latency_ms, last_checked, last_ok}).
export function summarizeRows(rows) {
  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  const latencies = [];
  for (const row of rows) {
    const status = normalizeProbeStatus(row.status);
    counts[status] += 1;
    const latency = okLatencyMs(status, row.latency_ms);
    if (latency != null) latencies.push(latency);
  }
  return {
    status: rollupSubnetStatus({ ...counts, total: rows.length }),
    surface_count: rows.length,
    ok_count: counts.ok,
    degraded_count: counts.degraded,
    failed_count: counts.failed,
    unknown_count: counts.unknown,
    last_checked: latestIso(rows.map((r) => r.last_checked)),
    last_ok: latestIso(rows.map((r) => r.last_ok)),
    avg_latency_ms: latencies.length
      ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
      : null,
    latency_sample_count: latencies.length,
  };
}

// Per-subnet overlay: build the response from fresh live rows only. Static
// metadata may supply non-operational identity fields, but stale static surface
// rows are never preserved. Returns null when there is no live snapshot.
export function overlaySubnetHealth(staticArtifact, liveCurrent, netuid) {
  if (!liveCurrent || !Array.isArray(liveCurrent.surfaces)) return null;
  const liveBySurface = new Map();
  for (const row of liveCurrent.surfaces) {
    if (row.netuid === netuid) addLiveSurfaceRow(liveBySurface, row);
  }
  if (liveBySurface.size === 0) return null;

  const merged = [];
  for (const live of new Map(
    [...liveBySurface.values()].map((row) => [surfaceLookupKey(row), row]),
  ).values()) {
    merged.push({
      surface_id: live.surface_id,
      netuid,
      kind: live.kind,
      provider: live.provider,
      url: live.url,
      status: normalizeProbeStatus(live.status),
      classification: live.classification,
      latency_ms: live.latency_ms,
      status_code: live.status_code,
      last_checked: live.last_checked,
      last_ok: live.last_ok,
      observed_by: "live-cron-prober",
    });
  }

  return {
    schema_version: staticArtifact?.schema_version ?? 1,
    contract_version: staticArtifact?.contract_version,
    generated_at: staticArtifact?.generated_at,
    netuid,
    slug: staticArtifact?.slug,
    name: staticArtifact?.name,
    summary: summarizeRows(merged),
    operational_observed_at: liveCurrent.last_run_at || null,
    surfaces: merged,
  };
}

// Global operational health (fresh): the live per-subnet operational rollup +
// global counts. Returns null when the snapshot is cold so the caller serves the
// static summary (and labels the source correctly).
export function buildGlobalHealth(liveCurrent, staticSummary) {
  if (!liveCurrent || !liveCurrent.summary) {
    return null;
  }
  const source = liveCurrent.health_source || "live-cron-prober";
  return {
    schema_version: 1,
    contract_version: staticSummary?.contract_version,
    generated_at: liveCurrent.generated_at,
    source,
    health_source: source,
    scope: "operational",
    operational_observed_at: liveCurrent.last_run_at || null,
    global: liveCurrent.summary,
    subnets: liveCurrent.subnets || [],
  };
}

// Per-subnet status for badges (overlaid). Returns {status, ...} or null.
export function subnetBadgeStatus(liveCurrent, netuid) {
  if (!liveCurrent || !Array.isArray(liveCurrent.subnets)) return null;
  return liveCurrent.subnets.find((entry) => entry.netuid === netuid) || null;
}

// Overlay live RPC/WSS health onto the static rpc-endpoints artifact.
export function mergeRpcEndpoints(staticArtifact, liveRpcPool) {
  if (
    !staticArtifact ||
    !Array.isArray(staticArtifact.endpoints) ||
    !liveRpcPool ||
    !Array.isArray(liveRpcPool.endpoints)
  ) {
    return null;
  }
  const liveById = new Map(liveRpcPool.endpoints.map((e) => [e.id, e]));
  const endpoints = staticArtifact.endpoints.map((endpoint) => {
    const live = liveById.get(endpoint.id);
    if (!live) return endpoint;
    return {
      ...endpoint,
      status: normalizeProbeStatus(live.status),
      classification: live.classification,
      latency_ms: live.latency_ms,
      archive_support: live.archive_support ?? endpoint.archive_support,
      health_source: "probe-derived",
      health_stale: false,
      // observed_at is when this status was observed, i.e. the sweep time. rpc-pool
      // rows carry only last_ok (last SUCCESS), so a failing/degraded endpoint's
      // last_ok is a stale prior-success time — using it would label a fresh
      // failed observation with an hours-old timestamp. Prefer the run time.
      observed_at: liveRpcPool.last_run_at || live.last_ok || null,
    };
  });
  // The live overlay above can change a row's `status`/`archive_support` — the
  // two summary fields derived from them (`by_status`, `archive_supported_count`)
  // must be recomputed from the post-overlay `endpoints`, or they silently drift
  // from the rows actually served alongside them (found live: a fully-recovered
  // sweep still reported stale `degraded` counts from the last static build).
  // `by_kind`/`by_provider`/`endpoint_count` are untouched by the overlay (kind
  // and provider are static-only fields), so those pass through unchanged.
  const byStatus = {};
  let archiveSupportedCount = 0;
  for (const endpoint of endpoints) {
    const status = endpoint.status || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (endpoint.archive_support === true) archiveSupportedCount += 1;
  }
  return {
    ...staticArtifact,
    generated_at: liveRpcPool.generated_at ?? staticArtifact.generated_at,
    source: "live-cron-prober",
    operational_observed_at: liveRpcPool.last_run_at || null,
    summary: {
      ...staticArtifact.summary,
      by_status: sortedRecord(byStatus),
      archive_supported_count: archiveSupportedCount,
    },
    endpoints,
  };
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// Overlay live RPC health onto the static proxy pool: an endpoint stays eligible
// only if the static policy (auth/safety/scoring) AND current health agree. To
// avoid over-reacting to a single transient probe, an endpoint is dropped only
// after 2+ consecutive failed prober runs (~4 min sustained down); the in-isolate
// circuit breaker handles instantaneous per-request failures. Returns the pool
// unchanged when there is no live snapshot.
//
// pool_eligible/pool_eligibility_reasons are RECOMPUTED every overlay, not just
// narrowed from the static build's boolean -- confirmed live 2026-07-12 that
// the prior `Boolean(endpoint.pool_eligible) && !wrongChain && !sustainedDown`
// form could only ever REMOVE eligibility from the static baseline (built once
// daily by publish-cloudflare.yml), never restore it once the 15-minute
// live-cron-prober found a previously-degraded endpoint healthy again -- a
// real, live-reproduced incident: all 4 finney-rpc endpoints showed
// status:"ok" (health_source:"live-cron-prober", so genuinely fresh) with
// pool_eligible:false / pool_eligibility_reasons:["status-degraded"] served
// from api.metagraph.sh, and POST /rpc/v1/finney genuinely 503'd with "No
// eligible public RPC endpoint" -- up to ~24h of self-contradictory served
// data plus a real proxy outage per stale-eligibility endpoint, self-healing
// only at the next daily rebuild.
//
// Deliberately does NOT delegate to endpointPoolEligibility below: that
// helper's `status !== "ok"` check has no hysteresis (any non-ok probe is
// disqualifying), which is right for the build-time snapshot but would
// regress the sustained-down tolerance this live overlay already provides --
// a single transient non-ok probe must not evict an otherwise-healthy
// endpoint. So only the STRUCTURAL checks (kind/auth_required/public_safe --
// static properties that never change between prober runs) are reused here;
// health eligibility is judged solely by wrongChain/sustainedDown, exactly
// as before, just no longer gated behind the stale static boolean too.
// score/score_reasons are intentionally left static (out of scope for this
// fix; a stale score never excludes an eligible endpoint since
// weightedPickEndpoint falls back to weight 1 for score<=0, only
// deprioritises it).
export function overlayRpcPoolEligibility(pool, liveRpcPool) {
  if (!pool || !liveRpcPool || !Array.isArray(liveRpcPool.endpoints)) {
    return pool;
  }
  const liveById = new Map(liveRpcPool.endpoints.map((e) => [e.id, e]));
  return {
    ...pool,
    endpoints: (pool.endpoints || []).map((endpoint) => {
      const live = liveById.get(endpoint.id);
      if (!live) return endpoint;
      const refreshed = {
        ...endpoint,
        status: normalizeProbeStatus(live.status),
        latency_ms: live.latency_ms ?? endpoint.latency_ms,
        latest_block: live.latest_block ?? endpoint.latest_block ?? null,
        health_source: "live-cron-prober",
      };
      const reasons = [];
      if (!isBaseLayerEndpoint(refreshed.kind)) {
        reasons.push("not-bittensor-base-layer");
      }
      if (refreshed.auth_required !== false) {
        reasons.push("auth-required");
      }
      if (refreshed.public_safe !== true) {
        reasons.push("not-public-safe");
      }
      if (live.classification === "wrong-chain") {
        reasons.push("wrong-chain");
      }
      if (
        live.status !== "ok" &&
        (live.consecutive_failures || 0) >= POOL_SUSTAINED_DOWN_FAILURES
      ) {
        reasons.push("sustained-down");
      }
      return {
        ...refreshed,
        pool_eligible: reasons.length === 0,
        pool_eligibility_reasons: reasons.length ? reasons : ["eligible"],
      };
    }),
  };
}

// Set the live health-probe freshness onto the static freshness artifact.
export function mergeFreshness(staticFreshness, liveMeta) {
  if (!liveMeta || !staticFreshness) return null;
  const sources = Array.isArray(staticFreshness.sources)
    ? staticFreshness.sources.map((source) =>
        source.id === "surface-health"
          ? {
              ...source,
              as_of: liveMeta.last_run_at,
              timestamp: liveMeta.last_run_at,
              status: "current",
              stale_behavior: "warn",
              notes: "Operational surfaces are probed live every ~15 minutes.",
            }
          : source,
      )
    : staticFreshness.sources;
  return {
    ...staticFreshness,
    sources,
    summary: {
      ...staticFreshness.summary,
      health_probe_as_of: liveMeta.last_run_at,
      operational_probe_as_of: liveMeta.last_run_at,
    },
  };
}

// Format D1 GROUP BY aggregates into a trends payload. `windows` maps a label to
// an array of per-surface aggregate rows {surface_id, surface_key?, total,
// ok_count, avg_latency_ms, latency_samples, p50, p95, p99}. SQL groups by stable
// surface_key and keeps surface_id as the current display alias. Latency is
// success-only: avg_latency_ms / the p50/p95/p99 tail describe healthy probes,
// and latency_sample_count says how many backed them (0 ⇒ no healthy reading).
export function formatTrends({ netuid, observedAt, windows }) {
  const formatWindow = (rows) => {
    let total = 0;
    let okCount = 0;
    let latencySampleTotal = 0;
    const perSurface = [];
    for (const row of rows) {
      const rowTotal = Number(row.total) || 0;
      const rowOk = Number(row.ok_count) || 0;
      const latencySamples = Number(row.latency_samples) || 0;
      total += rowTotal;
      okCount += rowOk;
      latencySampleTotal += latencySamples;
      perSurface.push({
        surface_id: row.surface_id,
        samples: rowTotal,
        uptime_ratio: rowTotal ? displayUptimeRatio(rowOk / rowTotal) : null,
        avg_latency_ms: roundInt(row.avg_latency_ms),
        latency_sample_count: latencySamples,
        latency_ms: {
          p50: roundInt(row.p50),
          p95: roundInt(row.p95),
          p99: roundInt(row.p99),
        },
      });
    }
    perSurface.sort((a, b) => a.surface_id.localeCompare(b.surface_id));
    return {
      samples: total,
      uptime_ratio: total ? displayUptimeRatio(okCount / total) : null,
      latency_sample_count: latencySampleTotal,
      surfaces: perSurface,
    };
  };
  const windowsOut = {};
  for (const [label, rows] of Object.entries(windows)) {
    windowsOut[label] = formatWindow(rows);
  }
  return {
    schema_version: 1,
    netuid,
    observed_at: observedAt || null,
    source: "live-cron-prober",
    windows: windowsOut,
  };
}

// Format all-subnet daily aggregates for the matrix UI. This intentionally
// keeps the bulk contract subnet-level instead of per-surface to bound payload
// size while still exposing enough data for sparklines and uptime sorting.
export function formatBulkTrends({ observedAt, windows, windowDays = {} }) {
  const formatWindow = (rows, days) => {
    const bySubnet = new Map();
    for (const row of rows || []) {
      const netuid = Number(row.netuid);
      const date = String(row.date || "");
      if (
        !Number.isInteger(netuid) ||
        netuid < 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
      ) {
        continue;
      }
      const samples = Math.max(0, Number(row.total) || 0);
      const okCount = Math.max(0, Number(row.ok_count) || 0);
      const latencyRaw =
        row.avg_latency_ms == null ? null : Number(row.avg_latency_ms);
      const avgLatency = Number.isFinite(latencyRaw)
        ? Math.round(latencyRaw)
        : null;
      // Healthy readings behind this day's mean — weight by these, not total
      // samples. Legacy rows lack the count, so fall back to total samples.
      const latencyCount = !Number.isFinite(latencyRaw)
        ? 0
        : row.latency_samples == null
          ? samples
          : Math.max(0, Number(row.latency_samples) || 0);

      let entry = bySubnet.get(netuid);
      if (!entry) {
        entry = {
          netuid,
          samples: 0,
          okCount: 0,
          latencyTotal: 0,
          latencySamples: 0,
          points: [],
        };
        bySubnet.set(netuid, entry);
      }

      entry.samples += samples;
      entry.okCount += okCount;
      if (Number.isFinite(latencyRaw) && latencyCount > 0) {
        entry.latencyTotal += latencyRaw * latencyCount;
        entry.latencySamples += latencyCount;
      }
      entry.points.push({
        date,
        samples,
        uptime_ratio: samples ? displayUptimeRatio(okCount / samples) : null,
        avg_latency_ms: avgLatency,
        latency_sample_count: latencyCount,
      });
    }

    const subnets = [...bySubnet.values()]
      .map((entry) => ({
        netuid: entry.netuid,
        samples: entry.samples,
        uptime_ratio: entry.samples
          ? displayUptimeRatio(entry.okCount / entry.samples)
          : null,
        avg_latency_ms: entry.latencySamples
          ? Math.round(entry.latencyTotal / entry.latencySamples)
          : null,
        latency_sample_count: entry.latencySamples,
        points: entry.points.sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => a.netuid - b.netuid);

    return {
      days: Number(days) || 0,
      granularity: "1d",
      subnet_count: subnets.length,
      subnets,
    };
  };

  const windowsOut = {};
  for (const [label, rows] of Object.entries(windows || {})) {
    windowsOut[label] = formatWindow(rows, windowDays[label]);
  }
  return {
    schema_version: 1,
    observed_at: observedAt || null,
    source: "live-cron-prober",
    windows: windowsOut,
  };
}

// --- AI-4 historical analytics (pure transforms over D1 query rows) ---------

// A gap larger than this between consecutive failing checks ends one incident and
// starts another. Must exceed the probe cadence (15 min) so consecutive failed
// probes group into a single incident; 30 min = cadence + one missed-run buffer.
// Used by the gap-island SQL in the incidents handler.
export const INCIDENT_GAP_MS = 30 * 60 * 1000;

// Minimum consecutive failed probes for a gap-island to count as an incident.
// A single failed probe that recovers on the next (~15 min later) is transient
// noise — a momentary timeout / rate-limit / 5xx — not downtime, and it
// dominated the ledger (~76% of rows were single-sample, zero-duration). This
// mirrors the Cosmos liveness model: an isolated missed block is tolerated;
// only sustained misses (MinSignedPerWindow) count as downtime. At 2 (≥ ~4 min
// sustained) the ledger reflects real dips, not prober flapping.
export const MIN_INCIDENT_SAMPLES = 2;

function round4(value) {
  return value == null ? null : Number(Number(value).toFixed(4));
}
function roundInt(value) {
  return value == null ? null : Math.round(Number(value));
}
function toFiniteOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// p50/p95/p99 + avg/min/max latency per surface, computed in SQL (one row per
// stable surface). `rows`: [{ surface_id, surface_key?, samples, p50, p95, p99,
// avg_latency_ms, min_latency_ms, max_latency_ms }].
export function formatPercentiles({ netuid, window, observedAt, rows }) {
  const surfaces = (rows || [])
    .map((row) => ({
      surface_id: row.surface_id,
      // `latency_samples` (shared latency-stat column); legacy callers still pass
      // `samples`. This is the count of healthy readings behind the percentiles.
      samples: Number(row.latency_samples ?? row.samples) || 0,
      latency_ms: {
        p50: roundInt(row.p50),
        p95: roundInt(row.p95),
        p99: roundInt(row.p99),
        avg: roundInt(row.avg_latency_ms),
        min: roundInt(row.min_latency_ms),
        max: roundInt(row.max_latency_ms),
      },
    }))
    .sort((a, b) => a.surface_id.localeCompare(b.surface_id));
  return {
    schema_version: 1,
    netuid,
    window: window || null,
    observed_at: observedAt || null,
    source: "live-cron-prober",
    surfaces,
  };
}

// RPC reverse-proxy usage analytics (B3) from the rpc_proxy_events telemetry.
// `totals`: one aggregate row { total, ok_count, failover_count, cache_hits,
// avg_latency_ms }. `latency`: one row { p50, p95 } (window percentiles).
// `endpointRows`/`networkRows`: per-endpoint / per-network breakdowns ordered by
// request volume. `bucketRows`: bounded time buckets for heatmaps. Cold/
// unmigrated D1 yields a schema-stable zeroed payload (every arg may be
// empty/undefined), so the route never errors before the table exists.
export function formatRpcUsage({
  window,
  observedAt,
  totals,
  latency,
  endpointRows,
  networkRows,
  bucketRows,
  bucketGranularity,
}) {
  const total = Number(totals?.total) || 0;
  const okCount = Number(totals?.ok_count) || 0;
  const failoverCount = Number(totals?.failover_count) || 0;
  const cacheHits = Number(totals?.cache_hits) || 0;
  const errorCount = Math.max(0, total - okCount);
  const ratioOf = (numerator, denominator) =>
    denominator ? round4(numerator / denominator) : null;
  return {
    schema_version: 1,
    window: window || null,
    bucket_granularity: bucketGranularity || null,
    observed_at: observedAt || null,
    source: "rpc-proxy",
    summary: {
      total_requests: total,
      ok_requests: okCount,
      error_requests: errorCount,
      error_rate: ratioOf(errorCount, total),
      failover_requests: failoverCount,
      failover_rate: ratioOf(failoverCount, total),
      cache_hits: cacheHits,
      cache_hit_rate: ratioOf(cacheHits, total),
      latency_ms: {
        p50: roundInt(latency?.p50),
        p95: roundInt(latency?.p95),
        avg: roundInt(totals?.avg_latency_ms),
      },
    },
    endpoints: (endpointRows || []).map((row, index) => {
      const requests = Number(row.requests) || 0;
      const ok = Number(row.ok_count) || 0;
      return {
        rank: index + 1,
        endpoint_id: row.endpoint_id,
        provider: row.provider || null,
        requests,
        ok_requests: ok,
        error_rate: ratioOf(requests - ok, requests),
        avg_latency_ms: roundInt(row.avg_latency_ms),
      };
    }),
    networks: (networkRows || []).map((row) => {
      const requests = Number(row.requests) || 0;
      const ok = Number(row.ok_count) || 0;
      return {
        network: row.network,
        requests,
        ok_requests: ok,
        error_rate: ratioOf(requests - ok, requests),
      };
    }),
    buckets: (bucketRows || [])
      .map((row) => {
        const ts = Number(row.ts);
        if (!Number.isFinite(ts)) return null;
        return {
          ts: Math.trunc(ts),
          requests: Number(row.requests) || 0,
          errors: Math.max(0, Number(row.errors) || 0),
          avg_latency_ms: roundInt(row.avg_latency_ms),
        };
      })
      .filter(Boolean),
  };
}

// SLA + downtime incidents per surface. `slaRows`: [{ surface_id, surface_key?,
// total, ok_count }]. `incidentRows`: [{ surface_id, surface_key?, started_at, ended_at,
// failed_samples }] — one row PER INCIDENT (gap-islands grouped in SQL).
// `maxIncidents` is a per-surface defensive API cap so one flapping endpoint
// cannot monopolize the budget and starve sibling surfaces on the same subnet.
export function formatIncidents({
  netuid,
  window,
  observedAt,
  slaRows,
  incidentRows,
  maxIncidents,
}) {
  const incidentLimit = Number.isInteger(maxIncidents)
    ? Math.max(0, maxIncidents)
    : Infinity;
  const incidentsBySurface = new Map();
  const acceptedBySurface = new Map();
  for (const row of incidentRows || []) {
    const key = surfaceLookupKey(row);
    if (!key) continue;
    const accepted = acceptedBySurface.get(key) || 0;
    if (accepted >= incidentLimit) {
      continue;
    }
    const list = incidentsBySurface.get(key) || [];
    const startedAt = Number(row.started_at);
    const endedAt = Number(row.ended_at);
    list.push({
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      failed_samples: Number(row.failed_samples) || 0,
    });
    acceptedBySurface.set(key, accepted + 1);
    incidentsBySurface.set(key, list);
  }

  const surfaces = (slaRows || [])
    .map((row) => {
      const total = Number(row.total) || 0;
      const okCount = Number(row.ok_count) || 0;
      const incidents = incidentsBySurface.get(surfaceLookupKey(row)) || [];
      const downtimeMs = incidents.reduce((sum, i) => sum + i.duration_ms, 0);
      return {
        surface_id: row.surface_id,
        samples: total,
        uptime_ratio: total ? displayUptimeRatio(okCount / total) : null,
        incident_count: incidents.length,
        downtime_ms: downtimeMs,
        incidents,
      };
    })
    .sort((a, b) => a.surface_id.localeCompare(b.surface_id));

  return {
    schema_version: 1,
    netuid,
    window: window || null,
    observed_at: observedAt || null,
    source: "live-cron-prober",
    surfaces,
  };
}

// Global, cross-subnet incident ledger from the same gap-island grouping as
// formatIncidents, but keyed by netuid + stable surface identity and listing ONLY surfaces
// that had an incident in the window (a "what's been down lately" feed, not a
// full SLA table). `incidentRows`: [{ netuid, surface_id, started_at, ended_at,
// failed_samples }], already capped + ordered by the SQL.
export function formatGlobalIncidents({
  window,
  observedAt,
  incidentRows,
  maxIncidents,
}) {
  const incidentLimit = Number.isInteger(maxIncidents)
    ? Math.max(0, maxIncidents)
    : Infinity;
  const bySurface = new Map();
  let acceptedIncidents = 0;
  for (const row of incidentRows || []) {
    if (acceptedIncidents >= incidentLimit) {
      break;
    }
    const netuid = Number(row.netuid);
    const key = `${netuid}/${surfaceLookupKey(row)}`;
    const entry = bySurface.get(key) || {
      netuid,
      surface_id: row.surface_id,
      incidents: [],
    };
    const startedAt = Number(row.started_at);
    const endedAt = Number(row.ended_at);
    entry.incidents.push({
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      failed_samples: Number(row.failed_samples) || 0,
    });
    bySurface.set(key, entry);
    acceptedIncidents += 1;
  }

  const surfaces = [...bySurface.values()]
    .map((entry) => ({
      netuid: entry.netuid,
      surface_id: entry.surface_id,
      incident_count: entry.incidents.length,
      downtime_ms: entry.incidents.reduce((sum, i) => sum + i.duration_ms, 0),
      incidents: entry.incidents,
    }))
    .sort(
      (a, b) => a.netuid - b.netuid || a.surface_id.localeCompare(b.surface_id),
    );

  return {
    schema_version: 1,
    window: window || null,
    observed_at: observedAt || null,
    source: "live-cron-prober",
    summary: {
      incident_count: acceptedIncidents,
      affected_surface_count: surfaces.length,
    },
    surfaces,
  };
}

// A finite number, or null — coerces economic metrics that may be missing or NaN.
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Shared by the alpha-gain boards (#7227): higher current price breaks a tied
// %-change; unknown price ranks last.
function alphaGainTiebreak(a, b) {
  return (b.alpha_price_tao ?? -1) - (a.alpha_price_tao ?? -1);
}

// Cross-subnet economic opportunity boards: where the open slots are, what they
// cost, where the emission is, and where a validator permit is still attainable.
// Each board is a spec run through the shared `economicBoard` pipeline below, so
// adding one is a table entry, not a code path. `metric` is the sort key (null
// drops the row); `eligible` filters the projected entry; `project` shapes it.
const ECONOMIC_BOARD_SPECS = [
  {
    // Most room to register a new neuron — the miner's first question.
    key: "open-slots",
    direction: "desc",
    metric: (row) => finiteOrNull(row.open_slots),
    project: (row, openSlots) => ({
      open_slots: openSlots,
      max_uids: finiteOrNull(row.max_uids),
      registration_cost_tao: finiteOrNull(row.registration_cost_tao),
      registration_allowed: row.registration_allowed === true,
    }),
    eligible: (entry) => entry.open_slots > 0,
    // Cheaper entry breaks ties (unknown cost ranks last).
    tiebreak: (a, b) =>
      (a.registration_cost_tao ?? Infinity) -
      (b.registration_cost_tao ?? Infinity),
  },
  {
    // Cheapest way in, among subnets whose registration is actually open.
    key: "cheapest-registration",
    direction: "asc",
    metric: (row) =>
      row.registration_allowed === true
        ? finiteOrNull(row.registration_cost_tao)
        : null,
    project: (row, cost) => ({
      registration_cost_tao: cost,
      open_slots: finiteOrNull(row.open_slots),
      registration_allowed: true,
    }),
    // Drop subnets known to be full; keep unknown-capacity ones (open_slots null).
    eligible: (entry) => entry.open_slots == null || entry.open_slots > 0,
    // More open slots breaks ties.
    tiebreak: (a, b) => (b.open_slots ?? -1) - (a.open_slots ?? -1),
  },
  {
    // Where the emission is concentrated — the yield signal.
    key: "highest-emission",
    direction: "desc",
    metric: (row) => finiteOrNull(row.emission_share),
    project: (row, emissionShare) => ({
      emission_share: emissionShare,
      total_stake_tao: finiteOrNull(row.total_stake_tao),
      validator_count: finiteOrNull(row.validator_count),
      miner_count: finiteOrNull(row.miner_count),
    }),
    eligible: (entry) => entry.emission_share > 0,
    tiebreak: (a, b) => (b.total_stake_tao ?? -1) - (a.total_stake_tao ?? -1),
  },
  {
    // Open validator permits — the validator's first question.
    key: "validator-headroom",
    direction: "desc",
    metric: (row) => {
      const max = finiteOrNull(row.max_validators);
      const have = finiteOrNull(row.validator_count);
      return max != null && have != null && max > 0
        ? Math.max(0, max - have)
        : null;
    },
    project: (row, headroom) => ({
      validator_headroom: headroom,
      validator_count: finiteOrNull(row.validator_count),
      max_validators: finiteOrNull(row.max_validators),
      emission_share: finiteOrNull(row.emission_share),
    }),
    eligible: (entry) => entry.validator_headroom > 0,
    // More emission per open permit breaks ties.
    tiebreak: (a, b) => (b.emission_share ?? -1) - (a.emission_share ?? -1),
  },
  {
    // Biggest 1-day alpha-price gainers (#7227) — sort key for "which subnet
    // moved most today" without a per-subnet /trajectory round-trip.
    key: "biggest-alpha-gain-1d",
    direction: "desc",
    metric: (row) => finiteOrNull(row.alpha_price_change_1d),
    project: (row, change) => ({
      alpha_price_change_1d: change,
      alpha_price_tao: finiteOrNull(row.alpha_price_tao),
      emission_share: finiteOrNull(row.emission_share),
    }),
    eligible: (entry) => entry.alpha_price_change_1d > 0,
    tiebreak: alphaGainTiebreak,
  },
  {
    // Biggest 7-day alpha-price gainers (#7227).
    key: "biggest-alpha-gain-7d",
    direction: "desc",
    metric: (row) => finiteOrNull(row.alpha_price_change_7d),
    project: (row, change) => ({
      alpha_price_change_7d: change,
      alpha_price_tao: finiteOrNull(row.alpha_price_tao),
      emission_share: finiteOrNull(row.emission_share),
    }),
    eligible: (entry) => entry.alpha_price_change_7d > 0,
    tiebreak: alphaGainTiebreak,
  },
];

export const ECONOMIC_LEADERBOARD_BOARDS = ECONOMIC_BOARD_SPECS.map(
  (spec) => spec.key,
);

export const LEADERBOARD_BOARDS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
  "most-reliable",
  ...ECONOMIC_LEADERBOARD_BOARDS,
];

// Project one economic board from economics rows: map → identity-merge → metric
// gate → eligibility → rank (board direction, then board tiebreak, then netuid
// for total determinism) → cap. Null-safe end to end: a missing `rows` yields []
// and a row whose metric is null never reaches the board.
function economicBoard(rows, metaFor, cap, spec) {
  const direction = spec.direction === "asc" ? 1 : -1;
  return (rows || [])
    .map((row) => {
      const metric = spec.metric(row);
      if (metric == null) return null;
      const meta = metaFor(row.netuid);
      const entry = {
        netuid: row.netuid,
        slug: meta.slug ?? row.slug ?? null,
        name: meta.name ?? row.name ?? null,
        ...spec.project(row, metric),
      };
      return spec.eligible(entry) ? { metric, entry } : null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        direction * (a.metric - b.metric) ||
        (spec.tiebreak ? spec.tiebreak(a.entry, b.entry) : 0) ||
        a.entry.netuid - b.entry.netuid,
    )
    .slice(0, cap)
    .map((item) => item.entry);
}

// Assemble registry leaderboards from already-query-shaped inputs:
// healthRows [{netuid, total, ok_count, avg_latency_ms}], rpcRows
// [{netuid, min_latency_ms}], mostComplete [{netuid, slug, name,
// completeness_score, surface_count, operational_interface_count}], growthRows
// [{netuid, delta}], economicsRows (live economics tier rows: netuid, slug,
// name, open_slots, registration_cost_tao, emission_share, validator/miner
// counts, max_validators, …). `subnetMeta` is a Map(netuid -> {slug, name}).
// The economic boards are null-safe: an empty/absent economicsRows leaves each
// economic board as [] rather than omitting it.
export function formatLeaderboards({
  board,
  limit,
  observedAt,
  healthRows,
  rpcRows,
  mostComplete,
  growthRows,
  reliabilityRows,
  economicsRows,
  subnetMeta,
}) {
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));
  const metaFor = (netuid) => (subnetMeta && subnetMeta.get(netuid)) || {};

  const healthiest = (healthRows || [])
    .map((row) => {
      const total = Number(row.total) || 0;
      const ok = Number(row.ok_count) || 0;
      return {
        netuid: row.netuid,
        ...metaFor(row.netuid),
        uptime_ratio: total ? displayUptimeRatio(ok / total) : null,
        surfaces_ok: ok,
        surfaces_total: total,
        avg_latency_ms: roundInt(row.avg_latency_ms),
      };
    })
    .filter((entry) => entry.surfaces_total > 0)
    .sort(
      (a, b) =>
        (b.uptime_ratio ?? -1) - (a.uptime_ratio ?? -1) ||
        (a.avg_latency_ms ?? Infinity) - (b.avg_latency_ms ?? Infinity) ||
        a.netuid - b.netuid,
    )
    .slice(0, cap);

  const fastestRpc = (rpcRows || [])
    .map((row) => ({
      netuid: row.netuid,
      ...metaFor(row.netuid),
      latency_ms: roundInt(row.min_latency_ms),
    }))
    .filter((entry) => entry.latency_ms != null)
    .sort((a, b) => a.latency_ms - b.latency_ms || a.netuid - b.netuid)
    .slice(0, cap);

  const completeBoard = (mostComplete || [])
    .map((row) => ({
      netuid: row.netuid,
      slug: row.slug ?? null,
      name: row.name ?? null,
      completeness_score: row.completeness_score ?? null,
    }))
    // Drop subnets with no completeness signal — completeness_score is a nullable
    // INTEGER, and a not-yet-profiled subnet carries null. Ranking it on a
    // "most-complete" board (emitting completeness_score: null) is wrong; every
    // sibling board filters its absent metric (healthiest/most-enriched on >0,
    // fastest-rpc/fastest-growing on != null, most-reliable on a null score).
    .filter((entry) => entry.completeness_score != null)
    .sort(
      (a, b) =>
        b.completeness_score - a.completeness_score || a.netuid - b.netuid,
    )
    .slice(0, cap);

  // Enrichment depth: how much curation/discovery has fleshed out a subnet's
  // surface area (the flywheel output), ranked by total surfaces then callable
  // (operational) interface depth. Distinct from completeness (which weights
  // identity + required kinds) and readiness (which weights live callability).
  const enrichedBoard = (mostComplete || [])
    .map((row) => ({
      netuid: row.netuid,
      slug: row.slug ?? null,
      name: row.name ?? null,
      surface_count: Number(row.surface_count) || 0,
      operational_interface_count: Number(row.operational_interface_count) || 0,
    }))
    .filter((entry) => entry.surface_count > 0)
    .sort(
      (a, b) =>
        b.surface_count - a.surface_count ||
        b.operational_interface_count - a.operational_interface_count ||
        a.netuid - b.netuid,
    )
    .slice(0, cap);

  const fastestGrowing = (growthRows || [])
    .map((row) => ({
      netuid: row.netuid,
      ...metaFor(row.netuid),
      completeness_delta: roundInt(row.delta),
    }))
    .filter(
      (entry) =>
        entry.completeness_delta != null && entry.completeness_delta > 0,
    )
    .sort(
      (a, b) =>
        b.completeness_delta - a.completeness_delta || a.netuid - b.netuid,
    )
    .slice(0, cap);

  // Durable reliability ranking: the windowed score (uptime ratio minus a
  // latency penalty, A–F graded) computed from surface_uptime_daily, ranked
  // across subnets. Distinct from `healthiest`, which ranks the instantaneous
  // snapshot uptime rather than the window-based grade. Null-safe: a subnet with
  // no samples in the window scores null and is dropped.
  const mostReliable = (reliabilityRows || [])
    .map((row) => {
      const score = scoreFromStats({
        samples: Number(row.samples) || 0,
        okCount: Number(row.ok_count) || 0,
        avgLatencyMs:
          row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
        latencySamples: Number(row.latency_samples) || 0,
      });
      return score && { netuid: row.netuid, ...metaFor(row.netuid), ...score };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.avg_latency_ms ?? Infinity) - (b.avg_latency_ms ?? Infinity) ||
        a.netuid - b.netuid,
    )
    .slice(0, cap);

  const economicBoards = {};
  for (const spec of ECONOMIC_BOARD_SPECS) {
    economicBoards[spec.key] = economicBoard(economicsRows, metaFor, cap, spec);
  }

  const allBoards = {
    healthiest,
    "fastest-rpc": fastestRpc,
    "most-complete": completeBoard,
    "most-enriched": enrichedBoard,
    "fastest-growing": fastestGrowing,
    "most-reliable": mostReliable,
    ...economicBoards,
  };
  const boards = board ? { [board]: allBoards[board] || [] } : allBoards;

  return {
    schema_version: 1,
    board: board || null,
    observed_at: observedAt || null,
    source: "registry+live-cron-prober",
    boards,
  };
}

// Week-over-week trajectory from daily snapshots. `rows`: [{snapshot_date,
// completeness_score, surface_count, endpoint_count}].
export function formatTrajectory({ netuid, rows }) {
  const points = (rows || [])
    .map((row) => ({
      date: row.snapshot_date,
      // D1 INTEGER/REAL cells often arrive as numeric strings — coerce through
      // the same round helpers as the latency formatters so OpenAPI integer/number
      // types are never violated on the trajectory artifact.
      completeness_score: roundInt(row.completeness_score),
      surface_count: roundInt(row.surface_count),
      endpoint_count: roundInt(row.endpoint_count),
      // Economic time series (#1307) — null on rows captured before the columns
      // existed / when economics was unavailable that day.
      validator_count: roundInt(row.validator_count),
      miner_count: roundInt(row.miner_count),
      total_stake_tao: toFiniteOrNull(row.total_stake_tao),
      alpha_price_tao: toFiniteOrNull(row.alpha_price_tao),
      emission_share: toFiniteOrNull(row.emission_share),
      // Pool liquidity + volume (#2552) — reserves are a point-in-time chain
      // read (not cumulative), so unlike the other economics columns their
      // useful signal is the *delta* between two points, not the raw level;
      // see deltaOver below for the derived net TAO/alpha flow.
      tao_in_pool_tao: toFiniteOrNull(row.tao_in_pool_tao),
      alpha_in_pool: toFiniteOrNull(row.alpha_in_pool),
      alpha_out_pool: toFiniteOrNull(row.alpha_out_pool),
      subnet_volume_tao: toFiniteOrNull(row.subnet_volume_tao),
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const latest = points[points.length - 1] || null;
  const deltaOver = (days) => {
    if (!latest) return null;
    const cutoff = pointAtOrBefore(points, latest.date, days);
    if (!cutoff || cutoff.date === latest.date) return null;
    return {
      from_date: cutoff.date,
      to_date: latest.date,
      completeness_score: diff(
        latest.completeness_score,
        cutoff.completeness_score,
      ),
      surface_count: diff(latest.surface_count, cutoff.surface_count),
      endpoint_count: diff(latest.endpoint_count, cutoff.endpoint_count),
      // Net TAO/alpha flow into or out of the pool over the window (#2552) —
      // reserve level now minus reserve level then, positive means net
      // inflow. tao_in_pool_tao's delta doubles as the requested "TAO in/out
      // flow" metric; no separate flow-only ingestion needed.
      tao_in_pool_tao: diff(latest.tao_in_pool_tao, cutoff.tao_in_pool_tao),
      alpha_in_pool: diff(latest.alpha_in_pool, cutoff.alpha_in_pool),
      alpha_out_pool: diff(latest.alpha_out_pool, cutoff.alpha_out_pool),
    };
  };

  return {
    schema_version: 1,
    netuid,
    point_count: points.length,
    points,
    deltas: { "7d": deltaOver(7), "30d": deltaOver(30) },
  };
}

// One subnet's trajectory from the daily snapshots (shared by the REST route
// and the MCP tool). D1 fully eliminated (2026-07-17): subnet_snapshots is
// Postgres-only now (both callers try the Postgres tier first), so this is
// only reached on a tier miss and always returns an empty trajectory.
export async function loadSubnetTrajectory(netuid) {
  return formatTrajectory({ netuid, rows: [] });
}

function diff(now, then) {
  if (now == null || then == null) return null;
  return Number(now) - Number(then);
}

// Latest point whose date is <= (latestDate - days). Dates are YYYY-MM-DD
// strings compared lexically (valid for ISO dates).
function pointAtOrBefore(points, latestDate, days) {
  const target = shiftDate(latestDate, -days);
  let chosen = null;
  for (const point of points) {
    if (String(point.date) <= target) chosen = point;
    else break;
  }
  return chosen;
}

function shiftDate(isoDate, days) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const base = Date.UTC(y, (m || 1) - 1, d || 1) + days * 24 * 60 * 60 * 1000;
  return new Date(base).toISOString().slice(0, 10);
}

// Long-term daily uptime series per surface, from surface_uptime_daily rows
// {surface_id, day, samples, ok_count, uptime_ratio, avg_latency_ms, status}.
// Groups by surface, sorts days ascending, and rolls a window-wide uptime_ratio
// from the summed ok_count/samples (exact, not an average of ratios).
export function formatUptime({
  netuid,
  window,
  observedAt = null,
  rows,
  now = null,
}) {
  // computeReliability keys per-surface aggregation on the stable surface_key
  // itself (falling back to surface_id), so renamed rows already collapse into
  // one bucket — no need to pre-rewrite surface_id here.
  const reliability = computeReliability(rows || [], {
    window: window || null,
    now,
  });
  const bySurface = new Map();
  for (const row of rows || []) {
    const key = surfaceLookupKey(row);
    if (!key) continue;
    const entry = bySurface.get(key) || {
      surface_id: null,
      surface_id_day: null,
      days: [],
    };
    // Resolve the display alias to the surface_id from the LATEST day: the loader
    // returns rows newest-first (ORDER BY day DESC), so a blind last-writer wins
    // would leave a renamed surface showing its OLDEST (stale) alias. Track the
    // day the alias came from and only adopt a row whose day is newer.
    if (
      row.surface_id &&
      (entry.surface_id_day == null ||
        String(row.day).localeCompare(entry.surface_id_day) > 0)
    ) {
      entry.surface_id = row.surface_id;
      entry.surface_id_day = String(row.day);
    }
    entry.days.push({
      day: row.day,
      samples: Number(row.samples) || 0,
      ok_count: Number(row.ok_count) || 0,
      uptime_ratio:
        Number(row.samples) > 0
          ? displayUptimeRatio(Number(row.ok_count) / Number(row.samples))
          : null,
      avg_latency_ms: roundInt(row.avg_latency_ms),
      latency_sample_count: Number(row.latency_samples) || 0,
      latency_ms: {
        p50: roundInt(row.p50),
        p95: roundInt(row.p95),
        p99: roundInt(row.p99),
      },
      status: row.status || "unknown",
    });
    bySurface.set(key, entry);
  }
  const surfaces = [...bySurface.entries()]
    .map(([surfaceKey, entry]) => {
      const { days } = entry;
      days.sort((a, b) => String(a.day).localeCompare(String(b.day)));
      const samples = days.reduce((sum, d) => sum + d.samples, 0);
      const okCount = days.reduce((sum, d) => sum + d.ok_count, 0);
      return {
        surface_id: entry.surface_id || surfaceKey,
        day_count: days.length,
        samples,
        uptime_ratio: samples ? displayUptimeRatio(okCount / samples) : null,
        reliability: reliability.surfaces[surfaceKey] || null,
        // Per-day series without the internal ok_count (uptime_ratio covers it).
        days: days.map((d) => ({
          day: d.day,
          samples: d.samples,
          uptime_ratio: d.uptime_ratio,
          avg_latency_ms: d.avg_latency_ms,
          latency_sample_count: d.latency_sample_count,
          latency_ms: d.latency_ms,
          status: d.status,
        })),
      };
    })
    .sort((a, b) => a.surface_id.localeCompare(b.surface_id));
  return {
    schema_version: 1,
    netuid,
    window: window || null,
    observed_at: observedAt || null,
    source: "live-cron-prober",
    reliability: reliability.subnet,
    surfaces,
  };
}

// Load + score a subnet's reliability from surface_uptime_daily over a
// window. D1 fully eliminated (2026-07-17): this table has no Postgres-tier
// mirror wired for this read yet, so it always returns null now rather than
// adding new tier plumbing out of scope for D1 retirement -- callers already
// treat a null reliability as the no-data case (matches the prior cold-D1
// behavior exactly).
export async function loadSubnetReliability() {
  return null;
}

// Sample-weighted reliability score over one or many subnets in a single
// aggregate query, so a provider spanning dozens of subnets stays one D1
// round-trip. D1 fully eliminated (2026-07-17): this table has no
// Postgres-tier mirror wired for the badge read path yet, so it always
// returns null now rather than adding new tier plumbing out of scope for D1
// retirement -- the reliability badge renders "n/a" for this metric, exactly
// as it already did whenever D1 was cold/unbound.
export async function loadReliabilityAggregate() {
  return null;
}

// --- Live-everywhere health resolution + composed-artifact overlays ----------
// Health must never be served from a build-time artifact. resolveLiveHealth
// returns the freshest live snapshot — KV health:current first, then a
// reconstruction from surface_status (latest per-surface) when KV is cold —
// or null when no live source exists (callers then serve `unknown`, never a
// baked value). The overlay helpers below are pure: they take the resolved
// snapshot and replace the embedded health on composed artifacts.
//
// D1 retirement (2026-07-16, item 5 of the D1->Postgres cleanup): the KV-cold
// fallback reads Postgres via tryPostgresTier(METAGRAPH_HEALTH_SOURCE) against
// a synthesized internal request to /api/v1/internal/health-status-live
// (workers/data-api.mjs) -- the same "no client request to forward,
// synthesize one" shape workers/request-handlers/analytics-routes.mjs's
// handleCompare already uses for this exact table. D1 is fully eliminated
// here (no write, no read fallback) -- surface_status's D1 write retired the
// same day (see health-prober.mjs's runHealthProber header comment); a
// Postgres miss/outage now returns null and the caller serves `unknown`,
// same degrade every other route in this file already tolerates.

// A finite but out-of-range epoch-ms (|ms| > 8.64e15, the JS Date limit) makes
// toISOString() throw a RangeError, which would 500 the live endpoint response
// on one corrupt last_checked/last_ok cell. Range-guard via getTime() and drop
// to null, preserving the existing non-finite -> null behavior.
function isoFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function liveFromStatusRows(rows) {
  const surfaces = rows.map((r) => ({
    surface_id: r.surface_id,
    surface_key: r.surface_key ?? null,
    netuid: r.netuid,
    kind: r.kind,
    provider: r.provider,
    url: r.url,
    status: normalizeProbeStatus(r.status),
    classification: r.classification,
    latency_ms: Number.isFinite(r.latency_ms) ? r.latency_ms : null,
    status_code: Number.isInteger(r.status_code) ? r.status_code : null,
    last_checked: isoFromMs(r.last_checked),
    last_ok: isoFromMs(r.last_ok),
  }));
  const byNetuid = new Map();
  for (const row of surfaces) {
    const group = byNetuid.get(row.netuid) || [];
    group.push(row);
    byNetuid.set(row.netuid, group);
  }
  const subnets = [...byNetuid.entries()]
    .map(([netuid, group]) => ({ netuid, ...summarizeRows(group) }))
    .sort((a, b) => a.netuid - b.netuid);
  const lastRun = latestIso(surfaces.map((s) => s.last_checked));
  const statusCounts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of surfaces) {
    statusCounts[normalizeProbeStatus(row.status)] += 1;
  }
  return {
    schema_version: 1,
    generated_at: lastRun,
    last_run_at: lastRun,
    source: "live-postgres-fallback",
    health_source: "live-postgres-fallback",
    summary: { surface_count: surfaces.length, status_counts: statusCounts },
    subnets,
    surfaces,
  };
}

export async function resolveLiveHealth({ readHealthKv, env, now } = {}) {
  if (typeof readHealthKv === "function" && env) {
    try {
      const current = await readHealthKv(env, KV_HEALTH_CURRENT);
      // The prober writes surfaces + subnets + summary; accept any live snapshot
      // that carries the per-surface or per-subnet rows the overlays consume —
      // but freshness-gate it exactly like the Postgres fallback below. KV
      // health:current has NO TTL, so without this a wedged prober would serve
      // its last snapshot as fresh forever. last_run_at older than the window →
      // skip → fall through to the (freshness-gated) Postgres path → null
      // (caller serves `unknown`). A missing/unparseable last_run_at is treated
      // as fresh (back-compat: a wedged prober still emits its real
      // last_run_at, so the stale case is covered).
      if (
        current &&
        (Array.isArray(current.surfaces) || Array.isArray(current.subnets))
      ) {
        const currentTime = typeof now === "function" ? now() : Date.now();
        const lastRun = Date.parse(current.last_run_at);
        if (
          !Number.isFinite(lastRun) ||
          lastRun >= currentTime - D1_HEALTH_FALLBACK_MAX_AGE_MS
        ) {
          return { ...current, health_source: "live-cron-prober" };
        }
      }
    } catch {
      // fall through to Postgres
    }
  }
  const currentTime = typeof now === "function" ? now() : Date.now();
  const freshnessCutoff = currentTime - D1_HEALTH_FALLBACK_MAX_AGE_MS;
  if (env) {
    const pg = await tryPostgresTier(
      env,
      new Request(
        `https://api.metagraph.sh/api/v1/internal/health-status-live?since=${freshnessCutoff}`,
      ),
      "METAGRAPH_HEALTH_SOURCE",
    );
    if (Array.isArray(pg?.rows) && pg.rows.length) {
      return liveFromStatusRows(pg.rows);
    }
  }
  return null;
}

// Live economics freshness window. Economics is refreshed on its own schedule
// (the indexer-box data-refresh-economics systemd timer, ~3h -- moved off the
// former GitHub Actions refresh-economics.yml 2026-07-15), independent of the
// DATA publish, so its acceptable
// age is sized to that cadence (~hours) — NOT the 25-minute health window. A KV blob
// older than this is treated as cold and the committed R2 economics.json serves.
export const ECONOMICS_FRESHNESS_MAX_AGE_MS = 8 * 60 * 60 * 1000;

// Live economics tier: return the KV 'economics:current' blob (byte-identical to
// the built economics.json) when it is present, on-contract, fresh, and passes
// integrity invariants — else null so the caller serves the committed R2 artifact.
// KV-primary / R2-fallback: the blob is served verbatim (never reconstructed), so
// the cross-subnet emission_share + summary are never re-derived in the Worker.
// Pure given readHealthKv + now.
export async function resolveLiveEconomics({
  readHealthKv,
  env,
  contractVersion,
  now,
} = {}) {
  if (typeof readHealthKv !== "function" || !env) return null;
  let blob;
  try {
    blob = await readHealthKv(env, KV_ECONOMICS_CURRENT);
  } catch {
    return null;
  }
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null;
  // On-contract only: a blob built under an older contract may predate a schema
  // change — fall through to the (also-versioned) R2 artifact + stale-contract path.
  if (
    contractVersion &&
    blob.contract_version &&
    blob.contract_version !== contractVersion
  ) {
    return null;
  }
  // Freshness: reject a stale blob (writer wedged) so R2 takes over.
  const capturedMs = Date.parse(blob.captured_at);
  if (!Number.isFinite(capturedMs)) return null;
  const currentMs = typeof now === "function" ? now() : Date.now();
  if (currentMs - capturedMs > ECONOMICS_FRESHNESS_MAX_AGE_MS) return null;
  // Integrity: row count must match the summary and the cross-subnet
  // emission_share must still sum to ~1 — a partial/corrupt write never serves.
  const rows = Array.isArray(blob.subnets) ? blob.subnets : null;
  if (!rows) return null;
  const expected = blob.summary?.with_economics_count;
  if (Number.isInteger(expected) && rows.length !== expected) return null;
  const emissionSum = rows.reduce(
    (sum, row) =>
      sum + (typeof row.emission_share === "number" ? row.emission_share : 0),
    0,
  );
  if (rows.length > 0 && Math.abs(emissionSum - 1) > 0.001) return null;
  return { data: blob, source: "live-kv" };
}

// Attach the per-subnet economics row from the live economics blob onto a
// subnet-detail artifact at serve time (#1308), so /api/v1/subnets/{netuid}
// carries validator/miner counts, registration, stake and alpha price without a
// second call to /api/v1/economics. Null-safe: when the live economics store is
// cold/stale (resolveLiveEconomics → null) or the subnet has no economics row,
// the detail is returned unchanged (no `economics` field).
export function overlaySubnetEconomics(detail, economicsBlob, netuid) {
  if (!detail || typeof detail !== "object") return detail;
  const rows = economicsBlob?.subnets;
  if (!Array.isArray(rows)) return detail;
  const row = rows.find((entry) => entry?.netuid === netuid);
  if (!row) return detail;
  return { ...detail, economics: row };
}

// Overlay the live per-subnet operational rollup onto a composed overview
// artifact's `health`. Returns null only when there is no live snapshot at all
// (caller falls back); when the snapshot exists but the subnet has no probed
// surfaces, health is `unknown` — never the baked value.
export function overlayOverviewHealth(staticOverview, live, netuid) {
  if (!live || !Array.isArray(live.subnets)) return null;
  const summary = live.subnets.find((entry) => entry.netuid === netuid) || null;
  return {
    ...(staticOverview || { netuid }),
    health: summary
      ? { netuid, ...summary, observed_by: "live-cron-prober" }
      : { netuid, status: "unknown", surface_count: 0 },
    operational_observed_at: live.last_run_at || null,
    health_source: live.health_source || "live-cron-prober",
  };
}

// Overlay live per-service health + recomputed call eligibility onto an agent
// catalog detail artifact. Structural fields (base_url, auth, schema) are kept;
// `health` and `eligibility.callable` become live (callable now = live status
// not failed AND not classified dead/unsafe). Catalog services are already a
// public-safe subset at build time, so structural callability is implied.
export function overlayCatalogDetail(staticDetail, live, netuid) {
  if (!live || !Array.isArray(live.surfaces)) return null;
  const liveBySurface = new Map();
  for (const row of live.surfaces) {
    if (row.netuid === netuid) addLiveSurfaceRow(liveBySurface, row);
  }
  const services = (staticDetail?.services || []).map((service) => {
    const row = liveRowForSurface(liveBySurface, service);
    const status = row ? row.status : "unknown";
    const classification = row
      ? row.classification
      : (service.health?.classification ?? null);
    const callableNow =
      Boolean(row) &&
      status !== "failed" &&
      classification !== "dead" &&
      classification !== "unsafe";
    return {
      ...service,
      health: {
        status,
        classification,
        latency_ms: row ? row.latency_ms : null,
        last_ok: row ? row.last_ok : null,
        last_checked: row ? row.last_checked : null,
        stale: false,
        observed_by: row ? "live-cron-prober" : "unavailable",
      },
      eligibility: {
        ...(service.eligibility || {}),
        callable: callableNow,
        live_status: status,
      },
    };
  });
  // #357: readiness_verified — only true when a catalogued surface was actually
  // probed healthy ("ok") by the live cron, so an agent never treats a
  // catalogued-but-dead API as ready. Computed from the same rows that drive
  // per-service health; absent on the static artifact (no live truth there).
  const readinessVerified = services.some(
    (service) => service.health?.status === "ok",
  );
  return {
    ...staticDetail,
    services,
    readiness: staticDetail?.readiness
      ? { ...staticDetail.readiness, readiness_verified: readinessVerified }
      : staticDetail?.readiness,
    operational_observed_at: live.last_run_at || null,
    health_source: live.health_source || "live-cron-prober",
  };
}

// Overlay each agent-catalog index entry's `health` (a per-subnet status string)
// from the live snapshot. Structural counts are left untouched.
export function overlayCatalogIndex(staticIndex, live) {
  if (!live || !Array.isArray(live.subnets)) return null;
  const statusByNetuid = new Map(
    live.subnets.map((entry) => [entry.netuid, entry.status]),
  );
  const subnets = (staticIndex?.subnets || []).map((entry) => ({
    ...entry,
    health: statusByNetuid.get(entry.netuid) ?? "unknown",
  }));
  return {
    ...staticIndex,
    subnets,
    operational_observed_at: live.last_run_at || null,
    health_source: live.health_source || "live-cron-prober",
  };
}

// Replace one EndpointResource's operational health with the live probe row,
// or mark it `unknown` when the surface has no live reading. Structural and
// capability fields are preserved; only the freshness-bearing fields (status,
// classification, latency, the observed_* timestamps, health_source/stale, and
// pool eligibility) are overwritten so a build-time value is never served as
// fresh.
function withPoolEligibility(endpoint) {
  const eligibility = endpointPoolEligibility(endpoint);
  return {
    ...endpoint,
    pool_eligible: eligibility.eligible,
    pool_eligibility_reasons: eligibility.reasons,
  };
}

function overlayEndpointHealth(endpoint, liveRow) {
  // Not-monitored endpoints (docs, dashboards, …) carry a stable structural
  // classification, not a freshness signal — they are never probed, so their
  // `not-monitored` status is permanent and honest. Leave them untouched;
  // overlaying would mislabel an intentionally-unmonitored surface as
  // `unavailable`/stale.
  if (
    endpoint?.monitoring_status === "not_monitored" ||
    endpoint?.health_source === "not-monitored"
  ) {
    return endpoint;
  }
  if (!liveRow) {
    return withPoolEligibility({
      ...endpoint,
      status: "unknown",
      classification: "unknown",
      latency_ms: null,
      observed_at: null,
      last_checked: null,
      last_ok: null,
      health_source: "unavailable",
      health_stale: true,
      error: null,
    });
  }
  return withPoolEligibility({
    ...endpoint,
    status: normalizeProbeStatus(liveRow.status),
    classification:
      liveRow.classification ?? endpoint.classification ?? "unknown",
    latency_ms: Number.isFinite(liveRow.latency_ms) ? liveRow.latency_ms : null,
    observed_at: liveRow.last_checked || null,
    last_checked: liveRow.last_checked || null,
    last_ok: liveRow.last_ok || null,
    health_source: "live-cron-prober",
    health_stale: false,
    error: liveRow.status === "ok" ? null : (endpoint.error ?? null),
  });
}

function countEndpointStatuses(endpoints) {
  const counts = {};
  for (const endpoint of endpoints) {
    const bucket = normalizeProbeStatus(endpoint.status);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  return counts;
}

// Overlay live per-endpoint operational health onto any artifact that embeds the
// shared EndpointResource list (subnet detail, profile, the endpoints
// collection, provider endpoints, the composed overview). Each endpoint is
// joined to the live snapshot by surface_id; surfaces absent from the live store
// become `unknown` (never the baked build-time value). The artifact's status
// histogram is recomputed when present. Returns null only when the artifact
// carries no endpoints array (the caller then serves it untouched).
export function overlayArtifactEndpoints(staticData, live) {
  if (!staticData || !Array.isArray(staticData.endpoints)) return null;
  const liveBySurface = new Map();
  if (live && Array.isArray(live.surfaces)) {
    for (const row of live.surfaces) addLiveSurfaceRow(liveBySurface, row);
  }
  const endpoints = staticData.endpoints.map((endpoint) =>
    overlayEndpointHealth(endpoint, liveRowForSurface(liveBySurface, endpoint)),
  );
  const result = {
    ...staticData,
    endpoints,
    operational_observed_at: live?.last_run_at || null,
    health_source: live?.health_source || "unavailable",
  };
  if (staticData.summary && typeof staticData.summary === "object") {
    result.summary = {
      ...staticData.summary,
      by_status: countEndpointStatuses(endpoints),
      pool_eligible_count: endpoints.filter(
        (endpoint) => endpoint.pool_eligible,
      ).length,
    };
  }
  return result;
}

export { OPERATIONAL_KINDS };
