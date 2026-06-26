import {
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  artifactPathFromTemplate,
  compileRoutePattern,
} from "../src/contracts.mjs";
import {
  applyQueryFilters,
  canonicalListSearch,
  paginationLinkHeader,
} from "./list-query.mjs";
import {
  apiHeaders,
  errorResponse,
  exposeCustomResponseHeaders,
  ifNoneMatchSatisfied,
  weakEtag,
} from "./http.mjs";
import {
  latestPointer,
  logEvent,
  readArtifact,
  readHealthKv,
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
  analyticsMeta,
  analyticsQueryError,
  configureAnalytics,
  d1All,
  handleBulkHealthTrends,
  handleChainActivity,
  handleGlobalIncidents,
  handleHealthIncidents,
  handleHealthPercentiles,
  handleHealthTrends,
  hasD1FallbackRows,
  markD1FallbackResponse,
  validateQueryParams,
  withEdgeCache,
} from "./request-handlers/analytics.mjs";
import {
  loadStagedNeurons,
  loadStagedEvents,
  loadStagedBlocks,
  loadStagedExtrinsics,
} from "./request-handlers/staging.mjs";
import {
  handleSubnetMetagraph,
  handleNeuron,
  handleSubnetValidators,
  handleSubnetEvents,
  handleNeuronHistory,
  handleSubnetHistory,
  handleAccount,
  handleAccountHistory,
  handleAccountBalance,
  handleAccountEvents,
  handleAccountExtrinsics,
  handleAccountTransfers,
  handleAccountSubnets,
  handleBlocks,
  handleBlock,
  handleBlockExtrinsics,
  handleBlockEvents,
  handleExtrinsics,
  handleExtrinsic,
} from "./request-handlers/entities.mjs";
import {
  classifyUpstreamAttempt,
  configureRpcProxy,
  graphqlRateLimited,
  handleRpcProxyRequest,
  handleRpcUsage,
  handleSurfaceVerify,
  isRpcEndpointEjected,
  orderSafeRpcEndpoints,
  proxyWithFailover,
  readRpcPoolArtifact,
  recordRpcFailure,
  recordRpcSuccess,
  rpcCachePolicy,
  RPC_POOL_ARTIFACT_TTL_MS,
  selectSafeRpcEndpoint,
  weightedPickEndpoint,
} from "./request-handlers/rpc-proxy.mjs";
import {
  buildChangeEvent,
  deliveryStoragePrefix,
  generateSecret,
  generateSubscriptionId,
  isValidSubscriptionId,
  publicSubscriptionView,
  subscriptionStorageKey,
  summarizeDeliveryRecords,
  WEBHOOK_REDELIVERY_LIST_LIMIT,
  timingSafeEqual,
  validateSubscriptionInput,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_IDEMPOTENCY_HEADER,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "../src/webhooks.mjs";
import {
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  pruneHealthHistory,
  rollupDailyUptime,
  runHealthProber,
  writeSubnetSnapshot,
} from "../src/health-prober.mjs";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.mjs";
import { dailyLatencyColumns } from "../src/health-sql.mjs";
import {
  buildGlobalHealth,
  formatLeaderboards,
  formatTrajectory,
  formatUptime,
  LEADERBOARD_BOARDS,
  mergeFreshness,
  mergeRpcEndpoints,
  overlayArtifactEndpoints,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlayOverviewHealth,
  overlaySubnetEconomics,
  overlaySubnetHealth,
  resolveLiveEconomics,
  resolveLiveHealth,
} from "../src/health-serving.mjs";
import {
  rollupNeuronDaily,
  archiveNeuronDaily,
  archivePrunableNeuronDaily,
  pruneNeuronDaily,
  neuronDailyUpsertStatements,
  validNeuronDailyRows,
} from "../src/neuron-history.mjs";
import {
  eventInsertStatements,
  pruneAccountEvents,
  rollupAccountEventsDaily,
  validEventRows,
} from "../src/account-events.mjs";
import {
  blockInsertStatements,
  pruneBlocks,
  validBlockRows,
} from "../src/blocks.mjs";
import {
  extrinsicInsertStatements,
  pruneExtrinsics,
  validExtrinsicRows,
} from "../src/extrinsics.mjs";
import {
  economicsSnapshotUpsertStatements,
  validEconomicsBackfillRows,
} from "../src/economics-backfill.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { handleFeedRequest } from "../src/feeds.mjs";
import { handleBadgeRequest } from "../src/badge.mjs";
import { handleOgImage } from "../src/og-image.mjs";
import { handleIconProxy } from "../src/icon-proxy.mjs";
import { handleGraphQLRequest } from "../src/graphql.mjs";
import {
  aiEnabled,
  askQuestion,
  runEmbeddingSync,
  semanticSearch,
  withinRateLimit,
} from "../src/ai-search.mjs";
import {
  ACCOUNT_BALANCE_PATH_PATTERN,
  ACCOUNT_EVENTS_PATH_PATTERN,
  ACCOUNT_HISTORY_PATH_PATTERN,
  ACCOUNT_EXTRINSICS_PATH_PATTERN,
  ACCOUNT_TRANSFERS_PATH_PATTERN,
  ACCOUNT_PATH_PATTERN,
  ACCOUNT_SUBNETS_PATH_PATTERN,
  BLOCK_DETAIL_PATH_PATTERN,
  BLOCK_EXTRINSICS_PATH_PATTERN,
  BLOCK_EVENTS_PATH_PATTERN,
  BLOCKS_FEED_PATH_PATTERN,
  EXTRINSIC_DETAIL_PATH_PATTERN,
  EXTRINSICS_FEED_PATH_PATTERN,
  BULK_TRENDS_PATH_PATTERN,
  DAY_MS,
  EMBEDDING_SYNC_CRON,
  EVENTS_INGEST_TOKEN_HEADER,
  EVENTS_LOAD_CRON,
  HEALTH_PRUNE_CRON,
  INCIDENTS_PATH_PATTERN,
  JSON_CONTENT_TYPE,
  MAX_ASK_BODY_BYTES,
  MAX_BACKFILL_INGEST_BODY_BYTES,
  MAX_BACKFILL_INGEST_ROWS,
  MAX_BLOCKS_INGEST_BODY_BYTES,
  MAX_BLOCKS_INGEST_ROWS,
  MAX_EVENTS_INGEST_BODY_BYTES,
  MAX_EVENTS_INGEST_ROWS,
  MAX_UPTIME_ROWS,
  MAX_WEBHOOK_BODY_BYTES,
  NEURON_HISTORY_ROLLUP_CRON,
  PERCENTILES_PATH_PATTERN,
  RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN,
  resolveClientIp,
  SUBNET_HISTORY_PATH_PATTERN,
  SUBNET_METAGRAPH_PATH_PATTERN,
  SUBNET_NEURON_HISTORY_PATH_PATTERN,
  SUBNET_NEURON_PATH_PATTERN,
  SUBNET_VALIDATORS_PATH_PATTERN,
  SUBNET_EVENTS_PATH_PATTERN,
  TRAJECTORY_PATH_PATTERN,
  TRENDS_PATH_PATTERN,
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

// Reduce a request's query string to its canonical, cache-relevant form: keep
// only the params that actually steer the response body (the collection's
// filters / search / sort / pagination / projection), single-valued, and emit
// them in a deterministic order. URLSearchParams.set sorts nothing, but the
// fixed iteration order below makes `?b=2&a=1` and `?a=1&b=2&unused=x` collapse
// to the same key — so param order and ignored params stop fragmenting the
// cache. Routes with no query collection (pure static artifacts) honour no
// params at all, so their canonical search is the empty string. Shared by both
// the static edge cache and the live-overlay collection cache.
function canonicalCacheSearch(url, matched) {
  return canonicalListSearch(
    url,
    matched.queryCollection,
    matched.queryFilterNames || [],
  );
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return handleScheduled(controller, env, ctx);
  },
};

// The staged-artifact loaders now live in request-handlers/staging.mjs (#1763).
// Re-export them so the scheduled cron drain (handleScheduled) and the staging
// tests keep importing them from this module.
export {
  loadStagedNeurons,
  loadStagedEvents,
  loadStagedBlocks,
  loadStagedExtrinsics,
};

// The RPC-proxy subsystem now lives in request-handlers/rpc-proxy.mjs (#1763).
// The router dispatches the handlers directly via the imports above; these
// helpers + constants are re-exported only so the rpc-cache / rpc-failover /
// rpc-endpoint-selection / rpc-pool-cache tests keep importing them from this
// module (their public test surface is api.mjs, not the new file).
export {
  classifyUpstreamAttempt,
  isRpcEndpointEjected,
  orderSafeRpcEndpoints,
  proxyWithFailover,
  readRpcPoolArtifact,
  recordRpcFailure,
  recordRpcSuccess,
  rpcCachePolicy,
  RPC_POOL_ARTIFACT_TTL_MS,
  selectSafeRpcEndpoint,
  weightedPickEndpoint,
};

// Byte length of a UTF-8 string. Shared by the realtime ingest handlers below to
// bound request bodies before parsing. (The staging loaders carry their own copy;
// it is a pure stdlib one-liner, so a tiny duplicate beats a cross-module import
// for a leaf used on both sides of the extraction.)
function utf8Bytes(value) {
  return new TextEncoder().encode(value);
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
  if (utf8Bytes(raw).length > MAX_EVENTS_INGEST_BODY_BYTES) {
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
  // Report rows ACTUALLY inserted, not rows validated. The statements use
  // INSERT OR IGNORE on (block_number, event_index), and the streamer/poller
  // ingest windows overlap by design, so duplicates are the normal case and are
  // silently dropped — `rows.length` over-reports. Sum the per-statement
  // D1 `meta.changes` instead.
  let inserted = 0;
  if (rows.length) {
    const results = await db.batch(eventInsertStatements(db, rows));
    for (const result of results) inserted += result?.meta?.changes ?? 0;
  }
  return new Response(JSON.stringify({ ok: true, inserted }), {
    status: 200,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

// POST /api/v1/internal/blocks (#1345 Option B): the realtime block-explorer ingest
// path for the finalized-head streamer (#1361). Same auth as /internal/events (the
// shared METAGRAPH_EVENTS_INGEST_SECRET over EVENTS_INGEST_TOKEN_HEADER). Body is
// {blocks:[...], extrinsics:[...]}, loaded with the SAME parameterized INSERT OR
// IGNORE as the staged-batch loaders — idempotent on the PKs (block_number;
// (block_number, extrinsic_index)). NOT in the public contract. Closes the
// blocks/extrinsics realtime gap (the coalesced CI poller alone missed ~58%; #1749).
export async function handleBlockIngest(request, env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "POST only.", 405);
  }
  const configured = env.METAGRAPH_EVENTS_INGEST_SECRET;
  if (!configured) {
    return errorResponse(
      "blocks_ingest_disabled",
      "Realtime block ingest requires METAGRAPH_EVENTS_INGEST_SECRET to be configured.",
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
    return errorResponse("unavailable", "Block store unavailable.", 503);
  }
  const raw = await request.text();
  if (utf8Bytes(raw).length > MAX_BLOCKS_INGEST_BODY_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Body exceeds ${MAX_BLOCKS_INGEST_BODY_BYTES} bytes.`,
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON object {blocks:[...], extrinsics:[...]}.",
      400,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON object {blocks:[...], extrinsics:[...]}.",
      400,
    );
  }
  const incomingBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  const incomingExtrinsics = Array.isArray(parsed.extrinsics)
    ? parsed.extrinsics
    : [];
  if (
    incomingBlocks.length > MAX_BLOCKS_INGEST_ROWS ||
    incomingExtrinsics.length > MAX_BLOCKS_INGEST_ROWS
  ) {
    return errorResponse(
      "too_many_rows",
      `At most ${MAX_BLOCKS_INGEST_ROWS} rows per array (blocks, extrinsics).`,
      413,
    );
  }
  // Report rows ACTUALLY inserted (INSERT OR IGNORE on the PKs drops the expected
  // streamer/poller overlap), summing per-statement D1 meta.changes. Block
  // statements come first in the batch, then extrinsic statements.
  const blockStmts = blockInsertStatements(db, validBlockRows(incomingBlocks));
  const extrinsicStmts = extrinsicInsertStatements(
    db,
    validExtrinsicRows(incomingExtrinsics),
  );
  let blocksInserted = 0;
  let extrinsicsInserted = 0;
  if (blockStmts.length || extrinsicStmts.length) {
    const results = await db.batch([...blockStmts, ...extrinsicStmts]);
    results.forEach((result, i) => {
      const changes = result?.meta?.changes ?? 0;
      if (i < blockStmts.length) blocksInserted += changes;
      else extrinsicsInserted += changes;
    });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      blocks_inserted: blocksInserted,
      extrinsics_inserted: extrinsicsInserted,
    }),
    { status: 200, headers: { "content-type": JSON_CONTENT_TYPE } },
  );
}

// POST /api/v1/internal/backfill-neurons (#1345 Phase 1): the historical metagraph
// backfill ingest for scripts/backfill-neuron-history.py. Disabled (503) until the
// dedicated METAGRAPH_BACKFILL_SECRET is configured (falls back to the events-ingest
// secret; reuses the EVENTS_INGEST_TOKEN_HEADER header); then a constant-time token
// compare. The body is an array of neuron_daily rows (or {rows:[...]}), each carrying
// its own snapshot_date,
// upserted with the SAME column set + ON CONFLICT target as the forward rollup, so a
// backfilled row is byte-identical to a rolled one and any re-POST is idempotent on
// (netuid,uid,snapshot_date). NOT in the public contract.
export async function handleNeuronBackfill(request, env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "POST only.", 405);
  }
  const configured =
    env.METAGRAPH_BACKFILL_SECRET || env.METAGRAPH_EVENTS_INGEST_SECRET;
  if (!configured) {
    return errorResponse(
      "backfill_disabled",
      "Historical backfill requires METAGRAPH_BACKFILL_SECRET (or METAGRAPH_EVENTS_INGEST_SECRET) to be configured.",
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
    return errorResponse("unavailable", "History store unavailable.", 503);
  }
  const raw = await request.text();
  if (utf8Bytes(raw).length > MAX_BACKFILL_INGEST_BODY_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Body exceeds ${MAX_BACKFILL_INGEST_BODY_BYTES} bytes.`,
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON array of neuron_daily rows (or {rows:[...]}).",
      400,
    );
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON array of neuron_daily rows (or {rows:[...]}).",
      400,
    );
  }
  if (incoming.length > MAX_BACKFILL_INGEST_ROWS) {
    return errorResponse(
      "too_many_rows",
      `At most ${MAX_BACKFILL_INGEST_ROWS} rows per request.`,
      413,
    );
  }
  const rows = validNeuronDailyRows(incoming);
  if (rows.length) {
    await db.batch(neuronDailyUpsertStatements(db, rows));
  }
  return new Response(
    JSON.stringify({
      ok: true,
      received: incoming.length,
      inserted: rows.length,
    }),
    { status: 200, headers: { "content-type": JSON_CONTENT_TYPE } },
  );
}

// POST /api/v1/internal/backfill-economics (#1307, epic #1302): the per-SUBNET
// alpha-price history backfill ingest for scripts/backfill-economics-history.py —
// the analogue of handleNeuronBackfill, but for the economics time series. Auth +
// caps are IDENTICAL to the neuron backfill: disabled (503) until
// METAGRAPH_BACKFILL_SECRET (or METAGRAPH_EVENTS_INGEST_SECRET) is configured,
// then a constant-time token compare over the shared EVENTS_INGEST_TOKEN_HEADER.
// The body is an array of {netuid, snapshot_date, captured_at, alpha_price_tao}
// rows (or {rows:[...]}), upserted into subnet_snapshots on (netuid,snapshot_date)
// with the SAME COALESCE semantics as the forward prober — only alpha_price_tao +
// the key/captured_at columns are touched, so a backfilled value fills a NULL but
// never clobbers a forward fire or any other column, and any re-POST is idempotent.
// NOT in the public contract.
export async function handleEconomicsBackfill(request, env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "POST only.", 405);
  }
  const configured =
    env.METAGRAPH_BACKFILL_SECRET || env.METAGRAPH_EVENTS_INGEST_SECRET;
  if (!configured) {
    return errorResponse(
      "backfill_disabled",
      "Historical backfill requires METAGRAPH_BACKFILL_SECRET (or METAGRAPH_EVENTS_INGEST_SECRET) to be configured.",
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
    return errorResponse("unavailable", "History store unavailable.", 503);
  }
  const raw = await request.text();
  if (utf8Bytes(raw).length > MAX_BACKFILL_INGEST_BODY_BYTES) {
    return errorResponse(
      "payload_too_large",
      `Body exceeds ${MAX_BACKFILL_INGEST_BODY_BYTES} bytes.`,
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON array of economics rows (or {rows:[...]}).",
      400,
    );
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return errorResponse(
      "invalid_body",
      "Body must be a JSON array of economics rows (or {rows:[...]}).",
      400,
    );
  }
  if (incoming.length > MAX_BACKFILL_INGEST_ROWS) {
    return errorResponse(
      "too_many_rows",
      `At most ${MAX_BACKFILL_INGEST_ROWS} rows per request.`,
      413,
    );
  }
  const rows = validEconomicsBackfillRows(incoming);
  if (rows.length) {
    await db.batch(economicsSnapshotUpsertStatements(db, rows));
  }
  return new Response(
    JSON.stringify({
      ok: true,
      received: incoming.length,
      inserted: rows.length,
    }),
    { status: 200, headers: { "content-type": JSON_CONTENT_TYPE } },
  );
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
    // Block-explorer hot window (#1345): pick up any R2-staged `blocks` sidecar
    // (same poller, same staging key convention) and load it via the binding. In
    // the SAME cron so the staged-R2 drain stays gated to one cron (no cross-cron
    // clobber); .catch-isolated so a block-load failure never affects the others.
    await loadStagedBlocks(env).catch(() => {});
    // Block-explorer extrinsic slice (#1345): pick up any R2-staged `extrinsics`
    // sidecar (same poller, same staging key convention) and load it via the
    // binding. In the SAME cron so the staged-R2 drain stays gated to one cron (no
    // cross-cron clobber); .catch-isolated so an extrinsic-load failure never
    // affects the others.
    await loadStagedExtrinsics(env).catch(() => {});
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
      // .catch-isolated — a transient D1 error must degrade to a no-op for this
      // tick, not abort the whole Promise.all and discard the snapshot write.
      pruneHealthHistory(env).catch(() => ({ pruned: false })),
      // D1 safety-valve: prune chain-explorer tables at a 365-day window so D1
      // never hits the 10 GB cap before the Postgres cold tier (#1519) ships.
      // account_events is safe here — rollupAccountEventsDaily (above) already
      // aggregated the daily summaries. blocks + extrinsics have no daily rollup
      // yet, so older raw rows are discarded. All three are .catch-isolated.
      pruneAccountEvents(env).catch(() => ({ pruned: false })),
      pruneBlocks(env).catch(() => ({ pruned: false })),
      pruneExtrinsics(env).catch(() => ({ pruned: false })),
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
    // Pin a single `now` so the backlog archive and the prune derive the SAME
    // retention cutoff. The archive does ~33k-row R2 work and can straddle a UTC
    // midnight; if archive and prune each called Date.now() independently, the
    // prune's cutoff could be one day larger and delete a day from D1 that the
    // archive never wrote to R2 — the exact gap this archive-before-prune closes.
    const now = Date.now();
    const rolled = await rollupNeuronDaily(env).catch(() => ({
      rolled: false,
    }));
    const archived = await archiveNeuronDaily(env).catch(() => ({
      archived: false,
    }));
    const archivedPrunable = await archivePrunableNeuronDaily(env, {
      now,
    }).catch(() => ({
      archived: false,
    }));
    const pruned =
      archived.archived && archivedPrunable.archived
        ? await pruneNeuronDaily(env, { now }).catch(() => ({ pruned: false }))
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
  if (url.pathname === "/api/v1/internal/blocks") {
    return handleBlockIngest(request, env);
  }
  if (url.pathname === "/api/v1/internal/backfill-neurons") {
    return handleNeuronBackfill(request, env);
  }
  if (url.pathname === "/api/v1/internal/backfill-economics") {
    return handleEconomicsBackfill(request, env);
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

  // Brand-icon favicon proxy (binary, not a JSON contract route). Implements the
  // icon-proxy contract consumed by metagraphed-ui <BrandIcon>; SSRF-safe (fetches
  // only fixed favicon services) + R2-cached. See src/icon-proxy.mjs.
  if (url.pathname === "/api/v1/icon") {
    return handleIconProxy(request, env, url, { readArtifact });
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

  // Cross-subnet compare (registry structure + economics + live health composed
  // side by side; the same fileless-D1 pattern as the leaderboards route).
  // Edge-cached on the cron snapshot's last_run_at so a polling/cross-colo burst
  // doesn't re-run the economics + D1 reads.
  if (url.pathname === "/api/v1/compare") {
    return withEdgeCache(
      request,
      ctx,
      env,
      "compare",
      () => handleCompare(request, env, url),
      canonicalCompareCachePath(url),
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
      // GROUP BY daily aggregation, deterministic per cron snapshot — edge-cache
      // on last_run_at like the sibling analytics routes (pathname carries the
      // netuid, search carries ?window). Cheap single-row lookups stay uncached.
      return withEdgeCache(request, ctx, env, "subnet-history", () =>
        handleSubnetHistory(
          request,
          env,
          Number(subnetHistoryMatch[1]),
          resolved.url,
        ),
      );
    }
    const metagraphMatch = SUBNET_METAGRAPH_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (metagraphMatch) {
      // Full per-subnet metagraph (range read over the neurons tier), deterministic
      // per cron snapshot — edge-cache on last_run_at; ?validator_permit rides the
      // search into the key.
      return withEdgeCache(request, ctx, env, "subnet-metagraph", () =>
        handleSubnetMetagraph(
          request,
          env,
          Number(metagraphMatch[1]),
          resolved.url,
        ),
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
      // Validator slice of the metagraph (filtered range read), deterministic per
      // cron snapshot — edge-cache on last_run_at like the sibling routes.
      return withEdgeCache(request, ctx, env, "subnet-validators", () =>
        handleSubnetValidators(
          request,
          env,
          Number(validatorsMatch[1]),
          resolved.url,
        ),
      );
    }
    // Per-subnet chain-event stream (#1345): account_events filtered by netuid.
    // Live + continuously appended, so served direct (no edge cache) like the
    // account-events route — envelopeResponse's ETag + "short" cache govern it.
    const subnetEventsMatch = SUBNET_EVENTS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (subnetEventsMatch) {
      return handleSubnetEvents(
        request,
        env,
        Number(subnetEventsMatch[1]),
        resolved.url,
      );
    }
    // Account entity routes (#1347): computed live from the account_events +
    // neurons D1 tiers. More-specific paths first (each pattern is anchored).
    const accountHistoryMatch = ACCOUNT_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountHistoryMatch) {
      return handleAccountHistory(
        request,
        env,
        accountHistoryMatch[1],
        resolved.url,
      );
    }
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
    const accountExtrinsicsMatch = ACCOUNT_EXTRINSICS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountExtrinsicsMatch) {
      return handleAccountExtrinsics(
        request,
        env,
        accountExtrinsicsMatch[1],
        resolved.url,
      );
    }
    const accountTransfersMatch = ACCOUNT_TRANSFERS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountTransfersMatch) {
      return handleAccountTransfers(
        request,
        env,
        accountTransfersMatch[1],
        resolved.url,
      );
    }
    const accountBalanceMatch = ACCOUNT_BALANCE_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountBalanceMatch) {
      return handleAccountBalance(request, env, accountBalanceMatch[1]);
    }
    const accountMatch = ACCOUNT_PATH_PATTERN.exec(resolved.url.pathname);
    if (accountMatch) {
      return handleAccount(request, env, accountMatch[1]);
    }
    // Block-explorer routes (#1345): computed live from the `blocks` D1 tier.
    // Sub-resource (#1845) before detail before the feed; each pattern is anchored.
    const blockExtrinsicsMatch = BLOCK_EXTRINSICS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (blockExtrinsicsMatch) {
      return handleBlockExtrinsics(
        request,
        env,
        blockExtrinsicsMatch[1],
        resolved.url,
      );
    }
    const blockEventsMatch = BLOCK_EVENTS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (blockEventsMatch) {
      return handleBlockEvents(request, env, blockEventsMatch[1], resolved.url);
    }
    const blockDetailMatch = BLOCK_DETAIL_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (blockDetailMatch) {
      return handleBlock(request, env, blockDetailMatch[1]);
    }
    if (BLOCKS_FEED_PATH_PATTERN.test(resolved.url.pathname)) {
      return handleBlocks(request, env, resolved.url);
    }
    // Block-explorer extrinsic routes (#1345 second slice): computed live from the
    // `extrinsics` D1 tier. Detail (more specific) before the feed; each pattern
    // is anchored.
    const extrinsicDetailMatch = EXTRINSIC_DETAIL_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (extrinsicDetailMatch) {
      return handleExtrinsic(request, env, extrinsicDetailMatch[1]);
    }
    if (EXTRINSICS_FEED_PATH_PATTERN.test(resolved.url.pathname)) {
      return handleExtrinsics(request, env, resolved.url);
    }
    if (resolved.url.pathname === "/api/v1/incidents") {
      return withEdgeCache(request, ctx, env, "global-incidents", () =>
        handleGlobalIncidents(request, env, resolved.url),
      );
    }
    if (resolved.url.pathname === "/api/v1/chain/activity") {
      return handleChainActivity(request, env, resolved.url, ctx);
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
    pathname === "/api/v1/compare" ||
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

// Re-inserts the /{network}/ segment that resolveNetworkPrefix strips before
// dispatch, so a self-referential link (e.g. the pagination Link header) stays
// on the network the client asked for. Mainnet (prefix "") is a no-op.
function networkPublicUrl(url, network) {
  if (!network.prefix) {
    return url;
  }
  const publicUrl = new URL(url);
  publicUrl.pathname = publicUrl.pathname.replace(
    /^\/(api\/v1|metagraph)(\/|$)/,
    `/$1/${network.prefix}$2`,
  );
  return publicUrl;
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

// Wire the api.mjs-local snapshot-meta reader into the extracted analytics module
// (workers/request-handlers/analytics.mjs, #1763). The analytics handlers + their
// edge-cache guard own the D1-fallback state; they only need this one in-isolate
// memoized KV read, which stays here because the deferred handler clusters and a
// test import it from api.mjs. Injecting the stable reference (rather than having
// analytics.mjs import it back) keeps the two modules from importing each other.
configureAnalytics({ readHealthMetaKv });

// Same wiring for the extracted RPC-proxy module (workers/request-handlers/
// rpc-proxy.mjs, #1763): handleRpcUsage needs the in-isolate snapshot-meta read
// for its observed_at stamp. Injecting the stable reference keeps rpc-proxy.mjs
// from importing api.mjs back (it owns the RPC_HEALTH breaker + pool-artifact memo
// itself; this is the only api.mjs-local helper it depends on).
configureRpcProxy({ readHealthMetaKv });

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
        )}${url.pathname}${canonicalCacheSearch(url, matched)}`,
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
        )}/${encodeURIComponent(lastRunAt)}${url.pathname}${canonicalCacheSearch(url, matched)}`,
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
  // Advertise the page chain via an RFC 8288 Link header on paginated list
  // responses. networkPublicUrl restores the prefix stripped before dispatch;
  // paginationLinkHeader returns null (no header) for non-list/single-page data.
  const linkValue = paginationLinkHeader(
    networkPublicUrl(url, network),
    transformed.meta.pagination,
    {
      queryCollection: matched.queryCollection,
      queryFilterNames: matched.queryFilterNames || [],
    },
  );
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
    linkValue ? { link: linkValue } : {},
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

// Week-over-week structural trajectory from daily snapshots.
async function handleTrajectory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
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
  const response = await envelopeResponse(
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
  return hasD1FallbackRows(rows) ? markD1FallbackResponse(response) : response;
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
  const response = await envelopeResponse(
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
  return hasD1FallbackRows(rows) ? markD1FallbackResponse(response) : response;
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

// Economic source for cross-subnet projections (e.g. the leaderboard economic
// boards): the live KV 'economics:current' blob when fresh/on-contract/integrity-
// checked, else the committed R2 economics.json — the same KV-primary/R2-fallback
// the /api/v1/economics route uses. Always resolves to an array (empty when both
// tiers are cold), so every caller stays null-safe.
async function resolveEconomicsRows(env) {
  const live = await resolveLiveEconomics({
    readHealthKv,
    env,
    contractVersion: contractVersion(env),
  });
  if (Array.isArray(live?.data?.subnets)) return live.data.subnets;
  const artifact = await readArtifact(env, "/metagraph/economics.json");
  return artifact.ok && Array.isArray(artifact.data?.subnets)
    ? artifact.data.subnets
    : [];
}

// Registry leaderboards: healthiest / fastest-rpc / most-complete /
// most-enriched / fastest-growing plus the economic opportunity boards
// (open-slots / cheapest-registration / highest-emission / validator-headroom).
// Combines live D1 status with registry projections and the economics tier.
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
  // 30d window for the durable reliability board (matches the reliability/badge
  // default), distinct from the 7d completeness-growth window above.
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples, economicsRows, reliabilityRows] =
    await Promise.all([
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
      // Economic boards: the economics tier alongside the operational D1 queries.
      resolveEconomicsRows(env),
      // Durable reliability board: per-subnet windowed uptime + latency from the
      // surface_uptime_daily rollup (one GROUP BY netuid round-trip).
      d1All(
        env,
        `SELECT netuid,
              SUM(samples) AS samples,
              SUM(ok_count) AS ok_count,
              ${dailyLatencyColumns({ roundedAvg: true })}
       FROM surface_uptime_daily
       WHERE day >= ?
       GROUP BY netuid`,
        [thirtyDaysAgo],
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
    reliabilityRows,
    economicsRows,
    subnetMeta,
  });
  const response = await envelopeResponse(
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
  return hasD1FallbackRows(healthRows, rpcRows, growthSamples, reliabilityRows)
    ? markD1FallbackResponse(response)
    : response;
}

// The data domains /api/v1/compare can place side by side: registry structure
// (completeness + surface counts from profiles), the live economics tier, and
// the live per-subnet probe-health rollup. Composed in one call so a caller can
// choose between subnets without N×(detail + economics + health) round-trips.
const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
// Same shape + hard cap as the subnets collection's `netuids` CSV filter: 1-128
// ids, each ≤ 5 digits. Bounds the compare fan-out at the parameter layer.
const COMPARE_NETUIDS_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;

function compareNetuids(netuidsRaw) {
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

function compareDimensions(dimensionsRaw) {
  if (dimensionsRaw === null) return COMPARE_DIMENSIONS;
  const requested = dimensionsRaw.split(",");
  const unknown = requested.find((d) => !COMPARE_DIMENSIONS.includes(d));
  if (unknown !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => requested.includes(d));
}

function canonicalCompareCachePath(url) {
  if (validateQueryParams(url, ["netuids", "dimensions"])) return null;
  const requestedNetuids = compareNetuids(url.searchParams.get("netuids"));
  if (!requestedNetuids) return null;
  const dimensions = compareDimensions(url.searchParams.get("dimensions"));
  if (!dimensions) return null;
  const params = [`netuids=${encodeURIComponent(requestedNetuids.join(","))}`];
  if (dimensions.length !== COMPARE_DIMENSIONS.length) {
    params.push(`dimensions=${encodeURIComponent(dimensions.join(","))}`);
  }
  return `${url.pathname}?${params.join("&")}`;
}

// Pure projection: fold the requested netuids + the resolved source rows into
// the side-by-side compare shape, in REQUESTED order. A netuid absent from the
// registry profiles is returned `found: false` with every requested dimension
// null (so a caller can still align columns); a found subnet missing from a
// given source tier gets that one dimension as null. Exported for unit coverage.
export function composeCompareData({
  requestedNetuids,
  dimensions,
  subnetMeta,
  structureRows,
  economicsRows,
  healthRows,
  observedAt,
}) {
  const includeStructure = dimensions.includes("structure");
  const includeEconomics = dimensions.includes("economics");
  const includeHealth = dimensions.includes("health");

  const structureByNetuid = new Map();
  for (const row of structureRows || []) {
    structureByNetuid.set(row.netuid, {
      completeness_score: row.completeness_score,
      surface_count: row.surface_count,
      operational_interface_count: row.operational_interface_count,
    });
  }
  const economicsByNetuid = new Map();
  for (const row of economicsRows || []) {
    economicsByNetuid.set(row.netuid, {
      registration_cost_tao: row.registration_cost_tao,
      registration_allowed: row.registration_allowed,
      open_slots: row.open_slots,
      emission_share: row.emission_share,
      alpha_price_tao: row.alpha_price_tao,
      validator_count: row.validator_count,
      miner_count: row.miner_count,
      total_stake_tao: row.total_stake_tao,
      miner_readiness: row.miner_readiness,
    });
  }
  const healthByNetuid = new Map();
  for (const row of healthRows || []) {
    healthByNetuid.set(row.netuid, {
      surface_count: row.surface_count,
      ok_count: row.ok_count,
      avg_latency_ms: row.avg_latency_ms,
    });
  }

  const subnets = requestedNetuids.map((netuid) => {
    const meta = subnetMeta.get(netuid) || null;
    const entry = {
      netuid,
      name: meta?.name ?? null,
      slug: meta?.slug ?? null,
      found: meta !== null,
    };
    if (includeStructure) {
      entry.structure = meta ? (structureByNetuid.get(netuid) ?? null) : null;
    }
    if (includeEconomics) {
      entry.economics = meta ? (economicsByNetuid.get(netuid) ?? null) : null;
    }
    if (includeHealth) {
      entry.health = meta ? (healthByNetuid.get(netuid) ?? null) : null;
    }
    return entry;
  });

  return {
    schema_version: 1,
    source: "registry+economics+live-cron-prober",
    observed_at: observedAt ?? null,
    dimensions,
    requested_netuids: requestedNetuids,
    subnets,
  };
}

// Cross-subnet compare: place several subnets side by side across the registry
// structure, economics, and live-health tiers in one call (fileless-D1 pattern,
// like handleLeaderboards). `netuids` is required; `dimensions` defaults to all.
async function handleCompare(request, env, url) {
  const validationError = validateQueryParams(url, ["netuids", "dimensions"]);
  if (validationError) return analyticsQueryError(validationError);

  const netuidsRaw = url.searchParams.get("netuids");
  const requestedNetuids = compareNetuids(netuidsRaw);
  if (!requestedNetuids) {
    return errorResponse(
      "invalid_query",
      "netuids is required: a comma-separated list of 1-128 subnet ids.",
      400,
      { parameter: "netuids" },
    );
  }

  const dimensionsRaw = url.searchParams.get("dimensions");
  const dimensions = compareDimensions(dimensionsRaw);
  if (!dimensions) {
    const unknown = dimensionsRaw
      .split(",")
      .find((d) => !COMPARE_DIMENSIONS.includes(d));
    return errorResponse(
      "invalid_query",
      `Unknown dimension "${unknown}". Valid dimensions: ${COMPARE_DIMENSIONS.join(", ")}.`,
      400,
      { parameter: "dimensions" },
    );
  }

  // subnetMeta + structure always come from the cached profiles projection;
  // economics + health are only read when their dimension is requested.
  const { subnetMeta, mostComplete } = await leaderboardProfilesProjection(env);
  const [economicsRows, healthRows] = await Promise.all([
    dimensions.includes("economics") ? resolveEconomicsRows(env) : null,
    dimensions.includes("health")
      ? d1All(
          env,
          `SELECT netuid,
                COUNT(*) AS surface_count,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                ROUND(AVG(latency_ms)) AS avg_latency_ms
         FROM surface_status
         WHERE netuid IN (${requestedNetuids.map(() => "?").join(", ")})
         GROUP BY netuid`,
          requestedNetuids,
        )
      : null,
  ]);

  const meta = await readHealthMetaKv(env);
  const data = composeCompareData({
    requestedNetuids,
    dimensions,
    subnetMeta,
    structureRows: mostComplete,
    economicsRows,
    healthRows,
    observedAt: meta?.last_run_at ?? null,
  });
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/compare.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: data.observed_at,
        source: "registry+economics+live-cron-prober",
      },
    },
    "standard",
  );
  return hasD1FallbackRows(healthRows)
    ? markD1FallbackResponse(response)
    : response;
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
  if (stale) {
    // The degraded branch is a transient 503; a 503 carrying explicit freshness
    // (public, max-age=60, stale-while-revalidate=300) is cacheable per RFC 7234,
    // so a shared/edge cache could keep serving "degraded" for up to ~6 min after
    // the data recovers. Never cache it — mirror errorResponse in workers/http.mjs.
    headers.set("cache-control", "no-store");
    headers.set("x-metagraph-cache-profile", "no-store");
  }
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
        event_id_header: WEBHOOK_EVENT_ID_HEADER,
        idempotency_header: WEBHOOK_IDEMPOTENCY_HEADER,
        note: "HMAC-SHA256 of the raw request body, hex-encoded, keyed by your secret. Delivery is at-least-once: dedupe retries on the idempotency header.",
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
  return dataResponse(env, {
    ...publicSubscriptionView(record),
    delivery: await readDeliveryStatus(env, id),
  });
}

// Delivery health for the public GET, summarized from the parked records.
// Best-effort — a list/get hiccup or a store without `list` degrades to "ok".
async function readDeliveryStatus(env, id) {
  try {
    if (typeof env.METAGRAPH_CONTROL.list !== "function") {
      return summarizeDeliveryRecords([]); // local dev: KV mock without list()
    }
    const { keys } = await env.METAGRAPH_CONTROL.list({
      prefix: deliveryStoragePrefix(id),
      limit: WEBHOOK_REDELIVERY_LIST_LIMIT,
    });
    const records = await Promise.all(
      keys
        .slice(0, WEBHOOK_REDELIVERY_LIST_LIMIT)
        .map((entry) =>
          env.METAGRAPH_CONTROL.get(entry.name, { type: "json" }),
        ),
    );
    return summarizeDeliveryRecords(records);
  } catch {
    return summarizeDeliveryRecords([]); // best-effort: never break the read
  }
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
  exposeCustomResponseHeaders(headers);
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
  } else if (url.pathname === "/api/v1/graphql") {
    // POST executes queries; GET serves the published SDL document.
    methods = "GET, POST, OPTIONS";
  } else if (url.pathname === "/mcp" || url.pathname === "/api/v1/ask") {
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
