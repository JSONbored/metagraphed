// Live operational-health cron prober.
//
// Runs in the Worker on a 15-minute Cron Trigger (workers/api.mjs `scheduled()`):
// loads the committed operational-surfaces.json list, probes each surface with
// the shared isomorphic core (src/health-probe-core.mjs) under bounded
// concurrency, then writes:
//   - Postgres surface_checks (append-only time-series → /health/trends)
//   - Postgres surface_status (upserted latest row + circuit-breaker counter,
//     via the same sync call as surface_checks -- D1's copies of both tables
//     are retired, 2026-07-16, D1 fully eliminated from this module)
//   - KV health:current  (global + per-subnet operational rollup + 58 rows)
//   - KV health:rpc-pool (live RPC/WSS endpoint eligibility for the proxy)
//   - KV health:meta     (last_run_at + counts → freshness + self-monitoring)
//
// Everything is injected (kv, loadSurfaces, probe, now) so the whole run is
// unit-testable without a live runtime. Decoupled from the data build: a stale
// structural snapshot can never freeze health again.

import {
  isUnsafePublicUrl,
  mapLimit,
  normalizeProbeStatus,
  okLatencyMs,
  probeSurface as coreProbeSurface,
  rollupSubnetStatus,
} from "./health-probe-core.mjs";
import { ipv6EmbeddedIpv4 } from "./ip-safety.mjs";
import { tryPostgresTier } from "../workers/postgres-tier.mjs";
import {
  recordSubnetIdentityChanges,
  syncSubnetIdentityToPostgres,
} from "./subnet-identity-history.mjs";
import {
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
} from "./kv-keys.mjs";
import {
  diffChangedSubnetNetuids,
  notifySubnetStatusChanged,
} from "./subnet-status-subscribe.mjs";

// Re-export so existing importers (workers/api.mjs, mcp-server, discovery) keep
// resolving the KV health keys through the prober; the names now live in kv-keys.
export { KV_HEALTH_CURRENT, KV_HEALTH_META, KV_HEALTH_RPC_POOL };
export const OPERATIONAL_SURFACES_PATH = "/metagraph/operational-surfaces.json";

const PROBE_CONCURRENCY = 8;
// Warn when a sweep nears the 15-minute Cron Trigger ceiling (~8 min = generous
// headroom). Early signal to raise concurrency or shard before runs overlap.
const PROBE_WALLTIME_WARN_MS = 8 * 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RPC_KINDS = new Set(["subtensor-rpc", "subtensor-wss", "archive"]);
const DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_RECORD_TYPES = ["A", "AAAA"];
const DNS_TIMEOUT_MS = 4000;
const RPC_BLOCK_PLAUSIBILITY_TOLERANCE = 10;

// #1757: epoch-zero is a "never" sentinel, not a real probe time — `iso(0)`
// would otherwise emit the "1970-01-01T00:00:00.000Z" placeholder onto a served
// last_ok for a surface that has never probed OK. Treat any falsy/zero ms as
// null at the source so consumers don't each need a pre-2000 sentinel guard. A
// real timestamp (run time, last OK) is always a large positive ms.
const iso = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // A finite but out-of-range epoch (|ms| > 8.64e15, the JS Date limit) makes
  // new Date(ms).toISOString() throw a RangeError, which would tear down the whole
  // prober run on a single corrupt checked_at_ms/last_ok_ms cell. Drop it to null,
  // mirroring the getTime() range guard chain-stake-flow.mjs added in #3016.
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

function safeRpcBlockNumber(value) {
  if (value == null) return null;
  const block = Number(value);
  return Number.isSafeInteger(block) && block > 0 ? block : null;
}

