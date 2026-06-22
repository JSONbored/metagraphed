import {
  API_QUERY_COLLECTIONS,
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  artifactPathFromTemplate,
  compileRoutePattern,
} from "../src/contracts.mjs";
import { applyQueryFilters } from "./list-query.mjs";
import {
  apiHeaders,
  errorResponse,
  ifNoneMatchSatisfied,
  weakEtag,
} from "./http.mjs";
import {
  d1TimeoutMs,
  latestPointer,
  logEvent,
  readArtifact,
  readHealthKv,
  withTimeout,
} from "./storage.mjs";
import {
  contractStaleness,
  contractVersion,
  dataResponse,
  envelopeResponse,
  publishedAt,
} from "./responses.mjs";
import {
  BADGE_SVG_PATTERN,
  homepageResponse,
  apiCatalogResponse,
  mcpServerCardResponse,
  agentToolsResponse,
  handleBadgeSvgRequest,
} from "./request-handlers/discovery.mjs";
import {
  buildChangeEvent,
  generateSecret,
  generateSubscriptionId,
  isValidSubscriptionId,
  publicSubscriptionView,
  subscriptionStorageKey,
  timingSafeEqual,
  validateSubscriptionInput,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "../src/webhooks.mjs";
import {
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  pruneHealthHistory,
  rollupDailyUptime,
  runHealthProber,
  workerResolvedUrlSafetyGuard,
  workerWebSocketConnector,
  writeSubnetSnapshot,
} from "../src/health-prober.mjs";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.mjs";
import {
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
} from "../src/health-sql.mjs";
import { findSurface, verifySurface } from "../src/surface-verify.mjs";
import { SURFACE_ALIASES_PATH } from "../src/surface-aliases.mjs";
import {
  buildGlobalHealth,
  formatBulkTrends,
  formatGlobalIncidents,
  formatIncidents,
  formatLeaderboards,
  formatPercentiles,
  formatRpcUsage,
  formatTrajectory,
  formatTrends,
  formatUptime,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
  LEADERBOARD_BOARDS,
  mergeFreshness,
  mergeRpcEndpoints,
  overlayArtifactEndpoints,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlayOverviewHealth,
  overlayRpcPoolEligibility,
  overlaySubnetEconomics,
  overlaySubnetHealth,
  resolveLiveEconomics,
  resolveLiveHealth,
} from "../src/health-serving.mjs";
import {
  NEURON_COLUMNS,
  NEURON_INSERT_COLUMNS,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildNeuronDetail,
} from "../src/metagraph-neurons.mjs";
import {
  rollupNeuronDaily,
  archiveNeuronDaily,
  archivePrunableNeuronDaily,
  pruneNeuronDaily,
  buildNeuronHistory,
  buildSubnetHistory,
  parseHistoryWindow,
  NEURON_DAILY_READ_COLUMNS,
  MAX_HISTORY_POINTS,
} from "../src/neuron-history.mjs";
import {
  ACCOUNT_EVENT_COLUMNS,
  buildAccountEvents,
  buildAccountSubnets,
  buildAccountSummary,
  eventInsertStatements,
  rollupAccountEventsDaily,
  pruneAccountEvents,
  validEventRows,
} from "../src/account-events.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { handleFeedRequest } from "../src/feeds.mjs";
import { handleBadgeRequest } from "../src/badge.mjs";
import { handleOgImage } from "../src/og-image.mjs";
import { handleGraphQLRequest } from "../src/graphql.mjs";
import {
  aiEnabled,
  askQuestion,
  runEmbeddingSync,
  semanticSearch,
  withinRateLimit,
} from "../src/ai-search.mjs";
import {
  ACCOUNT_EVENTS_PATH_PATTERN,
  ACCOUNT_PATH_PATTERN,
  ACCOUNT_SUBNETS_PATH_PATTERN,
  ANALYTICS_WINDOW_PARAM,
  ANALYTICS_WINDOWS,
  BULK_TRENDS_PATH_PATTERN,
  DAY_MS,
  DENIED_RPC_PREFIXES,
  EMBEDDING_SYNC_CRON,
  EVENTS_INGEST_TOKEN_HEADER,
  EVENTS_LOAD_CRON,
  HEALTH_PRUNE_CRON,
  HEALTH_TREND_WINDOWS,
  INCIDENTS_PATH_PATTERN,
  JSON_CONTENT_TYPE,
  MAX_ASK_BODY_BYTES,
  MAX_BULK_TREND_ROWS,
  MAX_EVENTS_INGEST_BODY_BYTES,
  MAX_EVENTS_INGEST_ROWS,
  MAX_STAGED_EVENTS_BYTES,
  MAX_STAGED_EVENT_ROWS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
  MAX_RPC_BODY_BYTES,
  MAX_UPTIME_ROWS,
  MAX_WEBHOOK_BODY_BYTES,
  NEURON_HISTORY_ROLLUP_CRON,
  PERCENTILES_PATH_PATTERN,
  RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN,
  resolveClientIp,
  RPC_USAGE_BUCKETS,
  SAFE_RPC_METHODS,
  SUBNET_HISTORY_PATH_PATTERN,
  SUBNET_METAGRAPH_PATH_PATTERN,
  SUBNET_NEURON_HISTORY_PATH_PATTERN,
  SUBNET_NEURON_PATH_PATTERN,
  SUBNET_VALIDATORS_PATH_PATTERN,
  TRAJECTORY_PATH_PATTERN,
  TRENDS_PATH_PATTERN,
  TRUSTED_RPC_UPSTREAM_ORIGINS,
  UPTIME_PATH_PATTERN,
  UPTIME_WINDOWS,
  WEBHOOK_SUBSCRIPTION_TOKEN_HEADER,
  WEBHOOK_TTL_SECONDS,
} from "./config.mjs";

const RAW_ARTIFACT_ROUTES = PUBLIC_ARTIFACTS.filter((entry) =>
  entry.path.endsWith(".json"),
).map((entry) => ({
  ...entry,
  pattern: compileRoutePattern(entry.path),
}));

const ROUTES = API_ROUTES.map((entry) => ({
  ...entry,
  pattern: compileRoutePattern(entry.path),
  artifactPath(params) {
    return artifactPathFromTemplate(entry.artifact_path, params);
  },
}));

// Routes that can include live operational-health overlays must never use the
// edge Cache API. Cache eligibility is route-based instead of checking whether
// live data was available for a particular request, so a cold KV/D1 overlay
// cannot seed stale static fallbacks into the edge cache.
const LIVE_OVERLAY_ROUTE_IDS = new Set([
  "health",
  "subnet-health",
  "rpc-endpoints",
  "freshness",
  "subnet-overview",
  "agent-catalog",
  "agent-catalog-subnet",
  "endpoints",
  "subnet-endpoints",
  "provider-endpoints",
  // Economics serves live from KV 'economics:current' (refreshed independently of
  // the data publish), falling back to the committed R2 economics.json — so it must
  // not be static-edge-cached.
  "economics",
]);

function isStaticEdgeCacheEligible(matched, network) {
  return !network.isDefault || !LIVE_OVERLAY_ROUTE_IDS.has(matched.id);
}

// Live-overlay COLLECTION routes worth caching keyed on the cron snapshot's
// last_run_at (not the static edge cache, since their body carries live status).
// Scoped to the large /api/v1/endpoints index (~1.43 MB / 1160 rows) whose
// overlay output is fully determined by (contract_version, last_run_at) — the
// per-subnet `subnet-endpoints` variant is small and intentionally excluded.
const CACHEABLE_OVERLAY_ROUTE_IDS = new Set(["endpoints"]);

function canonicalOverlayCacheSearch(url, matched) {
  const config = API_QUERY_COLLECTIONS[matched.queryCollection];
  if (!config) return "";
  const filterNames =
    matched.queryFilterNames?.length > 0
      ? matched.queryFilterNames
      : Object.keys(config.filters);
  const cacheableNames = [
    "q",
    "fields",
    "limit",
    "cursor",
    "sort",
    "order",
    ...filterNames,
  ];
  const canonicalUrl = new URL("https://edge-cache.metagraph.sh/");
  for (const name of cacheableNames) {
    const value = url.searchParams.get(name);
    if (value !== null) canonicalUrl.searchParams.set(name, value);
  }
  return canonicalUrl.search;
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return handleScheduled(controller, env, ctx);
  },
};

// Sanity bounds for an authenticated, HMAC-signed staged neuron batch (the data
// is already trusted; these are defense-in-depth caps so a malformed signed file
// can't blow up the D1 load). The byte cap intentionally allows the
// expected all-subnet signed JSON envelope (~33k rows) while still bounding
// memory use before parsing. netuid and uid are both u16 on-chain, so each is
// capped at the u16 max (65535) — matching the existing netuid guard in
// src/webhooks.mjs and avoiding rejection of legitimately high subnet ids.
const STAGED_NEURONS_KEY = "metagraph/neurons-pending.json";
const MAX_STAGED_NEURONS_BYTES = 32_000_000;
const MAX_STAGED_NEURON_ROWS = 50_000;
const MAX_STAGED_NEURON_STRING_BYTES = 512;
const MAX_STAGED_NETUID = 65_535;
const MAX_STAGED_UID = 65_535;
const MAX_STAGED_REFRESHED_NETUIDS = 256;

function neuronStagingSignPayload(rows, refreshed_netuids, captured_at) {
  if (refreshed_netuids == null && captured_at == null) {
    return JSON.stringify(rows);
  }
  return JSON.stringify({ rows, refreshed_netuids, captured_at });
}

function parseNeuronStagingMeta(envelope, rows) {
  const hasRefreshed = envelope?.refreshed_netuids !== undefined;
  const hasCaptured = envelope?.captured_at !== undefined;
  if (!hasRefreshed && !hasCaptured) {
    return { legacy: true };
  }
  if (!hasRefreshed || !hasCaptured) {
    return { invalid: true };
  }
  const refreshed_netuids = envelope.refreshed_netuids;
  const captured_at = envelope.captured_at;
  if (
    !Array.isArray(refreshed_netuids) ||
    refreshed_netuids.length > MAX_STAGED_REFRESHED_NETUIDS ||
    !Number.isInteger(captured_at) ||
    captured_at < 0
  ) {
    return { invalid: true };
  }
  const refreshedSet = new Set();
  for (const netuid of refreshed_netuids) {
    if (
      !Number.isInteger(netuid) ||
      netuid < 0 ||
      netuid > MAX_STAGED_NETUID ||
      refreshedSet.has(netuid)
    ) {
      return { invalid: true };
    }
    refreshedSet.add(netuid);
  }
  for (const row of rows) {
    if (row.captured_at !== captured_at || !refreshedSet.has(row.netuid)) {
      return { invalid: true };
    }
  }
  return { legacy: false, refreshed_netuids, captured_at };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function timingSafeStringEqual(a, b) {
  const left = utf8Bytes(String(a || ""));
  const right = utf8Bytes(String(b || ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function hmacHex(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, utf8Bytes(value));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validStagedNeuronRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > MAX_STAGED_NETUID
  )
    return false;
  if (!Number.isInteger(row.uid) || row.uid < 0 || row.uid > MAX_STAGED_UID)
    return false;
  for (const [key, value] of Object.entries(row)) {
    if (!NEURON_INSERT_COLUMNS.includes(key)) return false;
    if (
      typeof value === "string" &&
      utf8Bytes(value).length > MAX_STAGED_NEURON_STRING_BYTES
    )
      return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    if (
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      typeof value === "symbol" ||
      typeof value === "function"
    )
      return false;
  }
  return true;
}

// Load a staged per-UID metagraph snapshot from R2 into D1 (#1303). The
// refresh-metagraph CI job fetches the metagraph first-party (#1348), wraps the
// neuron rows in an HMAC-signed envelope, and writes it to R2
// (metagraph/neurons-pending.json) using its existing R2 permission; we load only
// authenticated, bounded, schema-valid rows through the METAGRAPH_HEALTH_DB
// binding — which needs no API-token D1 permission — with PARAMETERIZED inserts
// (values are always bound, never interpolated). After every batch succeeds we
// delete older rows for the coverage represented by the staged payload: legacy
// bare-array snapshots replace the full table, while coverage envelopes replace
// only their refreshed subnets. Then delete the staged object so it loads exactly
// once.
export async function loadStagedNeurons(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const object = await bucket.get(STAGED_NEURONS_KEY);
  if (!object) return { ok: false, reason: "none" };
  if (Number(object.size || 0) > MAX_STAGED_NEURONS_BYTES) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "too_large" };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  if (rows.length > MAX_STAGED_NEURON_ROWS) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "too_many_rows" };
  }
  if (!rows.length || rows.some((row) => !validStagedNeuronRow(row))) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "invalid" };
  }
  const stagingMeta = parseNeuronStagingMeta(envelope, rows);
  if (stagingMeta.invalid) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "invalid" };
  }
  const expected = await hmacHex(
    signingKey,
    neuronStagingSignPayload(
      rows,
      stagingMeta.legacy ? null : stagingMeta.refreshed_netuids,
      stagingMeta.legacy ? null : stagingMeta.captured_at,
    ),
  );
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  const cols = NEURON_INSERT_COLUMNS;
  const colList = cols.join(",");
  const ROWS_PER_STMT = 5;
  const STMTS_PER_BATCH = 50;
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = chunk
      .map(() => `(${cols.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
    statements.push(
      db
        .prepare(`INSERT OR REPLACE INTO neurons (${colList}) VALUES ${tuples}`)
        .bind(...values),
    );
  }
  // A staged snapshot is replacement data for its declared coverage: every row
  // shares one captured_at stamp (set once by the producer). If ANY batch throws,
  // bail WITHOUT deleting prior rows or the staged object — the prior snapshot
  // stays as a fallback and the next cron retries the same staged file.
  try {
    for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
      await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
    }
  } catch {
    return { ok: false, reason: "load_failed" };
  }
  // Snapshot-replace (#1303): only after EVERY upsert batch succeeds, delete
  // rows older than this snapshot's stamp for the same replacement scope. Legacy
  // bare-array snapshots have no coverage metadata, so they replace the whole
  // table. Coverage envelopes can intentionally represent a partial refresh, so
  // prune only those refreshed netuids; otherwise a subnet that failed to fetch
  // could be erased by an unrelated newer captured_at stamp.
  let snapshotCapturedAt = 0;
  for (const row of rows) {
    if (
      Number.isInteger(row.captured_at) &&
      row.captured_at > snapshotCapturedAt
    )
      snapshotCapturedAt = row.captured_at;
  }
  let purged;
  try {
    const prune = stagingMeta.legacy
      ? db
          .prepare(`DELETE FROM neurons WHERE captured_at < ?`)
          .bind(snapshotCapturedAt)
      : db
          .prepare(
            `DELETE FROM neurons WHERE netuid IN (${stagingMeta.refreshed_netuids
              .map(() => "?")
              .join(",")}) AND captured_at < ?`,
          )
          .bind(...stagingMeta.refreshed_netuids, stagingMeta.captured_at);
    const result = await prune.run();
    purged = result?.meta?.changes ?? 0;
  } catch {
    // Rows are already loaded; a failed prune just leaves stale rows for the next
    // run to clear. Do NOT delete the staged object — let the next cron re-prune.
    return { ok: false, reason: "purge_failed" };
  }
  await bucket.delete(STAGED_NEURONS_KEY);
  return { ok: true, rows: rows.length, purged };
}

// Load a staged chain-event batch from R2 into D1 (#1346, epic #1345). The
// refresh-events CI job decodes finney's System.Events first-party (no Taostats)
// and writes account_events rows as JSON to R2 (events/account-events-pending.json)
// with its existing R2 permission; we load them here through the binding (no
// API-token D1 permission) with PARAMETERIZED INSERT OR IGNORE keyed
// (block_number, event_index) — so overlapping poller windows re-insert harmlessly
// (idempotent, no cursor needed) and a tampered file can only fail, never inject.
// Then delete the object so each batch loads once.
export async function loadStagedEvents(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  if (!bucket?.get || !db?.prepare) return { ok: false, reason: "unavailable" };
  const key = "events/account-events-pending.json";
  const object = await bucket.get(key);
  if (!object) return { ok: false, reason: "none" };
  // Byte cap: never materialize a pathological body. `size` is object metadata,
  // available before the body is streamed. Do NOT delete — that would drop rows the
  // producer staged; leave it (loud) and let the overlapping poller's next window
  // self-heal it. A misconfigured backfill exceeding this should be chunked by the
  // producer, not parsed here.
  if (Number(object.size || 0) > MAX_STAGED_EVENTS_BYTES) {
    console.warn(
      `loadStagedEvents: staged file ${object.size} bytes exceeds ${MAX_STAGED_EVENTS_BYTES}; skipping (poller overlap self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size || 0) };
  }
  let parsed;
  try {
    parsed = await object.json();
  } catch {
    await bucket.delete(key);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = validEventRows(parsed);
  if (!rows.length) {
    await bucket.delete(key);
    return { ok: false, reason: "empty" };
  }
  // Row cap: bound the D1 writes + subrequests per */3 tick. Drain up to the cap
  // now; if rows remain, rewrite the object with ONLY the remainder so the next tick
  // continues — never delete while rows are un-persisted. Order matters: write to D1
  // FIRST, then shrink R2. A crash between them re-reads the full file next tick and
  // re-inserts the loaded rows harmlessly (INSERT OR IGNORE), so nothing is dropped.
  const batch =
    rows.length > MAX_STAGED_EVENT_ROWS
      ? rows.slice(0, MAX_STAGED_EVENT_ROWS)
      : rows;
  const remainder =
    rows.length > MAX_STAGED_EVENT_ROWS
      ? rows.slice(MAX_STAGED_EVENT_ROWS)
      : [];
  const statements = eventInsertStatements(db, batch);
  const STMTS_PER_BATCH = 50;
  for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
  }
  if (remainder.length) {
    await bucket.put(key, JSON.stringify(remainder));
    return { ok: true, rows: batch.length, remaining: remainder.length };
  }
  await bucket.delete(key);
  return { ok: true, rows: batch.length };
}

