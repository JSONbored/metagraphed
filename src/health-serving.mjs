// Live operational-health serving helpers.
//
// Pure functions that overlay the 2-minute cron snapshot (KV health:current /
// health:rpc-pool / health:meta, written by src/health-prober.mjs) onto the 6h
// static artifacts. Every helper returns null when the live store is cold/absent
// so the caller (workers/api.mjs) falls back to the static artifact — keeping
// serving zero-downtime and regression-proof. No I/O here: callers pass parsed
// objects + D1 rows in.

const D1_HEALTH_FALLBACK_MAX_AGE_MS = 10 * 60 * 1000;

const OPERATIONAL_KINDS = new Set([
  "subtensor-rpc",
  "subtensor-wss",
  "archive",
  "subnet-api",
  "sse",
  "data-artifact",
]);

export function parseLive(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rollupStatus(counts, total) {
  if (total === 0 || counts.unknown === total) return "unknown";
  if ((counts.failed || 0) === 0 && (counts.degraded || 0) === 0) return "ok";
  if ((counts.ok || 0) > 0 || (counts.degraded || 0) > 0) return "degraded";
  return "failed";
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
    counts[row.status] = (counts[row.status] || 0) + 1;
    if (Number.isFinite(row.latency_ms)) latencies.push(row.latency_ms);
  }
  return {
    status: rollupStatus(counts, rows.length),
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
  };
}

// Per-subnet overlay: build the response from fresh live rows only. Static
// metadata may supply non-operational identity fields, but stale static surface
// rows are never preserved. Returns null when there is no live snapshot.
export function overlaySubnetHealth(staticArtifact, liveCurrent, netuid) {
  if (!liveCurrent || !Array.isArray(liveCurrent.surfaces)) return null;
  const liveById = new Map();
  for (const row of liveCurrent.surfaces) {
    if (row.netuid === netuid) liveById.set(row.surface_id, row);
  }
  if (liveById.size === 0) return null;

  const merged = [];
  for (const [id, live] of liveById) {
    merged.push({
      surface_id: id,
      netuid,
      kind: live.kind,
      provider: live.provider,
      url: live.url,
      status: live.status,
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
      status: live.status,
      classification: live.classification,
      latency_ms: live.latency_ms,
      archive_support: live.archive_support ?? endpoint.archive_support,
      health_source: "probe-derived",
      health_stale: false,
      observed_at: live.last_ok || liveRpcPool.last_run_at,
    };
  });
  return {
    ...staticArtifact,
    generated_at: liveRpcPool.generated_at ?? staticArtifact.generated_at,
    source: "live-cron-prober",
    operational_observed_at: liveRpcPool.last_run_at || null,
    endpoints,
  };
}