function rpcBlockMedianFloor(blocks) {
  if (!blocks.length) return null;
  const sorted = [...blocks].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function sanitizeRpcLatestBlocks(rows) {
  const rpcRows = rows.filter((row) => RPC_KINDS.has(row.kind));
  const blocks = rpcRows
    .map((row) => safeRpcBlockNumber(row.latest_block))
    .filter((block) => block != null);
  const median = rpcBlockMedianFloor(blocks);
  for (const row of rpcRows) {
    const block = safeRpcBlockNumber(row.latest_block);
    row.latest_block =
      block != null &&
      (median == null || block <= median + RPC_BLOCK_PLAUSIBILITY_TOLERANCE)
        ? block
        : null;
  }
}

// --- DNS-aware SSRF guard for the Worker prober (codex #255) -------------------
// The literal `isUnsafePublicUrl` guard can't see DNS rebinding (a public-looking
// hostname that resolves to a private IP). Workers have no node:dns, so we verify
// answers via Cloudflare DNS-over-HTTPS immediately before the probe. Policy:
// block on a DETECTED private answer (real rebinding), but fail OPEN on a DoH
// timeout/error/no-answer — operational surfaces are a curated, public_safe,
// PR-reviewed allowlist that already passed the literal guard, so a DoH blip must
// never falsely mark all health unsafe.
function normalizedHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

function ipv4Octets(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
  });
  return octets.every((n) => n !== null) ? octets : null;
}

function isUnsafeIpv4(octets) {
  const [a, b, c, d] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  );
}

function isUnsafeIpAddress(value) {
  const host = normalizedHostname(value);
  const v4 = ipv4Octets(host);
  if (v4) return isUnsafeIpv4(v4);
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), 6to4 (2002::/16),
  // and NAT64 (64:ff9b::/96) tunnel a v4 address that the prefix checks below
  // can't see — re-check the embedded v4 against the same private ranges.
  const embedded = ipv6EmbeddedIpv4(host);
  if (embedded && isUnsafeIpv4(embedded)) return true;
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("100:") ||
    host.startsWith("64:ff9b:1:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    // fe80::/10 link-local + fec0::/10 deprecated site-local (RFC 3879): the whole
    // fe80::–feff: reserved range, matching the webhook guard (issue #1538).
    /^fe[89a-f][0-9a-f]:/i.test(host) ||
    host.startsWith("ff")
  );
}

function dnsAddressAnswers(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.Answer)) {
    return [];
  }
  return body.Answer.map((answer) => String(answer?.data || "").trim()).filter(
    (data) => ipv4Octets(data) || normalizedHostname(data).includes(":"),
  );
}

async function resolveDnsJson(host, recordType, fetchImpl, endpoint) {
  const query = new URL(endpoint);
  query.searchParams.set("name", host);
  query.searchParams.set("type", recordType);
  const response = await fetchImpl(query.toString(), {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  });
  if (!response?.ok) {
    return [];
  }
  return dnsAddressAnswers(await response.json());
}

export function workerResolvedUrlSafetyGuard({
  fetchImpl = fetch,
  dnsJsonEndpoint = DNS_JSON_ENDPOINT,
} = {}) {
  return async function isUnsafeWorkerResolvedUrl(value) {
    if (isUnsafePublicUrl(value)) {
      return true;
    }
    let host;
    try {
      host = normalizedHostname(new URL(value).hostname);
    } catch {
      return true;
    }
    if (ipv4Octets(host) || host.includes(":")) {
      return isUnsafeIpAddress(host);
    }
    const lookups = await Promise.allSettled(
      DNS_RECORD_TYPES.map((type) =>
        resolveDnsJson(host, type, fetchImpl, dnsJsonEndpoint),
      ),
    );
    const answers = lookups.flatMap((lookup) =>
      lookup.status === "fulfilled" ? lookup.value : [],
    );
    // Block on any confirmed private answer (rebinding), even if another RR
    // lookup failed. No confirmed private answer / DoH failure → fail open.
    return answers.some(isUnsafeIpAddress);
  };
}