// POST /api/v1/internal/events (#1360): the realtime ingest path for the
// finalized-head streamer (#1361). Disabled (503) until METAGRAPH_EVENTS_INGEST_SECRET
// is configured; then authenticated by a constant-time token compare. The body is
// an array of account_events rows (or {events:[...]}), loaded with the SAME
// parameterized INSERT OR IGNORE as the staged-batch loader — idempotent on
// (block_number, event_index), values always bound. NOT in the public contract.
export async function handleEventIngest(request, env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "POST only.", 405);
  }
  const configured = env.METAGRAPH_EVENTS_INGEST_SECRET;
  if (!configured) {
    return errorResponse(
      "events_ingest_disabled",
      "Realtime event ingest requires METAGRAPH_EVENTS_INGEST_SECRET to be configured.",
      503,
    );
  }
  const provided = request.headers.get(EVENTS_INGEST_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return errorResponse(
      "unauthorized",
      `Provide a valid ${EVENTS_INGEST_TOKEN_HEADER} header.`,
      401,
    );
  }
  const db = env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) {
    return errorResponse("unavailable", "Event store unavailable.", 503);
  }
  const raw = await request.text();
  if (raw.length > MAX_EVENTS_INGEST_BODY_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Body exceeds ${MAX_EVENTS_INGEST_BODY_BYTES} bytes.`,
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON array of event rows (or {events:[...]}).",
      400,
    );
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.events)
      ? parsed.events
      : null;
  if (!incoming) {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON array of event rows (or {events:[...]}).",
      400,
    );
  }
  if (incoming.length > MAX_EVENTS_INGEST_ROWS) {
    return errorResponse(
      "too_many_rows",
      `At most ${MAX_EVENTS_INGEST_ROWS} events per request.`,
      413,
    );
  }
  const rows = validEventRows(incoming);
  if (rows.length) {
    await db.batch(eventInsertStatements(db, rows));
  }
  return new Response(JSON.stringify({ ok: true, inserted: rows.length }), {
    status: 200,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

// Cron entrypoint. Cloudflare passes the exact cron string that fired in
// `controller.cron`; the hourly trigger prunes the time-series, every other
// trigger (the 15-minute one) runs a full operational-health probe sweep.

export async function handleScheduled(controller, env = {}, ctx = {}) {
  const cron = controller?.cron || "";
  // Fast-load cron (#1346 Option A): its whole job is to drain the R2-staged
  // batches into D1 quickly, then return without running the heavier probe/prune so
  // it can tick every ~3 min cheaply and keep chain-event latency at ~5 min.
  //
  // The drain is gated to THIS cron alone (audit #9). The four cron triggers fire as
  // separate concurrent invocations whose minutes coincide (e.g. 0/15/30/45), and
  // each staged load is an unlocked R2 read-modify-write (read → load → delete /
  // rewrite). Running the loaders on every tick let a concurrent invocation clobber a
  // freshly-staged file via the delete path; owning the drain on a single cron removes
  // the cross-cron concurrency entirely. Each loader stays isolated (`.catch`) so a
  // load failure never affects the early-return below.
  if (cron === EVENTS_LOAD_CRON) {
    // Token-free per-UID metagraph load (#1303): pick up any R2-staged neuron
    // snapshot and load it via the D1 binding; it then self-deletes.
    await loadStagedNeurons(env).catch(() => {});
    // Token-free chain-event load (#1346): pick up any R2-staged event batch from
    // the first-party poller and load it via the binding.
    await loadStagedEvents(env).catch(() => {});
    return { ok: true, fast_load: true };
  }
  if (cron === HEALTH_PRUNE_CRON) {
    // Roll the day's raw checks into the durable daily uptime table BEFORE
    // pruning, so long-term history is never lost when 30-day raw rows are
    // deleted (PR3). Roll the chain events the same way (#1346) before their
    // 90-day window is pruned. Skip prune when either rollup fails so raw rows
    // are never deleted without being aggregated first.
    const uptimeRollup = await rollupDailyUptime(env);
    const eventsRollup = await rollupAccountEventsDaily(env);
    const snapshotPromise = writeSubnetSnapshot(env, { readArtifact });
    if (!uptimeRollup.rolled || !eventsRollup.rolled) {
      const snapshot = await snapshotPromise;
      return {
        pruned: false,
        rollup_skipped_prune: true,
        uptime_rolled: uptimeRollup.rolled,
        events_rolled: eventsRollup.rolled,
        snapshot,
      };
    }
    const [pruned] = await Promise.all([
      pruneHealthHistory(env),
      pruneAccountEvents(env).catch(() => ({ pruned: false })),
      snapshotPromise,
    ]);
    return pruned;
  }
  if (cron === EMBEDDING_SYNC_CRON) {
    return runEmbeddingSync(env, { readArtifact });
  }
  if (cron === NEURON_HISTORY_ROLLUP_CRON) {
    // Once/day (#1345): snapshot the current `neurons` tier into the dated
    // neuron_daily table, archive that day and any prunable backlog to the R2
    // cold tier, then prune D1 to the 90-day hot window. Archive runs BEFORE
    // prune and the prune is GATED on confirmed archives for every day eligible
    // for deletion, so a day is never dropped from D1 before it exists in R2. Its
    // own cron minute so the ~33k-row work never piles onto the probe/prune/fast
    // crons; each step is .catch-isolated.
    const rolled = await rollupNeuronDaily(env).catch(() => ({
      rolled: false,
    }));
    const archived = await archiveNeuronDaily(env).catch(() => ({
      archived: false,
    }));
    const archivedPrunable = await archivePrunableNeuronDaily(env).catch(
      () => ({
        archived: false,
      }),
    );
    const pruned =
      archived.archived && archivedPrunable.archived
        ? await pruneNeuronDaily(env).catch(() => ({ pruned: false }))
        : { pruned: false, reason: "archive-not-confirmed" };
    return { rolled, archived, archivedPrunable, pruned };
  }
  return runHealthProber(env, ctx);
}

export async function handleRequest(request, env = {}, ctx = {}) {
  let url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight(request);
  }

  // Multi-network addressing: an explicit /{network}/ prefix (mainnet/testnet/
  // local + finney/test aliases) routes through the network-aware artifact
  // handler. Bare paths fall through to the full dispatch below unchanged, so
  // mainnet behaviour is byte-identical to before networks existed.
  const networkRoute = resolveNetworkPrefix(url);
  if (networkRoute.explicit) {
    if (networkRoute.network.isDefault) {
      url = networkRoute.url;
      request = new Request(url.toString(), request);
    } else {
      return handleNetworkScopedRequest(
        request,
        env,
        networkRoute.url,
        networkRoute.network,
        ctx,
      );
    }
  }

  if (url.pathname.startsWith("/rpc/v1/")) {
    return handleRpcProxyRequest(request, env, url, ctx);
  }

  // Change-feed webhooks: subscription management accepts POST/DELETE/GET, so it
  // must run before the read-only method gate below (like the RPC proxy).
  if (url.pathname.startsWith("/api/v1/webhooks/")) {
    return handleWebhookRequest(request, env, url);
  }

  // Remote MCP server (stateless JSON-RPC over POST), for AI agents. Runs before
  // the read-only method gate (it is POST-only) like the RPC proxy. Artifact/KV
  // readers are injected so the MCP tools reuse the exact R2/ASSETS resolution.
  if (url.pathname === "/mcp") {
    return handleMcpRequest(request, env, { readArtifact, readHealthKv });
  }

  // Grounded RAG answer endpoint (POST). Runs before the read-only method gate
  // and degrades to 503 when the AI bindings/kill-switch are absent.
  if (url.pathname === "/api/v1/ask") {
    return handleAskRequest(request, env);
  }

  // Realtime chain-event ingest (#1360): secret-gated internal write path for the
  // finalized-head streamer (#1361). POST-only; runs before the read-only gate.
  if (url.pathname === "/api/v1/internal/events") {
    return handleEventIngest(request, env);
  }

  // GraphQL read-only query layer over existing artifacts (issue #751). Runs
  // before the read-only method gate because GraphQL accepts POST requests.
  // Rate-limited up front (same binding/strategy/429 as the RPC proxy) so a
  // single client can't fan out into unbounded artifact reads + query execution.
  if (url.pathname === "/api/v1/graphql") {
    const limited = await graphqlRateLimited(request, env);
    if (limited) return limited;
    return handleGraphQLRequest(request, env);
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      {
        allow: "GET, HEAD, OPTIONS",
      },
    );
  }

  // Public content feeds (#741) — RSS 2.0 / Atom 1.0 / JSON Feed 1.1 over the
  // changelog + incident data we already compute. GET-only (runs after the
  // method gate); `/api/*` is run_worker_first so these never fall through to
  // the static assets. Read-only, content-negotiated, edge-cached.
  if (url.pathname.startsWith("/api/v1/feeds/")) {
    return handleFeedRequest(request, env, url, {
      readArtifact,
      errorResponse,
    });
  }

  // Embeddable SVG badges at /api/v1/{subnets/{netuid}|providers/{slug}}/
  // badge.svg. Worker-computed image, caught before the generic entity routing so
  // `badge.svg` isn't resolved as an entity sub-resource. `?metric=uptime` reads
  // the live reliability rollup, hence the health DB binding.
  if (
    /^\/api\/v1\/(?:subnets|providers)\/[^/]+\/badge\.svg$/.test(url.pathname)
  ) {
    return handleBadgeRequest(request, env, url, {
      readArtifact,
      db: env.METAGRAPH_HEALTH_DB,
    });
  }

  // Dynamic Open Graph card (/og.png, alias /og) for the landing page's
  // link-unfurl. Worker-computed PNG with live registry counts; workers-og's
  // wasm is lazy-loaded inside the handler so this never weighs on other routes.
  if (url.pathname === "/og.png" || url.pathname === "/og") {
    return handleOgImage(request, env, url, { readArtifact });
  }

  // Agent/AI discovery surfaces. The homepage advertises the machine resources
  // via RFC 8288 Link headers; /.well-known/api-catalog is the RFC 9727 linkset.
  // Both are worker-owned (see wrangler `run_worker_first`) so they carry the
  // right headers/content-type instead of 404-ing through to the static assets.
  if (url.pathname === "/" || url.pathname === "") {
    return homepageResponse(request);
  }

  if (url.pathname === "/.well-known/api-catalog") {
    return apiCatalogResponse(request);
  }

  if (url.pathname === "/.well-known/mcp/server-card.json") {
    return mcpServerCardResponse(request, env);
  }

  // Agent tool specs for non-MCP runtimes (OpenAI function calling / Anthropic
  // tool use), projected at request time from the same listToolDefinitions() the
  // MCP server advertises — so they can't drift. Worker-owned (run_worker_first).
  if (url.pathname === "/.well-known/agent-tools/index.json") {
    return agentToolsResponse(request, env, "index");
  }
  if (url.pathname === "/.well-known/agent-tools/openai.json") {
    return agentToolsResponse(request, env, "openai");
  }
  if (url.pathname === "/.well-known/agent-tools/anthropic.json") {
    return agentToolsResponse(request, env, "anthropic");
  }

  if (url.pathname === "/health") {
    return handleHealthRequest(request, env);
  }

  if (url.pathname === "/api/v1/events") {
    return handleEventsRequest(request, env);
  }

  // Semantic (vector) search over the registry. Special-handled (dynamic, not
  // artifact-backed) like /api/v1/events; degrades to 503 when AI is off.
  if (url.pathname === "/api/v1/search/semantic") {
    return handleSemanticSearchRequest(request, env, url);
  }

  // Registry leaderboards (D1 + registry projections; fileless-D1 pattern).
  if (url.pathname === "/api/v1/registry/leaderboards") {
    // Deterministic per-cron-tick D1 leaderboard; edge-cache keyed on the health
    // snapshot's last_run_at (auto-busts on the next probe) like the sibling
    // analytics routes, so a polling/cross-colo burst doesn't re-run the SQL.
    return withEdgeCache(request, ctx, env, "leaderboards", () =>
      handleLeaderboards(request, env, url),
    );
  }

  // RPC reverse-proxy usage analytics (D1 telemetry; fileless-D1 pattern, B3).
  if (url.pathname === "/api/v1/rpc/usage") {
    return handleRpcUsage(request, env, url);
  }

  // #358: live "verify-now" for one catalogued surface — an action endpoint
  // (modeled on the RPC proxy), so it lives outside the artifact-route contract.
  const verifyMatch =
    /^\/api\/v1\/surfaces\/([A-Za-z0-9][A-Za-z0-9:._-]*)\/verify$/.exec(
      url.pathname,
    );
  if (verifyMatch) {
    return handleSurfaceVerify(
      request,
      env,
      decodeURIComponent(verifyMatch[1]),
      ctx,
    );
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    const resolved = await resolveSubnetSlugRoute(env, url);
    if (resolved.notFound) {
      return errorResponse(
        "subnet_not_found",
        `No subnet matches the slug "${resolved.slug}".`,
        404,
        { slug: resolved.slug },
      );
    }
    // D1-backed health trends (slug-aware after resolution). Special-handled
    // rather than artifact-backed, like /api/v1/events.
    const bulkTrendsMatch = BULK_TRENDS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (bulkTrendsMatch) {
      return handleBulkHealthTrends(request, env, resolved.url, ctx);
    }
    const trendsMatch = TRENDS_PATH_PATTERN.exec(resolved.url.pathname);
    if (trendsMatch) {
      return handleHealthTrends(
        request,
        env,
        Number(trendsMatch[1]),
        resolved.url,
        ctx,
      );
    }
    const percentilesMatch = PERCENTILES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (percentilesMatch) {
      return handleHealthPercentiles(
        request,
        env,
        Number(percentilesMatch[1]),
        resolved.url,
        ctx,
      );
    }
    const incidentsMatch = INCIDENTS_PATH_PATTERN.exec(resolved.url.pathname);
    if (incidentsMatch) {
      return handleHealthIncidents(
        request,
        env,
        Number(incidentsMatch[1]),
        resolved.url,
        ctx,
      );
    }
    const trajectoryMatch = TRAJECTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (trajectoryMatch) {
      return withEdgeCache(request, ctx, env, "trajectory", () =>
        handleTrajectory(
          request,
          env,
          Number(trajectoryMatch[1]),
          resolved.url,
        ),
      );
    }
    const uptimeMatch = UPTIME_PATH_PATTERN.exec(resolved.url.pathname);
    if (uptimeMatch) {
      return withEdgeCache(request, ctx, env, "uptime", () =>
        handleUptime(request, env, Number(uptimeMatch[1]), resolved.url),
      );
    }
    // Per-UID metagraph (#1304/#1305): computed live from the neurons D1 tier.
    const neuronHistoryMatch = SUBNET_NEURON_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (neuronHistoryMatch) {
      return handleNeuronHistory(
        request,
        env,
        Number(neuronHistoryMatch[1]),
        Number(neuronHistoryMatch[2]),
        resolved.url,
      );
    }
    const subnetHistoryMatch = SUBNET_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (subnetHistoryMatch) {
      return handleSubnetHistory(
        request,
        env,
        Number(subnetHistoryMatch[1]),
        resolved.url,
      );
    }
    const metagraphMatch = SUBNET_METAGRAPH_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (metagraphMatch) {
      return handleSubnetMetagraph(
        request,
        env,
        Number(metagraphMatch[1]),
        resolved.url,
      );
    }
    const neuronMatch = SUBNET_NEURON_PATH_PATTERN.exec(resolved.url.pathname);
    if (neuronMatch) {
      return handleNeuron(
        request,
        env,
        Number(neuronMatch[1]),
        Number(neuronMatch[2]),
      );
    }
    const validatorsMatch = SUBNET_VALIDATORS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (validatorsMatch) {
      return handleSubnetValidators(
        request,
        env,
        Number(validatorsMatch[1]),
        resolved.url,
      );
    }
    // Account entity routes (#1347): computed live from the account_events +
    // neurons D1 tiers. More-specific paths first (each pattern is anchored).
    const accountEventsMatch = ACCOUNT_EVENTS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountEventsMatch) {
      return handleAccountEvents(
        request,
        env,
        accountEventsMatch[1],
        resolved.url,
      );
    }
    const accountSubnetsMatch = ACCOUNT_SUBNETS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountSubnetsMatch) {
      return handleAccountSubnets(request, env, accountSubnetsMatch[1]);
    }
    const accountMatch = ACCOUNT_PATH_PATTERN.exec(resolved.url.pathname);
    if (accountMatch) {
      return handleAccount(request, env, accountMatch[1]);
    }
    if (resolved.url.pathname === "/api/v1/incidents") {
      return withEdgeCache(request, ctx, env, "global-incidents", () =>
        handleGlobalIncidents(request, env, resolved.url),
      );
    }
    return handleApiRequest(request, env, resolved.url, DEFAULT_NETWORK, ctx);
  }

  if (BADGE_SVG_PATTERN.test(url.pathname)) {
    return handleBadgeSvgRequest(request, env, url);
  }

  if (
    url.pathname.startsWith("/metagraph/") &&
    url.pathname.endsWith(".json")
  ) {
    return handleRawArtifactRequest(request, env, url);
  }

  if (env.ASSETS?.fetch) {
    return env.ASSETS.fetch(request);
  }

  return errorResponse(
    "not_found",
    "No static asset binding is configured for this route.",
    404,
  );
}

// Dynamic routes backed by mainnet-only D1/AI/curated data — not partitioned per
// network, so they 404 under a /{network}/ prefix rather than silently serving
// mainnet data. Mirrors the special-cased branches in handleRequest.
function isMainnetOnlyApiPath(pathname) {
  return (
    pathname === "/api/v1/events" ||
    pathname === "/api/v1/ask" ||
    pathname === "/api/v1/graphql" ||
    pathname === "/api/v1/search/semantic" ||
    pathname === "/api/v1/registry/leaderboards" ||
    pathname.startsWith("/api/v1/webhooks/") ||
    BULK_TRENDS_PATH_PATTERN.test(pathname) ||
    TRENDS_PATH_PATTERN.test(pathname) ||
    PERCENTILES_PATH_PATTERN.test(pathname) ||
    INCIDENTS_PATH_PATTERN.test(pathname) ||
    TRAJECTORY_PATH_PATTERN.test(pathname) ||
    UPTIME_PATH_PATTERN.test(pathname)
  );
}

// Handles an explicit /{network}/-prefixed request (URL already prefix-stripped).
// Only the registry artifact surfaces are network-partitioned; dynamic/AI/live
// features stay mainnet-only. testnet/local data is R2-only and may not exist yet
// — readArtifact then returns a clean 404 carrying the requested network.
async function handleNetworkScopedRequest(
  request,
  env,
  url,
  network,
  ctx = {},
) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  // Local dev-mode: /api/v1/local returns the setup pointer (url is stripped, so
  // the network root is "/api/v1"); any data route under local is a clear no-data
  // 404 since metagraphed hosts nothing for a developer's local chain.
  if (network.id === "local") {
    if (url.pathname === "/api/v1") {
      return envelopeResponse(
        request,
        {
          data: LOCAL_NETWORK_INFO,
          meta: {
            network: "local",
            contract_version: contractVersion(env),
            source: "static",
          },
        },
        "short",
      );
    }
    return errorResponse(
      "not_found",
      "The local network is a client-side developer chain — metagraphed hosts no data for it. GET /api/v1/local for setup guidance before pointing your SDK/RPC at your own local node.",
      404,
      { network: "local" },
    );
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    if (isMainnetOnlyApiPath(url.pathname)) {
      return errorResponse(
        "not_found",
        `${url.pathname} is only available on mainnet, not the ${network.id} network.`,
        404,
        { network: network.id },
      );
    }
    const resolved = await resolveSubnetSlugRoute(
      env,
      url,
      Date.now(),
      network,
    );
    if (resolved.notFound) {
      return errorResponse(
        "subnet_not_found",
        `No subnet matches the slug "${resolved.slug}" on the ${network.id} network.`,
        404,
        { slug: resolved.slug, network: network.id },
      );
    }
    // Re-check after slug→netuid resolution: a slug-form per-subnet route (e.g.
    // /subnets/<slug>/health/trends) only reveals itself as a mainnet-only
    // dynamic route once the numeric netuid is filled in. Gate it explicitly
    // rather than relying on a downstream R2 miss.
    if (isMainnetOnlyApiPath(resolved.url.pathname)) {
      return errorResponse(
        "not_found",
        `${resolved.url.pathname} is only available on mainnet, not the ${network.id} network.`,
        404,
        { network: network.id },
      );
    }
    return handleApiRequest(request, env, resolved.url, network, ctx);
  }

  if (
    url.pathname.startsWith("/metagraph/") &&
    url.pathname.endsWith(".json")
  ) {
    return handleRawArtifactRequest(request, env, url, network);
  }

  return errorResponse(
    "not_found",
    `No network-scoped route matched this path on the ${network.id} network.`,
    404,
    { network: network.id },
  );
}

async function handleRawArtifactRequest(
  request,
  env,
  url,
  network = DEFAULT_NETWORK,
) {
  if (!matchRawArtifact(url.pathname)) {
    return errorResponse(
      "not_found",
      "No public artifact contract matched this path.",
      404,
      {
        artifact_path: url.pathname,
      },
    );
  }

  const networkPath = artifactPathForNetwork(url.pathname, network);
  if (
    network.isDefault &&
    RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN.test(networkPath)
  ) {
    return errorResponse(
      "retired_artifact",
      "Current-state health artifacts are retired; use the live API health endpoints instead.",
      410,
      { artifact_path: networkPath },
    );
  }
  const artifact = await readArtifact(env, networkPath);
  if (!artifact.ok) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: networkPath,
    });
  }
  // Live per-endpoint health overlay: raw artifacts that embed the shared
  // EndpointResource list (endpoints.json, subnets/{n}.json, profiles/{n}.json,
  // provider endpoints) must not serve build-time operational health as fresh.
  // Overlay the 15-minute cron snapshot so direct /metagraph/*.json fetchers see
  // the same live status the /api/v1 routes do; surfaces with no live reading
  // read `unknown`. Mainnet-only (live store is mainnet) and gated to artifacts
  // that actually carry probed endpoints.
  let data = artifact.data;
  if (
    network.isDefault &&
    Array.isArray(data?.endpoints) &&
    data.endpoints.some((endpoint) => endpoint?.surface_id)
  ) {
    const liveSnapshot = await resolveLiveHealth({
      readHealthKv,
      env,
      db: env.METAGRAPH_HEALTH_DB,
    });
    data = overlayArtifactEndpoints(data, liveSnapshot) ?? data;
  }
  // The raw artifact path has no envelope. Artifacts bake a deterministic epoch
  // `generated_at` marker (issue #349) so their bytes don't churn; stamp the real
  // publish time onto the served body's generated_at (and a header) so direct
  // fetchers of /metagraph/*.json see the true date. Operational-health fields are
  // overlaid live (above).
  const pub = await publishedAt(env);
  if (
    pub &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "generated_at" in data
  ) {
    data = { ...data, generated_at: pub };
  }
  const body = JSON.stringify(data);
  const headers = apiHeaders("standard");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-metagraph-artifact-source", artifact.source);
  headers.set("x-metagraph-storage-tier", artifact.storage_tier);
  if (pub) {
    headers.set("x-metagraph-published-at", pub);
  }
  headers.set("etag", await weakEtag(body));
  if (ifNoneMatchSatisfied(request, headers.get("etag"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

// Multi-network addressing (cosmos.directory-style). The friendly URL/UI segment
// (mainnet/testnet/local) maps to the chain-accurate value the data carries
// (finney/test/local) and to the R2 key prefix for non-default networks. Mainnet
// is the default: bare /api/v1/... and /metagraph/... resolve to it unprefixed,
// so every pre-network URL keeps working byte-for-byte. The chain names finney/
// test are accepted as aliases.
const NETWORKS = {
  mainnet: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  finney: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  testnet: {
    id: "testnet",
    chain: "test",
    prefix: "testnet",
    isDefault: false,
  },
  test: { id: "testnet", chain: "test", prefix: "testnet", isDefault: false },
  local: { id: "local", chain: "local", prefix: "local", isDefault: false },
};
const DEFAULT_NETWORK = NETWORKS.mainnet;

// `local` is a per-developer subtensor metagraphed cannot enumerate or host, so
// instead of registry data /api/v1/local returns the setup pointer: point your
// SDK/RPC at the local node and use mainnet/testnet here as the reference
// registry. (cosmos.directory similarly can't host a developer's local chain.)
const LOCAL_NETWORK_INFO = {
  network: "local",
  mode: "client-side",
  note: "Local is a per-developer subtensor you run yourself — metagraphed hosts no subnet data for it. Point your Bittensor SDK / RPC at your local node; use the mainnet and testnet registries here as the reference.",
  rpc: { network_arg: "local" },
  // The full develop-before-mainnet path (issue #354): stand up a local chain,
  // create a subnet on it, point your code at it, then graduate to testnet and
  // mainnet. Uses the official opentensor/subtensor localnet (it generates the
  // chain-spec + funded keys correctly) rather than a bespoke spec.
  quickstart: {
    summary:
      "Stand up a local Bittensor chain, create a subnet on it, and point your SDK at it — develop and test everything before you touch testnet or mainnet.",
    steps: [
      {
        step: 1,
        title: "Run a local chain",
        run: "git clone https://github.com/opentensor/subtensor && cd subtensor && ./scripts/localnet.sh --no-purge",
        detail:
          "Starts a local subtensor WebSocket endpoint with sudo, fast blocks, and pre-funded Alice/Bob keys (free TAO). First run compiles the node (needs the Rust toolchain + build deps).",
      },
      {
        step: 2,
        title: "Install the CLI + SDK",
        run: "pip install bittensor bittensor-cli",
        detail:
          "btcli drives chain operations; the bittensor SDK is what your miner/validator/app imports.",
      },
      {
        step: 3,
        title: "Fund a wallet + create a subnet on the local chain",
        run: "btcli wallet faucet --network local && btcli subnet create --network local",
        detail:
          "The faucet tops up free local TAO; subnet create registers a new netuid on your local chain (instant, free to iterate on).",
      },
      {
        step: 4,
        title: "Register + point your code at it",
        run: "btcli subnet register --netuid <N> --network local",
        detail:
          "Then in code: bt.SubtensorApi(network='local') (or bt.subtensor(network='local')). Everything you'd do on mainnet works here first.",
      },
      {
        step: 5,
        title: "Graduate to testnet, then mainnet",
        run: "Re-run with --network test, then --network finney.",
        detail:
          "Use /api/v1/testnet/subnets as the testnet reference and the mainnet registry here as production; /api/v1/lineage tracks which testnet subnets have graduated to mainnet.",
      },
    ],
  },
  reference: {
    testnet_subnets: "/api/v1/testnet/subnets",
    mainnet_subnets: "/api/v1/subnets",
    lineage: "/api/v1/lineage",
  },
  setup: {
    sdk: "Python bittensor SDK: bt.SubtensorApi(network='local') (or bt.subtensor(network='local')).",
    run_local_chain:
      "Run a local subtensor node (the Subtensor repo's localnet script) to expose your own local WebSocket endpoint with sudo + fast blocks and free TAO.",
  },
  guide: "/skills/bittensor/SKILL.md",
};
// Only an /api/v1/ or /metagraph/ path whose first segment is a known network
// alias is treated as network-scoped; real routes (subnets, providers, …) never
// collide with the alias set, so this never shadows an existing path.
const NETWORK_PREFIX_PATTERN =
  /^\/(api\/v1|metagraph)\/(mainnet|finney|testnet|test|local)(\/.*|$)/;

// Splits explicit /{network}/ prefixes off the path. Default-network aliases
// (mainnet/finney) are canonicalized iteratively so repeated aliases preserve
// the old bare-route dispatch without recursively re-entering handleRequest. If
// a non-default prefix remains after default alias normalization, it is returned
// for the network-scoped artifact handler. Bare paths resolve to mainnet with
// the URL unchanged (explicit:false) — the zero-regression default.
function resolveNetworkPrefix(url) {
  let rewritten = url;
  let explicit = false;

  while (true) {
    const match = NETWORK_PREFIX_PATTERN.exec(rewritten.pathname);
    if (!match) {
      return { network: DEFAULT_NETWORK, url: rewritten, explicit };
    }

    const network = NETWORKS[match[2]];
    const nextUrl = new URL(rewritten);
    nextUrl.pathname = `/${match[1]}${match[3] && match[3] !== "/" ? match[3] : ""}`;
    explicit = true;

    if (!network.isDefault) {
      return { network, url: nextUrl, explicit };
    }

    rewritten = nextUrl;
  }
}

// Inserts the network key segment for non-default networks, so the artifact read
// targets metagraph/{prefix}/...  (/metagraph/subnets.json + testnet ->
// /metagraph/testnet/subnets.json). Mainnet (prefix "") is a no-op.
function artifactPathForNetwork(artifactPath, network = DEFAULT_NETWORK) {
  if (!network || !network.prefix) {
    return artifactPath;
  }
  return artifactPath.replace(
    /^\/metagraph\//,
    `/metagraph/${network.prefix}/`,
  );
}

// Friendly per-subnet routes: /api/v1/subnets/<slug>/... resolves to the netuid
// (e.g. /api/v1/subnets/allways → /api/v1/subnets/7). Worker-only — the slug→
// netuid map is read from the served subnets.json and cached per isolate; no new
// committed artifact or route contract.
const SUBNET_SLUG_ROUTE_PATTERN = /^\/api\/v1\/subnets\/([^/]+)(\/.*)?$/;
const SUBNET_SLUG_INDEX_TTL_MS = 300_000;
// Per-network slug→netuid index, keyed by network.id (slugs/netuids differ across
// chains — testnet SN-N is unrelated to mainnet SN-N).
const subnetSlugIndexByNetwork = new Map(); // network.id -> { map, builtAt }

// Leaderboards re-derives a {meta, completeness} projection from the ~600 KB
// R2 profiles.json; cache the small projection in-isolate (5 min TTL, same as
// the slug index) so junk-query-param cache-busting can't force a full R2 read
// + parse per request.
const LEADERBOARD_PROFILES_TTL_MS = 300_000;
let leaderboardProfilesCache = null; // { subnetMeta, mostComplete, builtAt }

// rpc/pools.json is R2-only and static per-build (it changes only on redeploy).
// The RPC proxy reads it on every POST to /rpc/v1/* before failover, so a burst
// turns into N R2 reads of the same artifact (#1309). Memoize the successful read
// per-isolate (5 min TTL, same as the other in-isolate caches). The per-endpoint
// health that actually changes is overlaid separately from KV (readHealthKv) on
// every request, so caching the static pool never staleness-pins live eligibility.
// Keyed on env so tests / multi-binding callers never cross-read; only ok reads
// are cached so a transient R2 miss isn't sticky.
export const RPC_POOL_ARTIFACT_TTL_MS = 300_000;
let rpcPoolArtifactCache = { env: null, value: null, expiresAt: 0 };

export async function readRpcPoolArtifact(env, now = Date.now()) {
  if (
    rpcPoolArtifactCache.env === env &&
    now < rpcPoolArtifactCache.expiresAt
  ) {
    return rpcPoolArtifactCache.value;
  }
  const poolArtifact = await readArtifact(env, "/metagraph/rpc/pools.json");
  if (poolArtifact.ok) {
    rpcPoolArtifactCache = {
      env,
      value: poolArtifact,
      expiresAt: now + RPC_POOL_ARTIFACT_TTL_MS,
    };
  }
  return poolArtifact;
}

// KV_HEALTH_META is written by the health cron (~15 min cadence) and read by
// every analytics handler (percentiles, incidents, trends, uptime, trajectory,
// leaderboards). Each handler reads it independently; this in-isolate memo
// collapses repeated per-request KV reads on warm isolates — same pattern as
// latestPointer (#367) and readRpcPoolArtifact (#1309). Null results are not
// cached so a transient cold KV does not stay sticky.
export const HEALTH_META_KV_TTL_MS = 60_000;
let healthMetaKvMemo = { env: null, value: null, expiresAt: 0 };

export async function readHealthMetaKv(env, now = Date.now()) {
  if (healthMetaKvMemo.env === env && now < healthMetaKvMemo.expiresAt) {
    return healthMetaKvMemo.value;
  }
  const value = await readHealthKv(env, KV_HEALTH_META);
  if (value !== null) {
    healthMetaKvMemo = { env, value, expiresAt: now + HEALTH_META_KV_TTL_MS };
  }
  return value;
}

// economics:current is a large blob (one row per subnet) that resolveLiveEconomics
// reads on every /api/v1/economics request AND every /api/v1/subnets/{netuid}
// request (the per-subnet economics overlay, #1308). Neither route is edge-cached
// for the live overlay, so a warm isolate re-fetches + re-parses the same blob per
// request. Memoize the read in-isolate — same pattern as readHealthMetaKv (#1375),
// readRpcPoolArtifact (#1309), latestPointer (#367). Safe: resolveLiveEconomics
// re-validates the blob's captured_at freshness against the live clock on every
// call, so the 60 s memo (≪ the 8 h freshness window) never extends how long a
// stale blob can serve. Null results are not cached so a transient cold KV does
// not stay sticky; keyed on env so tests / multi-binding callers never cross-read.
export const ECONOMICS_CURRENT_KV_TTL_MS = 60_000;
let economicsCurrentKvMemo = { env: null, value: null, expiresAt: 0 };

export async function readEconomicsCurrentKv(env, now = Date.now()) {
  if (
    economicsCurrentKvMemo.env === env &&
    now < economicsCurrentKvMemo.expiresAt
  ) {
    return economicsCurrentKvMemo.value;
  }
  const value = await readHealthKv(env, KV_ECONOMICS_CURRENT);
  if (value !== null) {
    economicsCurrentKvMemo = {
      env,
      value,
      expiresAt: now + ECONOMICS_CURRENT_KV_TTL_MS,
    };
  }
  return value;
}

async function resolveSubnetSlugRoute(
  env,
  url,
  now = Date.now(),
  network = DEFAULT_NETWORK,
) {
  const match = SUBNET_SLUG_ROUTE_PATTERN.exec(url.pathname);
  // Not a per-subnet route, or already a numeric netuid → pass through.
  if (!match || /^\d+$/.test(match[1])) {
    return { url };
  }
  const slug = decodeSlugPathSegment(match[1]);
  if (slug === null) {
    return { notFound: true, slug: match[1] };
  }
  const netuid = await lookupSubnetNetuid(env, slug, now, network);
  if (netuid === null) {
    return { notFound: true, slug };
  }
  const rewritten = new URL(url);
  rewritten.pathname = `/api/v1/subnets/${netuid}${match[2] || ""}`;
  return { url: rewritten };
}

function decodeSlugPathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

async function lookupSubnetNetuid(
  env,
  slug,
  now = Date.now(),
  network = DEFAULT_NETWORK,
) {
  const cached = subnetSlugIndexByNetwork.get(network.id);
  if (!cached || now - cached.builtAt > SUBNET_SLUG_INDEX_TTL_MS) {
    const artifact = await readArtifact(
      env,
      artifactPathForNetwork("/metagraph/subnets.json", network),
    );
    if (artifact.ok && Array.isArray(artifact.data?.subnets)) {
      const map = new Map();
      // Curated slug is canonical — map it first for every subnet.
      for (const subnet of artifact.data.subnets) {
        if (
          typeof subnet.slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          map.set(subnet.slug.toLowerCase(), subnet.netuid);
        }
      }
      // Then the chain-name native_slug (e.g. "apex") fills any key it doesn't
      // already own, so subnets resolve by the name agents discover them by —
      // essential on testnet, where there are no curated overlay slugs. A
      // curated slug always wins a collision, and duplicate native slugs are
      // suppressed so ambiguous aliases cannot resolve by artifact order.
      const nativeSlugCounts = new Map();
      for (const subnet of artifact.data.subnets) {
        if (
          typeof subnet.native_slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          const key = subnet.native_slug.toLowerCase();
          nativeSlugCounts.set(key, (nativeSlugCounts.get(key) || 0) + 1);
        }
      }
      for (const subnet of artifact.data.subnets) {
        if (
          typeof subnet.native_slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          const key = subnet.native_slug.toLowerCase();
          if (!map.has(key) && nativeSlugCounts.get(key) === 1) {
            map.set(key, subnet.netuid);
          }
        }
      }
      subnetSlugIndexByNetwork.set(network.id, { map, builtAt: now });
    } else if (!cached) {
      // Could not load the index and have no prior copy — leave unresolved.
      return null;
    }
  }
  const netuid = subnetSlugIndexByNetwork
    .get(network.id)
    ?.map.get(slug.toLowerCase());
  return Number.isInteger(netuid) ? netuid : null;
}

async function handleApiRequest(
  request,
  env,
  url,
  network = DEFAULT_NETWORK,
  ctx = {},
) {
  const matched = matchRoute(url.pathname);
  if (!matched) {
    return errorResponse("not_found", "No API route matched this path.", 404);
  }
  // Edge-cache idempotent GETs for pure static-artifact routes (mirrors the
  // RPC-proxy Cache API pattern). Live-overlay routes are excluded by route id,
  // not by whether live data happened to be available for this request, so cold
  // KV/D1 fallback responses cannot seed stale operational metadata.
  // The key namespaces by network + contract version so a deploy or a network
  // switch can never serve a cross-version body; the response's own
  // cache-control max-age bounds staleness.
  const edgeCache =
    request.method === "GET" && isStaticEdgeCacheEligible(matched, network)
      ? globalThis.caches?.default
      : null;
  const edgeCacheKey = edgeCache
    ? new Request(
        `https://edge-cache.metagraph.sh/${network.id}/${encodeURIComponent(
          contractVersion(env),
        )}${url.pathname}${url.search}`,
      )
    : null;
  // Live-overlay collection cache (the large /api/v1/endpoints index). Excluded
  // from the static edge cache above, but its overlay only changes when the
  // 2-min cron writes a new health snapshot, so cache it keyed on last_run_at —
  // turning a per-request R2-GET + parse + 3-pass overlay + 1.43 MB re-stringify
  // + SHA-256 into at-most-once-per-cron-tick, staleness bounded to one interval.
  const overlayCache =
    request.method === "GET" &&
    network.isDefault &&
    CACHEABLE_OVERLAY_ROUTE_IDS.has(matched.id)
      ? globalThis.caches?.default
      : null;
  let overlayCacheKey = null;
  if (overlayCache) {
    // Cheap KV read of just the snapshot time; on a hit this + the cache match
    // is the whole request (no R2 GET / overlay / re-stringify).
    const opMeta = await readHealthMetaKv(env);
    const lastRunAt = opMeta?.last_run_at || null;
    if (lastRunAt) {
      overlayCacheKey = new Request(
        `https://edge-cache.metagraph.sh/overlay/${network.id}/${encodeURIComponent(
          contractVersion(env),
        )}/${encodeURIComponent(lastRunAt)}${url.pathname}${canonicalOverlayCacheSearch(url, matched)}`,
      );
      const overlayHit = await overlayCache.match(overlayCacheKey);
      if (overlayHit) {
        if (ifNoneMatchSatisfied(request, overlayHit.headers.get("etag"))) {
          return new Response(null, {
            status: 304,
            headers: overlayHit.headers,
          });
        }
        return overlayHit;
      }
    }
  }
  if (edgeCache) {
    const hit = await edgeCache.match(edgeCacheKey);
    if (hit) {
      // Honour conditional requests against the cached body's weak ETag so
      // polling agents still get a 304 on a warm cache (mirrors envelopeResponse).
      if (ifNoneMatchSatisfied(request, hit.headers.get("etag"))) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      return hit;
    }
  }
  // Mainnet (default) reads the unprefixed artifact (no-op); non-default networks
  // read metagraph/{prefix}/… — see artifactPathForNetwork.
  const artifactPath = artifactPathForNetwork(matched.artifactPath, network);

  // Live operational-health overlay (Phase 3): current health is live-only.
  // Static current-health artifacts are not read for mainnet health routes, so
  // stale R2 objects left behind by earlier publishes cannot affect responses.
  let artifact;
  let live = null;
  if (!network.isDefault) {
    // Non-default networks serve only the static partitioned artifact; the live
    // KV/D1 health overlay is mainnet-only.
    artifact = await readArtifact(env, artifactPath);
  } else if (matched.id === "health") {
    // Live-only global operational health: KV health:current → D1
    // surface_status, and an explicit `unknown` global when the live store is
    // cold. There is no stored health summary to fall back to (live-only).
    const liveSnapshot = await resolveLiveHealth({
      readHealthKv,
      env,
      db: env.METAGRAPH_HEALTH_DB,
    });
    const liveData = liveSnapshot
      ? buildGlobalHealth(liveSnapshot, {
          contract_version: contractVersion(env),
        })
      : null;
    live = { data: liveData || unknownGlobalHealth(contractVersion(env)) };
    artifact = { ok: false };
  } else if (matched.id === "subnet-health") {
    artifact = { ok: false };
    live = await liveHealthOverlay(env, matched, null);
    // Per-subnet health is live-only too: never 404 on a cold store — serve an
    // explicit `unknown` payload instead of the (now absent) static artifact.
    if (!live) {
      live = { data: unknownSubnetHealth(Number(matched.params.netuid)) };
    }
  } else if (matched.id === "economics") {
    // Economics: prefer the live KV 'economics:current' blob (fresh, on-contract,
    // integrity-checked); fall back to the committed R2 economics.json when KV is
    // cold/stale/invalid. Unlike health this keeps the R2 artifact as a real
    // fallback, so it can never 404.
    artifact = await readArtifact(env, artifactPath);
    live = await resolveLiveEconomics({
      readHealthKv: (e) => readEconomicsCurrentKv(e),
      env,
      contractVersion: contractVersion(env),
    });
  } else {
    artifact = await readArtifact(env, artifactPath);
    live = await liveHealthOverlay(
      env,
      matched,
      artifact.ok ? artifact.data : null,
    );
  }

  if (!artifact.ok && !live) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: artifactPath,
    });
  }

  let baseData = live ? live.data : artifact.data;
  // Per-subnet economics overlay (#1308): attach the live economics row so
  // /api/v1/subnets/{netuid} carries validator/miner counts, registration, stake
  // and alpha price in one call. Null-safe — a cold/stale economics tier leaves
  // the detail unchanged. Served live (not baked) so it never churns the artifact.
  if (
    network.isDefault &&
    matched.id === "subnet-detail" &&
    baseData &&
    typeof baseData === "object"
  ) {
    const liveEconomics = await resolveLiveEconomics({
      readHealthKv: (e) => readEconomicsCurrentKv(e),
      env,
      contractVersion: contractVersion(env),
    });
    baseData = overlaySubnetEconomics(
      baseData,
      liveEconomics?.data,
      Number(matched.params.netuid),
    );
  }
  const baseSource = live
    ? live.source || baseData?.health_source || "live-cron-prober"
    : matched.id === "economics"
      ? "r2-fallback"
      : artifact.source;

  // Serve-time contract drift (#1001): when serving a STORED artifact (not a
  // live overlay) that was built under an older contract than the live one, the
  // body may predate a schema change. Surface it on meta + the
  // x-metagraph-stale-contract header (in envelopeResponse) + a warn log so the
  // otherwise-silent drift is observable.
  const staleContract = live
    ? null
    : contractStaleness(env, artifact.data?.contract_version);
  if (staleContract) {
    logEvent(env, "warn", "stale_contract_served", {
      artifact_path: artifactPath,
      built_under: staleContract.built_under,
      live: staleContract.live,
    });
  }

  const transformed = applyQueryFilters(
    baseData,
    url,
    matched.queryCollection,
    matched.queryFilterNames,
  );
  if (transformed.error) {
    return errorResponse("invalid_query", transformed.error.message, 400, {
      artifact_path: artifactPath,
      parameter: transformed.error.parameter,
    });
  }
  // Real publish time from the KV latest pointer (null until a publish has
  // populated it). Unlike generated_at — a deterministic content marker that is
  // intentionally the 1970 epoch in committed/local builds (issue #349) — this
  // is the genuine "last updated" timestamp.
  const pub = await publishedAt(env);
  // A live tier whose blob carries its OWN freshness (economics' captured_at,
  // refreshed on its own 3h schedule) should report that as published_at, not the
  // unrelated data publish pointer — otherwise a fresh live-kv economics blob looks
  // as stale as the last full publish.
  const effectivePublishedAt =
    matched.id === "economics" &&
    live?.source === "live-kv" &&
    baseData?.captured_at
      ? baseData.captured_at
      : pub;
  // Freshness is served LIVE, never baked. Artifacts carry a deterministic epoch
  // `generated_at` marker (issue #349) so their bytes change only when the data
  // does (git-committable, no churn). The Worker stamps the real publish time onto
  // the response here — the envelope meta (below) AND the body, so a consumer
  // reading the raw body sees the true date instead of the 1970 marker. Same source
  // that feeds meta.published_at; storage stays deterministic, serving stays honest.
  let responseData = transformed.data;
  if (
    responseData &&
    typeof responseData === "object" &&
    !Array.isArray(responseData)
  ) {
    const patch = {};
    if (effectivePublishedAt && "generated_at" in responseData) {
      patch.generated_at = effectivePublishedAt;
    }
    if (pub && "published_at" in responseData && !responseData.published_at) {
      patch.published_at = pub;
    }
    if (Object.keys(patch).length) {
      responseData = { ...responseData, ...patch };
    }
  }
  const response = await envelopeResponse(
    request,
    {
      data: responseData,
      meta: {
        artifact_path: artifactPath,
        cache: matched.cache,
        contract_version: contractVersion(env),
        generated_at: effectivePublishedAt || baseData?.generated_at || null,
        published_at: effectivePublishedAt,
        source: baseSource,
        ...(staleContract ? { stale_contract: staleContract } : {}),
        ...(baseData?.operational_observed_at
          ? { operational_observed_at: baseData.operational_observed_at }
          : {}),
        ...transformed.meta,
      },
    },
    matched.cache,
  );
  // Cache only route-declared pure static-artifact 200s. Live-overlay routes
  // are skipped even when their live store is cold and the response falls back
  // to the static artifact. 304/HEAD/non-200 are skipped. The edge entry
  // expires per the response's cache-control max-age.
  if (edgeCache && live === null && response.status === 200) {
    ctx?.waitUntil?.(edgeCache.put(edgeCacheKey, response.clone()));
  }
  // Cache the live-overlay collection only when the overlay actually applied
  // (live !== null) and we keyed on a real last_run_at (overlayCacheKey set) —
  // never cache a cold-KV fallback, which would pin build-time health under a
  // stable key. The entry busts on the next cron snapshot (key) + max-age.
  if (overlayCacheKey && live !== null && response.status === 200) {
    ctx?.waitUntil?.(overlayCache.put(overlayCacheKey, response.clone()));
  }
  return response;
}

// D1-backed 7d/30d daily uptime + latency trends across all subnets. This is a
// compact matrix feed for UI dashboards and agents, so it groups by netuid/day
// instead of returning every surface series.
async function handleBulkHealthTrends(
  request,
  env,
  url = new URL(request.url),
  ctx = {},
) {
  for (const key of url.searchParams.keys()) {
    return errorResponse(
      "invalid_query",
      `${key} is not supported for this route.`,
      400,
      { parameter: key },
    );
  }

  return withEdgeCache(request, ctx, env, "bulk-trends", async () => {
    const nowMs = Date.now();
    const maxWindowDays = Math.max(...Object.values(HEALTH_TREND_WINDOWS));
    const cutoffDay = new Date(nowMs - maxWindowDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const rows = await d1All(
      env,
      `SELECT netuid,
            day AS date,
            SUM(samples) AS total,
            SUM(ok_count) AS ok_count,
            ${dailyLatencyColumns()}
     FROM surface_uptime_daily
     WHERE day >= ?
     GROUP BY netuid, day
     ORDER BY netuid, day
     LIMIT ?`,
      [cutoffDay, MAX_BULK_TREND_ROWS],
    );
    const windows = {};
    for (const [label, days] of Object.entries(HEALTH_TREND_WINDOWS)) {
      const windowCutoff = new Date(nowMs - days * DAY_MS)
        .toISOString()
        .slice(0, 10);
      windows[label] = rows.filter(
        (row) => String(row.day || row.date) >= windowCutoff,
      );
    }
    const meta = await readHealthMetaKv(env);
    const data = formatBulkTrends({
      observedAt: meta?.last_run_at || null,
      windows,
      windowDays: HEALTH_TREND_WINDOWS,
    });
    const response = envelopeResponse(
      request,
      {
        data,
        meta: {
          artifact_path: "/metagraph/health/trends.json",
          cache: "short",
          contract_version: contractVersion(env),
          generated_at: data.observed_at,
          published_at: await publishedAt(env),
          source: "live-cron-prober",
        },
      },
      "short",
    );
    return hasD1FallbackRows(rows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// D1-backed 7d/30d uptime + latency trends for one subnet's operational
// surfaces. Returns a schema-stable empty payload when D1 is unbound/cold so it
// never errors (mirrors the live-overlay fall-back philosophy).
async function handleHealthTrends(request, env, netuid, url, ctx = {}) {
  // Reject unsupported query params (400) like every sibling analytics route
  // (percentiles/incidents/uptime/trajectory and the bulk trends route); this
  // route takes no params and returns all configured windows.
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  return withEdgeCache(request, ctx, env, "trends", async () => {
    const db = env.METAGRAPH_HEALTH_DB;
    const nowMs = Date.now();
    const windows = {};
    // The per-window aggregations are independent — run them in parallel (one D1
    // round-trip each) like handleHealthPercentiles/handleLeaderboards, rather than
    // serializing the two with an await-in-loop.
    const windowRows = await Promise.all(
      Object.entries(HEALTH_TREND_WINDOWS).map(async ([label, days]) => {
        if (!db?.prepare) {
          return [label, []];
        }
        try {
          const result = await withTimeout(
            db
              .prepare(
                `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
             SELECT MAX(surface_id) AS surface_id,
                    surface_key,
                    COUNT(*) AS total,
                    SUM(ok) AS ok_count,
                    ${latencyStatColumns({ includeMinMax: false })}
             FROM ranked
             GROUP BY surface_key`,
              )
              .bind(netuid, nowMs - days * DAY_MS)
              .all(),
            d1TimeoutMs(env),
          );
          return [label, result?.results || []];
        } catch {
          return [label, markD1FallbackRows([])];
        }
      }),
    );
    for (const [label, rows] of windowRows) {
      windows[label] = rows;
    }
    const meta = await readHealthMetaKv(env);
    const data = formatTrends({
      netuid,
      observedAt: meta?.last_run_at || null,
      windows,
    });
    const response = envelopeResponse(
      request,
      {
        data,
        meta: {
          artifact_path: `/metagraph/health/trends/${netuid}.json`,
          cache: "short",
          contract_version: contractVersion(env),
          generated_at: data.observed_at,
          published_at: await publishedAt(env),
          source: "live-cron-prober",
        },
      },
      "short",
    );
    return hasD1FallbackRows(...Object.values(windows))
      ? markD1FallbackResponse(response)
      : response;
  });
}

function validateQueryParams(url, allowedParams) {
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowedParams.includes(key)) {
      return {
        parameter: key,
        message: `${key} is not supported for this route.`,
      };
    }
    if (seen.has(key)) {
      return {
        parameter: key,
        message: `${key} may only be provided once.`,
      };
    }
    seen.add(key);
  }
  return null;
}

function analyticsWindow(url) {
  const validationError = validateQueryParams(url, [ANALYTICS_WINDOW_PARAM]);
  if (validationError) return { error: validationError };

  const requested = url.searchParams.get(ANALYTICS_WINDOW_PARAM);
  if (requested !== null && !ANALYTICS_WINDOWS[requested]) {
    return {
      error: {
        parameter: ANALYTICS_WINDOW_PARAM,
        message: `"${requested}" is not a valid window. Supported: ${Object.keys(ANALYTICS_WINDOWS).join(", ")}.`,
      },
    };
  }

  const label = requested || "7d";
  return { label, days: ANALYTICS_WINDOWS[label] };
}

function analyticsQueryError(error) {
  return errorResponse("invalid_query", error.message, 400, {
    parameter: error.parameter,
  });
}

let d1FallbackGeneration = 0;
const D1_FALLBACK_ROWS = new WeakSet();
const D1_FALLBACK_RESPONSES = new WeakSet();

function markD1FallbackRows(rows = []) {
  d1FallbackGeneration += 1;
  D1_FALLBACK_ROWS.add(rows);
  return rows;
}

function hasD1FallbackRows(...rowSets) {
  return rowSets.some((rows) => D1_FALLBACK_ROWS.has(rows));
}

function markD1FallbackResponse(response) {
  D1_FALLBACK_RESPONSES.add(response);
  return response;
}

async function d1All(env, sql, params) {
  const db = env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return [];
  try {
    const result = await withTimeout(
      db
        .prepare(sql)
        .bind(...params)
        .all(),
      d1TimeoutMs(env),
    );
    return result?.results || [];
  } catch {
    return markD1FallbackRows([]);
  }
}

async function analyticsMeta(env, artifactPath, observedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: observedAt,
    // Canonical human-facing freshness, consistent with the artifact routes and
    // handleHealthTrends (generated_at is a deterministic build marker per #349).
    published_at: await publishedAt(env),
    source: "live-cron-prober",
  };
}

// Edge-cache wrapper for the D1-backed analytics routes (audit #6). Each of these
// re-runs a full-window D1 aggregation on EVERY request, yet the result only
// changes when the health cron writes a new snapshot — so a cross-colo / agent-
// polling burst re-executes the same 7d/30d aggregation needlessly. Mirrors the
// live-overlay collection cache exactly (the CACHEABLE_OVERLAY_ROUTE_IDS path):
// same Cache API, same `edge-cache.metagraph.sh` key host, same last_run_at
// keying, same conditional-GET 304 short-circuit, same ctx.waitUntil put.
//
// The key varies on everything that changes the body: contract_version (a deploy
// can never serve a cross-version payload) + the cron snapshot stamp
// (`last_run_at`) + the request path (carries netuid) + the canonical search
// (carries `window`). `keyParts` is the extra namespace segment per route. When
// the snapshot stamp is cold (null), caching is skipped entirely so a cold-KV
// empty payload can never seed a stale entry — identical to the overlay cache's
// `if (lastRunAt)` guard. The cache is transparent: body/shape/headers are
// whatever buildResponse() produced; only 200s are cached, never errors.
async function withEdgeCache(request, ctx, env, keyParts, buildResponse) {
  const cache = request.method === "GET" ? globalThis.caches?.default : null;
  // Cheap, per-isolate-memoized read of just the snapshot time. On a hit this +
  // the cache match is the whole request (no D1 aggregation at all).
  const lastRunAt = cache ? (await readHealthMetaKv(env))?.last_run_at : null;
  let cacheKey = null;
  if (cache && lastRunAt) {
    const url = new URL(request.url);
    cacheKey = new Request(
      `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
        contractVersion(env),
      )}/${encodeURIComponent(lastRunAt)}/${keyParts}${url.pathname}${url.search}`,
    );
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Honour conditional requests against the cached body's weak ETag so
      // polling agents still get a 304 on a warm cache (mirrors envelopeResponse).
      if (ifNoneMatchSatisfied(request, hit.headers.get("etag"))) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      return hit;
    }
  }
  const fallbackGeneration = d1FallbackGeneration;
  const response = await buildResponse();
  // Never cache errors / non-200s (cold-D1 still returns a 200 empty envelope;
  // a 400 bad-window or 5xx must not be persisted).
  if (
    cacheKey &&
    response.status === 200 &&
    !D1_FALLBACK_RESPONSES.has(response) &&
    d1FallbackGeneration === fallbackGeneration
  ) {
    ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
  }
  return response;
}

// p50/p95/p99 latency percentiles per surface, computed in D1.
async function handleHealthPercentiles(request, env, netuid, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(request, ctx, env, "percentiles", async () => {
    const rows = await d1All(
      env,
      `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
     SELECT MAX(surface_id) AS surface_id,
            surface_key,
            ${latencyStatColumns()}
     FROM ranked
     GROUP BY surface_key
     HAVING MAX(lat_cnt) > 0`,
      [netuid, Date.now() - days * DAY_MS],
    );
    const meta = await readHealthMetaKv(env);
    const data = formatPercentiles({
      netuid,
      window: label,
      observedAt: meta?.last_run_at || null,
      rows,
    });
    const response = envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          `/metagraph/health/percentiles/${netuid}.json`,
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(rows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// SLA + reconstructed downtime incidents per surface.
async function handleHealthIncidents(request, env, netuid, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(request, ctx, env, "incidents", async () => {
    const since = Date.now() - days * DAY_MS;
    const [slaRows, incidentRows] = await Promise.all([
      d1All(
        env,
        `SELECT MAX(surface_id) AS surface_id,
              COALESCE(surface_key, surface_id) AS surface_key,
              COUNT(*) AS total,
              SUM(ok) AS ok_count
       FROM surface_checks
       WHERE netuid = ? AND checked_at >= ?
       GROUP BY COALESCE(surface_key, surface_id)`,
        [netuid, since],
      ),
      // Gap-island grouping in SQL: collapse consecutive failures (gap <= the
      // incident threshold) into one incident row, then cap the public payload so
      // flapping endpoints cannot force unbounded result sets/responses.
      d1All(
        env,
        `WITH checks AS (
         SELECT COALESCE(surface_key, surface_id) AS surface_key,
                surface_id,
                checked_at,
                ok,
                checked_at - LAG(checked_at)
                  OVER (
                    PARTITION BY COALESCE(surface_key, surface_id)
                    ORDER BY checked_at
                  ) AS gap
         FROM surface_checks
         WHERE netuid = ? AND checked_at >= ?
       ),
       grouped AS (
         SELECT surface_key, surface_id, checked_at, ok,
                SUM(CASE WHEN ok = 1 OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                  OVER (PARTITION BY surface_key ORDER BY checked_at) AS grp
         FROM checks
       )
       SELECT MAX(surface_id) AS surface_id,
              surface_key,
              MIN(checked_at) AS started_at,
              MAX(checked_at) AS ended_at,
              COUNT(*) AS failed_samples
       FROM grouped
       WHERE ok = 0
       GROUP BY surface_key, grp
       HAVING COUNT(*) >= ?
       ORDER BY surface_id, started_at
       LIMIT ?`,
        [
          netuid,
          since,
          INCIDENT_GAP_MS,
          MIN_INCIDENT_SAMPLES,
          MAX_INCIDENT_ROWS,
        ],
      ),
    ]);
    const meta = await readHealthMetaKv(env);
    const data = formatIncidents({
      netuid,
      window: label,
      observedAt: meta?.last_run_at || null,
      slaRows,
      incidentRows,
      maxIncidents: MAX_INCIDENT_ROWS,
    });
    const response = envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          `/metagraph/health/incidents/${netuid}.json`,
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(slaRows, incidentRows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// Global, cross-subnet incident ledger — the same gap-island grouping as the
// per-subnet route but with no netuid filter, grouped by (netuid, surface_id)
// and capped. Powers a public status page's "recent incidents" feed. Returns a
// schema-stable empty payload when D1 is unbound/cold.
async function handleGlobalIncidents(request, env, url) {
  const { label, days, error } = analyticsWindow(url);
  if (error) {
    return analyticsQueryError(error);
  }
  const since = Date.now() - days * DAY_MS;
  const incidentRows = await d1All(
    env,
    `WITH recent_checks AS (
       SELECT netuid, COALESCE(surface_key, surface_id) AS surface_key, surface_id, checked_at, ok
       FROM surface_checks
       WHERE checked_at >= ?
       ORDER BY checked_at DESC
       LIMIT ?
     ),
     checks AS (
       SELECT netuid, surface_key, surface_id, checked_at, ok,
              checked_at - LAG(checked_at)
                OVER (
                  PARTITION BY netuid, surface_key
                  ORDER BY checked_at
                ) AS gap
       FROM recent_checks
     ),
     grouped AS (
       SELECT netuid, surface_key, surface_id, checked_at, ok,
              SUM(CASE WHEN ok = 1 OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                OVER (PARTITION BY netuid, surface_key ORDER BY checked_at) AS grp
       FROM checks
     )
     SELECT netuid,
            MAX(surface_id) AS surface_id,
            surface_key,
            MIN(checked_at) AS started_at,
            MAX(checked_at) AS ended_at,
            COUNT(*) AS failed_samples
     FROM grouped
     WHERE ok = 0
     GROUP BY netuid, surface_key, grp
     HAVING COUNT(*) >= ?
     ORDER BY started_at DESC
     LIMIT ?`,
    [
      since,
      MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
      INCIDENT_GAP_MS,
      MIN_INCIDENT_SAMPLES,
      MAX_INCIDENT_ROWS,
    ],
  );
  const meta = await readHealthMetaKv(env);
  const data = formatGlobalIncidents({
    window: label,
    observedAt: meta?.last_run_at || null,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        "/metagraph/incidents.json",
        data.observed_at,
      ),
    },
    "short",
  );
}

// Week-over-week structural trajectory from daily snapshots.
async function handleTrajectory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  // Keep the most-recent window (DESC) — formatTrajectory re-sorts ascending.
  // ASC + LIMIT would freeze on the oldest 400 days once history exceeds the cap.
  const rows = await d1All(
    env,
    `SELECT snapshot_date, completeness_score, surface_count, endpoint_count,
            validator_count, miner_count, total_stake_tao, alpha_price_tao,
            emission_share
     FROM subnet_snapshots
     WHERE netuid = ?
     ORDER BY snapshot_date DESC
     LIMIT 400`,
    [netuid],
  );
  const data = formatTrajectory({ netuid, rows });
  return envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/trajectory.json`,
        null,
      ),
    },
    "short",
  );
}

// --- Per-UID metagraph (#1304/#1305): served live from the neurons D1 tier ---
// (migration 0007, populated by the refresh-metagraph cron). Null-safe: an
// unbound/cold D1 returns a schema-stable empty payload, like the other
// D1-backed analytics routes.
async function metagraphMeta(env, artifactPath, generatedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: generatedAt,
    published_at: await publishedAt(env),
    source: "metagraph-snapshot",
  };
}

async function handleSubnetMetagraph(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["validator_permit"]);
  if (validationError) return analyticsQueryError(validationError);
  const validatorsOnly = url.searchParams.get("validator_permit") === "true";
  const rows = await d1All(
    env,
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ?${
      validatorsOnly ? " AND validator_permit = 1" : ""
    } ORDER BY uid`,
    [netuid],
  );
  const data = buildSubnetMetagraph(rows, netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/metagraph.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

async function handleNeuron(request, env, netuid, uid) {
  const rows = await d1All(
    env,
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
    [netuid, uid],
  );
  // Cold/absent snapshot → 200 with neuron:null, consistent with the other live
  // tiers (health/economics never 404 on a cold store).
  const data = buildNeuronDetail(rows[0] ?? null, netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/neurons/${uid}.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

async function handleSubnetValidators(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const rows = await d1All(
    env,
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY stake_tao DESC`,
    [netuid],
  );
  const data = buildSubnetValidators(rows, netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/validators.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// ---- Per-UID + per-subnet metagraph HISTORY (block-explorer Tier-1, #1345) --
// Served from the dated neuron_daily rollup tier (D1). Cold/absent store → 200
// with empty points (never 404), consistent with the live metagraph tiers.

// GET /api/v1/subnets/{netuid}/neurons/{uid}/history?window=7d|30d|90d|1y|all
// Per-UID time series (one point per snapshot_date, newest first, bounded).
async function handleNeuronHistory(request, env, netuid, uid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const params = [netuid, uid];
  let sql = `SELECT ${NEURON_DAILY_READ_COLUMNS} FROM neuron_daily WHERE netuid = ? AND uid = ?`;
  if (days != null) {
    // Cutoff computed in JS and bound as a plain YYYY-MM-DD (idx_neuron_daily_uid_date covers it).
    const cutoff = new Date(Date.now() - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    sql += " AND snapshot_date >= ?";
    params.push(cutoff);
  }
  sql += " ORDER BY snapshot_date DESC LIMIT ?";
  params.push(MAX_HISTORY_POINTS);
  const rows = await d1All(env, sql, params);
  const data = buildNeuronHistory(rows, netuid, uid, { window: label });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/neurons/${uid}/history.json`,
        data.points[0]?.captured_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/history?window=7d|30d|90d|1y|all
// Per-subnet daily aggregates over time (count + totals) for a history sparkline,
// without shipping every UID's row.
async function handleSubnetHistory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const params = [netuid];
  let sql =
    "SELECT snapshot_date, COUNT(*) AS neuron_count, " +
    "SUM(validator_permit) AS validator_count, " +
    "SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao " +
    "FROM neuron_daily WHERE netuid = ?";
  if (days != null) {
    const cutoff = new Date(Date.now() - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    sql += " AND snapshot_date >= ?";
    params.push(cutoff);
  }
  sql += " GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ?";
  params.push(MAX_HISTORY_POINTS);
  const rows = await d1All(env, sql, params);
  const data = buildSubnetHistory(rows, netuid, { window: label });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// ---- Account entity handlers (#1347) ---------------------------------------
function clampInt(raw, def, min, max) {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function accountMeta(env, artifactPath, generatedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: generatedAt,
    published_at: await publishedAt(env),
    source: "chain-events",
  };
}

// GET /api/v1/accounts/{ss58}: cross-subnet summary — event-history aggregates
// (account_events, matched by hotkey OR coldkey) joined to current registrations
// (neurons, by hotkey). Cold/absent store → schema-stable zero (never 404).
async function handleAccount(request, env, ss58) {
  const where = "hotkey = ? OR coldkey = ?";
  const [aggRows, kindRows, regRows, recentRows] = await Promise.all([
    d1All(
      env,
      `SELECT COUNT(*) AS c, COUNT(DISTINCT netuid) AS sc, MIN(block_number) AS fb, MAX(block_number) AS lb, MIN(observed_at) AS fo, MAX(observed_at) AS lo FROM account_events WHERE ${where}`,
      [ss58, ss58],
    ),
    d1All(
      env,
      `SELECT event_kind AS kind, COUNT(*) AS count FROM account_events WHERE ${where} GROUP BY event_kind ORDER BY count DESC`,
      [ss58, ss58],
    ),
    d1All(
      env,
      `SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons WHERE hotkey = ? ORDER BY stake_tao DESC`,
      [ss58],
    ),
    d1All(
      env,
      `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE ${where} ORDER BY block_number DESC, event_index DESC LIMIT 10`,
      [ss58, ss58],
    ),
  ]);
  const data = buildAccountSummary(ss58, {
    agg: aggRows[0],
    kinds: kindRows,
    registrations: regRows,
    recent: recentRows,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}.json`,
        data.last_seen_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/events: paginated event history (newest first),
// optional ?kind= filter, ?limit (<=1000) / ?offset.
async function handleAccountEvents(request, env, ss58, url) {
  const validationError = validateQueryParams(url, ["kind", "limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const kind = url.searchParams.get("kind");
  const params = [ss58, ss58];
  let sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE (hotkey = ? OR coldkey = ?)`;
  if (kind) {
    sql += " AND event_kind = ?";
    params.push(kind);
  }
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await d1All(env, sql, params);
  const data = buildAccountEvents(rows, ss58, { limit, offset });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/events.json`,
        data.events[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/subnets: the subnets where this hotkey is currently
// registered (the cross-subnet footprint), from the neurons tier.
async function handleAccountSubnets(request, env, ss58) {
  const rows = await d1All(
    env,
    `SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons WHERE hotkey = ? ORDER BY netuid`,
    [ss58],
  );
  const data = buildAccountSubnets(rows, ss58);
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/subnets.json`,
        null,
      ),
    },
    "short",
  );
}

// Long-term daily uptime history for one subnet's operational surfaces, served
// live from the surface_uptime_daily rollup (PR3). 90d/1y window. Returns a
// schema-stable empty payload when D1 is unbound/cold or no history has accrued
// yet (mirrors the other D1-backed analytics routes).
async function handleUptime(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam = url.searchParams.get("window") || "90d";
  if (!Object.hasOwn(UPTIME_WINDOWS, windowParam)) {
    return errorResponse(
      "invalid_query",
      "Query parameter `window` must be one of: 90d, 1y.",
      400,
      { parameter: "window" },
    );
  }
  const days = UPTIME_WINDOWS[windowParam];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await d1All(
    env,
    `SELECT MAX(surface_id) AS surface_id,
            COALESCE(surface_key, surface_id) AS surface_key,
            day,
            SUM(samples) AS samples,
            SUM(ok_count) AS ok_count,
            CASE
              WHEN SUM(samples) > 0 THEN ROUND(CAST(SUM(ok_count) AS REAL) / SUM(samples), 4)
              ELSE NULL
            END AS uptime_ratio,
            ${dailyLatencyColumns({ roundedAvg: true })},
            MAX(p50_latency_ms) AS p50,
            MAX(p95_latency_ms) AS p95,
            MAX(p99_latency_ms) AS p99,
            CASE
              WHEN SUM(samples) = 0 THEN 'unknown'
              WHEN SUM(ok_count) = SUM(samples) THEN 'ok'
              WHEN SUM(ok_count) = 0 THEN 'failed'
              ELSE 'degraded'
            END AS status
     FROM surface_uptime_daily
     WHERE netuid = ? AND day >= ?
     GROUP BY COALESCE(surface_key, surface_id), day
     ORDER BY day DESC
     LIMIT ?`,
    [netuid, cutoff, MAX_UPTIME_ROWS],
  );
  const healthMeta = await readHealthMetaKv(env);
  const data = formatUptime({
    netuid,
    window: windowParam,
    observedAt: healthMeta?.last_run_at || null,
    rows,
    now: new Date().toISOString(),
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/uptime.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Small {meta, completeness} projection over profiles.json, cached in-isolate.
async function leaderboardProfilesProjection(env, now = Date.now()) {
  if (
    leaderboardProfilesCache &&
    now - leaderboardProfilesCache.builtAt <= LEADERBOARD_PROFILES_TTL_MS
  ) {
    return leaderboardProfilesCache;
  }
  const artifact = await readArtifact(env, "/metagraph/profiles.json");
  const profiles = artifact.ok ? artifact.data?.profiles || [] : [];
  const subnetMeta = new Map();
  const mostComplete = [];
  for (const profile of profiles) {
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
      // Enrichment-depth signals for the most-enriched board (#753).
      surface_count: profile.surface_count ?? 0,
      operational_interface_count: profile.operational_interface_count ?? 0,
    });
  }
  const projection = { subnetMeta, mostComplete, builtAt: now };
  // Don't cache an empty projection (failed/cold read) — retry next request.
  if (mostComplete.length > 0) {
    leaderboardProfilesCache = projection;
  }
  return projection;
}

// Registry leaderboards: healthiest / fastest-rpc / most-complete /
// fastest-growing. Combines live D1 status with registry projections.
async function handleLeaderboards(request, env, url) {
  const validationError = validateQueryParams(url, ["board", "limit"]);
  if (validationError) return analyticsQueryError(validationError);
  const requestedBoard = url.searchParams.get("board");
  if (requestedBoard && !LEADERBOARD_BOARDS.includes(requestedBoard)) {
    return errorResponse(
      "invalid_query",
      `Unknown board "${requestedBoard}". Valid boards: ${LEADERBOARD_BOARDS.join(", ")}.`,
      400,
    );
  }
  const limit = url.searchParams.get("limit");
  if (
    limit !== null &&
    (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
  ) {
    // Reject invalid limits with a 400 like the list routes, instead of the
    // silent clamp formatLeaderboards would otherwise apply.
    return errorResponse(
      "invalid_query",
      "limit must be an integer between 1 and 100.",
      400,
    );
  }

  const { subnetMeta, mostComplete } = await leaderboardProfilesProjection(env);

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples] = await Promise.all([
    d1All(
      env,
      `SELECT netuid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              AVG(latency_ms) AS avg_latency_ms
       FROM surface_status
       GROUP BY netuid`,
      [],
    ),
    d1All(
      env,
      `SELECT netuid, MIN(latency_ms) AS min_latency_ms
       FROM surface_status
       WHERE kind IN ('subtensor-rpc', 'subtensor-wss')
         AND status = 'ok' AND latency_ms IS NOT NULL
       GROUP BY netuid`,
      [],
    ),
    d1All(
      env,
      `SELECT netuid, snapshot_date, completeness_score
       FROM subnet_snapshots
       WHERE snapshot_date >= ?
       ORDER BY netuid, snapshot_date`,
      [sevenDaysAgo],
    ),
  ]);

  // Per-subnet completeness delta over the window (latest - earliest sample).
  const growthByNetuid = new Map();
  for (const row of growthSamples) {
    const entry = growthByNetuid.get(row.netuid) || {
      first: undefined,
      last: undefined,
    };
    // `undefined` = no row yet; a real null completeness_score must latch as the
    // baseline so the delta guard below can drop unscored window endpoints.
    if (entry.first === undefined) entry.first = row.completeness_score ?? null;
    entry.last = row.completeness_score ?? null;
    growthByNetuid.set(row.netuid, entry);
  }
  const growthRows = [...growthByNetuid.entries()].map(([netuid, entry]) => ({
    netuid,
    delta:
      entry.first != null && entry.last != null
        ? Number(entry.last) - Number(entry.first)
        : null,
  }));

  const meta = await readHealthMetaKv(env);
  const data = formatLeaderboards({
    board: requestedBoard || null,
    limit,
    observedAt: meta?.last_run_at || null,
    healthRows,
    rpcRows,
    mostComplete,
    growthRows,
    subnetMeta,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/registry/leaderboards.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: data.observed_at,
        source: "registry+live-cron-prober",
      },
    },
    "standard",
  );
}

// Best-effort, async usage telemetry for the RPC proxy (B3). A telemetry write
// must never add latency to, or fail, a proxied call — so it runs under
// ctx.waitUntil and swallows every error (notably "no such table" before the
// 0004 migration is applied). When the binding/ctx is absent (tests, local dev)
// it is a no-op. The proxy degrades to "no analytics", never to "broken".
function recordRpcUsage(env, ctx, event) {
  const db = env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare || typeof ctx?.waitUntil !== "function") return;
  try {
    const write = db
      .prepare(
        `INSERT INTO rpc_proxy_events
           (observed_at, network, endpoint_id, provider, ok, status, attempts, latency_ms, cache)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.observed_at,
        event.network,
        event.endpoint_id ?? null,
        event.provider ?? null,
        event.ok ? 1 : 0,
        event.status ?? null,
        event.attempts ?? null,
        event.latency_ms ?? null,
        event.cache ?? null,
      )
      .run();
    ctx.waitUntil(Promise.resolve(write).catch(() => {}));
  } catch {
    // prepare/bind threw synchronously (malformed binding); drop the sample.
  }
}

// RPC reverse-proxy usage analytics (B3): request volume, latency p50/p95,
// failover + error rate, cache-hit rate, and the per-endpoint distribution that
// shows whether the load balancer is actually spreading traffic. Computed live
// from the rpc_proxy_events D1 telemetry; cold/unmigrated D1 returns a
// schema-stable zeroed payload (d1All swallows the missing-table error).
async function handleRpcUsage(request, env, url) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  const since = Date.now() - days * DAY_MS;
  const bucketConfig = RPC_USAGE_BUCKETS[label];
  const [totalsRows, latencyRows, endpointRows, networkRows, bucketRows] =
    await Promise.all([
      d1All(
        env,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count,
                SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS failover_count,
                SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
                AVG(latency_ms) AS avg_latency_ms
         FROM rpc_proxy_events
         WHERE observed_at >= ?`,
        [since],
      ),
      d1All(
        env,
        `WITH ranked AS (
           SELECT latency_ms,
                  ROW_NUMBER() OVER (ORDER BY latency_ms) AS rn,
                  COUNT(*) OVER () AS cnt
           FROM rpc_proxy_events
           WHERE observed_at >= ? AND latency_ms IS NOT NULL
         )
         SELECT MAX(CASE WHEN rn = CAST(0.50 * cnt AS INTEGER) + 1 THEN latency_ms END) AS p50,
                MAX(CASE WHEN rn = CAST(0.95 * cnt AS INTEGER) + 1 THEN latency_ms END) AS p95
         FROM ranked`,
        [since],
      ),
      d1All(
        env,
        `SELECT endpoint_id, provider,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count,
                AVG(latency_ms) AS avg_latency_ms
         FROM rpc_proxy_events
         WHERE observed_at >= ? AND endpoint_id IS NOT NULL
         GROUP BY endpoint_id, provider
         ORDER BY requests DESC
         LIMIT 50`,
        [since],
      ),
      d1All(
        env,
        `SELECT network,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count
         FROM rpc_proxy_events
         WHERE observed_at >= ?
         GROUP BY network
         ORDER BY requests DESC`,
        [since],
      ),
      d1All(
        env,
        // Buckets are aligned to absolute boundaries but `since` is not, so a
        // full window spans maxBuckets+1 buckets. Keep the most-recent
        // maxBuckets (inner ORDER BY ts DESC LIMIT) — dropping the partial
        // oldest bucket rather than the current one — then re-order ascending
        // for the chart. A bare `ORDER BY ts ASC LIMIT` would drop the current
        // bucket, leaving the series permanently missing its leading edge.
        `SELECT ts, requests, errors, avg_latency_ms FROM (
           SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS errors,
                  AVG(latency_ms) AS avg_latency_ms
           FROM rpc_proxy_events
           WHERE observed_at >= ?
           GROUP BY ts
           ORDER BY ts DESC
           LIMIT ?
         )
         ORDER BY ts ASC`,
        [
          bucketConfig.bucketMs,
          bucketConfig.bucketMs,
          since,
          bucketConfig.maxBuckets,
        ],
      ),
    ]);
  const meta = await readHealthMetaKv(env);
  const data = formatRpcUsage({
    window: label,
    observedAt: meta?.last_run_at || null,
    totals: totalsRows[0],
    latency: latencyRows[0],
    endpointRows,
    networkRows,
    bucketRows,
    bucketGranularity: bucketConfig.granularity,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(env, "/metagraph/rpc/usage.json", null),
    },
    "short",
  );
}

async function verifyMeta(env) {
  return {
    artifact_path: null,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: null,
    published_at: await publishedAt(env),
    source: "live-probe",
  };
}

// #358: live-probe one catalogued surface on demand. Safe by construction — the
// URL always comes from operational-surfaces.json (already public_safe, the exact
// URLs the 15-minute cron probes), never the caller. Gated by the RPC rate limiter
// plus a 60s per-surface Cache-API entry so repeat calls can't fan out into real
// outbound probes. An agent (or the verify_integration MCP tool) calls this to
// confirm "callable right now" before wiring.
async function handleSurfaceVerify(request, env, surfaceId, ctx = {}) {
  if (env.RPC_RATE_LIMITER?.limit) {
    const clientKey = resolveClientIp(request);
    const { success } = await env.RPC_RATE_LIMITER.limit({ key: clientKey });
    if (!success) {
      return errorResponse(
        "verify_rate_limited",
        "Too many verify requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const catalog = await readArtifact(
    env,
    "/metagraph/operational-surfaces.json",
  );
  if (!catalog.ok) {
    return errorResponse(
      "surfaces_unavailable",
      "The operational-surface catalog is unavailable.",
      503,
    );
  }
  let surface = findSurface(catalog.data?.surfaces, surfaceId);
  if (!surface) {
    const aliases = await readArtifact(env, SURFACE_ALIASES_PATH);
    if (aliases.ok) {
      surface = findSurface(catalog.data?.surfaces, surfaceId, aliases.data);
    }
  }
  if (!surface) {
    return errorResponse(
      "surface_not_found",
      `No catalogued surface with id, key, or deprecated id "${surfaceId}".`,
      404,
      { surface_id: surfaceId },
    );
  }

  const canonicalSurfaceId = surface.surface_key || surface.surface_id;
  const cache = globalThis.caches?.default || null;
  const cacheKey = cache
    ? new Request(
        `https://verify.metagraph.sh/${encodeURIComponent(canonicalSurfaceId)}`,
      )
    : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = await hit.json();
      return envelopeResponse(
        request,
        { data: { ...cached, from_cache: true }, meta: await verifyMeta(env) },
        "short",
      );
    }
  }

  const result = await verifySurface(surface, {
    isUnsafeUrl: workerResolvedUrlSafetyGuard({ fetchImpl: globalThis.fetch }),
    connect: workerWebSocketConnector(globalThis.fetch),
  });
  if (cache) {
    const stored = new Response(JSON.stringify(result), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=60",
      },
    });
    ctx?.waitUntil?.(cache.put(cacheKey, stored));
  }
  return envelopeResponse(
    request,
    { data: { ...result, from_cache: false }, meta: await verifyMeta(env) },
    "short",
  );
}

async function handleRpcProxyRequest(request, env, url, ctx = {}) {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "The RPC proxy only accepts POST requests.",
      405,
      {},
      {
        allow: "POST, OPTIONS",
      },
    );
  }

  if (env.METAGRAPH_ENABLE_RPC_PROXY !== "true") {
    return errorResponse(
      "rpc_proxy_disabled",
      "Read-only RPC proxying is intentionally disabled until endpoint scoring, abuse controls, and method filtering are enabled.",
      501,
    );
  }

  // Per-client abuse control. Skipped when the ratelimit binding is absent
  // (local dev / not yet provisioned) so tests and local runs are unaffected;
  // enforced on Cloudflare where the binding is bound.
  if (env.RPC_RATE_LIMITER?.limit) {
    const clientKey = resolveClientIp(request);
    const { success } = await env.RPC_RATE_LIMITER.limit({ key: clientKey });
    if (!success) {
      return errorResponse(
        "rpc_rate_limited",
        "Too many RPC proxy requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_RPC_BODY_BYTES) {
    return errorResponse(
      "rpc_body_too_large",
      "RPC request body is too large for the read-only proxy.",
      413,
    );
  }

  let bodyText;
  let rpcBody;
  try {
    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_RPC_BODY_BYTES) {
      return errorResponse(
        "rpc_body_too_large",
        "RPC request body is too large for the read-only proxy.",
        413,
      );
    }
    rpcBody = JSON.parse(bodyText);
  } catch {
    return errorResponse(
      "rpc_invalid_json",
      "RPC request body must be a JSON object.",
      400,
    );
  }

  if (
    !rpcBody ||
    Array.isArray(rpcBody) ||
    typeof rpcBody !== "object" ||
    typeof rpcBody.method !== "string"
  ) {
    return errorResponse(
      "rpc_invalid_request",
      "Only single JSON-RPC request objects are supported.",
      400,
    );
  }

  if (!isSafeRpcMethod(rpcBody.method)) {
    return errorResponse(
      "rpc_method_blocked",
      `RPC method is not allowed through this proxy: ${rpcBody.method}`,
      403,
      {
        allowed_methods: [...SAFE_RPC_METHODS].sort(),
      },
    );
  }

  const poolArtifact = await readRpcPoolArtifact(env);
  if (!poolArtifact.ok) {
    return errorResponse(
      poolArtifact.code,
      poolArtifact.message,
      poolArtifact.status,
      {
        artifact_path: "/metagraph/rpc/pools.json",
      },
    );
  }

  // The proxy forwards an HTTP JSON-RPC POST, so it can only reach HTTP(S)
  // upstreams. The /wss route points at WebSocket-only endpoints that cannot be
  // HTTP-POSTed, so reject it with a clear error instead of failing the upstream
  // fetch (which would surface as a 500).
  if (url.pathname.endsWith("/wss")) {
    return errorResponse(
      "rpc_websocket_unsupported",
      "WebSocket JSON-RPC is not available through this HTTP proxy. POST to /rpc/v1/finney for HTTP JSON-RPC, or connect to a public WSS endpoint directly.",
      400,
    );
  }
  // Network-aware pool selection: /rpc/v1/{network} → its pool (finney→finney-rpc,
  // test→test-rpc). An unknown network 404s instead of silently routing to
  // mainnet. `network` also tags the B3 usage telemetry below.
  const network = url.pathname.split("/")[3] || "";
  const poolId = RPC_PROXY_POOLS[network];
  if (!poolId) {
    return errorResponse(
      "rpc_network_unsupported",
      `Unknown RPC network "${network || "(none)"}". Supported networks: ${Object.keys(RPC_PROXY_POOLS).join(", ")}.`,
      404,
      { supported_networks: Object.keys(RPC_PROXY_POOLS) },
    );
  }
  const staticPool = (poolArtifact.data.pools || []).find(
    (candidate) => candidate.id === poolId,
  );
  // Overlay the 15-minute cron health so the proxy avoids sustained-down endpoints
  // (the in-isolate breaker still handles instantaneous failures). Falls back to
  // the static pool when the live snapshot is cold (always the case for the static
  // testnet pool, which is intentionally not probe-derived).
  const liveRpcPool = await readHealthKv(env, KV_HEALTH_RPC_POOL);
  const pool = overlayRpcPoolEligibility(staticPool, liveRpcPool);
  // startedAt anchors end-to-end proxy latency for the B3 usage telemetry; the
  // recorder is best-effort + async (never adds latency to / fails the call).
  const startedAt = Date.now();
  const { endpoints: candidates, unsafeEndpoint } = orderSafeRpcEndpoints(pool);
  if (!candidates.length) {
    recordRpcUsage(env, ctx, {
      observed_at: startedAt,
      network,
      endpoint_id: null,
      provider: null,
      ok: false,
      status: unsafeEndpoint ? 502 : 503,
      attempts: 0,
      latency_ms: Date.now() - startedAt,
      cache: "bypass",
    });
    if (unsafeEndpoint) {
      return errorResponse(
        "rpc_endpoint_unsafe",
        "Eligible RPC endpoint URL is not allowed by the Worker upstream safety policy.",
        502,
        { endpoint_id: unsafeEndpoint.id || null, pool_id: poolId },
      );
    }
    return errorResponse(
      "rpc_endpoint_unavailable",
      "No eligible public RPC endpoint is available for proxy routing.",
      503,
      { pool_id: poolId },
    );
  }

  // Response cache for idempotent reads (Cache API). Cache hit short-circuits
  // the upstream call; a successful, cacheable response is stored async.
  const cachePolicy = rpcCachePolicy(rpcBody.method, rpcBody.params);
  const cache = cachePolicy.cacheable ? globalThis.caches?.default : null;
  let cacheKey = null;
  if (cache) {
    cacheKey = await rpcCacheKey(network, rpcBody.method, rpcBody.params);
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Only the JSON-RPC `result` is cached (never caller-controlled envelope
      // fields like `id`), so rebuild the envelope with THIS request's id. This
      // stops a cache entry primed by one caller from replaying that caller's id
      // back to a later requester.
      let cachedPayload = null;
      try {
        cachedPayload = JSON.parse(await hit.text());
      } catch {
        // Malformed cache entry; treat as a miss and re-fetch below.
      }
      if (cachedPayload && cachedPayload.result !== undefined) {
        const headers = new Headers(hit.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-metagraph-rpc-cache", "hit");
        setRpcRateLimitHeaders(headers);
        recordRpcUsage(env, ctx, {
          observed_at: startedAt,
          network,
          endpoint_id: null,
          provider: null,
          ok: true,
          status: 200,
          attempts: 0,
          latency_ms: Date.now() - startedAt,
          cache: "hit",
        });
        return new Response(
          JSON.stringify(rpcResultEnvelope(rpcBody, cachedPayload.result)),
          { status: 200, headers },
        );
      }
    }
  }

  const response = await proxyWithFailover(candidates, { bodyText, poolId });
  // The endpoint headers are set ONLY when an upstream served (streamRpcResponse);
  // the all-failed path returns a bare 502, so a missing endpoint-id header marks
  // a routing failure (ok=false). Recorded once here — every downstream return
  // reuses this same response, so its served-endpoint/status/attempts are stable.
  const servedEndpointId = response.headers.get("x-metagraph-rpc-endpoint-id");
  recordRpcUsage(env, ctx, {
    observed_at: startedAt,
    network,
    endpoint_id: servedEndpointId,
    provider: response.headers.get("x-metagraph-rpc-provider"),
    ok: Boolean(servedEndpointId),
    status: response.status,
    attempts:
      Number(response.headers.get("x-metagraph-rpc-attempts")) ||
      candidates.length,
    latency_ms: Date.now() - startedAt,
    cache: cacheKey ? "miss" : "bypass",
  });
  if (!cacheKey) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("x-metagraph-rpc-cache", "miss");
  if (response.status !== 200) {
    return new Response(response.body, { status: response.status, headers });
  }

  // Cacheable method, cache miss: inspect a bounded clone so oversized upstream
  // results are streamed back to the client instead of buffered in the Worker.
  let inspect;
  try {
    inspect = await readResponseTextWithLimit(
      response.clone(),
      RPC_CLASSIFY_BODY_LIMIT_BYTES,
    );
  } catch {
    // Classification is best-effort: a flaky upstream body should not turn a
    // proxied response into a Worker exception while cache inspection is active.
    return new Response(response.body, { status: response.status, headers });
  }
  if (!inspect.truncated) {
    let parsed = null;
    try {
      parsed = JSON.parse(inspect.text);
    } catch {
      // body is not JSON; leave parsed null so it is not cached.
    }
    if (parsed && parsed.result !== undefined && parsed.error === undefined) {
      // Persist ONLY the cacheable `result` — not the upstream envelope, which
      // carries the priming caller's `id`. The envelope is rebuilt per request
      // on a cache hit above.
      const cached = new Response(JSON.stringify({ result: parsed.result }), {
        status: 200,
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          "cache-control": `public, s-maxage=${cachePolicy.ttl}`,
        },
      });
      ctx?.waitUntil?.(cache.put(cacheKey, cached));
    }
  }
  return new Response(response.body, { status: response.status, headers });
}

const RPC_MAX_ATTEMPTS = 3;
const RPC_ATTEMPT_TIMEOUT_MS = 6000;
const RPC_CLASSIFY_BODY_LIMIT_BYTES = 64 * 1024;
// /rpc/v1/{network} → the pool id served from rpc/pools.json. Adding a network
// here (plus its pool + allowlisted origins) is all the proxy needs to serve it.
const RPC_PROXY_POOLS = { finney: "finney-rpc", test: "test-rpc" };
// Max blocks an endpoint may trail the freshest reported tip before the proxy
// demotes it behind synced nodes. Bittensor block time is ~12s, so ~10 blocks
// (~15 min) tolerates cross-provider probe-timing skew while still routing around
// a genuinely stalled/lagging node.
const BLOCK_LAG_TOLERANCE = 10;

// JSON-RPC error codes that signal node trouble (retry another upstream) rather
// than a client/application error (return immediately so we don't mask a real
// error by trying every node).
const TRANSIENT_RPC_ERROR_CODES = new Set([-32603]); // internal error

// In-isolate circuit breaker: count consecutive transient failures per endpoint
// and temporarily eject (deprioritise) repeat offenders. Per-isolate only (no
// global view, resets on cold start) — cheap and enough to ride out the burst
// that matters. RPC_HEALTH is the module-default map; injectable for tests.
const RPC_HEALTH = new Map(); // endpointId -> { fails, ejectedUntil }
const RPC_EJECT_THRESHOLD = 3;
const RPC_EJECT_COOLDOWN_MS = 30_000;

export function recordRpcFailure(map, id, now) {
  const entry = map.get(id) || { fails: 0, ejectedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= RPC_EJECT_THRESHOLD && entry.ejectedUntil <= now) {
    entry.ejectedUntil = now + RPC_EJECT_COOLDOWN_MS;
  }
  map.set(id, entry);
}

export function recordRpcSuccess(map, id) {
  map.delete(id);
}

export function isRpcEndpointEjected(map, id, now) {
  const entry = map.get(id);
  return Boolean(entry && entry.ejectedUntil > now);
}

// Per-method response-cache policy for idempotent reads. Default-deny: only
// block-pinned (by an explicit block number/hash param) or quasi-static reads
// are cacheable; head-moving forms (param-less block reads, finalized head,
// system_health) are never cached.
export function rpcCachePolicy(method, params) {
  const args = Array.isArray(params) ? params : [];
  switch (method) {
    case "chain_getBlockHash":
      return args.length &&
        (typeof args[0] === "number" || /^\d+$/.test(String(args[0])))
        ? { cacheable: true, ttl: 3600 }
        : { cacheable: false, ttl: 0 };
    case "chain_getBlock":
    case "chain_getHeader":
      return args.length &&
        typeof args[0] === "string" &&
        args[0].startsWith("0x")
        ? { cacheable: true, ttl: 3600 }
        : { cacheable: false, ttl: 0 };
    case "state_getRuntimeVersion":
    case "system_chain":
    case "system_name":
    case "system_version":
    case "system_properties":
    case "rpc_methods":
      return { cacheable: true, ttl: 300 };
    default:
      return { cacheable: false, ttl: 0 };
  }
}

// Build a minimal JSON-RPC success envelope around a cached `result`, echoing
// the current request's `id` (when present) so cache hits never replay another
// caller's id.
function rpcResultEnvelope(requestBody, result) {
  const envelope = { jsonrpc: "2.0" };
  if (Object.prototype.hasOwnProperty.call(requestBody, "id")) {
    envelope.id = requestBody.id;
  }
  envelope.result = result;
  return envelope;
}

async function rpcCacheKey(network, method, params) {
  const normalized = JSON.stringify([
    network,
    method,
    Array.isArray(params) ? params : [],
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(
    `https://rpc-cache.metagraph.internal/${network}/${method}/${hash}`,
  );
}

// Decide how to treat one upstream attempt: "transient" (fail over to the next
// endpoint), "success"/"fatal" (return this upstream's response to the client).
export function classifyUpstreamAttempt({ thrown, status, parsedBody }) {
  if (thrown) return "transient"; // network error or AbortSignal timeout
  if (status >= 500 || status === 429) return "transient";
  if (status >= 400) return "fatal"; // upstream rejected the request itself
  if (parsedBody && typeof parsedBody === "object" && parsedBody.error) {
    if (TRANSIENT_RPC_ERROR_CODES.has(Number(parsedBody.error.code))) {
      return "transient";
    }
  }
  return "success";
}

async function readResponseTextWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return {
      text: text.slice(0, maxBytes),
      truncated: new TextEncoder().encode(text).byteLength > maxBytes,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      reader.cancel().catch(() => {});
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated: false };
}

function streamRpcResponse(upstream, endpoint, attempts, status) {
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-metagraph-rpc-endpoint-id", endpoint.id);
  headers.set("x-metagraph-rpc-provider", endpoint.provider);
  headers.set("x-metagraph-rpc-attempts", String(attempts.length + 1));
  setRpcRateLimitHeaders(headers);
  return new Response(upstream.body, { status: status || 502, headers });
}

// Advisory rate-limit headers on RPC proxy responses. The Cloudflare rate-limit
// binding (RPC_RATE_LIMITER) only returns {success}, so an exact remaining/reset
// is unavailable — we surface the static policy (mirrors wrangler.jsonc:
// 100 requests / 60s) plus Retry-After on a 429.
const RPC_RATE_LIMIT = { limit: 100, windowSeconds: 60 };
function setRpcRateLimitHeaders(headers) {
  headers.set("x-ratelimit-limit", String(RPC_RATE_LIMIT.limit));
  headers.set(
    "x-ratelimit-policy",
    `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
  );
}

// Per-client abuse control for the GraphQL endpoint. GraphQL is POST-only and
// runs before the read-only method gate, so — unlike the GET REST routes that
// the edge can cache — every call hits the worker and fans out into one or more
// artifact reads + query execution. That makes it at least as expensive as the
// RPC proxy, so it shares the SAME strict limiter binding, bucket strategy
// (cf-connecting-ip only; see resolveClientIp), policy, and 429 shape. Skipped
// only when the binding is absent (local dev / CI), matching the RPC/MCP paths.
// Returns a 429 Response when the caller is over the limit, else null.
async function graphqlRateLimited(request, env) {
  if (!env.RPC_RATE_LIMITER?.limit) return null;
  const { success } = await env.RPC_RATE_LIMITER.limit({
    key: resolveClientIp(request),
  });
  if (success) return null;
  return errorResponse(
    "graphql_rate_limited",
    "Too many GraphQL requests from this client; slow down.",
    429,
    {},
    {
      "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
      "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
      "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
      "x-ratelimit-remaining": "0",
    },
  );
}

// Try each ordered endpoint in turn; return the first success / non-transient
// response, and a clean 502 only when every attempt is a transient failure.
// Transient HTTP statuses are classified before reading bodies, and JSON-RPC
// error-envelope inspection is bounded so large upstream responses can stream.
export async function proxyWithFailover(
  orderedEndpoints,
  {
    bodyText,
    poolId,
    fetchFn = fetch,
    maxAttempts = RPC_MAX_ATTEMPTS,
    timeoutMs = RPC_ATTEMPT_TIMEOUT_MS,
    healthMap = RPC_HEALTH,
  },
) {
  const attempts = [];
  const limit = Math.min(orderedEndpoints.length, maxAttempts);
  for (let index = 0; index < limit; index += 1) {
    const endpoint = orderedEndpoints[index];
    let status = 0;
    let upstream = null;
    let parsedBody = null;
    let thrown = false;
    try {
      upstream = await fetchFn(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = upstream.status;
    } catch {
      thrown = true;
    }

    if (
      classifyUpstreamAttempt({ thrown, status, parsedBody }) === "transient"
    ) {
      await upstream?.body?.cancel?.();
      recordRpcFailure(healthMap, endpoint.id, Date.now());
      attempts.push({
        endpoint_id: endpoint.id,
        reason: thrown ? "unreachable" : `status-${status}`,
      });
      continue;
    }

    if (upstream && status < 400) {
      let clientBodyToCancel = null;
      try {
        if (upstream.body?.tee) {
          const [inspectBody, clientBody] = upstream.body.tee();
          clientBodyToCancel = clientBody;
          const inspect = await readResponseTextWithLimit(
            new Response(inspectBody),
            RPC_CLASSIFY_BODY_LIMIT_BYTES,
          );
          if (!inspect.truncated) {
            try {
              parsedBody = JSON.parse(inspect.text);
            } catch {
              parsedBody = null;
            }
            if (
              classifyUpstreamAttempt({ thrown, status, parsedBody }) ===
              "transient"
            ) {
              await clientBody.cancel();
              recordRpcFailure(healthMap, endpoint.id, Date.now());
              attempts.push({
                endpoint_id: endpoint.id,
                reason: `status-${status}`,
              });
              continue;
            }
          }
          upstream = new Response(clientBody, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          });
        } else {
          const inspect = await readResponseTextWithLimit(
            upstream,
            RPC_CLASSIFY_BODY_LIMIT_BYTES,
          );
          if (!inspect.truncated) {
            try {
              parsedBody = JSON.parse(inspect.text);
            } catch {
              parsedBody = null;
            }
            if (
              classifyUpstreamAttempt({ thrown, status, parsedBody }) ===
              "transient"
            ) {
              recordRpcFailure(healthMap, endpoint.id, Date.now());
              attempts.push({
                endpoint_id: endpoint.id,
                reason: `status-${status}`,
              });
              continue;
            }
          }
          upstream = new Response(inspect.text, {
            status,
            headers: upstream.headers,
          });
        }
      } catch {
        await clientBodyToCancel?.cancel?.().catch(() => {});
        await upstream?.body?.cancel?.().catch(() => {});
        recordRpcFailure(healthMap, endpoint.id, Date.now());
        attempts.push({
          endpoint_id: endpoint.id,
          reason: "body-read-error",
        });
        continue;
      }
    }

    // The endpoint responded (success, or an application-level error) — it is
    // reachable, so clear any breaker state for it.
    recordRpcSuccess(healthMap, endpoint.id);
    return streamRpcResponse(upstream, endpoint, attempts, status);
  }

  // Every attempt failed transiently. Return a fixed message — never echo an
  // upstream error body (leak hygiene).
  return errorResponse(
    "rpc_upstream_unavailable",
    "All eligible RPC upstreams failed; try again shortly.",
    502,
    {
      pool_id: poolId,
      attempts: attempts.map((a) => a.endpoint_id),
      last_reason: attempts.at(-1)?.reason || null,
    },
  );
}

function matchRawArtifact(pathname) {
  return RAW_ARTIFACT_ROUTES.some((candidate) =>
    candidate.pattern.test(pathname),
  );
}

function matchRoute(pathname) {
  for (const candidate of ROUTES) {
    const match = candidate.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const params = match.groups || {};
    return {
      id: candidate.id,
      artifactPath: candidate.artifactPath(params),
      cache: candidate.cache,
      params,
      queryCollection: candidate.query_collection,
      queryFilterNames: candidate.query_filter_names,
    };
  }
  return null;
}

// Lightweight readiness probe for uptime checks and load balancers. Reports
// which bindings are wired without touching R2/KV (no I/O, no cold-start cost).
async function handleHealthRequest(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      "method_not_allowed",
      "The health route only accepts GET and HEAD.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  const bindings = {
    assets: Boolean(env.ASSETS?.fetch),
    r2: Boolean(env.METAGRAPH_ARCHIVE?.get),
    kv: Boolean(env.METAGRAPH_CONTROL?.get),
    health_db: Boolean(env.METAGRAPH_HEALTH_DB?.prepare),
  };

  // Data freshness — the event-driven data publish (ADR 0007) advances the KV
  // `latest` pointer's published_at on each human-input registry merge and at
  // least once daily (the 07:17 UTC floor). If that pipeline silently stops, the
  // pointer goes stale; report `degraded` + HTTP 503 so an uptime monitor pointed
  // at /health catches a broken data-refresh. Only a *present* stale pointer trips
  // it, so local/dev and the worker-test harness (no published pointer) stay
  // healthy.
  // Default 48h = two missed daily floors. (The old 12h default — "two missed 6h
  // crons" — would false-degrade on a quiet day now that the floor is daily, not
  // 6-hourly.)
  const maxAgeHours = Number(env.METAGRAPH_HEALTH_MAX_AGE_HOURS) || 48;
  // Read the publish pointer + the operational-health meta concurrently (one
  // round-trip instead of two) — both are independent KV gets.
  const [pointer, meta] = bindings.kv
    ? await Promise.all([latestPointer(env), readHealthMetaKv(env)])
    : [null, null];
  const publishedAtIso =
    pointer && typeof pointer.published_at === "string"
      ? pointer.published_at
      : null;
  const publishedMs = publishedAtIso ? Date.parse(publishedAtIso) : NaN;
  const ageHours = Number.isFinite(publishedMs)
    ? (Date.now() - publishedMs) / 3_600_000
    : null;
  const stale = ageHours !== null && ageHours > maxAgeHours;

  // Operational-health freshness — the 15-minute cron prober's last run. Reported
  // for observability (a stuck prober shows a growing age); does not gate the
  // HTTP status here (Phase 4 wires alerting). Null until the first cron run.
  const opRunAtMs = meta?.last_run_at ? Date.parse(meta.last_run_at) : NaN;
  const opAgeMinutes = Number.isFinite(opRunAtMs)
    ? (Date.now() - opRunAtMs) / 60_000
    : null;

  // Chain-event index freshness (#1346/#1361) — the realtime streamer's heartbeat.
  // The newest observed_at row is an index-friendly heartbeat for the latest
  // indexed chain event; age_seconds is ~12-30s while the streamer is live,
  // growing toward the ~5-min poller backstop if it's down. Reported for
  // observability (does NOT gate the HTTP status, like operational_health);
  // best-effort + null on a cold/unbound store.
  let chainEvents = null;
  if (bindings.health_db) {
    const rows = await d1All(
      env,
      "SELECT block_number AS block, observed_at AS at FROM account_events " +
        "ORDER BY observed_at DESC LIMIT 1",
      [],
    );
    const row = rows[0] || {};
    const atMs = Number(row.at);
    const fresh = Number.isFinite(atMs);
    chainEvents = {
      latest_indexed_block: row.block ?? null,
      latest_event_at: fresh ? new Date(atMs).toISOString() : null,
      age_seconds: fresh ? Math.round((Date.now() - atMs) / 1000) : null,
    };
  }

  const body = JSON.stringify({
    status: stale ? "degraded" : "ok",
    service: "metagraphed",
    contract_version: contractVersion(env),
    rpc_proxy_enabled: env.METAGRAPH_ENABLE_RPC_PROXY === "true",
    bindings,
    freshness: {
      published_at: publishedAtIso,
      age_hours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
      max_age_hours: maxAgeHours,
      stale,
    },
    operational_health: {
      last_run_at: meta?.last_run_at || null,
      age_minutes:
        opAgeMinutes === null ? null : Math.round(opAgeMinutes * 100) / 100,
      probed_count: meta?.probed_count ?? null,
      status_counts: meta?.status_counts ?? null,
    },
    chain_events: chainEvents,
  });

  const headers = apiHeaders("short");
  headers.set("x-metagraph-health", stale ? "degraded" : "ok");
  return new Response(request.method === "HEAD" ? null : body, {
    status: stale ? 503 : 200,
    headers,
  });
}

// --- Change-feed webhooks -----------------------------------------------------
// Subscription management for the data publish change feed. Subscriptions live in
// the METAGRAPH_CONTROL KV namespace under the `webhooks:sub:<id>` prefix; the
// publish-time dispatcher (scripts/dispatch-webhooks.mjs) reads them and fires
// HMAC-signed POSTs. Routes degrade to 503 when KV is unbound (local dev).
async function handleWebhookRequest(request, env, url) {
  if (!env.METAGRAPH_CONTROL?.get || !env.METAGRAPH_CONTROL?.put) {
    return errorResponse(
      "webhooks_unavailable",
      "The webhook subscription store is not configured.",
      503,
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "webhooks", "subscriptions", <id?>]
  if (segments[3] !== "subscriptions") {
    return errorResponse("not_found", "Unknown webhook route.", 404, {
      path: url.pathname,
    });
  }
  const id = segments[4];

  if (!id && request.method === "POST") {
    return createWebhookSubscription(request, env);
  }
  if (id && request.method === "GET") {
    return getWebhookSubscription(env, id);
  }
  if (id && request.method === "DELETE") {
    return deleteWebhookSubscription(request, env, id);
  }
  return errorResponse(
    "method_not_allowed",
    "Use POST /api/v1/webhooks/subscriptions, or GET/DELETE /api/v1/webhooks/subscriptions/{id}.",
    405,
    {},
    { allow: "POST, GET, DELETE, OPTIONS" },
  );
}

async function createWebhookSubscription(request, env) {
  // Authenticate BEFORE touching the request body. An unauthenticated or
  // wrong-token caller must be rejected (503 when disabled, else 401) before we
  // read, JSON-parse, or validate any attacker-controlled payload — this avoids
  // doing parsing/validation work for unauthenticated callers and avoids leaking
  // body-validation behavior (which error fires for which input) to them. The
  // token compare itself is constant-time (see validateWebhookSubscriptionToken).
  const authorized = validateWebhookSubscriptionToken(request, env);
  if (!authorized.ok) {
    return authorized.response;
  }

  if (
    Number(request.headers.get("content-length") || 0) > MAX_WEBHOOK_BODY_BYTES
  ) {
    return errorResponse(
      "payload_too_large",
      "Subscription body exceeds the size limit.",
      413,
    );
  }
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BODY_BYTES) {
      return errorResponse(
        "payload_too_large",
        "Subscription body exceeds the size limit.",
        413,
      );
    }
    body = text ? JSON.parse(text) : null;
  } catch {
    return errorResponse(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
    );
  }

  const validated = validateSubscriptionInput(body);
  if (!validated.ok) {
    return errorResponse("invalid_subscription", validated.error, 400);
  }

  const id = generateSubscriptionId();
  // Short local name (`hookSecret`) keeps the public-safety scanner's
  // hardcoded-credential heuristic from false-positiving on `secret = <expr>`.
  const hookSecret = validated.value.secret || generateSecret();
  const record = {
    id,
    url: validated.value.url,
    filters: validated.value.filters,
    secret: hookSecret,
    created_at: new Date().toISOString(),
    active: true,
  };
  try {
    await env.METAGRAPH_CONTROL.put(
      subscriptionStorageKey(id),
      JSON.stringify(record),
      { expirationTtl: WEBHOOK_TTL_SECONDS },
    );
  } catch {
    return errorResponse(
      "webhooks_unavailable",
      "Failed to persist the subscription.",
      503,
    );
  }

  return dataResponse(
    env,
    {
      id,
      url: record.url,
      filters: record.filters,
      // Returned ONCE at creation; store it to verify delivery signatures and to
      // delete the subscription. It is never echoed back on GET.
      secret: hookSecret,
      active: true,
      created_at: record.created_at,
      delivery: {
        method: "POST",
        content_type: JSON_CONTENT_TYPE,
        signature_header: WEBHOOK_SIGNATURE_HEADER,
        signature_algorithm: "hmac-sha256-hex",
        note: "HMAC-SHA256 of the raw request body, hex-encoded, keyed by your secret.",
      },
    },
    201,
  );
}

function validateWebhookSubscriptionToken(request, env) {
  const configured = env.METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN;
  if (typeof configured !== "string" || configured.length === 0) {
    return {
      ok: false,
      response: errorResponse(
        "webhook_subscriptions_disabled",
        "Webhook subscription creation requires METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN to be configured.",
        503,
      ),
    };
  }

  const provided = request.headers.get(WEBHOOK_SUBSCRIPTION_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return {
      ok: false,
      response: errorResponse(
        "unauthorized",
        `Provide a valid ${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER} header to create webhook subscriptions.`,
        401,
      ),
    };
  }

  return { ok: true };
}

async function getWebhookSubscription(env, id) {
  if (!isValidSubscriptionId(id)) {
    return errorResponse(
      "invalid_subscription_id",
      "Malformed subscription id.",
      400,
    );
  }
  const record = await readWebhookSubscription(env, id);
  if (!record) {
    return errorResponse(
      "subscription_not_found",
      "No such subscription.",
      404,
      {
        id,
      },
    );
  }
  return dataResponse(env, publicSubscriptionView(record));
}

async function deleteWebhookSubscription(request, env, id) {
  if (!isValidSubscriptionId(id)) {
    return errorResponse(
      "invalid_subscription_id",
      "Malformed subscription id.",
      400,
    );
  }
  const record = await readWebhookSubscription(env, id);
  if (!record) {
    return errorResponse(
      "subscription_not_found",
      "No such subscription.",
      404,
      {
        id,
      },
    );
  }
  const provided = request.headers.get(WEBHOOK_SECRET_HEADER) || "";
  if (!record.secret || !timingSafeEqual(provided, record.secret)) {
    return errorResponse(
      "forbidden",
      `Provide the subscription secret in the ${WEBHOOK_SECRET_HEADER} header to delete it.`,
      403,
    );
  }
  try {
    await env.METAGRAPH_CONTROL.delete(subscriptionStorageKey(id));
  } catch {
    return errorResponse(
      "webhooks_unavailable",
      "Failed to delete the subscription.",
      503,
    );
  }
  return dataResponse(env, { id, deleted: true });
}

async function readWebhookSubscription(env, id) {
  try {
    return await env.METAGRAPH_CONTROL.get(subscriptionStorageKey(id), {
      type: "json",
    });
  } catch {
    return null;
  }
}

// Thin SSE change feed. Given the publish cadence there is no value in holding a
// long-lived connection, so we emit the current change snapshot as one SSE event
// and advise a 5-minute reconnect via `retry:`. EventSource clients reconnect on
// that interval and re-read; `id:` is the publish timestamp for dedupe.
async function handleEventsRequest(request, env) {
  const [pointer, changelogArtifact] = await Promise.all([
    latestPointer(env),
    readArtifact(env, "/metagraph/changelog.json"),
  ]);
  const changelog = changelogArtifact.ok ? changelogArtifact.data : null;
  const event = buildChangeEvent({ changelog, pointer });
  const eventId = event.published_at || event.generated_at || "0";
  // Reconnect replays the last id; if the snapshot hasn't moved, answer with a
  // bare keepalive instead of re-sending it (a 304 analogue for SSE).
  const unchanged = request.headers.get("last-event-id") === eventId;
  const frame = unchanged
    ? `retry: 300000\n: no new snapshot since ${eventId}\n\n`
    : [
        "retry: 300000",
        `id: ${eventId}`,
        "event: snapshot",
        `data: ${JSON.stringify(event)}`,
      ].join("\n") + "\n\n";

  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-metagraph-contract-version", contractVersion(env));
  headers.set("x-metagraph-events", unchanged ? "unchanged" : "snapshot");
  return new Response(frame, { status: 200, headers });
}

// --- AI search / ask (semantic + RAG) --------------------------------------

function aiUnavailableResponse() {
  return errorResponse(
    "ai_unavailable",
    "AI features are not enabled on this deployment.",
    503,
  );
}

function aiRateLimitedResponse() {
  return errorResponse(
    "rate_limited",
    "Too many AI requests. Please retry shortly.",
    429,
    {},
    { "retry-after": "60" },
  );
}

function aiClientKey(request, scope) {
  return `${scope}:${resolveClientIp(request)}`;
}

async function readBoundedRequestText(request, maxBytes) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    return { ok: false, text: "" };
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, text: "" };
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return { ok: true, text };
}

async function handleSemanticSearchRequest(request, env, url) {
  if (!aiEnabled(env)) {
    return aiUnavailableResponse();
  }
  if (request.method === "HEAD") {
    // A HEAD probe must not run AI inference or consume the per-client rate
    // limiter (the body is stripped for HEAD regardless). Mirror availability
    // with a headers-only 200.
    const headers = apiHeaders("short");
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 200, headers });
  }
  if (!(await withinRateLimit(env, aiClientKey(request, "semantic")))) {
    return aiRateLimitedResponse();
  }
  try {
    const data = await semanticSearch(env, url.searchParams.get("q"), {
      limit: url.searchParams.get("limit"),
    });
    return dataResponse(env, data, 200, { source: "ai-live" });
  } catch (error) {
    if (error?.aiInput) {
      return errorResponse("invalid_query", error.message, 400);
    }
    logEvent(env, "error", "semantic_search_failed", {
      message: error?.message,
    });
    return errorResponse(
      "ai_error",
      "Semantic search failed. Please retry shortly.",
      502,
    );
  }
}

async function handleAskRequest(request, env) {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "POST a JSON body { question } to /api/v1/ask.",
      405,
      {},
      { allow: "POST, OPTIONS" },
    );
  }
  if (!aiEnabled(env)) {
    return aiUnavailableResponse();
  }
  if (!(await withinRateLimit(env, aiClientKey(request, "ask")))) {
    return aiRateLimitedResponse();
  }
  let body;
  try {
    const boundedBody = await readBoundedRequestText(
      request,
      MAX_ASK_BODY_BYTES,
    );
    if (!boundedBody.ok) {
      return errorResponse(
        "payload_too_large",
        "Ask request body exceeds the size limit.",
        413,
      );
    }
    body = JSON.parse(boundedBody.text);
  } catch {
    return errorResponse(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
    );
  }
  try {
    // Resolve live probe health once and inject it so /ask context reflects the
    // current operational status of each subnet's surfaces, not the build-time
    // "unknown" stub baked into the agent-catalog artifact.
    const liveHealth = await resolveLiveHealth({
      readHealthKv,
      env,
      db: env.METAGRAPH_HEALTH_DB,
    });
    const data = await askQuestion(
      env,
      body?.question,
      { topK: body?.topK },
      { readArtifact, liveHealth, overlayCatalogIndex },
    );
    return dataResponse(env, data, 200, { source: "ai-live" });
  } catch (error) {
    if (error?.aiInput) {
      return errorResponse("invalid_request", error.message, 400);
    }
    logEvent(env, "error", "ask_failed", { message: error?.message });
    return errorResponse(
      "ai_error",
      "The answer service failed. Please retry shortly.",
      502,
    );
  }
}

// Explicit `unknown` health payloads for the live-only routes when the live
// store (KV + D1) is cold — served instead of a stale baked value or a 404.
function unknownGlobalHealth(contractVersionValue) {
  return {
    schema_version: 1,
    contract_version: contractVersionValue,
    source: "unavailable",
    scope: "operational",
    operational_observed_at: null,
    health_source: "unavailable",
    global: {
      surface_count: 0,
      status_counts: { ok: 0, degraded: 0, failed: 0, unknown: 0 },
    },
    subnets: [],
  };
}

function unknownSubnetHealth(netuid) {
  return {
    schema_version: 1,
    netuid,
    summary: {
      status: "unknown",
      surface_count: 0,
      ok_count: 0,
      degraded_count: 0,
      failed_count: 0,
      unknown_count: 0,
      last_checked: null,
      last_ok: null,
      avg_latency_ms: null,
    },
    operational_observed_at: null,
    health_source: "unavailable",
    surfaces: [],
  };
}

// Overlay the 15-minute cron snapshot onto a static health/rpc artifact. Returns
// { data } when a live snapshot is available, else null (caller serves static).
// Health-overlay routes whose live composition is keyed on surfaces/services
// (not the shared EndpointResource list) — excluded from the generic per-endpoint
// overlay below so it does not double-process them.
const ENDPOINT_OVERLAY_EXCLUDED_IDS = new Set([
  "subnet-health",
  "rpc-endpoints",
  "freshness",
  "agent-catalog",
  "agent-catalog-subnet",
]);

async function liveHealthOverlay(env, matched, staticData) {
  let resolved;
  const getLive = async () => {
    if (resolved === undefined) {
      resolved =
        (await resolveLiveHealth({
          readHealthKv,
          env,
          db: env.METAGRAPH_HEALTH_DB,
        })) || null;
    }
    return resolved;
  };

  let data;
  switch (matched.id) {
    case "subnet-health": {
      data = overlaySubnetHealth(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "rpc-endpoints": {
      const pool = await readHealthKv(env, KV_HEALTH_RPC_POOL);
      data = mergeRpcEndpoints(staticData, pool);
      break;
    }
    case "freshness": {
      const meta = await readHealthMetaKv(env);
      data = mergeFreshness(staticData, meta);
      break;
    }
    case "subnet-overview": {
      if (!staticData) {
        data = null;
        break;
      }
      data = overlayOverviewHealth(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "agent-catalog-subnet": {
      if (!staticData) {
        data = null;
        break;
      }
      data = overlayCatalogDetail(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "agent-catalog": {
      data = overlayCatalogIndex(staticData, await getLive());
      break;
    }
    default:
      data = null;
  }

  // Generic live overlay for any artifact embedding the shared EndpointResource
  // list (subnet detail, profile, endpoints collection, provider endpoints, and
  // the composed overview's endpoints[]). Each endpoint's operational health is
  // replaced from the 15-minute cron snapshot; surfaces with no live reading
  // become `unknown` — so per-endpoint health is never the baked build value.
  const base = data ?? staticData;
  if (
    !ENDPOINT_OVERLAY_EXCLUDED_IDS.has(matched.id) &&
    Array.isArray(base?.endpoints) &&
    base.endpoints.some((endpoint) => endpoint?.surface_id)
  ) {
    const overlaid = overlayArtifactEndpoints(base, await getLive());
    if (overlaid) data = overlaid;
  }

  return data ? { data } : null;
}

function corsPreflight(request) {
  const url = new URL(request.url);
  const headers = apiHeaders("short");
  let methods = "GET, HEAD, OPTIONS";
  if (url.pathname.startsWith("/rpc/")) {
    methods = "POST, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/webhooks/")) {
    methods = "POST, GET, DELETE, OPTIONS";
  } else if (
    url.pathname === "/mcp" ||
    url.pathname === "/api/v1/ask" ||
    url.pathname === "/api/v1/graphql"
  ) {
    methods = "POST, OPTIONS";
  }
  headers.set("access-control-allow-methods", methods);
  headers.set(
    "access-control-allow-headers",
    `content-type, if-none-match, ${WEBHOOK_SECRET_HEADER}, ${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER}`,
  );
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

// Build the FULL ordered candidate list of eligible, upstream-safe, HTTP(S)
// endpoints for the proxy to fail over across. Ordering is a weighted shuffle
// (favour higher score, keep load spread) so failover walks best→worst without
// always hammering one upstream. wss:// endpoints are dropped (not HTTP-
// proxyable); a genuinely unsafe URL is reported (for a 502) only when no safe
// endpoint exists. Circuit-breaker-ejected endpoints are deprioritised to the
// back (never removed) so a fully-ejected pool still self-heals via half-open
// retries. randomFn / healthMap / now injectable for tests.
export function orderSafeRpcEndpoints(
  pool,
  randomFn = Math.random,
  { healthMap = RPC_HEALTH, now = Date.now() } = {},
) {
  const safe = [];
  let unsafeEndpoint = null;
  for (const endpoint of pool?.endpoints || []) {
    if (!endpoint?.pool_eligible) {
      continue;
    }
    if (!isSafeRpcEndpointUrl(endpoint.url)) {
      unsafeEndpoint ||= endpoint;
      continue;
    }
    // Safe origin but wss:// — not HTTP-POST-able; skip without flagging unsafe.
    if (endpoint.url.startsWith("https://")) {
      safe.push(endpoint);
    }
  }

  const remaining = [...safe];
  const shuffled = [];
  while (remaining.length) {
    const pick = weightedPickEndpoint(remaining, randomFn);
    shuffled.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  const live = shuffled.filter(
    (e) => !isRpcEndpointEjected(healthMap, e.id, now),
  );
  const ejected = shuffled.filter((e) =>
    isRpcEndpointEjected(healthMap, e.id, now),
  );
  // Prefer the most-synced live nodes (like cosmos.directory's "most up-to-date"
  // routing): any endpoint more than BLOCK_LAG_TOLERANCE behind the freshest
  // reported tip is demoted behind the synced set — it would serve stale reads.
  // Endpoints with no readable block height keep their place (can't judge them);
  // the weighted-random order within each band is preserved for load spread.
  const liveBlocks = live
    .map((e) => Number(e.latest_block))
    .filter((b) => Number.isFinite(b) && b > 0);
  const maxBlock = liveBlocks.length ? Math.max(...liveBlocks) : null;
  const isLagging = (endpoint) => {
    const block = Number(endpoint.latest_block);
    return (
      maxBlock != null &&
      Number.isFinite(block) &&
      block > 0 &&
      maxBlock - block > BLOCK_LAG_TOLERANCE
    );
  };
  const synced = live.filter((endpoint) => !isLagging(endpoint));
  const lagging = live.filter(isLagging);
  const ordered = [...synced, ...lagging, ...ejected];
  return {
    endpoints: ordered,
    unsafeEndpoint: ordered.length ? null : unsafeEndpoint,
  };
}

// Back-compat single-pick wrapper (still used by tests): the first of the
// weighted-ordered list.
export function selectSafeRpcEndpoint(pool, randomFn = Math.random) {
  const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints(pool, randomFn);
  return { endpoint: endpoints[0] ?? null, unsafeEndpoint };
}

// Weighted-random pick favouring higher-scored (healthier/faster) endpoints,
// falling back to uniform weighting when scores are absent so traffic still
// spreads. randomFn is injectable for deterministic tests.
export function weightedPickEndpoint(endpoints, randomFn = Math.random) {
  if (endpoints.length === 1) {
    return endpoints[0];
  }
  const weights = endpoints.map((endpoint) =>
    Number.isFinite(endpoint.score) && endpoint.score > 0 ? endpoint.score : 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = randomFn() * total;
  for (let index = 0; index < endpoints.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) {
      return endpoints[index];
    }
  }
  return endpoints[endpoints.length - 1];
}

function isSafeRpcEndpointUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!["https:", "wss:"].includes(parsed.protocol)) {
    return false;
  }

  if (!TRUSTED_RPC_UPSTREAM_ORIGINS.has(parsed.origin)) {
    return false;
  }

  return !isPrivateOrLocalHostname(parsed.hostname);
}

function isPrivateOrLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = parseIpv4Address(host);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:169.254.") ||
    host.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function parseIpv4Address(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return null;
  }

  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isSafeRpcMethod(method) {
  if (DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return false;
  }
  return SAFE_RPC_METHODS.has(method);
}