// Overlay live RPC health onto the static proxy pool: an endpoint stays eligible
// only if the static policy (auth/safety/scoring) AND current health agree. To
// avoid over-reacting to a single transient probe, an endpoint is dropped only
// after 2+ consecutive failed prober runs (~4 min sustained down); the in-isolate
// circuit breaker handles instantaneous per-request failures. Returns the pool
// unchanged when there is no live snapshot.
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
      const sustainedDown =
        live.status !== "ok" && (live.consecutive_failures || 0) >= 2;
      return {
        ...endpoint,
        status: live.status,
        latency_ms: live.latency_ms ?? endpoint.latency_ms,
        health_source: "live-cron-prober",
        pool_eligible: Boolean(endpoint.pool_eligible) && !sustainedDown,
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
              notes: "Operational surfaces are probed live every ~2 minutes.",
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
// an array of per-surface aggregate rows {surface_id, total, ok_count, avg_latency_ms}.
export function formatTrends({ netuid, observedAt, windows }) {
  const formatWindow = (rows) => {
    let total = 0;
    let okCount = 0;
    const perSurface = [];
    for (const row of rows) {
      const rowTotal = Number(row.total) || 0;
      const rowOk = Number(row.ok_count) || 0;
      total += rowTotal;
      okCount += rowOk;
      perSurface.push({
        surface_id: row.surface_id,
        samples: rowTotal,
        uptime_ratio: rowTotal ? Number((rowOk / rowTotal).toFixed(4)) : null,
        avg_latency_ms:
          row.avg_latency_ms == null
            ? null
            : Math.round(Number(row.avg_latency_ms)),
      });
    }
    perSurface.sort((a, b) => a.surface_id.localeCompare(b.surface_id));
    return {
      samples: total,
      uptime_ratio: total ? Number((okCount / total).toFixed(4)) : null,
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

// --- AI-4 historical analytics (pure transforms over D1 query rows) ---------

// A gap larger than this between consecutive failing checks (probe cadence is
// ~2 min) ends one incident and starts another. Used by the gap-island SQL in
// the incidents handler.
export const INCIDENT_GAP_MS = 6 * 60 * 1000;

function round4(value) {
  return value == null ? null : Number(Number(value).toFixed(4));
}
function roundInt(value) {
  return value == null ? null : Math.round(Number(value));
}

// p50/p95/p99 + avg/min/max latency per surface, computed in SQL (one row per
// surface). `rows`: [{ surface_id, samples, p50, p95, p99, avg_latency_ms,
// min_latency_ms, max_latency_ms }].
export function formatPercentiles({ netuid, window, observedAt, rows }) {
  const surfaces = (rows || [])
    .map((row) => ({
      surface_id: row.surface_id,
      samples: Number(row.samples) || 0,
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

// SLA + downtime incidents per surface. `slaRows`: [{ surface_id, total,
// ok_count }]. `incidentRows`: [{ surface_id, started_at, ended_at,
// failed_samples }] — one row PER INCIDENT (gap-islands grouped in SQL).
// `maxIncidents` is a defensive API cap so flapping endpoints cannot force the
// formatter to materialize unbounded incident arrays.
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
  let acceptedIncidents = 0;
  for (const row of incidentRows || []) {
    if (acceptedIncidents >= incidentLimit) {
      break;
    }
    const list = incidentsBySurface.get(row.surface_id) || [];
    const startedAt = Number(row.started_at);
    const endedAt = Number(row.ended_at);
    list.push({
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      failed_samples: Number(row.failed_samples) || 0,
    });
    acceptedIncidents += 1;
    incidentsBySurface.set(row.surface_id, list);
  }

  const surfaces = (slaRows || [])
    .map((row) => {
      const total = Number(row.total) || 0;
      const okCount = Number(row.ok_count) || 0;
      const incidents = incidentsBySurface.get(row.surface_id) || [];
      const downtimeMs = incidents.reduce((sum, i) => sum + i.duration_ms, 0);
      return {
        surface_id: row.surface_id,
        samples: total,
        uptime_ratio: total ? round4(okCount / total) : null,
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

export const LEADERBOARD_BOARDS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "fastest-growing",
];

// Assemble registry leaderboards from already-query-shaped inputs:
// healthRows [{netuid, total, ok_count, avg_latency_ms}], rpcRows
// [{netuid, min_latency_ms}], mostComplete [{netuid, slug, name,
// completeness_score}], growthRows [{netuid, delta}]. `subnetMeta` is a
// Map(netuid -> {slug, name}).
export function formatLeaderboards({
  board,
  limit,
  observedAt,
  healthRows,
  rpcRows,
  mostComplete,
  growthRows,
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
        uptime_ratio: total ? round4(ok / total) : null,
        surfaces_ok: ok,
        surfaces_total: total,
        avg_latency_ms: roundInt(row.avg_latency_ms),
      };
    })
    .filter((entry) => entry.surfaces_total > 0)
    .sort(
      (a, b) =>
        (b.uptime_ratio ?? -1) - (a.uptime_ratio ?? -1) ||
        (a.avg_latency_ms ?? Infinity) - (b.avg_latency_ms ?? Infinity),
    )
    .slice(0, cap);

  const fastestRpc = (rpcRows || [])
    .map((row) => ({
      netuid: row.netuid,
      ...metaFor(row.netuid),
      latency_ms: roundInt(row.min_latency_ms),
    }))
    .filter((entry) => entry.latency_ms != null)
    .sort((a, b) => a.latency_ms - b.latency_ms)
    .slice(0, cap);

  const completeBoard = (mostComplete || [])
    .map((row) => ({
      netuid: row.netuid,
      slug: row.slug ?? null,
      name: row.name ?? null,
      completeness_score: row.completeness_score ?? null,
    }))
    .sort((a, b) => (b.completeness_score ?? -1) - (a.completeness_score ?? -1))
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
    .sort((a, b) => b.completeness_delta - a.completeness_delta)
    .slice(0, cap);

  const allBoards = {
    healthiest,
    "fastest-rpc": fastestRpc,
    "most-complete": completeBoard,
    "fastest-growing": fastestGrowing,
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
      completeness_score: row.completeness_score ?? null,
      surface_count: row.surface_count ?? null,
      endpoint_count: row.endpoint_count ?? null,
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
export function formatUptime({ netuid, window, rows }) {
  const bySurface = new Map();
  for (const row of rows || []) {
    const list = bySurface.get(row.surface_id) || [];
    list.push({
      day: row.day,
      samples: Number(row.samples) || 0,
      ok_count: Number(row.ok_count) || 0,
      uptime_ratio: row.uptime_ratio == null ? null : Number(row.uptime_ratio),
      avg_latency_ms:
        row.avg_latency_ms == null
          ? null
          : Math.round(Number(row.avg_latency_ms)),
      status: row.status || "unknown",
    });
    bySurface.set(row.surface_id, list);
  }
  const surfaces = [...bySurface.entries()]
    .map(([surfaceId, days]) => {
      days.sort((a, b) => String(a.day).localeCompare(String(b.day)));
      const samples = days.reduce((sum, d) => sum + d.samples, 0);
      const okCount = days.reduce((sum, d) => sum + d.ok_count, 0);
      return {
        surface_id: surfaceId,
        day_count: days.length,
        samples,
        uptime_ratio: samples ? Number((okCount / samples).toFixed(4)) : null,
        // Per-day series without the internal ok_count (uptime_ratio covers it).
        days: days.map((d) => ({
          day: d.day,
          samples: d.samples,
          uptime_ratio: d.uptime_ratio,
          avg_latency_ms: d.avg_latency_ms,
          status: d.status,
        })),
      };
    })
    .sort((a, b) => a.surface_id.localeCompare(b.surface_id));
  return {
    schema_version: 1,
    netuid,
    window: window || null,
    source: "live-cron-prober",
    surfaces,
  };
}

// --- Live-everywhere health resolution + composed-artifact overlays ----------
// Health must never be served from a build-time artifact. resolveLiveHealth
// returns the freshest live snapshot — KV health:current first, then a
// reconstruction from D1 surface_status (latest per-surface) when KV is cold —
// or null when no live source exists (callers then serve `unknown`, never a
// baked value). The overlay helpers below are pure: they take the resolved
// snapshot and replace the embedded health on composed artifacts.

function liveFromD1Rows(rows) {
  const surfaces = rows.map((r) => ({
    surface_id: r.surface_id,
    netuid: r.netuid,
    kind: r.kind,
    provider: r.provider,
    url: r.url,
    status: r.status,
    classification: r.classification,
    latency_ms: Number.isFinite(r.latency_ms) ? r.latency_ms : null,
    status_code: Number.isInteger(r.status_code) ? r.status_code : null,
    last_checked: Number.isFinite(r.last_checked)
      ? new Date(r.last_checked).toISOString()
      : null,
    last_ok: Number.isFinite(r.last_ok)
      ? new Date(r.last_ok).toISOString()
      : null,
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
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  }
  return {
    schema_version: 1,
    generated_at: lastRun,
    last_run_at: lastRun,
    source: "live-d1-fallback",
    health_source: "live-d1-fallback",
    summary: { surface_count: surfaces.length, status_counts: statusCounts },
    subnets,
    surfaces,
  };
}

export async function resolveLiveHealth({ readHealthKv, env, db, now } = {}) {
  if (typeof readHealthKv === "function" && env) {
    try {
      const current = await readHealthKv(env, "health:current");
      // The prober writes surfaces + subnets + summary; accept any live snapshot
      // that carries the per-surface or per-subnet rows the overlays consume.
      if (
        current &&
        (Array.isArray(current.surfaces) || Array.isArray(current.subnets))
      ) {
        return { ...current, health_source: "live-cron-prober" };
      }
    } catch {
      // fall through to D1
    }
  }
  const database = db || env?.METAGRAPH_HEALTH_DB;
  if (database?.prepare) {
    try {
      const currentTime = typeof now === "function" ? now() : Date.now();
      const freshnessCutoff = currentTime - D1_HEALTH_FALLBACK_MAX_AGE_MS;
      const { results } = await database
        .prepare(
          `SELECT surface_id, netuid, kind, provider, url, status, classification,
                  latency_ms, status_code, last_checked, last_ok
           FROM surface_status
           WHERE last_checked >= ?`,
        )
        .bind(freshnessCutoff)
        .all();
      if (Array.isArray(results) && results.length) {
        return liveFromD1Rows(results);
      }
    } catch {
      // fall through to null (caller serves `unknown`)
    }
  }
  return null;
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
  const liveById = new Map();
  for (const row of live.surfaces) {
    if (row.netuid === netuid) liveById.set(row.surface_id, row);
  }
  const services = (staticDetail?.services || []).map((service) => {
    const row = liveById.get(service.surface_id) || null;
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
  return {
    ...staticDetail,
    services,
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
    return {
      ...endpoint,
      status: "unknown",
      classification: "unknown",
      latency_ms: null,
      observed_at: null,
      last_checked: null,
      last_ok: null,
      health_source: "unavailable",
      health_stale: true,
      pool_eligible: false,
      error: null,
    };
  }
  return {
    ...endpoint,
    status: liveRow.status,
    classification:
      liveRow.classification ?? endpoint.classification ?? "unknown",
    latency_ms: Number.isFinite(liveRow.latency_ms) ? liveRow.latency_ms : null,
    observed_at: liveRow.last_checked || null,
    last_checked: liveRow.last_checked || null,
    last_ok: liveRow.last_ok || null,
    health_source: "live-cron-prober",
    health_stale: false,
    pool_eligible: liveRow.status === "ok",
    error: liveRow.status === "ok" ? null : (endpoint.error ?? null),
  };
}

function countEndpointStatuses(endpoints) {
  const counts = {};
  for (const endpoint of endpoints) {
    counts[endpoint.status] = (counts[endpoint.status] || 0) + 1;
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
  const liveById = new Map();
  if (live && Array.isArray(live.surfaces)) {
    for (const row of live.surfaces) liveById.set(row.surface_id, row);
  }
  const endpoints = staticData.endpoints.map((endpoint) =>
    overlayEndpointHealth(endpoint, liveById.get(endpoint.surface_id) || null),
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