// Worker outbound-WebSocket connector for the WSS subtensor probe. Workers open
// client sockets via fetch(Upgrade: websocket) → response.webSocket, NOT the
// `new WebSocket()` constructor (which the Node build uses). Resolves a
// Map<callKey, {ok, result, rpc_error}> matching the core's expectation.
export function workerWebSocketConnector(fetchImpl = fetch) {
  return (url, calls, timeoutMs) =>
    new Promise((resolve, reject) => {
      const httpUrl = url.replace(/^ws/i, "http");
      let settled = false;
      let socket = null;
      const byId = new Map(calls.map((call, index) => [index + 1, call.key]));
      const results = new Map();
      const timer = setTimeout(
        () => finish(new Error("WSS RPC probe timed out"), "TimeoutError"),
        timeoutMs,
      );

      function finish(error, name) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // ignore close failures
        }
        if (error) {
          if (name) error.name = name;
          reject(error);
        } else {
          resolve(results);
        }
      }

      fetchImpl(httpUrl, { headers: { Upgrade: "websocket" } })
        .then((response) => {
          socket = response.webSocket;
          if (!socket) {
            finish(new Error("server did not accept the WebSocket upgrade"));
            return;
          }
          socket.accept();
          socket.addEventListener("message", (event) => {
            try {
              const raw =
                typeof event.data === "string"
                  ? event.data
                  : new TextDecoder().decode(event.data);
              const body = JSON.parse(raw);
              const key = byId.get(body.id);
              if (!key) return;
              results.set(key, {
                ok: !body.error,
                result: body.result,
                rpc_error: body.error || null,
              });
              if (results.size === calls.length) finish(null);
            } catch (error) {
              finish(error);
            }
          });
          socket.addEventListener("error", () =>
            finish(new Error("WebSocket RPC connection failed")),
          );
          socket.addEventListener("close", () => {
            if (results.size < calls.length) {
              finish(new Error("WebSocket closed before all responses"));
            }
          });
          for (const [index, call] of calls.entries()) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: index + 1,
                method: call.method,
                params: call.params,
              }),
            );
          }
        })
        .catch((error) => finish(error));
    });
}

// Read the operational-surfaces.json (DUAL tier — committed + R2-mirrored) via
// the ASSETS binding, falling back to R2. It is committed precisely so this read
// never depends on the data publish (see artifact-storage.mjs): a publish outage
// must not freeze the live health prober. Returns the surfaces array (empty on
// failure — the run then no-ops rather than throwing).
export async function loadOperationalSurfaces(env) {
  // ASSETS first (committed, always present in the deployed Worker).
  try {
    if (env.ASSETS?.fetch) {
      const response = await env.ASSETS.fetch(
        new Request(`https://assets.local${OPERATIONAL_SURFACES_PATH}`),
      );
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body?.surfaces)) return body.surfaces;
      }
    }
  } catch {
    // fall through to R2
  }
  try {
    if (env.METAGRAPH_ARCHIVE?.get) {
      const prefix = env.METAGRAPH_R2_LATEST_PREFIX || "latest/";
      // R2 artifact keys are FLAT under the prefix (latest/<file>.json), NOT
      // latest/metagraph/<file>.json — the manifest's latest_key is
      // "latest/operational-surfaces.json". The "/metagraph/" segment is only
      // the public HTTP path, not the R2 key. This fallback went unexercised
      // until #1017 made operational-surfaces.json R2-only; the stray
      // "metagraph/" segment then 404'd every read and silently froze the prober.
      const key = `${prefix}operational-surfaces.json`;
      const object = await env.METAGRAPH_ARCHIVE.get(key);
      if (object) {
        const body = JSON.parse(await object.text());
        if (Array.isArray(body?.surfaces)) return body.surfaces;
      }
    }
  } catch {
    // fall through to empty
  }
  return [];
}

function summarizeGroup(rows) {
  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  let lastChecked = 0;
  let lastOk = 0;
  const latencies = [];
  for (const row of rows) {
    counts[normalizeProbeStatus(row.status)] += 1;
    if (row.checked_at_ms > lastChecked) lastChecked = row.checked_at_ms;
    if (row.last_ok_ms && row.last_ok_ms > lastOk) lastOk = row.last_ok_ms;
    if (Number.isFinite(row.latency_ms)) latencies.push(row.latency_ms);
  }
  return {
    status: rollupSubnetStatus({ ...counts, total: rows.length }),
    surface_count: rows.length,
    ok_count: counts.ok,
    degraded_count: counts.degraded,
    failed_count: counts.failed,
    unknown_count: counts.unknown,
    // Guard the 0 sentinel before iso(): iso(0) is the truthy epoch string
    // "1970-01-01T00:00:00.000Z", so `iso(0) || null` would report a fake last_ok
    // for a subnet whose surfaces have never probed OK. (last_checked is always
    // set from runAt, but guard it the same way for symmetry.)
    last_checked: lastChecked ? iso(lastChecked) : null,
    last_ok: lastOk ? iso(lastOk) : null,
    avg_latency_ms: latencies.length
      ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
      : null,
    // How many surfaces backed the mean (a 1-reading mean vs a 300-reading one).
    latency_sample_count: latencies.length,
  };
}

