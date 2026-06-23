// Live operational-health cron prober.
//
// Runs in the Worker on a 15-minute Cron Trigger (workers/api.mjs `scheduled()`):
// loads the committed operational-surfaces.json list, probes each surface with
// the shared isomorphic core (src/health-probe-core.mjs) under bounded
// concurrency, then writes:
//   - D1 surface_checks  (append-only time-series → /health/trends)
//   - D1 surface_status  (upserted latest row + circuit-breaker counter)
//   - KV health:current  (global + per-subnet operational rollup + 58 rows)
//   - KV health:rpc-pool (live RPC/WSS endpoint eligibility for the proxy)
//   - KV health:meta     (last_run_at + counts → freshness + self-monitoring)
//
// Everything is injected (db, kv, loadSurfaces, probe, now) so the whole run is
// unit-testable without a live runtime. Decoupled from the data build: a stale
// structural snapshot can never freeze health again.

import {
  isUnsafePublicUrl,
  mapLimit,
  okLatencyMs,
  probeSurface as coreProbeSurface,
  rollupSubnetStatus,
} from "./health-probe-core.mjs";
import { latencyStatColumns, rankedChecksCte } from "./health-sql.mjs";
import {
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
} from "./kv-keys.mjs";

// Re-export so existing importers (workers/api.mjs, mcp-server, discovery) keep
// resolving the KV health keys through the prober; the names now live in kv-keys.
export { KV_HEALTH_CURRENT, KV_HEALTH_META, KV_HEALTH_RPC_POOL };
export const OPERATIONAL_SURFACES_PATH = "/metagraph/operational-surfaces.json";

const PROBE_CONCURRENCY = 8;
// Warn when a sweep nears the 15-minute Cron Trigger ceiling (~8 min = generous
// headroom). Early signal to raise concurrency or shard before runs overlap.
const PROBE_WALLTIME_WARN_MS = 8 * 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Cloudflare D1 batch() calls are capped (~100 statements per batch). Chunk large
// probe/snapshot writes so a growing surface/subnet catalog cannot fail silently.
export const D1_STATEMENTS_PER_BATCH = 50;

export async function runD1StatementBatches(
  db,
  statements,
  batchSize = D1_STATEMENTS_PER_BATCH,
) {
  if (!statements.length) return { ok: true, batches: 0 };
  for (let i = 0; i < statements.length; i += batchSize) {
    await db.batch(statements.slice(i, i + batchSize));
  }
  return { ok: true, batches: Math.ceil(statements.length / batchSize) };
}
const RPC_KINDS = new Set(["subtensor-rpc", "subtensor-wss", "archive"]);
const DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_RECORD_TYPES = ["A", "AAAA"];
const DNS_TIMEOUT_MS = 4000;
const RPC_BLOCK_PLAUSIBILITY_TOLERANCE = 10;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

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

