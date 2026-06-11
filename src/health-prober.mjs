// Live operational-health cron prober.
//
// Runs in the Worker on a 2-minute Cron Trigger (workers/api.mjs `scheduled()`):
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
// unit-testable without a live runtime. Decoupled from the 6h build: a stale
// structural snapshot can never freeze health again.

import {
  isUnsafePublicUrl,
  mapLimit,
  probeSurface as coreProbeSurface,
} from "./health-probe-core.mjs";

export const KV_HEALTH_CURRENT = "health:current";
export const KV_HEALTH_RPC_POOL = "health:rpc-pool";
export const KV_HEALTH_META = "health:meta";
export const OPERATIONAL_SURFACES_PATH = "/metagraph/operational-surfaces.json";

const PROBE_CONCURRENCY = 8;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RPC_KINDS = new Set(["subtensor-rpc", "subtensor-wss", "archive"]);
const DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_RECORD_TYPES = ["A", "AAAA"];
const DNS_TIMEOUT_MS = 4000;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

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

// Read the committed operational-surfaces.json (dual tier) via the ASSETS
// binding, falling back to R2. Returns the surfaces array (empty on failure —
// the run then no-ops rather than throwing).
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
      const key = `${prefix}metagraph/operational-surfaces.json`;
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

function rollupStatus({ ok, degraded, failed, unknown, total }) {
  if (total === 0 || unknown === total) return "unknown";
  if (failed === 0 && degraded === 0) return "ok";
  if (ok > 0 || degraded > 0) return "degraded";
  return "failed";
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
    status: rollupStatus({ ...counts, total: rows.length }),
    surface_count: rows.length,
    ok_count: counts.ok,
    degraded_count: counts.degraded,
    failed_count: counts.failed,
    unknown_count: counts.unknown,
    last_checked: iso(lastChecked) || null,
    last_ok: iso(lastOk) || null,
    avg_latency_ms: latencies.length
      ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
      : null,
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
      const ids = surfaces.map((s) => s.surface_id);
      const placeholders = ids.map(() => "?").join(",");
      const { results } = await db
        .prepare(
          `SELECT surface_id, last_ok, consecutive_failures FROM surface_status WHERE surface_id IN (${placeholders})`,
        )
        .bind(...ids)
        .all();
      for (const row of results || []) priorStatus.set(row.surface_id, row);
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
    const prior = priorStatus.get(surface.surface_id);
    const lastOkMs = ok ? runAt : (prior?.last_ok ?? null);
    const consecutiveFailures = ok ? 0 : (prior?.consecutive_failures ?? 0) + 1;
    return {
      surface_id: surface.surface_id,
      netuid: surface.netuid,
      kind: surface.kind,
      provider: surface.provider || null,
      url: surface.url,
      status: base.status,
      classification: base.classification || null,
      latency_ms: Number.isFinite(base.latency_ms) ? base.latency_ms : null,
      status_code: Number.isInteger(base.status_code) ? base.status_code : null,
      archive_support: base.archive_support ?? null,
      checked_at_ms: runAt,
      last_ok_ms: lastOkMs,
      consecutive_failures: consecutiveFailures,
    };
  });

  await persistToD1(db, probed, runAt);
  await persistToKv(kv, probed, runAt);

  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of probed) counts[row.status] = (counts[row.status] || 0) + 1;
  return {
    ok: true,
    probed: probed.length,
    counts,
    run_at: iso(runAt),
    duration_ms: now() - runAt,
  };
}

async function persistToD1(db, probed, runAt) {
  if (!db?.prepare) return;
  try {
    const checkStmt = db.prepare(
      `INSERT INTO surface_checks
       (surface_id, netuid, kind, status, classification, latency_ms, status_code, ok, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const statusStmt = db.prepare(
      `INSERT INTO surface_status
       (surface_id, netuid, kind, url, provider, status, classification, latency_ms, status_code, last_checked, last_ok, consecutive_failures, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surface_id) DO UPDATE SET
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
    await db.batch(statements);
  } catch {
    // D1 unavailable / schema cold: KV still gets written so serving stays live.
  }
}

async function persistToKv(kv, probed, runAt) {
  if (!kv?.put) return;
  const counts = { ok: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const row of probed) counts[row.status] = (counts[row.status] || 0) + 1;

  const surfaceRows = probed.map((row) => ({
    surface_id: row.surface_id,
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
    return { pruned: true, cutoff, changes: result?.meta?.changes ?? null };
  } catch {
    return { pruned: false };
  }
}