// Run one full probe sweep and persist results. Returns a small summary object.
export async function runHealthProber(env, ctx, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const kv = overrides.kv || env.METAGRAPH_CONTROL;
  const loadSurfaces =
    overrides.loadSurfaces || (() => loadOperationalSurfaces(env));
  const probe = overrides.probeSurface || coreProbeSurface;
  const probeOptions = overrides.probeOptions || {
    // DNS-aware SSRF guard (resolves via DoH; fail-open on DoH error). Falls back
    // to the isomorphic literal guard when an override is supplied (tests).
    isUnsafeUrl:
      overrides.isUnsafeUrl ||
      workerResolvedUrlSafetyGuard({ fetchImpl: overrides.safetyFetch }),
    connect: overrides.connect || workerWebSocketConnector(),
  };
  const concurrency = overrides.concurrency || PROBE_CONCURRENCY;

  const runAt = now();
  const surfaces = await loadSurfaces();
  if (!surfaces.length) {
    return { ok: false, reason: "no-operational-surfaces", probed: 0 };
  }

  // Prior status (last_ok + consecutive_failures) for continuity + the breaker.
  // D1 retirement: this used to read D1's own surface_status directly; now
  // reuses the same Postgres-backed internal endpoint resolveLiveHealth's
  // KV-cold fallback calls (workers/data-api.mjs's
  // /api/v1/internal/health-status-live), with since=0 so it returns every
  // tracked surface regardless of freshness — this read needs the LAST known
  // row per surface for continuity even if it's stale, unlike the serving
  // fallback which deliberately filters to fresh rows only.
  const priorStatus = new Map();
  const priorRows = await tryPostgresTier(
    env,
    new Request(
      "https://api.metagraph.sh/api/v1/internal/health-status-live?since=0",
    ),
    "METAGRAPH_HEALTH_SOURCE",
  );
  if (Array.isArray(priorRows?.rows)) {
    for (const row of priorRows.rows) {
      priorStatus.set(row.surface_key || row.surface_id, row);
    }
  }

  const probed = await mapLimit(surfaces, concurrency, async (surface) => {
    const input = {
      id: surface.surface_id,
      netuid: surface.netuid,
      kind: surface.kind,
      url: surface.url,
      provider: surface.provider,
      authority: surface.authority,
      auth_required: surface.auth_required,
      public_safe: surface.public_safe,
      subnet_slug: surface.subnet_slug,
      subnet_name: surface.subnet_name,
      probe: surface.probe || { method: "GET", expect: "any" },
    };
    let base;
    try {
      base = await probe(input, probeOptions);
    } catch (error) {
      base = {
        status: "failed",
        classification: "unsupported",
        latency_ms: null,
        status_code: null,
        error: error?.message || "probe threw",
      };
    }
    const ok = base.status === "ok";
    const stableLookupKey = surface.surface_key || surface.surface_id;
    const prior = priorStatus.get(stableLookupKey);
    const lastOkMs = ok ? runAt : (prior?.last_ok ?? null);
    // The sustained-down breaker protects the public RPC pool from repeatedly
    // routing to unusable endpoints. For base-layer RPC surfaces, any non-ok
    // prober run counts toward that eviction threshold because `degraded`
    // includes auth-required, rate-limited, transient, and timeout outcomes that
    // are not necessarily usable by the proxy. Both base-layer kinds — HTTP
    // (`subtensor-rpc`) and WebSocket (`subtensor-wss`) — are proxy-routable and
    // pooled, so both must count; only matching `subtensor-rpc` let a
    // persistently-degraded WSS endpoint reset its streak every run and stay
    // pool_eligible forever. Non-RPC degraded runs remain soft signals and reset
    // the hard-failure streak.
    const isBaseLayerRpc =
      surface.kind === "subtensor-rpc" || surface.kind === "subtensor-wss";
    const countsTowardBreaker =
      base.status === "failed" || (isBaseLayerRpc && base.status !== "ok");
    const consecutiveFailures = countsTowardBreaker
      ? (prior?.consecutive_failures ?? 0) + 1
      : 0;
    return {
      surface_id: surface.surface_id,
      // #1005: stable key re-keyed onto D1 history; null for pre-#1005 artifacts.
      surface_key: surface.surface_key ?? null,
      netuid: surface.netuid,
      kind: surface.kind,
      provider: surface.provider || null,
      url: surface.url,
      status: base.status,
      classification: base.classification || null,
      // Success-only: failures store null latency (counted in uptime, not latency).
      latency_ms: okLatencyMs(base.status, base.latency_ms),
      status_code: Number.isInteger(base.status_code) ? base.status_code : null,
      archive_support: base.archive_support ?? null,
      latest_block: safeRpcBlockNumber(base.latest_block),
      checked_at_ms: runAt,
      last_ok_ms: lastOkMs,
      consecutive_failures: consecutiveFailures,
    };
  });

  sanitizeRpcLatestBlocks(probed);

  const priorCurrent = await readHealthCurrentSnapshot(kv);
  const nextCurrent = await persistToKv(kv, probed, runAt);
  const changedNetuids = diffChangedSubnetNetuids(priorCurrent, nextCurrent);
  // Best-effort: never fail the probe sweep because a status subscriber
  // notify couldn't land (#6034).
  if (changedNetuids.length > 0) {
    await notifySubnetStatusChanged(env, changedNetuids);
  }
  await syncHealthChecksToPostgres(env, probed);

  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of probed) counts[normalizeProbeStatus(row.status)] += 1;
  const durationMs = now() - runAt;
  // Wall-time guard: the prober runs on a 15-minute Cron Trigger, a hard CF
  // ceiling. As the autonomous flywheel grows surfaces, a sweep that creeps past
  // this threshold is the early signal to raise PROBE_CONCURRENCY or shard
  // surfaces across firings before runs start overlapping / getting killed.
  if (durationMs > PROBE_WALLTIME_WARN_MS) {
    console.warn(
      `prober wall-time ${durationMs}ms for ${probed.length} surfaces exceeds the ${PROBE_WALLTIME_WARN_MS}ms warn threshold (15-min cron limit) — raise PROBE_CONCURRENCY or shard surfaces.`,
    );
  }
  return {
    ok: true,
    probed: probed.length,
    counts,
    run_at: iso(runAt),
    duration_ms: durationMs,
  };
}

