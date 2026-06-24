// Module-scope configuration constants for the API Worker — pure literals,
// regexes, and lookup sets with no runtime dependencies. Extracted from
// workers/api.mjs (issue #510, de-monolith) so handlers can share them without
// the entry file owning every constant. Import-free by design: this module must
// stay a leaf so api.mjs and any future request-handler module can depend on it
// without cycles.

// Cron schedule strings (must match wrangler.jsonc `triggers.crons`). The hourly
// trigger prunes the D1 time-series; the fast trigger only drains staged batches
// into D1; every other trigger runs the 15-minute probe.
export const HEALTH_PRUNE_CRON = "0 * * * *";
// Daily embedding-sync trigger (Worker-runtime, since CI has no AI bindings).
// Distinct minute (odd) so it never collides with the 15-minute probe or the
// top-of-hour prune. Must match a wrangler.jsonc `triggers.crons` entry.
export const EMBEDDING_SYNC_CRON = "37 3 * * *";
// Fast event-load trigger (#1346 Option A): drains any R2-staged chain-event /
// neuron batch into D1 within ~3 min — cutting ingestion latency from ~20 min to
// ~5 min WITHOUT running the (heavier) health probe. Must match a wrangler.jsonc
// `triggers.crons` entry.
export const EVENTS_LOAD_CRON = "*/3 * * * *";
// Daily neuron-history rollup (#1345 Tier-1): snapshots the current `neurons`
// table into the dated neuron_daily table once a day, on its own minute (distinct
// from the probe/prune/embed/fast crons) so the ~33k-row INSERT...SELECT runs
// exactly once/day, not on every tick. Must match a wrangler.jsonc cron entry.
export const NEURON_HISTORY_ROLLUP_CRON = "47 5 * * *";
// Trend windows for /api/v1/subnets/{netuid}/health/trends and
// /api/v1/health/trends.
export const RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN =
  /^\/metagraph\/health\/(?:latest\.json|summary\.json|subnets\/\d+\.json)$/;
export const HEALTH_TREND_WINDOWS = { "7d": 7, "30d": 30 };
export const BULK_TRENDS_PATH_PATTERN = /^\/api\/v1\/health\/trends$/;
export const TRENDS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/trends$/;
export const PERCENTILES_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/percentiles$/;
export const INCIDENTS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/incidents$/;
export const TRAJECTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/trajectory$/;
export const UPTIME_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/uptime$/;
// Per-UID metagraph routes (#1304/#1305): computed live from the neurons D1 tier.
export const SUBNET_METAGRAPH_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/metagraph$/;
export const SUBNET_NEURON_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)$/;
export const SUBNET_VALIDATORS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/validators$/;
// Per-UID + per-subnet metagraph HISTORY (block-explorer Tier-1, #1345): time
// series read from the neuron_daily rollup tier.
export const SUBNET_NEURON_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)\/history$/;
export const SUBNET_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/history$/;
// Account entity routes (#1347): computed live from the account_events + neurons
// D1 tiers. SS58 addresses are base58 (no 0/O/I/l), 47-48 chars.
export const ACCOUNT_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})$/;
export const ACCOUNT_EVENTS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/events$/;
export const ACCOUNT_SUBNETS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/subnets$/;
// Block-explorer routes (#1345): recent feed + per-block detail, computed live
// from the `blocks` D1 tier. {ref} is a numeric block_number OR a 0x block_hash
// (32-byte hex = 64 chars).
export const BLOCKS_FEED_PATH_PATTERN = /^\/api\/v1\/blocks$/;
export const BLOCK_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})$/;
// Block-explorer extrinsic routes (#1345 second slice): recent feed + per-extrinsic
// detail, computed live from the `extrinsics` D1 tier. {hash} is a 0x extrinsic_hash
// (32-byte blake2b = 64 hex chars).
export const EXTRINSICS_FEED_PATH_PATTERN = /^\/api\/v1\/extrinsics$/;
export const EXTRINSIC_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/extrinsics\/(0x[0-9a-fA-F]{64})$/;
export const UPTIME_WINDOWS = { "90d": 90, "1y": 365 };
export const MAX_UPTIME_ROWS = 10000;
export const MAX_BULK_TREND_ROWS = 10000;
export const ANALYTICS_WINDOWS = { "7d": 7, "30d": 30 };
export const ANALYTICS_WINDOW_PARAM = "window";
export const RPC_USAGE_BUCKETS = {
  "7d": { granularity: "1h", bucketMs: 60 * 60 * 1000, maxBuckets: 7 * 24 },
  "30d": {
    granularity: "6h",
    bucketMs: 6 * 60 * 60 * 1000,
    maxBuckets: 30 * 4,
  },
};
export const MAX_INCIDENT_ROWS = 1000;
export const MAX_GLOBAL_INCIDENT_SOURCE_ROWS = 5000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// Fixed bucket used as the rate-limit key (and request-scoped client id) when no
// trustworthy client IP is available.
export const ANONYMOUS_CLIENT_KEY = "anonymous";

// Resolve the client IP for rate-limiting / per-client keys. On Cloudflare,
// `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client.
// `X-Forwarded-For` is fully client-controlled and MUST NOT be trusted here: an
// attacker could rotate it to mint a fresh rate-limit bucket per request and
// evade the limiter. So we read `cf-connecting-ip` ONLY; when it is absent
// (non-CF / local / the test harness) we collapse to a single fixed bucket
// rather than honoring any client-supplied header. A shared fixed bucket is the
// safe failure mode — worst case all such callers share one limit.
export function resolveClientIp(request) {
  return request.headers.get("cf-connecting-ip") || ANONYMOUS_CLIENT_KEY;
}