function isUnsafeIpAddress(value) {
  const host = normalizedHostname(value);
  const v4 = ipv4Octets(host);
  if (v4) {
    const [a, b, c, d] = v4;
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
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("100:") ||
    host.startsWith("64:ff9b:1:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab][0-9a-f]:/i.test(host) ||
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
    counts[row.status] = (counts[row.status] || 0) + 1;
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
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
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
  const priorStatus = new Map();
  if (db) {
    try {
      const keys = surfaces.map((s) => s.surface_key || s.surface_id);
      const ids = surfaces.map((s) => s.surface_id);
      const keyPlaceholders = keys.map(() => "?").join(",");
      const idPlaceholders = ids.map(() => "?").join(",");
      const { results } = await db
        .prepare(
          `SELECT surface_id, surface_key, last_ok, consecutive_failures
           FROM surface_status
           WHERE surface_key IN (${keyPlaceholders})
              OR surface_id IN (${idPlaceholders})`,
        )
        .bind(...keys, ...ids)
        .all();
      for (const row of results || []) {
        priorStatus.set(row.surface_key || row.surface_id, row);
      }
    } catch {
      // First run / cold table — treat all as having no prior state.
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
    // routing to unusable endpoints. For RPC surfaces, any non-ok prober run
    // counts toward that eviction threshold because `degraded` includes
    // auth-required, rate-limited, transient, and timeout outcomes that are not
    // necessarily usable by the proxy. Non-RPC degraded runs remain soft signals
    // and reset the hard-failure streak.
    const countsTowardBreaker =
      base.status === "failed" ||
      (surface.kind === "subtensor-rpc" && base.status !== "ok");
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

  const d1Persist = await persistToD1(db, probed, runAt);
  await persistToKv(kv, probed, runAt);

  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of probed) counts[row.status] = (counts[row.status] || 0) + 1;
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
    d1_persisted: d1Persist.ok === true,
  };
}

async function persistToD1(db, probed, runAt) {
  if (!db?.prepare) return { ok: false, reason: "unavailable" };
  try {
    const checkStmt = db.prepare(
      `INSERT INTO surface_checks
       (surface_id, surface_key, netuid, kind, status, classification, latency_ms, status_code, ok, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // #1005: surface_status now keys latest rows on surface_key, so a display
    // id/slug rename updates the alias in-place instead of creating a new latest
    // row and resetting breaker continuity.
    const statusStmt = db.prepare(
      `INSERT INTO surface_status
       (surface_id, surface_key, netuid, kind, url, provider, status, classification, latency_ms, status_code, last_checked, last_ok, consecutive_failures, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surface_key) WHERE surface_key IS NOT NULL DO UPDATE SET
         surface_id=excluded.surface_id,
         netuid=excluded.netuid, kind=excluded.kind, url=excluded.url,
         provider=excluded.provider, status=excluded.status,
         classification=excluded.classification, latency_ms=excluded.latency_ms,
         status_code=excluded.status_code, last_checked=excluded.last_checked,
         last_ok=excluded.last_ok, consecutive_failures=excluded.consecutive_failures,
         updated_at=excluded.updated_at
       ON CONFLICT(surface_id) DO UPDATE SET
         surface_key=excluded.surface_key,
         netuid=excluded.netuid, kind=excluded.kind, url=excluded.url,
         provider=excluded.provider, status=excluded.status,
         classification=excluded.classification, latency_ms=excluded.latency_ms,
         status_code=excluded.status_code, last_checked=excluded.last_checked,
         last_ok=excluded.last_ok, consecutive_failures=excluded.consecutive_failures,
         updated_at=excluded.updated_at`,
    );
    const statements = [];
    for (const row of probed) {
      statements.push(
        checkStmt.bind(
          row.surface_id,
          row.surface_key,
          row.netuid,
          row.kind,
          row.status,
          row.classification,
          row.latency_ms,
          row.status_code,
          row.status === "ok" ? 1 : 0,
          row.checked_at_ms,
        ),
        statusStmt.bind(
          row.surface_id,
          row.surface_key,
          row.netuid,
          row.kind,
          row.url,
          row.provider,
          row.status,
          row.classification,
          row.latency_ms,
          row.status_code,
          row.checked_at_ms,
          row.last_ok_ms,
          row.consecutive_failures,
          runAt,
        ),
      );
    }
    return await runD1StatementBatches(db, statements);
  } catch {
    // D1 unavailable / schema cold: KV still gets written so serving stays live,
    // but surface the split so operators can spot analytics drift.
    console.warn("health prober: D1 persist failed; KV snapshot still updated");
    return { ok: false, reason: "batch_failed" };
  }
}

async function persistToKv(kv, probed, runAt) {
  if (!kv?.put) return;
  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of probed) counts[row.status] = (counts[row.status] || 0) + 1;

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
// retained indefinitely for long-term uptime analytics — so the 30-day raw
// prune never loses history. MUST run before pruneHealthHistory. Rolls up today
// + yesterday each hour (the post-midnight fire finalizes the prior day; upsert
// keeps it idempotent). No-ops when D1 is unbound/cold. Latency is rolled up
// success-only with its sample count, plus the day's exact p50/p95/p99 so tail
// latency survives the raw prune (percentiles can't be rebuilt from a mean).
export async function rollupDailyUptime(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { rolled: false };
  const runAt = now();
  const days = [utcDayBounds(runAt), utcDayBounds(runAt - 24 * 60 * 60 * 1000)];
  const conflictColumns = `
       surface_id = excluded.surface_id,
       surface_key = excluded.surface_key,
       netuid = excluded.netuid,
       samples = excluded.samples,
       ok_count = excluded.ok_count,
       uptime_ratio = excluded.uptime_ratio,
       avg_latency_ms = excluded.avg_latency_ms,
       latency_samples = excluded.latency_samples,
       p50_latency_ms = excluded.p50_latency_ms,
       p95_latency_ms = excluded.p95_latency_ms,
       p99_latency_ms = excluded.p99_latency_ms,
       status = excluded.status,
       updated_at = excluded.updated_at`;
  const stmt = db.prepare(
    `${rankedChecksCte("checked_at >= ? AND checked_at < ?")}
     INSERT INTO surface_uptime_daily
       (surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio,
        latency_samples, avg_latency_ms, p50_latency_ms, p95_latency_ms,
        p99_latency_ms, status, updated_at)
     SELECT
       MAX(surface_id) AS surface_id,
       surface_key,
       netuid,
       ? AS day,
       COUNT(*) AS samples,
       SUM(ok) AS ok_count,
       ROUND(CAST(SUM(ok) AS REAL) / COUNT(*), 4) AS uptime_ratio,
       ${latencyStatColumns({ roundedAvg: true, includeMinMax: false })},
       CASE
         WHEN SUM(ok) = COUNT(*) THEN 'ok'
         WHEN SUM(ok) = 0 THEN 'failed'
         ELSE 'degraded'
       END AS status,
       ? AS updated_at
     FROM ranked
     GROUP BY surface_key, netuid
     ON CONFLICT(surface_key, day) WHERE surface_key IS NOT NULL DO UPDATE SET${conflictColumns}
     ON CONFLICT(surface_id, day) DO UPDATE SET${conflictColumns}`,
  );
  try {
    await db.batch(
      days.map(({ date, start, end }) => stmt.bind(start, end, date, runAt)),
    );
    return { rolled: true, days: days.map((d) => d.date) };
  } catch {
    return { rolled: false };
  }
}

// Hourly maintenance cron: prune time-series rows older than the retention
// window so the hot table stays lean.
export async function pruneHealthHistory(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { pruned: false };
  const cutoff = now() - (overrides.retentionMs || HISTORY_RETENTION_MS);
  try {
    const result = await db
      .prepare(`DELETE FROM surface_checks WHERE checked_at < ?`)
      .bind(cutoff)
      .run();
    // Prune RPC proxy usage telemetry (B3) to the same 30-day hot window. Wrapped
    // separately + best-effort so a not-yet-migrated rpc_proxy_events table never
    // blocks the surface_checks prune (the table arrives with the 0004 migration).
    try {
      await db
        .prepare(`DELETE FROM rpc_proxy_events WHERE observed_at < ?`)
        .bind(cutoff)
        .run();
    } catch {
      // rpc_proxy_events absent or transient error — skip the telemetry prune.
    }
    return { pruned: true, cutoff, changes: result?.meta?.changes ?? null };
  } catch {
    return { pruned: false };
  }
}

// Daily growth snapshot (AI-4). Captures each subnet's structural maturity into
// subnet_snapshots, keyed on (netuid, UTC date). Fired from the hourly cron;
// ON CONFLICT DO NOTHING makes repeated fires within a day idempotent (the first
// fire of the day wins). `overrides.readArtifact` is injected from the Worker.
export async function writeSubnetSnapshot(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  const readArtifact = overrides.readArtifact;
  if (!db?.prepare || typeof readArtifact !== "function") {
    return { ok: false, reason: "unavailable" };
  }
  const profilesResult = await readArtifact(env, "/metagraph/profiles.json");
  if (!profilesResult?.ok) return { ok: false, reason: "profiles_unavailable" };
  const profiles = Array.isArray(profilesResult.data?.profiles)
    ? profilesResult.data.profiles
    : [];
  if (!profiles.length) return { ok: false, reason: "no_profiles" };

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

  const date = new Date(now()).toISOString().slice(0, 10);
  const capturedAt = now();
  // The structural columns + captured_at are owned by the first same-day fire.
  // The economics columns can arrive late (economics.json is pure chain state
  // with no committed-asset fallback, unlike profiles.json), so DO NOTHING
  // would freeze a NULL-economics first fire and the 23 later hourly fires could
  // never backfill it — a permanent gap in the trajectory series. Backfill them
  // with COALESCE(existing, excluded): a later fire fills a NULL, but a later
  // NULL can never wipe an earlier fire's good value.
  const stmt = db.prepare(
    `INSERT INTO subnet_snapshots
       (netuid, snapshot_date, completeness_score, surface_count,
        endpoint_count, monitored_count, candidate_count,
        validator_count, miner_count, total_stake_tao, alpha_price_tao,
        emission_share, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (netuid, snapshot_date) DO UPDATE SET
       validator_count = COALESCE(subnet_snapshots.validator_count, excluded.validator_count),
       miner_count = COALESCE(subnet_snapshots.miner_count, excluded.miner_count),
       total_stake_tao = COALESCE(subnet_snapshots.total_stake_tao, excluded.total_stake_tao),
       alpha_price_tao = COALESCE(subnet_snapshots.alpha_price_tao, excluded.alpha_price_tao),
       emission_share = COALESCE(subnet_snapshots.emission_share, excluded.emission_share)`,
  );
  const statements = profiles
    .filter((profile) => Number.isInteger(profile.netuid))
    .map((profile) => {
      const econ = economicsByNetuid.get(profile.netuid) || {};
      return stmt.bind(
        profile.netuid,
        date,
        profile.completeness_score ?? null,
        profile.surface_count ?? null,
        profile.endpoint_count ?? null,
        profile.monitored_endpoint_count ?? null,
        profile.candidate_count ?? null,
        econ.validator_count ?? null,
        econ.miner_count ?? null,
        econ.total_stake_tao ?? null,
        econ.alpha_price_tao ?? null,
        econ.emission_share ?? null,
        capturedAt,
      );
    });
  if (!statements.length) return { ok: false, reason: "no_rows" };
  try {
    await runD1StatementBatches(db, statements);
    return { ok: true, date, rows: statements.length };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}