async function readHealthCurrentSnapshot(kv) {
  if (!kv?.get) return null;
  try {
    const raw = await kv.get(KV_HEALTH_CURRENT);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function persistToKv(kv, probed, runAt) {
  if (!kv?.put) return null;
  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of probed) counts[normalizeProbeStatus(row.status)] += 1;

  const surfaceRows = probed.map((row) => ({
    surface_id: row.surface_id,
    surface_key: row.surface_key,
    netuid: row.netuid,
    kind: row.kind,
    provider: row.provider,
    url: row.url,
    status: row.status,
    classification: row.classification,
    latency_ms: row.latency_ms,
    status_code: row.status_code,
    last_checked: iso(row.checked_at_ms),
    last_ok: iso(row.last_ok_ms),
  }));

  const byNetuid = new Map();
  for (const row of probed) {
    const group = byNetuid.get(row.netuid) || [];
    group.push(row);
    byNetuid.set(row.netuid, group);
  }
  const subnets = [...byNetuid.entries()]
    .map(([netuid, rows]) => ({ netuid, ...summarizeGroup(rows) }))
    .sort((a, b) => a.netuid - b.netuid);

  const current = {
    schema_version: 1,
    generated_at: iso(runAt),
    last_run_at: iso(runAt),
    source: "live-cron-prober",
    summary: { surface_count: probed.length, status_counts: counts },
    subnets,
    surfaces: surfaceRows,
  };

  const rpcRows = probed
    .filter((row) => RPC_KINDS.has(row.kind))
    .map((row) => ({
      id: row.surface_id,
      url: row.url,
      kind: row.kind,
      provider: row.provider,
      status: row.status,
      classification: row.classification,
      latency_ms: row.latency_ms,
      // Fresh tip height (from chain_getHeader) so the proxy can prefer the
      // most-synced node and demote laggards. Null when the probe couldn't read.
      latest_block: row.latest_block ?? null,
      archive_support: row.archive_support,
      last_ok: iso(row.last_ok_ms),
      consecutive_failures: row.consecutive_failures,
      pool_eligible: row.status === "ok",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rpcPool = {
    schema_version: 1,
    generated_at: iso(runAt),
    last_run_at: iso(runAt),
    source: "live-cron-prober",
    endpoint_count: rpcRows.length,
    eligible_count: rpcRows.filter((r) => r.pool_eligible).length,
    endpoints: rpcRows,
  };

  const meta = {
    schema_version: 1,
    last_run_at: iso(runAt),
    probed_count: probed.length,
    status_counts: counts,
    rpc_endpoint_count: rpcRows.length,
    rpc_eligible_count: rpcPool.eligible_count,
  };

  await Promise.all([
    kv.put(KV_HEALTH_CURRENT, JSON.stringify(current)),
    kv.put(KV_HEALTH_RPC_POOL, JSON.stringify(rpcPool)),
    kv.put(KV_HEALTH_META, JSON.stringify(meta)),
  ]);
  return current;
}

// #4832 gap-closure: best-effort Postgres mirror of the D1 write above --
// never awaited-and-thrown into the caller, mirroring
// syncSubnetIdentityToPostgres's own header comment (subnet-identity-history.mjs)
// for why this is a direct service-binding call rather than routing through
// the public proxy layer. D1+KV remain the sole authoritative write target;
// a Postgres failure here never affects live serving.
export async function syncHealthChecksToPostgres(env, probed) {
  if (!env?.DATA_API || !env?.HEALTH_CHECKS_SYNC_SECRET) {
    return { synced: false, reason: "unavailable" };
  }
  if (!Array.isArray(probed) || probed.length === 0) {
    return { synced: false, reason: "no_rows" };
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/health-checks-sync",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-health-checks-sync-token": env.HEALTH_CHECKS_SYNC_SECRET,
          },
          body: JSON.stringify({ probed }),
        },
      ),
    );
    if (!upstream.ok) {
      return { synced: false, reason: `status_${upstream.status}` };
    }
    return { synced: true };
  } catch {
    return { synced: false, reason: "fetch_failed" };
  }
}