// Read-only, bounded Substrate/Subtensor methods safe to expose through the
// public proxy. Deliberately excludes heavy/abusable reads (state_getMetadata,
// state_getStorage) and anything mutating — those stay blocked by the allowlist
// plus DENIED_RPC_PREFIXES.
export const SAFE_RPC_METHODS = new Set([
  "chain_getBlock",
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "rpc_methods",
  "state_getRuntimeVersion",
  "system_chain",
  "system_health",
  "system_name",
  "system_properties",
  "system_version",
]);
export const DENIED_RPC_PREFIXES = [
  "author_",
  "state_call",
  "sudo_",
  "payment_",
  "contracts_",
];
export const MAX_RPC_BODY_BYTES = 65536;
export const METAGRAPH_LATEST_KEY = "metagraph:latest";
export const MAX_WEBHOOK_BODY_BYTES = 8192;
export const MAX_ASK_BODY_BYTES = 4096;
export const WEBHOOK_SUBSCRIPTION_TOKEN_HEADER =
  "x-metagraph-webhook-subscription-token";
// Realtime chain-event ingest (#1360): the header carrying the shared secret the
// finalized-head streamer (#1361) presents to POST /api/v1/internal/events.
export const EVENTS_INGEST_TOKEN_HEADER = "x-metagraph-events-token";
export const MAX_EVENTS_INGEST_BODY_BYTES = 262144; // 256 KB
export const MAX_EVENTS_INGEST_ROWS = 500;
// Internal historical backfill ingest (#1345 Phase 1): batched neuron_daily
// upserts from the chain-direct backfill script (scripts/backfill-neuron-history.py).
// Auth via the dedicated METAGRAPH_BACKFILL_SECRET (falls back to the events-ingest
// secret) over the shared EVENTS_INGEST_TOKEN_HEADER. Caps are wider than the event
// ingest because a metagraph row is wider and a subnet-day is up to ~256 rows; the
// script chunks well under these and the PK upsert makes any re-POST idempotent.
export const MAX_BACKFILL_INGEST_BODY_BYTES = 1_048_576; // 1 MiB
export const MAX_BACKFILL_INGEST_ROWS = 2_000;
// Caps on the R2-staged chain-event drain (loadStagedEvents, #1346). Unlike the
// single bounded HTTP body above, a staged file is produced by the CI poller and
// can grow large on a backfill or a stuck window. The byte cap guards against
// materializing a pathological body; the row cap bounds the D1 writes + subrequests
// PER */3 tick (10 000 rows -> ~1 000 INSERT statements -> ~20 db.batch() calls,
// far under the 1 000-subrequest limit). On overflow the drain loads up to the row
// cap and LEAVES the remainder in R2 for the next tick — it never deletes
// un-persisted rows; INSERT OR IGNORE on (block_number, event_index) makes any
// re-drain idempotent.
export const MAX_STAGED_EVENTS_BYTES = 4_194_304; // 4 MiB parse-safety ceiling
export const MAX_STAGED_EVENT_ROWS = 10_000;
// Block-explorer hot window (#1345): the staged `blocks` sidecar caps. One block
// row per finalized block in the rolling poller window, so the row volume is far
// lower than the per-block event count — but keep the same byte ceiling +
// progressive-drain row cap so a pathological body can never be materialized and
// each */3 tick stays well under the subrequest limit. INSERT OR IGNORE on
// block_number makes any re-drain idempotent.
export const MAX_STAGED_BLOCKS_BYTES = 4_194_304; // 4 MiB parse-safety ceiling
export const MAX_STAGED_BLOCK_ROWS = 10_000;
// Block-explorer extrinsic slice (#1345): the staged `extrinsics` sidecar caps.
// Several extrinsics per finalized block in the rolling poller window, so the row
// volume sits between the per-block count and the per-event count — keep the same
// byte ceiling + progressive-drain row cap so a pathological body can never be
// materialized and each */3 tick stays well under the subrequest limit. INSERT OR
// IGNORE on (block_number, extrinsic_index) makes any re-drain idempotent.
export const MAX_STAGED_EXTRINSICS_BYTES = 4_194_304; // 4 MiB parse-safety ceiling
export const MAX_STAGED_EXTRINSIC_ROWS = 10_000;
// Dormant subscriptions self-clean after 180 days; the publish-time dispatcher
// refreshes the TTL on each successful delivery.
export const WEBHOOK_TTL_SECONDS = 180 * 24 * 60 * 60;
export const TRUSTED_RPC_UPSTREAM_ORIGINS = new Set([
  "https://archive.chain.opentensor.ai",
  "https://bittensor-finney.api.onfinality.io",
  "https://bittensor-public.nodies.app",
  "https://entrypoint-finney.opentensor.ai",
  "https://lite.chain.opentensor.ai",
  // Bittensor testnet base-layer RPC + WSS (the /rpc/v1/test + test-wss pools);
  // verified testnet genesis 0x8f9cf8…, distinct from finney. WSS endpoints
  // confirmed (101 Switching Protocols). See registry/native/test-base-endpoints.json.
  "https://test.finney.opentensor.ai",
  "https://test.chain.opentensor.ai",
  "wss://test.finney.opentensor.ai",
  "wss://test.chain.opentensor.ai",
  "wss://archive.chain.opentensor.ai",
  "wss://bittensor-finney.api.onfinality.io",
  "wss://entrypoint-finney.opentensor.ai",
  "wss://lite.chain.opentensor.ai",
]);