// #4832 gap-closure: best-effort Postgres mirror of rollupDailyUptime below.
// Reuses HEALTH_CHECKS_SYNC_SECRET (same conceptual sync boundary as
// syncHealthChecksToPostgres, not a separate secret) since this fires from
// the same hourly cron right alongside it. Unlike syncHealthChecksToPostgres
// -- which ships the already-computed probed batch -- this only ships the
// UTC day *boundaries*; Postgres computes its own rollup from its own
// surface_checks (already populated by the sibling sync), using
// PERCENTILE_CONT for the p50/p95/p99 tail instead of D1/SQLite's
// rank-based CTE (see src/health-sql.mjs's rankedChecksCte/
// latencyStatColumns, which this mirrors semantically, not textually).
export async function syncHealthUptimeRollupToPostgres(env, days, updatedAt) {
  if (!env?.DATA_API || !env?.HEALTH_CHECKS_SYNC_SECRET) {
    return { synced: false, reason: "unavailable" };
  }
  if (!Array.isArray(days) || days.length === 0) {
    return { synced: false, reason: "no_days" };
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/health-uptime-rollup-sync",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-health-checks-sync-token": env.HEALTH_CHECKS_SYNC_SECRET,
          },
          body: JSON.stringify({ days, updated_at: updatedAt }),
        },
      ),
    );
    if (!upstream.ok) {
      return { synced: false, reason: `status_${upstream.status}` };
    }
    return { synced: true };
  } catch {
    return { synced: false, reason: "fetch_failed" };
  }
}

// UTC day bounds for a given epoch-ms instant: { date: "YYYY-MM-DD", start, end }.
function utcDayBounds(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    date: new Date(start).toISOString().slice(0, 10),
    start,
    end: start + 24 * 60 * 60 * 1000,
  };
}

// Durable daily uptime rollup (PR3). Aggregates the raw 15-minute surface_checks
// for a UTC day into ONE row per (surface, day) in surface_uptime_daily —
// retained indefinitely for long-term uptime analytics. MUST run before
// pruneHealthHistory: pruneHealthHistory's caller (workers/api.mjs) skips the
// whole prune tick when `rolled` is false, so D1's raw surface_checks (the
// only remaining recovery source if Postgres's rollup were ever silently
// broken for a stretch) is never pruned out from under a day that hasn't
// durably rolled up yet.
//
// D1 write retired (2026-07-16, item 3 of the D1->Postgres cleanup): this
// function's own `INSERT INTO surface_uptime_daily` is gone --
// syncHealthUptimeRollupToPostgres (below) is the sole writer now.
// METAGRAPH_HEALTH_SOURCE flipped to "postgres" in wrangler.jsonc confirms
// Postgres's surface_uptime_daily already holds a full rolling window (see
// that flag's own header comment). `rolled` now reflects whether the
// Postgres sync itself succeeded -- rolls up today + yesterday each hour
// (the post-midnight fire finalizes the prior day; Postgres's own upsert,
// data-api.mjs's handleHealthUptimeRollupSync, keeps this idempotent).
export async function rollupDailyUptime(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const runAt = now();
  const days = [utcDayBounds(runAt), utcDayBounds(runAt - 24 * 60 * 60 * 1000)];
  const result = await syncHealthUptimeRollupToPostgres(env, days, runAt);
  if (!result.synced) {
    return { rolled: false, reason: result.reason };
  }
  return { rolled: true, days: days.map((d) => d.date) };
}

// Hourly maintenance cron: prune time-series rows older than the retention
// window so the hot table stays lean.
// D1 retirement: this used to prune D1's own surface_checks/rpc_proxy_events
// tables alongside their Postgres mirrors. Both D1 writes are gone (see
// syncHealthChecksToPostgres/syncRpcUsageEventToPostgres's own header
// comments), so D1's copies are frozen and nothing reads them anymore --
// pruning a table nobody reads is pointless upkeep on a store being retired
// wholesale. Only the Postgres-side prune remains.
export async function pruneHealthHistory(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const cutoff = now() - (overrides.retentionMs || HISTORY_RETENTION_MS);
  await syncRpcProxyEventsPruneToPostgres(env, cutoff);
  return { pruned: true, cutoff };
}

// #5497: mirrors pruneHealthHistory's D1 rpc_proxy_events delete into the
// Postgres copy (#4832's read-resilience gap-closure), via the DATA_API
// service binding -- same shape as syncSubnetSnapshotToPostgres below.
// Best-effort: never throws, and a failure here must never block the D1
// prune above (the primary contract).
export async function syncRpcProxyEventsPruneToPostgres(env, cutoff) {
  if (!env?.DATA_API || !env?.RPC_USAGE_SYNC_SECRET) {
    return { synced: false, reason: "unavailable" };
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request("https://api.metagraph.sh/api/v1/internal/rpc-usage-prune", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rpc-usage-sync-token": env.RPC_USAGE_SYNC_SECRET,
        },
        body: JSON.stringify({ cutoff }),
      }),
    );
    if (!upstream.ok) {
      return { synced: false, reason: `status_${upstream.status}` };
    }
    return { synced: true };
  } catch {
    return { synced: false, reason: "fetch_failed" };
  }
}

// #4832 gap-closure: mirror writeSubnetSnapshot's D1 upsert into Postgres via
// the DATA_API service binding, called directly from writeSubnetSnapshot
// below -- same "in-Worker hourly cron, direct env.DATA_API.fetch() service-
// binding call, not an external GitHub Actions workflow" shape as
// syncSubnetIdentityToPostgres (src/subnet-identity-history.mjs), which this
// same function already calls. Best-effort: never throws, and a failure here
// must never block the D1 write above (the primary contract).
export async function syncSubnetSnapshotToPostgres(
  env,
  { profiles, economicsByNetuid, date, capturedAt } = {},
) {
  if (!env?.DATA_API || !env?.SUBNET_SNAPSHOT_SYNC_SECRET) {
    return { synced: false, reason: "unavailable" };
  }
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return { synced: false, reason: "no_profiles" };
  }
  const rows = profiles
    .filter((profile) => Number.isInteger(profile.netuid))
    .map((profile) => {
      const econ = economicsByNetuid?.get(profile.netuid) || {};
      return {
        netuid: profile.netuid,
        snapshot_date: date,
        completeness_score: profile.completeness_score ?? null,
        surface_count: profile.surface_count ?? null,
        endpoint_count: profile.endpoint_count ?? null,
        monitored_count: profile.monitored_endpoint_count ?? null,
        candidate_count: profile.candidate_count ?? null,
        validator_count: econ.validator_count ?? null,
        miner_count: econ.miner_count ?? null,
        total_stake_tao: econ.total_stake_tao ?? null,
        alpha_price_tao: econ.alpha_price_tao ?? null,
        emission_share: econ.emission_share ?? null,
        tao_in_pool_tao: econ.tao_in_pool_tao ?? null,
        alpha_in_pool: econ.alpha_in_pool ?? null,
        alpha_out_pool: econ.alpha_out_pool ?? null,
        subnet_volume_tao: econ.subnet_volume_tao ?? null,
        captured_at: capturedAt,
      };
    });
  if (!rows.length) return { synced: false, reason: "no_rows" };
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/subnet-snapshot-sync",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-subnet-snapshot-sync-token": env.SUBNET_SNAPSHOT_SYNC_SECRET,
          },
          body: JSON.stringify(rows),
        },
      ),
    );
    if (!upstream.ok) {
      return { synced: false, reason: `status_${upstream.status}` };
    }
    return { synced: true, rows: rows.length };
  } catch {
    return { synced: false, reason: "fetch_failed" };
  }
}

// Daily growth snapshot (AI-4). Captures each subnet's structural maturity into
// subnet_snapshots, keyed on (netuid, UTC date). Fired from the hourly cron.
// `overrides.readArtifact` is injected from the Worker. No D1 binding needed
// anywhere in this function anymore -- subnet_snapshots is Postgres-only (see
// syncSubnetSnapshotToPostgres below) and recordSubnetIdentityChanges reads
// its own latest-hash baseline from Postgres too now (see that function's own
// header comment in src/subnet-identity-history.mjs).
export async function writeSubnetSnapshot(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const readArtifact = overrides.readArtifact;
  if (typeof readArtifact !== "function") {
    return { ok: false, reason: "unavailable" };
  }
  const profilesResult = await readArtifact(env, "/metagraph/profiles.json");
  if (!profilesResult?.ok) return { ok: false, reason: "profiles_unavailable" };
  const profiles = Array.isArray(profilesResult.data?.profiles)
    ? profilesResult.data.profiles
    : [];
  if (!profiles.length) return { ok: false, reason: "no_profiles" };

  const capturedAt = now();
  const identityHistory = await recordSubnetIdentityChanges(env, {
    profiles,
    now: capturedAt,
  });
  // #4832 gap-closure: best-effort Postgres mirror of the D1 write above --
  // never awaited-and-thrown into the caller, see syncSubnetIdentityToPostgres's
  // own header comment for why this is a direct service-binding call rather
  // than routing through the public proxy layer.
  await syncSubnetIdentityToPostgres(env, { profiles });

  // Per-subnet economics for the time series (#1307). Best-effort: a missing
  // economics artifact just leaves those columns null (structural trajectory
  // still records).
  let economicsResult;
  try {
    economicsResult = await readArtifact(env, "/metagraph/economics.json");
  } catch {
    economicsResult = null;
  }
  const economicsByNetuid = new Map(
    (Array.isArray(economicsResult?.data?.subnets)
      ? economicsResult.data.subnets
      : []
    ).map((row) => [row.netuid, row]),
  );

  const date = new Date(capturedAt).toISOString().slice(0, 10);
  // D1 write retired (2026-07-16, item 2 of the D1->Postgres cleanup):
  // syncSubnetSnapshotToPostgres (called unconditionally, best-effort, right
  // above) is now the sole writer -- METAGRAPH_SUBNET_SNAPSHOTS_SOURCE flipped
  // to "postgres" in wrangler.jsonc confirms Postgres already holds the full
  // history (see that flag's own header comment for the verification
  // writeup). Postgres's own handleSubnetSnapshotSync
  // (workers/data-api.mjs) replicates the exact same COALESCE(existing,
  // excluded) backfill semantics the retired D1 upsert used to apply here --
  // the structural columns + captured_at stay owned by the first same-day
  // fire, and NULL economics columns backfill on a later fire without a
  // later NULL ever wiping an earlier fire's good value.
  const syncResult = await syncSubnetSnapshotToPostgres(env, {
    profiles,
    economicsByNetuid,
    date,
    capturedAt,
  });
  const rows = profiles.filter((profile) =>
    Number.isInteger(profile.netuid),
  ).length;
  if (!rows) {
    return { ok: false, reason: "no_rows", identity_history: identityHistory };
  }
  if (!syncResult.synced) {
    return {
      ok: false,
      reason: syncResult.reason,
      identity_history: identityHistory,
    };
  }
  return {
    ok: true,
    date,
    rows,
    identity_history: identityHistory,
  };
}
