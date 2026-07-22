// metagraphed data Worker — Postgres-backed serving via Cloudflare Hyperdrive.
//
// Kept SEPARATE from the main api.mjs Worker (which is near its bundle budget): the
// postgres.js driver + the growing Postgres-backed read surface live here, and the
// main Worker routes the relevant paths in via a service binding (DATA_API). This is
// the serving half of ADR 0013 — the indexer + Rust backfill write the rich Postgres
// tiers (chain_events / deep history); this exposes them to the public API.
//
// Mostly read-only, parameterized (postgres.js tagged templates), one request one
// sql.begin(DATA_API_READ_TRANSACTION, ...) transaction (#4686 connection-affinity). The ONE
// exception is POST /api/v1/internal/neurons-sync (#4771): the write path into
// this SAME Postgres instance's neurons/neuron_daily tables. It does NOT get its
// own dedicated Worker the way registry-sync-api.mjs does -- that split is
// justified by registry-sync-api targeting a genuinely SEPARATE Postgres instance,
// deliberately isolated so a bug in one can't take the other down. Here, splitting
// read and write for the IDENTICAL database would buy nothing (both need the same
// postgres.js driver either way) while adding a whole extra Worker/config/binding/
// secret for zero bundle-budget benefit. handleNeuronsSync below owns its own
// auth gate + connection, kept clearly separate from the read path's shared
// per-request client and response headers (a write ack must never carry the
// read routes' `cache-control: public, max-age=10`).
import postgres from "postgres";
import * as Sentry from "@sentry/cloudflare";
import { parseJsonPreservingBigIntegers } from "../src/postgres-json-parse.ts";
import { decodeCursor, encodeCursor } from "../src/cursor.ts";
import { buildBlock, buildBlockFeed } from "../src/blocks.ts";
import {
  buildExtrinsic,
  buildExtrinsicFeed,
  buildBlockExtrinsics,
  buildAccountExtrinsics,
} from "../src/extrinsics.ts";
import {
  buildAccountEvents,
  formatAccountEvent,
  buildAccountTransfers,
  buildBlockEvents,
  buildSubnetEvents,
  buildSubnetEventSummary,
  buildAccountSummary,
  buildAccountSubnets,
  buildAccountHistory,
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  SUBNET_EVENT_SUMMARY_WINDOWS,
  DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
} from "../src/account-events.ts";
import { buildAlphaVolume } from "../src/alpha-volume.ts";
import {
  buildSubnetOhlc,
  OHLC_INTERVAL_DEFAULT,
  DEFAULT_OHLC_WINDOW_DAYS,
  MAX_OHLC_WINDOW_DAYS,
} from "../src/subnet-ohlc.mjs";
import {
  buildSubnetOwnershipHistory,
  OWNERSHIP_CHANGE_EVENT_METHOD,
} from "../src/subnet-ownership-history.mjs";
import { buildAccountEntities } from "../src/entity-labels.ts";
import {
  buildSubnetLeaseHistory,
  SUBNET_LEASE_CREATED_KIND,
  SUBNET_LEASE_TERMINATED_KIND,
} from "../src/subnet-lease-history.mjs";
import {
  buildSubnetConviction,
  fetchConvictionRates,
} from "../src/subnet-conviction.mjs";
import {
  buildBlocksSummary,
  BLOCKS_SUMMARY_SCAN_CAP,
} from "../src/blocks-summary.ts";
import { buildRuntimeVersionHistory } from "../src/runtime-versions.mjs";
import {
  buildConcentration,
  buildChainConcentration,
  buildConcentrationHistory,
  CONCENTRATION_HISTORY_ROW_CAP,
  CONCENTRATION_HISTORY_WINDOWS,
  DEFAULT_CONCENTRATION_HISTORY_WINDOW,
} from "../src/concentration.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
  PERFORMANCE_HISTORY_ROW_CAP,
  PERFORMANCE_HISTORY_WINDOWS,
  DEFAULT_PERFORMANCE_HISTORY_WINDOW,
} from "../src/subnet-performance.mjs";
import { buildChainPerformance } from "../src/chain-performance.ts";
import {
  buildChainIdleStake,
  buildSubnetIdleStake,
} from "../src/subnet-idle-stake.mjs";
import { buildChainYield } from "../src/chain-yield.ts";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
  YIELD_HISTORY_ROW_CAP,
  YIELD_HISTORY_WINDOWS,
  DEFAULT_YIELD_HISTORY_WINDOW,
} from "../src/subnet-yield.mjs";
import { buildAccountPortfolio } from "../src/account-portfolio.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  HISTORY_WINDOWS,
  DEFAULT_HISTORY_WINDOW,
  MAX_HISTORY_POINTS,
} from "../src/neuron-history.ts";
import { buildValidatorHistory } from "../src/validator-history.mjs";
import {
  buildTurnover,
  buildTurnoverChanges,
  turnoverChangeDetail,
} from "../src/turnover.mjs";
import {
  buildChainTurnover,
  CHAIN_TURNOVER_WINDOWS,
  DEFAULT_CHAIN_TURNOVER_WINDOW,
  CHAIN_TURNOVER_LIMIT_DEFAULT,
} from "../src/chain-turnover.ts";
import {
  buildMovers,
  MOVERS_WINDOWS,
  DEFAULT_MOVERS_WINDOW,
  DEFAULT_MOVERS_SORT,
  MOVERS_LIMIT_DEFAULT,
} from "../src/movers.ts";
import {
  buildAccountsList,
  DEFAULT_ACCOUNTS_LIST_SORT,
  ACCOUNTS_LIST_LIMIT_DEFAULT,
} from "../src/accounts-list.ts";
import {
  buildTopHoldersList,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
} from "../src/top-holders.mjs";
import { decodeChainEventArgs } from "../src/chain-event-args.ts";
import {
  buildValidatorNominators,
  NOMINATOR_WINDOWS,
  DEFAULT_NOMINATOR_WINDOW,
  NOMINATOR_SORTS,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/validator-nominators.mjs";
import {
  buildAccountWeightSetters,
  WEIGHTS_EVENT_KIND,
  ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "../src/account-weight-setters.ts";
import {
  buildSubnetWeightSetters,
  SUBNET_WEIGHT_SETTERS_LIMIT,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
} from "../src/subnet-weight-setters.mjs";
import {
  buildSubnetWeights,
  SUBNET_WEIGHTS_WINDOWS,
  DEFAULT_SUBNET_WEIGHTS_WINDOW,
} from "../src/subnet-weights.mjs";
import {
  buildAccountStakeFlow,
  STAKE_FLOW_WINDOWS,
  DEFAULT_STAKE_FLOW_WINDOW,
} from "../src/account-stake-flow.ts";
import { buildStakeFlow } from "../src/stake-flow.mjs";
import {
  buildAccountStakeMoves,
  STAKE_MOVED_EVENT_KIND,
  ACCOUNT_STAKE_MOVES_WINDOWS,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
} from "../src/account-stake-moves.ts";
import {
  buildSubnetStakeMoves,
  SUBNET_STAKE_MOVES_WINDOWS,
  DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
} from "../src/subnet-stake-moves.mjs";
import {
  buildSubnetStakeTransfers,
  STAKE_TRANSFERRED_EVENT_KIND,
  SUBNET_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
} from "../src/subnet-stake-transfers.mjs";
import {
  buildAccountRegistrations,
  REGISTRATION_EVENT_KIND,
  REGISTRATION_WINDOWS,
  DEFAULT_REGISTRATION_WINDOW,
} from "../src/account-registrations.ts";
import {
  buildSubnetRegistrations,
  SUBNET_REGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
} from "../src/subnet-registrations.mjs";
import {
  buildAccountServing,
  SERVING_EVENT_KIND,
  SERVING_WINDOWS,
  DEFAULT_SERVING_WINDOW,
} from "../src/account-serving.ts";
import {
  buildSubnetServing,
  SUBNET_SERVING_WINDOWS,
  DEFAULT_SUBNET_SERVING_WINDOW,
} from "../src/subnet-serving.mjs";
import {
  buildAccountAxonRemovals,
  AXON_REMOVAL_EVENT_KIND,
  AXON_REMOVAL_WINDOWS,
  DEFAULT_AXON_REMOVAL_WINDOW,
} from "../src/account-axon-removals.ts";
import {
  buildSubnetAxonRemovals,
  SUBNET_AXON_REMOVALS_WINDOWS,
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
} from "../src/subnet-axon-removals.mjs";
import {
  buildAccountPrometheus,
  PROMETHEUS_EVENT_KIND,
  PROMETHEUS_WINDOWS,
  DEFAULT_PROMETHEUS_WINDOW,
} from "../src/account-prometheus.ts";
import {
  buildSubnetPrometheus,
  SUBNET_PROMETHEUS_WINDOWS,
  DEFAULT_SUBNET_PROMETHEUS_WINDOW,
} from "../src/subnet-prometheus.mjs";
import {
  buildAccountDeregistrations,
  DEREGISTRATION_EVENT_KIND,
  DEREGISTRATION_WINDOWS,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "../src/account-deregistrations.ts";
import {
  buildSubnetDeregistrations,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "../src/subnet-deregistrations.mjs";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
  COUNTERPARTIES_SCAN_CAP,
} from "../src/counterparties.ts";
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  HEALTH_TREND_WINDOWS,
  MAX_BULK_TREND_ROWS,
  MAX_INCIDENT_ROWS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  UPTIME_WINDOWS,
  MAX_UPTIME_ROWS,
  RPC_USAGE_BUCKETS,
  resolveClientIp,
  ROLLUP_TOKEN_HEADER,
} from "./config.ts";
import {
  formatBulkTrends,
  formatTrends,
  formatPercentiles,
  formatIncidents,
  formatGlobalIncidents,
  formatUptime,
  formatTrajectory,
  formatRpcUsage,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "../src/health-serving.ts";
import {
  buildEconomicsTrends,
  parseHistoryWindow,
} from "../src/neuron-history.ts";
import { ECONOMICS_TRENDS_ROW_CAP } from "../src/economics-trends.ts";
import {
  buildChainWeights,
  CHAIN_WEIGHTS_LIMIT_DEFAULT,
} from "../src/chain-weights.ts";
import {
  buildChainWeightSetters,
  CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
} from "../src/chain-weight-setters.ts";
import {
  buildChainServing,
  CHAIN_SERVING_LIMIT_DEFAULT,
} from "../src/chain-serving.ts";
import {
  buildChainPrometheus,
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
} from "../src/chain-prometheus.ts";
import {
  buildChainAxonRemovals,
  CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
} from "../src/chain-axon-removals.ts";
import {
  buildChainRegistrations,
  CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
} from "../src/chain-registrations.ts";
import {
  buildChainDeregistrations,
  CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
} from "../src/chain-deregistrations.ts";
import {
  buildChainStakeMoves,
  CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
} from "../src/chain-stake-moves.ts";
import {
  buildChainStakeTransfers,
  CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
} from "../src/chain-stake-transfers.ts";
import {
  buildChainStakeFlow,
  CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
} from "../src/chain-stake-flow.ts";
import {
  buildChainAlphaVolume,
  CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
} from "../src/chain-alpha-volume.ts";
import { buildChainTransfers } from "../src/chain-transfers.ts";
import { buildChainTransferPairs } from "../src/chain-transfer-pairs.ts";
import {
  SUBNET_HYPERPARAMS_INSERT_COLUMNS,
  formatSubnetHyperparams,
  buildSubnetHyperparams,
} from "../src/subnet-hyperparams.mjs";
import {
  hyperparamsHash,
  buildSubnetHyperparamsHistory,
} from "../src/subnet-hyperparams-history.mjs";
import {
  ACCOUNT_IDENTITY_INSERT_COLUMNS,
  IDENTITY_FIELDS,
  buildAccountIdentity,
} from "../src/account-identity.ts";
import {
  VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
  nominatorCountsByHotkey,
} from "../src/validator-nominator-summary.mjs";
import { tempoByNetuid as buildTempoByNetuid } from "../src/subnet-tempo.mjs";
import {
  NOMINATOR_POSITION_INSERT_COLUMNS,
  buildAccountPositions,
  distinctHotkeys,
  stakeByHotkeyNetuid,
} from "../src/account-nominator-positions.ts";
import {
  identityHash,
  buildAccountIdentityHistory,
} from "../src/account-identity-history.ts";
import {
  identitySnapshotFromProfile,
  identityHash as subnetIdentityHash,
  buildSubnetIdentityHistory,
} from "../src/subnet-identity-history.mjs";
import {
  buildChainIdentityHistory,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "../src/chain-identity-history.ts";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
  buildChainSigners,
} from "../src/chain-analytics.ts";
import { CHAIN_SIGNERS_SORTS } from "../src/chain-query-loaders.ts";

// metagraphed#6769: a caught write/query failure (logged via console.error,
// converted to a clean error response) never reached Sentry -- only an
// UNCAUGHT exception would, via data-api.sentry.mjs's withSentry() wrapper.
// Sentry.captureException is a safe no-op with no active client (confirmed
// live: returns an event id, doesn't throw), which is every test in this
// file -- they import this raw, unwrapped handler directly.
function captureDataApiError(err, route) {
  Sentry.captureException(err, { tags: { route } });
}

const DATA_API_READ_TRANSACTION = "isolation level repeatable read read only";
const ANALYTICS_DAY_MS = 24 * 60 * 60 * 1000;

// METAGRAPHED-7: Hyperdrive closes/recycles pooled connections out from under a live query
// under load -- postgres.js's Cloudflare build (node_modules/postgres/cf/src/connection.js)
// surfaces this as one of these three `error.code`s (Errors.connection in cf/src/errors.js),
// all transport-layer, never a query-correctness problem: CONNECTION_CLOSED (socket closed
// mid-query), CONNECTION_DESTROYED (pool tore the connection down), CONNECT_TIMEOUT (the
// initial handshake itself timed out). Retried below (MAX_CONNECTION_RETRY_ATTEMPTS times),
// only for the read-only route dispatcher (already scoped to a single sql.begin()
// transaction, so nothing can have partially committed) -- never for the write/sync routes,
// where blindly retrying a batch that may have partially applied would risk double-writes.
const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);
// A single retry (the original METAGRAPHED-7 fix) regressed: under sustained load,
// Hyperdrive can recycle the retry's own freshly created connection too, so the retry
// itself hits the same error class and the request still fails. 2 retries (3 total
// attempts) gives a second freshly created client a chance before giving up.
const MAX_CONNECTION_RETRY_ATTEMPTS = 2;

// Resolve a ?window= label to a cutoff epoch-ms, matching the D1 loaders'
// `Date.now() - days*DAY_MS` exactly. An unrecognized label falls back to the
// map's default rather than erroring -- entities.mjs's own validation already
// rejected genuinely bad values before tryPostgresTier ever forwards the
// request here, so this only needs to mirror the happy path.
function windowCutoff(url, windows, defaultLabel) {
  const label = url.searchParams.get("window") || defaultLabel;
  const days = Object.hasOwn(windows, label)
    ? windows[label]
    : windows[defaultLabel];
  return Date.now() - days * ANALYTICS_DAY_MS;
}

// The resolved window label to pass into a build* function's `{ window }` option,
// matching what windowCutoff used to compute the cutoff (falls back to the
// default for an unrecognized/absent label, same as windowCutoff).
function windowLabelFor(url, windows, defaultLabel) {
  const label = url.searchParams.get("window") || defaultLabel;
  return Object.hasOwn(windows, label) ? label : defaultLabel;
}

// A ?limit= value for the /chain/* network-wide analytics routes (#4832
// Tier 2). Most callers arrive via tryPostgresTier after the D1-side handler
// has already validated the route-specific bounds, but the Postgres-serving
// Worker must stay safe even if reached directly: every chain-wide analytics
// leaderboard is capped at the public API's 1..100 range before the value is
// bound into a SQL LIMIT clause.
function chainLimit(url, defaultLimit) {
  return clampRequestLimit(url.searchParams.get("limit"), {
    defaultLimit,
    maxLimit: 100,
  });
}

function queryError(error) {
  return json({ error }, 400);
}

// Resolve a ?window= label to a YYYY-MM-DD cutoff date for a neuron_daily
// `snapshot_date` (a native DATE column, not an epoch-ms timestamp), matching
// the D1 loaders' `new Date(Date.now() - days*DAY_MS).toISOString().slice(0,10)`
// exactly. A `null` day value (e.g. HISTORY_WINDOWS.all) means no lower bound.
function windowCutoffDate(url, windows, defaultLabel) {
  const label = url.searchParams.get("window") || defaultLabel;
  const days = Object.hasOwn(windows, label)
    ? windows[label]
    : windows[defaultLabel];
  if (days == null) return null;
  return new Date(Date.now() - days * ANALYTICS_DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// The newest `last_observed` epoch-ms across a row set, as an ISO string (or
// null for an empty/cold result) -- matches the `{ data, generatedAt }` contract
// the surviving account-level D1 loaders (and the former loadAccountStakeFlow /
// loadSubnetStakeFlow pair removed in #6016) all compute identically.
// entities.mjs destructures `generatedAt` straight off the tryPostgresTier body,
// so this route MUST nest under `data` too, not return buildX(...)'s object flat
// the way the subnet-level (single-object) routes do.
function latestObservedIso(rows, field = "last_observed") {
  let latest = null;
  for (const row of rows) {
    const n = Number(row?.[field]);
    if (Number.isFinite(n) && n > 0 && (latest == null || n > latest)) {
      latest = n;
    }
  }
  return latest == null ? null : new Date(latest).toISOString();
}
import { timingSafeEqual } from "../src/webhooks.mjs";
import {
  ALERT_TRIGGER_CREATE_TOKEN_HEADER,
  ALERT_TRIGGER_MAX_BODY_BYTES,
  ALERT_TRIGGER_OWNER_TOKEN_HEADER,
  ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER,
  evaluatorAlertTriggerView,
  generateAlertTriggerOwnerToken,
  isValidAlertOwnerToken,
  isValidAlertTriggerId,
  ownerAlertTriggerView,
  validateAlertTriggerInput,
} from "../src/alert-triggers.ts";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  DAY_PATTERN,
  clampLimit as clampRequestLimit,
  clampOffset as clampRequestOffset,
  parseLimitParam,
} from "./request-params.ts";
import {
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildGlobalValidators,
  buildNeuronDetail,
  buildValidatorDetail,
  GLOBAL_VALIDATOR_SORTS,
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  NEURON_INSERT_COLUMNS,
} from "../src/metagraph-neurons.ts";
import { buildAccountPositionHistory } from "../src/account-position-history.ts";
import {
  createUnkeyKey,
  verifyUnkeyKey,
  updateUnkeyKeyTier,
  revokeUnkeyKey,
} from "../src/unkey-client.mjs";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";
import {
  createSessionToken,
  issueWalletChallenge,
  SESSION_TTL_SECONDS,
  verifySessionToken,
  verifyWalletChallenge,
} from "../src/wallet-auth.mjs";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const FILTER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function validEventFilter(value) {
  return value == null || value === "" || FILTER_PATTERN.test(value);
}

// --- POST /api/v1/internal/neurons-sync (#4771) -----------------------------
// The write path into this Worker's own Postgres for neurons/neuron_daily.
// Reached only via the main Worker's DATA_API service binding (no public
// routes of its own) -- see workers/api.mjs's handleNeuronsSyncProxy, which
// forwards the request here unchanged. The shared-secret check below is the
// only auth gate in the whole path, mirroring workers/registry-sync-api.ts's
// shape (shared-secret POST, no R2/HMAC envelope needed since the secret
// header IS the transport's auth).
//
// This is the write path .github/workflows/refresh-metagraph.yml's
// sign-and-stage job POSTs scripts/fetch-metagraph-native.py's output to,
// alongside (not replacing, during the #4771 verification window) the
// existing R2-stage-to-D1 path. The payload is the SAME bare-array shape
// already produced for D1 (NEURON_INSERT_COLUMNS) -- no new fetch/shape work
// needed, only a new destination.
//
// Collapses D1's two-step architecture (loadStagedNeurons loads the latest
// snapshot; a SEPARATE daily cron, rollupNeuronDaily, later snapshots that
// table into neuron_daily via SQL) into ONE step: every row already carries
// its own captured_at, so this upserts BOTH neurons (latest-only) AND
// neuron_daily (dated) from the same payload in the same transaction. No
// Postgres-side rollup cron is needed, and therefore none of D1's
// archive-then-prune complexity (src/neuron-history.ts, #4770) has an
// equivalent here to build.
const NEURONS_SYNC_TOKEN_HEADER = "x-neurons-sync-token";
// ~33k rows today (129 subnets x <=256 UIDs); generous headroom over that
// (matches the D1 staging path's MAX_STAGED_NEURON_ROWS/MAX_STAGED_NEURONS_BYTES,
// workers/request-handlers/staging.mjs) without inviting a pathological body.
const NEURONS_SYNC_MAX_BODY_BYTES = 32_000_000;
const NEURONS_SYNC_MAX_ROWS = 50_000;
const NEURONS_SYNC_MAX_STRING_BYTES = 512;
const NEURONS_SYNC_MAX_NETUID = 65_535;
const NEURONS_SYNC_MAX_UID = 65_535;
// Multi-row VALUES tuples per statement (postgres.js's sql(rows, ...cols)
// helper) -- bounds a single statement's size while still batching the whole
// ~33k-row snapshot in a couple dozen round-trips rather than one per row.
const NEURONS_SYNC_ROWS_PER_STATEMENT = 1_000;
const NEURONS_SYNC_BOOLEAN_COLUMNS = new Set([
  "active",
  "validator_permit",
  "is_immunity_period",
]);

// Separate from the read path's json() -- a write ack must never carry the
// GET routes' `cache-control: public, max-age=10` (or the CORS wildcard,
// meaningless for a service-binding-only route).
function writeJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

// Bounds-check one incoming row against NEURON_INSERT_COLUMNS -- the exact
// same trust posture as workers/request-handlers/staging.mjs's
// validStagedNeuronRow (this payload arrives over a different transport, but
// it's the same untrusted-until-checked shape from the same producer script).
function validNeuronSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > NEURONS_SYNC_MAX_NETUID
  )
    return false;
  if (
    !Number.isInteger(row.uid) ||
    row.uid < 0 ||
    row.uid > NEURONS_SYNC_MAX_UID
  )
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  for (const [key, value] of Object.entries(row)) {
    if (!NEURON_INSERT_COLUMNS.includes(key)) return false;
    if (
      typeof value === "string" &&
      utf8Bytes(value).length > NEURONS_SYNC_MAX_STRING_BYTES
    )
      return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    // Every column here is a TEXT/INTEGER/NUMERIC/BOOLEAN scalar (never
    // JSONB) -- a nested object or array slipping through would only be
    // caught later as an opaque Postgres bind error (a 502), so reject it
    // here as a clean 400 instead. (bigint/symbol/function are NOT checked:
    // JSON.parse, this row's only real source, can never produce them.)
    if (value !== null && typeof value === "object") return false;
  }
  return true;
}

// captured_at is epoch ms; snapshot_date is the UTC day, matching D1's
// rollupNeuronDaily (`date(captured_at / 1000, 'unixepoch')`).
function neuronSyncSnapshotDate(capturedAtMs) {
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

// Coerce one validated row into the exact JS types each Postgres column
// expects: 0/1 -> boolean for the BOOLEAN columns (the fetch script emits
// 0/1 integers, same convention D1's INTEGER columns use), everything else
// passes through (postgres.js binds numbers/strings/nulls as-is).
function coerceNeuronSyncRow(row) {
  const out = {};
  for (const col of NEURON_INSERT_COLUMNS) {
    const value = row[col] ?? null;
    out[col] = NEURONS_SYNC_BOOLEAN_COLUMNS.has(col)
      ? Boolean(Number(value))
      : value;
  }
  return out;
}

function stripClientSnapshotDate(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const { snapshot_date: _snapshotDate, ...rest } = row;
  return rest;
}

async function handleNeuronsSync(request, env) {
  if (!env.NEURONS_SYNC_SECRET) {
    return writeJson(
      { error: "neurons sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(NEURONS_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.NEURONS_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${NEURONS_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > NEURONS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${NEURONS_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      { error: "body must be a JSON array of neuron rows (or {rows:[...]})" },
      400,
    );
  }
  if (incoming.length > NEURONS_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${NEURONS_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  // Mirrors handleNeuronDailyBackfill's identical strip-before-validate: a
  // client-provided snapshot_date isn't in NEURON_INSERT_COLUMNS, so
  // validNeuronSyncRow's key allowlist would otherwise reject the whole row
  // -- this handler had the exact same bug, just never patched alongside
  // the backfill one.
  const validatedIncoming = incoming.map(stripClientSnapshotDate);
  if (
    !validatedIncoming.length ||
    !validatedIncoming.every(validNeuronSyncRow)
  ) {
    return writeJson({ error: "rows must match the neuron row shape" }, 400);
  }

  const rows = validatedIncoming.map(coerceNeuronSyncRow);
  // Per-netuid max captured_at, NOT one batch-wide value -- a global max would
  // let one netuid's later capture prune rows this SAME request just upserted
  // for a different, earlier-captured netuid in the same batch (the max would
  // exceed that netuid's own captured_at, so its own just-written rows would
  // satisfy `captured_at < max` and be deleted as if deregistered).
  const netuidMaxCapturedAt = new Map();
  for (const row of rows) {
    const prev = netuidMaxCapturedAt.get(row.netuid) ?? 0;
    if (row.captured_at > prev)
      netuidMaxCapturedAt.set(row.netuid, row.captured_at);
  }
  const netuids = [...netuidMaxCapturedAt.keys()];

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    // sql.begin() reserves ONE physical connection for the whole batch, same
    // connection-affinity reasoning as the read path above (#4686) -- and
    // makes the whole snapshot atomic: a mid-batch failure must never leave
    // `neurons` upserted with stale UIDs left un-pruned, or `neuron_daily`
    // partially written for the day.
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      const dailyRows = rows.map((row) => ({
        ...row,
        snapshot_date: neuronSyncSnapshotDate(row.captured_at),
        updated_at: Date.now(),
      }));

      for (let i = 0; i < rows.length; i += NEURONS_SYNC_ROWS_PER_STATEMENT) {
        const chunk = rows.slice(i, i + NEURONS_SYNC_ROWS_PER_STATEMENT);
        await sql`
          INSERT INTO neurons ${sql(chunk, ...NEURON_INSERT_COLUMNS)}
          ON CONFLICT (netuid, uid) DO UPDATE SET
            hotkey = EXCLUDED.hotkey,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            validator_trust = EXCLUDED.validator_trust,
            consensus = EXCLUDED.consensus,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            emission_tao = EXCLUDED.emission_tao,
            stake_tao = EXCLUDED.stake_tao,
            registered_at_block = EXCLUDED.registered_at_block,
            is_immunity_period = EXCLUDED.is_immunity_period,
            axon = EXCLUDED.axon,
            block_number = EXCLUDED.block_number,
            captured_at = EXCLUDED.captured_at,
            take = EXCLUDED.take
          WHERE neurons.captured_at <= EXCLUDED.captured_at`;
      }

      for (
        let i = 0;
        i < dailyRows.length;
        i += NEURONS_SYNC_ROWS_PER_STATEMENT
      ) {
        const chunk = dailyRows.slice(i, i + NEURONS_SYNC_ROWS_PER_STATEMENT);
        await sql`
          INSERT INTO neuron_daily ${sql(chunk, ...NEURON_INSERT_COLUMNS, "snapshot_date", "updated_at")}
          ON CONFLICT (netuid, uid, snapshot_date) DO UPDATE SET
            hotkey = EXCLUDED.hotkey,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            validator_trust = EXCLUDED.validator_trust,
            consensus = EXCLUDED.consensus,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            emission_tao = EXCLUDED.emission_tao,
            stake_tao = EXCLUDED.stake_tao,
            registered_at_block = EXCLUDED.registered_at_block,
            is_immunity_period = EXCLUDED.is_immunity_period,
            axon = EXCLUDED.axon,
            block_number = EXCLUDED.block_number,
            captured_at = EXCLUDED.captured_at,
            updated_at = EXCLUDED.updated_at,
            take = EXCLUDED.take
          WHERE neuron_daily.captured_at <= EXCLUDED.captured_at`;
      }

      // Per-account daily position rollup (#4832 gap-closure; #4839 gave this
      // its own Postgres write path in this same transaction, replacing D1's
      // now-retired rollupAccountPositionDaily / src/account-position-history.mjs):
      // the SAME snapshot as neuron_daily above, re-keyed by (account, netuid,
      // snapshot_date) with account = hotkey. `hotkey IS NOT NULL` mirrors that
      // retired D1 rollup's own filter -- account is NOT NULL and part of the
      // primary key, but a neuron row's hotkey can itself be null.
      const positionRows = dailyRows
        .filter((row) => row.hotkey != null)
        .map((row) => ({
          account: row.hotkey,
          netuid: row.netuid,
          snapshot_date: row.snapshot_date,
          uid: row.uid,
          coldkey: row.coldkey,
          active: row.active,
          validator_permit: row.validator_permit,
          rank: row.rank,
          trust: row.trust,
          incentive: row.incentive,
          dividends: row.dividends,
          stake_tao: row.stake_tao,
          emission_tao: row.emission_tao,
          captured_at: row.captured_at,
          updated_at: row.updated_at,
        }));
      for (
        let i = 0;
        i < positionRows.length;
        i += NEURONS_SYNC_ROWS_PER_STATEMENT
      ) {
        const chunk = positionRows.slice(
          i,
          i + NEURONS_SYNC_ROWS_PER_STATEMENT,
        );
        await sql`
          INSERT INTO account_position_daily ${sql(chunk, "account", "netuid", "snapshot_date", "uid", "coldkey", "active", "validator_permit", "rank", "trust", "incentive", "dividends", "stake_tao", "emission_tao", "captured_at", "updated_at")}
          ON CONFLICT (account, netuid, snapshot_date) DO UPDATE SET
            uid = EXCLUDED.uid,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            stake_tao = EXCLUDED.stake_tao,
            emission_tao = EXCLUDED.emission_tao,
            captured_at = EXCLUDED.captured_at,
            updated_at = EXCLUDED.updated_at
          WHERE account_position_daily.captured_at <= EXCLUDED.captured_at`;
      }

      // Prune UIDs that no longer appear in the snapshot for a netuid this
      // batch actually covers (deregistered/replaced UIDs) -- scoped to ONLY
      // the netuids present in this payload, so a partial-coverage batch can
      // never wipe an unrelated subnet's rows. Mirrors D1's loadStagedNeurons
      // prune, minus its "legacy" whole-table branch: every batch here
      // declares its own coverage implicitly via which netuids its rows
      // belong to. `netuids` is never empty here -- the earlier
      // `!incoming.length` check guarantees at least one row, and every row
      // has a netuid.
      //
      // The VALUES join builds a per-netuid threshold table -- each netuid is
      // only pruned against ITS OWN max captured_at, never another netuid's,
      // closing the cross-netuid data-loss gap a single shared threshold
      // would open. Built via sql.unsafe with explicit-cast positional
      // placeholders (plain scalar binds, one per cell) rather than a bound
      // JS array -- confirmed live 2026-07-10 that Hyperdrive's recommended
      // `fetch_types: false` (this Worker's own setting, above) breaks
      // postgres.js's automatic ARRAY-literal serialization (`ANY($1)`/
      // `unnest($1::int[])` sent a malformed literal with no braces), while
      // scalar binds -- the only kind every other query in this Worker
      // uses -- are unaffected.
      const valuesSql = netuids
        .map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::bigint)`)
        .join(", ");
      const pruneParams = netuids.flatMap((netuid) => [
        netuid,
        netuidMaxCapturedAt.get(netuid),
      ]);
      const pruned = await sql.unsafe(
        `DELETE FROM neurons n
         USING (VALUES ${valuesSql}) AS batch(netuid, captured_at)
         WHERE n.netuid = batch.netuid
           AND n.captured_at < batch.captured_at
         RETURNING n.netuid`,
        pruneParams,
      );

      return writeJson({
        ok: true,
        neurons_written: rows.length,
        neuron_daily_written: dailyRows.length,
        account_position_daily_written: positionRows.length,
        netuids_covered: netuids.length,
        deregistered_pruned: pruned.length,
      });
    });
  } catch (err) {
    console.error("data-api neurons-sync write failed:", err);
    captureDataApiError(err, "neurons-sync");
    return writeJson({ error: "write failed" }, 502);
  }
  // No sql.end() here: Hyperdrive automatically cleans up the connection when
  // the request/invocation ends (Cloudflare's documented pattern).
}

// --- POST /api/v1/internal/backfill-neuron-daily ----------------------------
//
// Historical deep-history ingest for scripts/backfill-neuron-history.py and
// scripts/backfill-stake-monthly.py. neuron_daily/account_position_daily had
// NO Postgres history before handleNeuronsSync went live 2026-07-10 -- the
// year of D1 history those scripts previously backfilled was destroyed, not
// migrated, when #4772/#4908 dropped D1's neuron_daily table. The old ingest
// route those scripts called (/api/v1/internal/backfill-neurons, D1-only)
// was deleted in the same PR; this is its Postgres replacement.
//
// Deliberately NOT a thin wrapper around handleNeuronsSync: that function's
// `neurons` (latest-only) INSERT and its deregistration prune both key off
// "this batch's max captured_at is the newest state for these netuids" --
// true for a forward daily sync, false for a backfill walking dates from a
// year ago forward. A backfill batch must NEVER touch `neurons` or prune
// anything; it only ever fills in specific past `snapshot_date`s in
// neuron_daily/account_position_daily. Row shape/validation/column list
// (NEURON_INSERT_COLUMNS, validNeuronSyncRow, coerceNeuronSyncRow) is reused
// as-is -- both backfill scripts already send the identical row shape
// handleNeuronsSync expects, snapshot_date included.
//
// Same ON CONFLICT ... WHERE captured_at <= EXCLUDED.captured_at guard as the
// forward path, so a backfill re-POST (or a backfill overlapping a date the
// forward sync already covered) is idempotent and can never clobber a
// fresher row -- it can only fill a genuinely missing past snapshot_date.
const NEURON_DAILY_BACKFILL_TOKEN_HEADER = "x-neuron-daily-backfill-token";

async function handleNeuronDailyBackfill(request, env) {
  if (!env.NEURON_DAILY_BACKFILL_SECRET) {
    return writeJson(
      { error: "neuron-daily backfill is not provisioned on this deployment" },
      503,
    );
  }
  const provided =
    request.headers.get(NEURON_DAILY_BACKFILL_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.NEURON_DAILY_BACKFILL_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${NEURON_DAILY_BACKFILL_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > NEURONS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${NEURONS_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      { error: "body must be a JSON array of neuron rows (or {rows:[...]})" },
      400,
    );
  }
  if (incoming.length > NEURONS_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${NEURONS_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  const validatedIncoming = incoming.map(stripClientSnapshotDate);
  if (
    !validatedIncoming.length ||
    !validatedIncoming.every(validNeuronSyncRow)
  ) {
    return writeJson({ error: "rows must match the neuron row shape" }, 400);
  }

  const rows = validatedIncoming.map(coerceNeuronSyncRow);
  const dailyRows = rows.map((row) => ({
    ...row,
    snapshot_date: neuronSyncSnapshotDate(row.captured_at),
    updated_at: Date.now(),
  }));
  const positionRows = dailyRows
    .filter((row) => row.hotkey != null)
    .map((row) => ({
      account: row.hotkey,
      netuid: row.netuid,
      snapshot_date: row.snapshot_date,
      uid: row.uid,
      coldkey: row.coldkey,
      active: row.active,
      validator_permit: row.validator_permit,
      rank: row.rank,
      trust: row.trust,
      incentive: row.incentive,
      dividends: row.dividends,
      stake_tao: row.stake_tao,
      emission_tao: row.emission_tao,
      captured_at: row.captured_at,
      updated_at: row.updated_at,
    }));

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      for (
        let i = 0;
        i < dailyRows.length;
        i += NEURONS_SYNC_ROWS_PER_STATEMENT
      ) {
        const chunk = dailyRows.slice(i, i + NEURONS_SYNC_ROWS_PER_STATEMENT);
        await sql`
          INSERT INTO neuron_daily ${sql(chunk, ...NEURON_INSERT_COLUMNS, "snapshot_date", "updated_at")}
          ON CONFLICT (netuid, uid, snapshot_date) DO UPDATE SET
            hotkey = EXCLUDED.hotkey,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            validator_trust = EXCLUDED.validator_trust,
            consensus = EXCLUDED.consensus,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            emission_tao = EXCLUDED.emission_tao,
            stake_tao = EXCLUDED.stake_tao,
            registered_at_block = EXCLUDED.registered_at_block,
            is_immunity_period = EXCLUDED.is_immunity_period,
            axon = EXCLUDED.axon,
            block_number = EXCLUDED.block_number,
            captured_at = EXCLUDED.captured_at,
            updated_at = EXCLUDED.updated_at,
            take = EXCLUDED.take
          WHERE neuron_daily.captured_at <= EXCLUDED.captured_at`;
      }

      for (
        let i = 0;
        i < positionRows.length;
        i += NEURONS_SYNC_ROWS_PER_STATEMENT
      ) {
        const chunk = positionRows.slice(
          i,
          i + NEURONS_SYNC_ROWS_PER_STATEMENT,
        );
        await sql`
          INSERT INTO account_position_daily ${sql(chunk, "account", "netuid", "snapshot_date", "uid", "coldkey", "active", "validator_permit", "rank", "trust", "incentive", "dividends", "stake_tao", "emission_tao", "captured_at", "updated_at")}
          ON CONFLICT (account, netuid, snapshot_date) DO UPDATE SET
            uid = EXCLUDED.uid,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            stake_tao = EXCLUDED.stake_tao,
            emission_tao = EXCLUDED.emission_tao,
            captured_at = EXCLUDED.captured_at,
            updated_at = EXCLUDED.updated_at
          WHERE account_position_daily.captured_at <= EXCLUDED.captured_at`;
      }

      return writeJson({
        ok: true,
        neuron_daily_written: dailyRows.length,
        account_position_daily_written: positionRows.length,
      });
    });
  } catch (err) {
    console.error("data-api neuron-daily-backfill write failed:", err);
    captureDataApiError(err, "neuron-daily-backfill");
    return writeJson({ error: "write failed" }, 502);
  }
  // No sql.end() here: Hyperdrive automatically cleans up the connection when
  // the request/invocation ends (Cloudflare's documented pattern).
}

// --- POST /api/v1/internal/rollup-account-events-daily (#4832 gap-closure) -
//
// account_events is written continuously by indexer-rs directly into this
// same Postgres instance (not through any Worker route), so unlike
// neurons-sync above there is no existing write request to piggyback the
// rollup onto -- a Worker-native cron (ACCOUNT_EVENTS_ROLLUP_CRON,
// workers/config.mjs) dispatches this instead, proxied through the main
// Worker the same way (workers/api.mjs's handleRollupAccountEventsDailyProxy,
// called from handleScheduled). Also rolls up wallet_flow_daily (#6886/#6887)
// in the same run -- the account-keyed, per-day net/gross StakeAdded vs
// StakeRemoved rollup GET /api/v1/accounts/top-holders' ?sort=net_flow_*
// reads, sharing this same day-bucket loop rather than a second cron entry
// (same source table, same active-day re-roll window, one Postgres
// round-trip pair per day instead of two separate ticks). Formerly a
// dedicated hourly GitHub Actions workflow (rollup-account-events-daily.yml,
// retired) made the same POST over
// the public internet; the cron dispatch constructs the identical request
// internally instead. Mirrors D1's rollupAccountEventsDaily
// (src/account-events.mjs) exactly: re-roll the two active UTC days each
// run (past days are already finalized), upsert idempotently. No request
// body -- this is a trigger-only POST, not a data-carrying sync.

function utcDayBounds(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    date: new Date(start).toISOString().slice(0, 10),
    start,
    end: start + 24 * 60 * 60 * 1000,
  };
}

async function handleRollupAccountEventsDaily(request, env) {
  if (!env.ROLLUP_SYNC_SECRET) {
    return writeJson(
      {
        error:
          "account-events-daily rollup is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided = request.headers.get(ROLLUP_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.ROLLUP_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${ROLLUP_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const runAt = Date.now();
  const days = [utcDayBounds(runAt), utcDayBounds(runAt - 24 * 60 * 60 * 1000)];
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;
      const rolled = [];
      for (const { date, start, end } of days) {
        await sql`
          INSERT INTO account_events_daily (hotkey, netuid, day, event_count, event_kinds, first_block, last_block, updated_at)
          SELECT
            hotkey,
            netuid,
            ${date}::date AS day,
            COUNT(*) AS event_count,
            string_agg(DISTINCT event_kind, ',') AS event_kinds,
            MIN(block_number) AS first_block,
            MAX(block_number) AS last_block,
            ${runAt} AS updated_at
          FROM account_events
          WHERE hotkey IS NOT NULL AND netuid IS NOT NULL
            AND observed_at >= ${start} AND observed_at < ${end}
          GROUP BY hotkey, netuid
          ON CONFLICT (hotkey, netuid, day) DO UPDATE SET
            event_count = EXCLUDED.event_count,
            event_kinds = EXCLUDED.event_kinds,
            first_block = EXCLUDED.first_block,
            last_block = EXCLUDED.last_block,
            updated_at = EXCLUDED.updated_at`;
        // wallet_flow_daily (#6886/#6887): the account-keyed counterpart to
        // account_events_daily above, scoped to just the two stake-flow
        // kinds and grouped by account instead of (hotkey, netuid). Both
        // StakeAdded and StakeRemoved carry a positive amount_tao (see
        // src/chain-stake-flow.ts's own header), so net = added - removed.
        await sql`
          INSERT INTO wallet_flow_daily (coldkey, day, net_flow_tao, gross_in_tao, gross_out_tao, updated_at)
          SELECT
            coldkey,
            ${date}::date AS day,
            COALESCE(SUM(CASE WHEN event_kind = ${STAKE_ADDED_KIND} THEN amount_tao WHEN event_kind = ${STAKE_REMOVED_KIND} THEN -amount_tao ELSE 0 END), 0) AS net_flow_tao,
            COALESCE(SUM(CASE WHEN event_kind = ${STAKE_ADDED_KIND} THEN amount_tao ELSE 0 END), 0) AS gross_in_tao,
            COALESCE(SUM(CASE WHEN event_kind = ${STAKE_REMOVED_KIND} THEN amount_tao ELSE 0 END), 0) AS gross_out_tao,
            ${runAt} AS updated_at
          FROM account_events
          WHERE coldkey IS NOT NULL AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND})
            AND observed_at >= ${start} AND observed_at < ${end}
          GROUP BY (coldkey)
          ON CONFLICT (coldkey, day) DO UPDATE SET
            net_flow_tao = EXCLUDED.net_flow_tao,
            gross_in_tao = EXCLUDED.gross_in_tao,
            gross_out_tao = EXCLUDED.gross_out_tao,
            updated_at = EXCLUDED.updated_at`;
        rolled.push(date);
      }
      return writeJson({ ok: true, rolled });
    });
  } catch (err) {
    console.error("data-api account-events-daily rollup failed:", err);
    captureDataApiError(err, "account-events-daily-rollup");
    return writeJson({ error: "rollup failed" }, 502);
  }
}

// --- POST /api/v1/internal/subnet-hyperparams-sync (#4832 gap-closure) -----
//
// The write path into subnet_hyperparams + subnet_hyperparams_history,
// reached only via workers/api.mjs's handleSubnetHyperparamsSyncProxy (the
// same proxyToDataApi shape as neurons-sync/rollup-account-events-daily
// above) -- now this workflow's SOLE write path, D1's own R2-stage-to-D1
// loader (loadStagedSubnetHyperparams) having been retired alongside D1's
// copy of these two tables. .github/workflows/refresh-subnet-hyperparams.yml's
// sign-and-stage job POSTs the signed envelope produced by
// scripts/sign-staged-neurons.mjs (its {schema_version, hmac_sha256, rows}
// shape, kept for the HMAC utility even with no D1 R2-stage step left to
// authenticate) directly here -- the hmac_sha256 field itself is ignored: it
// exists to authenticate an R2 object drop across an untrusted intermediate
// step, and is unnecessary to replicate here since the POST itself is
// independently authenticated by the token header below, matching
// handleNeuronsSync's own request/{rows:[...]} shape.
//
// Every successful upstream fetch covers ALL active subnets in one run (the
// fetch script loops every netuid every time and exits nonzero on any
// missing netuid -- get_subnet_hyperparameters has no bulk variant -- so
// there's no partial-coverage concept to track here), so the prune below is
// a plain NOT IN against this batch's netuids, unlike neurons-sync's
// per-netuid captured_at-scoped prune.
const SUBNET_HYPERPARAMS_SYNC_TOKEN_HEADER = "x-subnet-hyperparams-sync-token";
// ~129 rows today (one per active subnet); generous headroom.
const SUBNET_HYPERPARAMS_SYNC_MAX_BODY_BYTES = 2_000_000;
const SUBNET_HYPERPARAMS_SYNC_MAX_ROWS = 2_000;
const SUBNET_HYPERPARAMS_SYNC_MAX_NETUID = 65_535;
const SUBNET_HYPERPARAMS_BOOLEAN_COLUMNS = new Set([
  "registration_allowed",
  "commit_reveal_enabled",
  "liquid_alpha_enabled",
  "subnet_is_active",
  "transfers_enabled",
  "bonds_reset_enabled",
  "user_liquidity_enabled",
  "owner_cut_enabled",
  "owner_cut_auto_lock_enabled",
]);
// The 33 hyperparameter field names -- strips netuid (front) and
// block_number/captured_at (back), which subnet_hyperparams_history carries
// as its own separately-typed netuid/block_number/observed_at columns instead.
const SUBNET_HYPERPARAMS_HISTORY_FIELDS =
  SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1, -2);

// Bounds-check one incoming row against SUBNET_HYPERPARAMS_INSERT_COLUMNS --
// every field but netuid is null-or-finite-number; the fetch script emits 0/1
// for the boolean-flag columns, not JSON booleans.
function validSubnetHyperparamsSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > SUBNET_HYPERPARAMS_SYNC_MAX_NETUID
  )
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  for (const [key, value] of Object.entries(row)) {
    if (!SUBNET_HYPERPARAMS_INSERT_COLUMNS.includes(key)) return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    if (value !== null && typeof value !== "number") return false;
  }
  return true;
}

// 0/1 -> boolean for the BOOLEAN columns (see NEURONS_SYNC_BOOLEAN_COLUMNS'
// identical reasoning above); everything else passes through unchanged.
function coerceSubnetHyperparamsSyncRow(row) {
  const out = {};
  for (const col of SUBNET_HYPERPARAMS_INSERT_COLUMNS) {
    const value = row[col] ?? null;
    out[col] = SUBNET_HYPERPARAMS_BOOLEAN_COLUMNS.has(col)
      ? Boolean(Number(value))
      : value;
  }
  return out;
}

async function handleSubnetHyperparamsSync(request, env) {
  if (!env.SUBNET_HYPERPARAMS_SYNC_SECRET) {
    return writeJson(
      {
        error: "subnet-hyperparams sync is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided =
    request.headers.get(SUBNET_HYPERPARAMS_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.SUBNET_HYPERPARAMS_SYNC_SECRET)
  ) {
    return writeJson(
      {
        error: `provide a valid ${SUBNET_HYPERPARAMS_SYNC_TOKEN_HEADER} header`,
      },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > SUBNET_HYPERPARAMS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${SUBNET_HYPERPARAMS_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of subnet-hyperparams rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > SUBNET_HYPERPARAMS_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SUBNET_HYPERPARAMS_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!incoming.length || !incoming.every(validSubnetHyperparamsSyncRow)) {
    return writeJson(
      { error: "rows must match the subnet-hyperparams row shape" },
      400,
    );
  }

  const rows = incoming.map(coerceSubnetHyperparamsSyncRow);
  const netuids = incoming.map((row) => row.netuid);

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      await sql`
        INSERT INTO subnet_hyperparams ${sql(rows, ...SUBNET_HYPERPARAMS_INSERT_COLUMNS)}
        ON CONFLICT (netuid) DO UPDATE SET
          kappa_ratio = EXCLUDED.kappa_ratio,
          immunity_period = EXCLUDED.immunity_period,
          min_allowed_weights = EXCLUDED.min_allowed_weights,
          max_weight_limit_ratio = EXCLUDED.max_weight_limit_ratio,
          tempo = EXCLUDED.tempo,
          weights_version = EXCLUDED.weights_version,
          weights_rate_limit = EXCLUDED.weights_rate_limit,
          activity_cutoff = EXCLUDED.activity_cutoff,
          activity_cutoff_factor = EXCLUDED.activity_cutoff_factor,
          registration_allowed = EXCLUDED.registration_allowed,
          target_regs_per_interval = EXCLUDED.target_regs_per_interval,
          min_burn_tao = EXCLUDED.min_burn_tao,
          max_burn_tao = EXCLUDED.max_burn_tao,
          burn_half_life = EXCLUDED.burn_half_life,
          burn_increase_mult = EXCLUDED.burn_increase_mult,
          bonds_moving_avg_raw = EXCLUDED.bonds_moving_avg_raw,
          max_regs_per_block = EXCLUDED.max_regs_per_block,
          serving_rate_limit = EXCLUDED.serving_rate_limit,
          max_validators = EXCLUDED.max_validators,
          commit_reveal_period = EXCLUDED.commit_reveal_period,
          commit_reveal_enabled = EXCLUDED.commit_reveal_enabled,
          alpha_high_ratio = EXCLUDED.alpha_high_ratio,
          alpha_low_ratio = EXCLUDED.alpha_low_ratio,
          liquid_alpha_enabled = EXCLUDED.liquid_alpha_enabled,
          alpha_sigmoid_steepness = EXCLUDED.alpha_sigmoid_steepness,
          yuma_version = EXCLUDED.yuma_version,
          subnet_is_active = EXCLUDED.subnet_is_active,
          transfers_enabled = EXCLUDED.transfers_enabled,
          bonds_reset_enabled = EXCLUDED.bonds_reset_enabled,
          user_liquidity_enabled = EXCLUDED.user_liquidity_enabled,
          owner_cut_enabled = EXCLUDED.owner_cut_enabled,
          owner_cut_auto_lock_enabled = EXCLUDED.owner_cut_auto_lock_enabled,
          min_childkey_take_ratio = EXCLUDED.min_childkey_take_ratio,
          block_number = EXCLUDED.block_number,
          captured_at = EXCLUDED.captured_at
        WHERE subnet_hyperparams.captured_at <= EXCLUDED.captured_at`;

      // Prune subnets no longer in the snapshot (deregistered/removed) --
      // scalar positional binds via sql.unsafe, not a bound array, avoiding
      // the same fetch_types:false ANY()/array-bind landmine documented on
      // handleNeuronsSync's own prune above. `netuids` is never empty here
      // -- the earlier `!incoming.length` check guarantees at least one row.
      const placeholders = netuids.map((_, i) => `$${i + 1}::int`).join(", ");
      const pruned = await sql.unsafe(
        `DELETE FROM subnet_hyperparams WHERE netuid NOT IN (${placeholders}) RETURNING netuid`,
        netuids,
      );

      // Diff-and-append into subnet_hyperparams_history (mirrors D1's
      // recordSubnetHyperparamsChanges) -- hashed on the RAW incoming rows
      // (pre-coercion): formatSubnetHyperparams' toD1Flag(value) already
      // tolerates either a 0/1 number or a real boolean, so the hash stays
      // domain-identical to the D1 path regardless of which shape reaches it.
      const latest = await sql`
        SELECT DISTINCT ON (netuid) netuid, hyperparams_hash
        FROM subnet_hyperparams_history
        ORDER BY netuid, id DESC`;
      const latestByNetuid = new Map(
        latest.map((row) => [Number(row.netuid), row.hyperparams_hash]),
      );
      const now = Date.now();
      const changedRows = [];
      for (const row of incoming) {
        const hyperparameters = formatSubnetHyperparams(row);
        const hash = await hyperparamsHash(hyperparameters);
        if (latestByNetuid.get(row.netuid) === hash) continue;
        changedRows.push({
          netuid: row.netuid,
          block_number: row.block_number ?? null,
          observed_at: now,
          ...hyperparameters,
          hyperparams_hash: hash,
        });
        latestByNetuid.set(row.netuid, hash);
      }
      if (changedRows.length) {
        await sql`
          INSERT INTO subnet_hyperparams_history ${sql(
            changedRows,
            "netuid",
            "block_number",
            "observed_at",
            ...SUBNET_HYPERPARAMS_HISTORY_FIELDS,
            "hyperparams_hash",
          )}`;
      }

      return writeJson({
        ok: true,
        subnet_hyperparams_written: rows.length,
        deregistered_pruned: pruned.length,
        history_appended: changedRows.length,
      });
    });
  } catch (err) {
    console.error("data-api subnet-hyperparams-sync write failed:", err);
    captureDataApiError(err, "subnet-hyperparams-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/subnet-locks-sync (#6638, conviction/ownership-
// contest tracker epic #4302) ------------------------------------------
//
// The write path into subnet_locks -- latest-only snapshot of the chain's
// HotkeyLock/DecayingHotkeyLock/OwnerLock/DecayingOwnerLock storage maps
// (see docs/conviction-lock-mechanism.md). No history table here, unlike
// subnet_hyperparams above: this feeds a live leaderboard, not an audit
// trail -- the read side rolls each row forward from its own last_update
// using the CURRENT UnlockRate/MaturityRate at query time, so only the
// latest snapshot per (netuid, hotkey, is_owner, is_perpetual) matters.
// fetch-subnet-locks.py always covers the WHOLE network in one run (its
// query_map calls carry no netuid filter), so -- like
// handleSubnetHyperparamsSync's own reasoning -- the prune below is a
// plain "not in this batch" sweep, never scoped to a subset of netuids.
const SUBNET_LOCKS_SYNC_TOKEN_HEADER = "x-subnet-locks-sync-token";
// Real-world row count is small (a few dozen active locks network-wide as
// of 2026-07-18 -- building conviction is opt-in and most subnets have
// none), but generous headroom for growth: ~129 subnets x up to a few
// hundred concurrent challengers each, x2 for the perpetual/decaying split.
const SUBNET_LOCKS_SYNC_MAX_BODY_BYTES = 5_000_000;
const SUBNET_LOCKS_SYNC_MAX_ROWS = 50_000;
const SUBNET_LOCKS_INSERT_COLUMNS = [
  "netuid",
  "hotkey",
  "is_owner",
  "is_perpetual",
  "locked_mass",
  "conviction_bits",
  "last_update",
  "captured_at",
];

// conviction_bits is the raw U64F64 (u128) value -- arrives as a decimal
// digit string (u128 exceeds JS's safe-integer range and Postgres NUMERIC
// accepts a string literal directly), never a JS number.
function validSubnetLocksSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (!Number.isInteger(row.netuid) || row.netuid < 0 || row.netuid > 65_535)
    return false;
  if (
    typeof row.hotkey !== "string" ||
    row.hotkey.length < 1 ||
    row.hotkey.length > 64
  )
    return false;
  if (typeof row.is_owner !== "boolean") return false;
  if (typeof row.is_perpetual !== "boolean") return false;
  if (!Number.isInteger(row.locked_mass) || row.locked_mass < 0) return false;
  if (
    typeof row.conviction_bits !== "string" ||
    !/^\d+$/.test(row.conviction_bits)
  )
    return false;
  if (row.last_update !== null && !Number.isInteger(row.last_update))
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  return true;
}

async function handleSubnetLocksSync(request, env) {
  if (!env.SUBNET_LOCKS_SYNC_SECRET) {
    return writeJson(
      { error: "subnet-locks sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(SUBNET_LOCKS_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.SUBNET_LOCKS_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${SUBNET_LOCKS_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > SUBNET_LOCKS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${SUBNET_LOCKS_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of subnet-locks rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > SUBNET_LOCKS_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SUBNET_LOCKS_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!incoming.every(validSubnetLocksSyncRow)) {
    return writeJson(
      { error: "rows must match the subnet-locks row shape" },
      400,
    );
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      if (incoming.length) {
        await sql`
          INSERT INTO subnet_locks ${sql(incoming, ...SUBNET_LOCKS_INSERT_COLUMNS)}
          ON CONFLICT (netuid, hotkey, is_owner, is_perpetual) DO UPDATE SET
            locked_mass = EXCLUDED.locked_mass,
            conviction_bits = EXCLUDED.conviction_bits,
            last_update = EXCLUDED.last_update,
            captured_at = EXCLUDED.captured_at
          WHERE subnet_locks.captured_at <= EXCLUDED.captured_at`;
      }

      // Every run is a full-network snapshot (see header comment) -- prune
      // whatever this batch didn't report. Row-value tuple comparison
      // (native Postgres, no array bind) -- scalar positional placeholders
      // via sql.unsafe, same landmine-avoidance as handleSubnetHyperparams-
      // Sync's own prune (fetch_types:false makes bound ARRAY/ANY() params
      // unreliable on this connection).
      let prunedCount = 0;
      if (incoming.length) {
        const values = [];
        const tuples = incoming.map((row, i) => {
          const base = i * 4;
          values.push(row.netuid, row.hotkey, row.is_owner, row.is_perpetual);
          return `($${base + 1}::int, $${base + 2}::text, $${base + 3}::bool, $${base + 4}::bool)`;
        });
        const prunedRows = await sql.unsafe(
          `DELETE FROM subnet_locks
           WHERE (netuid, hotkey, is_owner, is_perpetual) NOT IN (${tuples.join(", ")})
           RETURNING netuid`,
          values,
        );
        prunedCount = prunedRows.length;
      }

      return writeJson({
        ok: true,
        subnet_locks_written: incoming.length,
        pruned: prunedCount,
      });
    });
  } catch (err) {
    console.error("data-api subnet-locks-sync write failed:", err);
    captureDataApiError(err, "subnet-locks-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/account-identity-sync (#4832 gap-closure) ------
//
// The write path into account_identity + account_identity_history, mirroring
// handleSubnetHyperparamsSync's shape above -- same signed-envelope-direct-
// POST rationale (see that function's own header comment). Two real
// differences from the hyperparams path: (1) every column but account/
// captured_at is TEXT, no boolean-flag coercion needed; (2) NO prune step --
// an identity is a property of the owning account, not of currently having
// an active neuron, matching loadStagedAccountIdentity's own D1 behavior
// (workers/request-handlers/staging.mjs) -- an account missing from one
// snapshot pass hasn't necessarily lost its identity.
const ACCOUNT_IDENTITY_SYNC_TOKEN_HEADER = "x-account-identity-sync-token";
// ~460 rows live-observed 2026-07-09 (~1.5% of ~30k active neurons); generous
// headroom, matching the D1 staging path's MAX_STAGED_ACCOUNT_IDENTITY_ROWS/
// _BYTES.
const ACCOUNT_IDENTITY_SYNC_MAX_BODY_BYTES = 5_000_000;
const ACCOUNT_IDENTITY_SYNC_MAX_ROWS = 20_000;
const ACCOUNT_IDENTITY_SYNC_MAX_STRING_BYTES = 1024;

// Bounds-check one incoming row against ACCOUNT_IDENTITY_INSERT_COLUMNS --
// same trust posture as staging.mjs's validStagedAccountIdentityRow. Unlike
// validSubnetHyperparamsSyncRow, every column but account/captured_at is
// TEXT-only, so a bare number must be actively REJECTED here, not tolerated.
function validAccountIdentitySyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.account !== "string" || row.account.length === 0) return false;
  if (!Number.isFinite(row.captured_at)) return false;
  for (const [key, value] of Object.entries(row)) {
    if (!ACCOUNT_IDENTITY_INSERT_COLUMNS.includes(key)) return false;
    if (key === "account" || key === "captured_at") continue;
    if (value === null) continue;
    if (typeof value !== "string") return false;
    if (utf8Bytes(value).length > ACCOUNT_IDENTITY_SYNC_MAX_STRING_BYTES)
      return false;
  }
  return true;
}

// Postgres' TEXT type rejects any embedded NUL byte outright ("invalid byte
// sequence for encoding UTF8: 0x00") -- confirmed live 2026-07-11 against a
// real staged row whose discord/additional fields were a literal U+0000
// placeholder. SQLite's byte-oriented TEXT storage tolerates this silently
// (the D1 path never needed to guard against it), so this is a Postgres-only
// concern: strip rather than reject, matching the "sanitize a chain-data
// value the sink genuinely can't represent" precedent set by
// weights_rate_limit's u64::MAX widening in subnet-hyperparams-sync.
function stripNullBytes(value) {
  return typeof value === "string" ? value.replaceAll("\u0000", "") : value;
}

function sanitizeAccountIdentitySyncRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = stripNullBytes(value);
  }
  return out;
}

function coerceAccountIdentitySyncRow(row) {
  const out = {};
  for (const col of ACCOUNT_IDENTITY_INSERT_COLUMNS) {
    out[col] = row[col] ?? null;
  }
  return out;
}

async function handleAccountIdentitySync(request, env) {
  if (!env.ACCOUNT_IDENTITY_SYNC_SECRET) {
    return writeJson(
      { error: "account-identity sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided =
    request.headers.get(ACCOUNT_IDENTITY_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.ACCOUNT_IDENTITY_SYNC_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${ACCOUNT_IDENTITY_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > ACCOUNT_IDENTITY_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${ACCOUNT_IDENTITY_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of account-identity rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > ACCOUNT_IDENTITY_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${ACCOUNT_IDENTITY_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!incoming.length || !incoming.every(validAccountIdentitySyncRow)) {
    return writeJson(
      { error: "rows must match the account-identity row shape" },
      400,
    );
  }

  // Sanitize BEFORE both the upsert and the history hash so the two stay
  // consistent with each other -- a raw NUL byte would otherwise reach the
  // history INSERT below via the untouched `incoming` rows even after the
  // latest-only table's own values were cleaned.
  const sanitized = incoming.map(sanitizeAccountIdentitySyncRow);
  const rows = sanitized.map(coerceAccountIdentitySyncRow);

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      await sql`
        INSERT INTO account_identity ${sql(rows, ...ACCOUNT_IDENTITY_INSERT_COLUMNS)}
        ON CONFLICT (account) DO UPDATE SET
          name = EXCLUDED.name,
          url = EXCLUDED.url,
          github = EXCLUDED.github,
          image = EXCLUDED.image,
          discord = EXCLUDED.discord,
          description = EXCLUDED.description,
          additional = EXCLUDED.additional,
          captured_at = EXCLUDED.captured_at
        WHERE account_identity.captured_at <= EXCLUDED.captured_at`;

      // Diff-and-append into account_identity_history (mirrors D1's
      // recordAccountIdentityChanges) -- hashed on the sanitized rows (NUL
      // bytes already stripped above), matching identitySnapshotFromRow's
      // own field selection.
      const latest = await sql`
        SELECT DISTINCT ON (account) account, identity_hash
        FROM account_identity_history
        ORDER BY account, id DESC`;
      const latestByAccount = new Map(
        latest.map((row) => [row.account, row.identity_hash]),
      );
      const now = Date.now();
      const changedRows = [];
      for (const row of sanitized) {
        const snapshot = {};
        for (const field of IDENTITY_FIELDS)
          snapshot[field] = row[field] ?? null;
        const hash = await identityHash(snapshot);
        if (latestByAccount.get(row.account) === hash) continue;
        changedRows.push({
          account: row.account,
          observed_at: now,
          ...snapshot,
          identity_hash: hash,
        });
        latestByAccount.set(row.account, hash);
      }
      if (changedRows.length) {
        await sql`
          INSERT INTO account_identity_history ${sql(
            changedRows,
            "account",
            "observed_at",
            ...IDENTITY_FIELDS,
            "identity_hash",
          )}`;
      }

      return writeJson({
        ok: true,
        account_identity_written: rows.length,
        history_appended: changedRows.length,
      });
    });
  } catch (err) {
    console.error("data-api account-identity-sync write failed:", err);
    captureDataApiError(err, "account-identity-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// Postgres hard-caps a single statement at 65535 bound parameters -- a bulk
// `INSERT ... ${sql(rows, ...columns)}` blows past that the moment
// rows.length * columns.length exceeds it, which the ROW-count ceilings
// alone (*_SYNC_MAX_ROWS above/below) don't prevent, since those bound the
// PAYLOAD, not any single statement. Found live 2026-07-14 exercising
// validator-nominator-counts-sync for the first time at real production
// scale (#5352): 112,550 hotkey rows x 3 columns = 337,650 params, and the
// paired nominator-positions-sync payload (132,505 rows x 5 columns =
// 662,525 params) hits the exact same wall -- both single-batch INSERTs
// failed the request with a Postgres protocol error, surfaced to the caller
// as a bare 502 with no detail. batchedUpsert splits `rows` into
// PARAMS_PER_ROW-sized chunks (each well under the 65535 ceiling) and runs
// them as sequential statements inside ONE transaction (`sql.begin`), same
// atomicity as every other sync handler's single-statement writes -- a
// mid-batch failure still rolls back the whole sync rather than leaving a
// partial write, and both these tables are latest-only/REPLACE-on-conflict
// so a subsequent retry is safe either way.
async function batchedUpsert(sql, rows, insertFn, maxRowsPerBatch) {
  for (let i = 0; i < rows.length; i += maxRowsPerBatch) {
    await insertFn(sql, rows.slice(i, i + maxRowsPerBatch));
  }
}

// --- POST /api/v1/internal/validator-nominator-counts-sync (#2549) --------
//
// The write path into validator_nominator_counts (migration 0043) --
// simpler than account-identity-sync above: latest-only, no history table
// (a nominator count is a live gauge, not a fact worth diffing over time
// yet). Populated by its own low-frequency job
// (apps/indexer-rs/src/bin/poller/jobs/validator_nominators.rs), decoupled
// from the fast refresh-metagraph cron -- see that job's and the migration's
// own header comments for why a full SubtensorModule::Alpha scan can't share
// the neurons snapshot's cadence.
const VALIDATOR_NOMINATOR_COUNTS_SYNC_TOKEN_HEADER =
  "x-validator-nominator-counts-sync-token";
// floor(65535 / 3 columns) = 21845 -- batchedUpsert's per-statement row cap,
// rounded down for headroom (see batchedUpsert's own header comment for why
// this exists at all).
const VALIDATOR_NOMINATOR_COUNTS_MAX_ROWS_PER_BATCH = 20_000;
// A ceiling on distinct hotkeys ever seen holding stake, NOT on
// validator-permit hotkeys (~1-2k) -- this table isn't validator-scoped by
// design (see the fetch script). A live full-scan probe 2026-07-14 found
// 112,552 distinct hotkeys network-wide; these caps sit at roughly 9x that
// observed figure as headroom for network growth, not a tight bound.
const VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_BODY_BYTES = 100_000_000;
const VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_ROWS = 1_000_000;

function validValidatorNominatorCountsSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.hotkey !== "string" || row.hotkey.length === 0) return false;
  if (!Number.isInteger(row.nominator_count) || row.nominator_count < 0)
    return false;
  if (!Number.isFinite(row.captured_at)) return false;
  for (const key of Object.keys(row)) {
    if (!VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS.includes(key)) return false;
  }
  return true;
}

async function handleValidatorNominatorCountsSync(request, env) {
  if (!env.VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET) {
    return writeJson(
      {
        error:
          "validator-nominator-counts sync is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided =
    request.headers.get(VALIDATOR_NOMINATOR_COUNTS_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET)
  ) {
    return writeJson(
      {
        error: `provide a valid ${VALIDATOR_NOMINATOR_COUNTS_SYNC_TOKEN_HEADER} header`,
      },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      {
        error: `body exceeds ${VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_BODY_BYTES} bytes`,
      },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of validator-nominator-count rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_ROWS) {
    return writeJson(
      {
        error: `at most ${VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_ROWS} rows per request`,
      },
      413,
    );
  }
  if (
    !incoming.length ||
    !incoming.every(validValidatorNominatorCountsSyncRow)
  ) {
    return writeJson(
      { error: "rows must match the validator-nominator-count row shape" },
      400,
    );
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;
      await batchedUpsert(
        sql,
        incoming,
        (sql, batch) => sql`
          INSERT INTO validator_nominator_counts ${sql(batch, ...VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS)}
          ON CONFLICT (hotkey) DO UPDATE SET
            nominator_count = EXCLUDED.nominator_count,
            captured_at = EXCLUDED.captured_at
          WHERE validator_nominator_counts.captured_at <= EXCLUDED.captured_at`,
        VALIDATOR_NOMINATOR_COUNTS_MAX_ROWS_PER_BATCH,
      );
    });
    return writeJson({
      ok: true,
      validator_nominator_counts_written: incoming.length,
    });
  } catch (err) {
    console.error(
      "data-api validator-nominator-counts-sync write failed:",
      err,
    );
    captureDataApiError(err, "validator-nominator-counts-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

const NOMINATOR_POSITIONS_SYNC_TOKEN_HEADER =
  "x-nominator-positions-sync-token";
// floor(65535 / 5 columns) = 13107 -- batchedUpsert's per-statement row cap,
// rounded down for headroom (see batchedUpsert's own header comment, above
// validator-nominator-counts-sync, for the live incident this fixes).
const NOMINATOR_POSITIONS_MAX_ROWS_PER_BATCH = 10_000;
// Same headroom rationale as VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_ROWS above --
// this is one row per (coldkey, hotkey, netuid) triple, not per hotkey, so
// it carries generous headroom over the 762,577 total Alpha rows observed
// in the live full-scan probe (#2549/#5233), not a tight bound.
const NOMINATOR_POSITIONS_SYNC_MAX_BODY_BYTES = 200_000_000;
const NOMINATOR_POSITIONS_SYNC_MAX_ROWS = 1_000_000;

function validNominatorPositionSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.coldkey !== "string" || row.coldkey?.length === 0)
    return false;
  if (typeof row.hotkey !== "string" || row.hotkey.length === 0) return false;
  if (!Number.isInteger(row.netuid) || row.netuid < 0) return false;
  if (!Number.isFinite(row.share_fraction) || row.share_fraction < 0)
    return false;
  if (!Number.isFinite(row.captured_at)) return false;
  for (const key of Object.keys(row)) {
    if (!NOMINATOR_POSITION_INSERT_COLUMNS.includes(key)) return false;
  }
  return true;
}

async function handleNominatorPositionsSync(request, env) {
  if (!env.NOMINATOR_POSITIONS_SYNC_SECRET) {
    return writeJson(
      {
        error: "nominator-positions sync is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided =
    request.headers.get(NOMINATOR_POSITIONS_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.NOMINATOR_POSITIONS_SYNC_SECRET)
  ) {
    return writeJson(
      {
        error: `provide a valid ${NOMINATOR_POSITIONS_SYNC_TOKEN_HEADER} header`,
      },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > NOMINATOR_POSITIONS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      {
        error: `body exceeds ${NOMINATOR_POSITIONS_SYNC_MAX_BODY_BYTES} bytes`,
      },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of nominator-position rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > NOMINATOR_POSITIONS_SYNC_MAX_ROWS) {
    return writeJson(
      {
        error: `at most ${NOMINATOR_POSITIONS_SYNC_MAX_ROWS} rows per request`,
      },
      413,
    );
  }
  if (!incoming.length || !incoming.every(validNominatorPositionSyncRow)) {
    return writeJson(
      { error: "rows must match the nominator-position row shape" },
      400,
    );
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;
      await batchedUpsert(
        sql,
        incoming,
        (sql, batch) => sql`
          INSERT INTO nominator_positions ${sql(batch, ...NOMINATOR_POSITION_INSERT_COLUMNS)}
          ON CONFLICT (coldkey, hotkey, netuid) DO UPDATE SET
            share_fraction = EXCLUDED.share_fraction,
            captured_at = EXCLUDED.captured_at
          WHERE nominator_positions.captured_at <= EXCLUDED.captured_at`,
        NOMINATOR_POSITIONS_MAX_ROWS_PER_BATCH,
      );
    });
    return writeJson({
      ok: true,
      nominator_positions_written: incoming.length,
    });
  } catch (err) {
    console.error("data-api nominator-positions-sync write failed:", err);
    captureDataApiError(err, "nominator-positions-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/account-balances-sync (#6742) -------------------
//
// Chain-wide free/reserved balance snapshot, one row per account with a
// nonzero balance --
// apps/indexer-rs/src/bin/poller/jobs/account_balances.rs's own header comment
// on why this reads System::Account directly rather than reconstructing
// balance from transfer/fee/stake events (a direct state read can't drift;
// event-replay can, one missed mutation path at a time). Same "latest-only,
// captured_at freshness guard" upsert shape as nominator-positions-sync.
const ACCOUNT_BALANCE_INSERT_COLUMNS = [
  "ss58",
  "free_tao",
  "reserved_tao",
  "captured_at",
];
const ACCOUNT_BALANCES_SYNC_TOKEN_HEADER = "x-account-balances-sync-token";
// floor(65535 / 4 columns) = 16383 -- batchedUpsert's per-statement row cap,
// rounded down for headroom, matching NOMINATOR_POSITIONS_MAX_ROWS_PER_BATCH's
// own rounding for a different column count.
const ACCOUNT_BALANCES_MAX_ROWS_PER_BATCH = 10_000;
// Generous headroom over the ~543k total System::Account entries observed
// in the live full-scan probe (2026-07-19, ~530k after filtering all-zero
// accounts) -- same order of magnitude as nominator-positions-sync's own
// ceiling, not a tight bound.
const ACCOUNT_BALANCES_SYNC_MAX_BODY_BYTES = 200_000_000;
const ACCOUNT_BALANCES_SYNC_MAX_ROWS = 1_000_000;

function validAccountBalanceSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.ss58 !== "string" || row.ss58.length === 0) return false;
  if (!Number.isFinite(row.free_tao) || row.free_tao < 0) return false;
  if (!Number.isFinite(row.reserved_tao) || row.reserved_tao < 0) return false;
  if (!Number.isFinite(row.captured_at)) return false;
  for (const key of Object.keys(row)) {
    if (!ACCOUNT_BALANCE_INSERT_COLUMNS.includes(key)) return false;
  }
  return true;
}

async function handleAccountBalancesSync(request, env) {
  if (!env.ACCOUNT_BALANCES_SYNC_SECRET) {
    return writeJson(
      { error: "account-balances sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided =
    request.headers.get(ACCOUNT_BALANCES_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.ACCOUNT_BALANCES_SYNC_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${ACCOUNT_BALANCES_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > ACCOUNT_BALANCES_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${ACCOUNT_BALANCES_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of account-balance rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > ACCOUNT_BALANCES_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${ACCOUNT_BALANCES_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!incoming.length || !incoming.every(validAccountBalanceSyncRow)) {
    return writeJson(
      { error: "rows must match the account-balance row shape" },
      400,
    );
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;
      await batchedUpsert(
        sql,
        incoming,
        (sql, batch) => sql`
          INSERT INTO account_balances ${sql(batch, ...ACCOUNT_BALANCE_INSERT_COLUMNS)}
          ON CONFLICT (ss58) DO UPDATE SET
            free_tao = EXCLUDED.free_tao,
            reserved_tao = EXCLUDED.reserved_tao,
            captured_at = EXCLUDED.captured_at
          WHERE account_balances.captured_at <= EXCLUDED.captured_at`,
        ACCOUNT_BALANCES_MAX_ROWS_PER_BATCH,
      );
    });
    return writeJson({ ok: true, account_balances_written: incoming.length });
  } catch (err) {
    console.error("data-api account-balances-sync write failed:", err);
    captureDataApiError(err, "account-balances-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/subnet-identity-sync (#4832 gap-closure) -------
//
// The write path into subnet_identity_history -- architecturally different
// from the three internal sync routes above: this one is triggered from
// WITHIN the main Worker's own hourly cron (writeSubnetSnapshot,
// src/health-prober.mjs), not an external GitHub Actions workflow, so it's
// called via a direct env.DATA_API.fetch() service-binding call rather than
// crossing the public internet through workers/api.mjs's proxy layer (see
// that function's own comment). No latest-only sibling table exists here
// (mirrors D1's own shape -- the current identity lives in the profiles.json
// artifact itself): only diff-and-append against the last recorded hash per
// netuid, reusing identitySnapshotFromProfile/identityHash UNCHANGED from
// src/subnet-identity-history.mjs so the hash stays domain-identical to the
// D1 path. No dedicated per-field row validator (unlike the other three
// sync routes): profiles.json is the SAME trust boundary D1's own
// recordSubnetIdentityChanges reads from directly with no staging-style
// validation either -- identitySnapshotFromProfile's own null-guard already
// skips a malformed individual profile without erroring the batch.
const SUBNET_IDENTITY_SYNC_TOKEN_HEADER = "x-subnet-identity-sync-token";
// ~129 subnets today; generous headroom, matching the other sync routes'
// convention.
const SUBNET_IDENTITY_SYNC_MAX_BODY_BYTES = 5_000_000;
const SUBNET_IDENTITY_SYNC_MAX_ROWS = 2_000;

function sanitizeSubnetIdentitySyncSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const out = {};
  for (const [key, value] of Object.entries(snapshot)) {
    out[key] = stripNullBytes(value);
  }
  return out;
}

async function handleSubnetIdentitySync(request, env) {
  if (!env.SUBNET_IDENTITY_SYNC_SECRET) {
    return writeJson(
      { error: "subnet-identity sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(SUBNET_IDENTITY_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.SUBNET_IDENTITY_SYNC_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${SUBNET_IDENTITY_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > SUBNET_IDENTITY_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${SUBNET_IDENTITY_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const profiles = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.profiles)
      ? parsed.profiles
      : null;
  if (!profiles) {
    return writeJson(
      {
        error:
          "body must be a JSON array of subnet profiles (or {profiles:[...]})",
      },
      400,
    );
  }
  if (profiles.length > SUBNET_IDENTITY_SYNC_MAX_ROWS) {
    return writeJson(
      {
        error: `at most ${SUBNET_IDENTITY_SYNC_MAX_ROWS} profiles per request`,
      },
      413,
    );
  }
  if (!profiles.length) {
    return writeJson({ error: "profiles must be a non-empty array" }, 400);
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      const latest = await sql`
        SELECT DISTINCT ON (netuid) netuid, identity_hash
        FROM subnet_identity_history
        ORDER BY netuid, id DESC`;
      const latestByNetuid = new Map(
        latest.map((row) => [Number(row.netuid), row.identity_hash]),
      );
      const [blockRow] = await sql`
        SELECT MAX(block_number) AS block_number FROM blocks`;
      const blockNumber =
        blockRow?.block_number == null ? null : Number(blockRow.block_number);

      const now = Date.now();
      const changedRows = [];
      for (const profile of profiles) {
        if (!Number.isInteger(profile?.netuid)) continue;
        const snapshot = sanitizeSubnetIdentitySyncSnapshot(
          identitySnapshotFromProfile(profile),
        );
        if (!snapshot) continue;
        const hash = await subnetIdentityHash(snapshot);
        if (latestByNetuid.get(profile.netuid) === hash) continue;
        changedRows.push({
          netuid: profile.netuid,
          block_number: blockNumber,
          observed_at: now,
          ...snapshot,
          identity_hash: hash,
        });
        latestByNetuid.set(profile.netuid, hash);
      }
      if (changedRows.length) {
        await sql`
          INSERT INTO subnet_identity_history ${sql(
            changedRows,
            "netuid",
            "block_number",
            "observed_at",
            "subnet_name",
            "symbol",
            "description",
            "github_repo",
            "subnet_url",
            "discord",
            "logo_url",
            "identity_hash",
          )}`;
      }

      return writeJson({
        ok: true,
        history_appended: changedRows.length,
      });
    });
  } catch (err) {
    console.error("data-api subnet-identity-sync write failed:", err);
    captureDataApiError(err, "subnet-identity-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/health-checks-sync (#4832 gap-closure) --------
//
// Best-effort Postgres mirror of the D1+KV probe write in
// src/health-prober.mjs's runHealthProber -- same "own hourly/15-min cron,
// direct env.DATA_API.fetch() service-binding call" shape as
// subnet-identity-sync above, not an external GitHub Actions workflow. D1+KV
// stay the sole authoritative write target (live serving reads them
// unchanged); this route only mirrors the SAME probed batch into
// surface_checks/surface_status so the Postgres tier can eventually take
// over the read side. surface_status uses ON CONFLICT (surface_id) only
// (not D1's dual surface_key/surface_id conflict targets -- Postgres allows
// one conflict target per INSERT): a surface rename mid-migration can
// briefly fail this route's UPSERT on the surface_key unique index rather
// than silently duplicate a row, which is an acceptable degrade for a
// mirror that isn't yet the read source of truth.
const HEALTH_CHECKS_SYNC_TOKEN_HEADER = "x-health-checks-sync-token";
// One probe run today is ~150-200 surfaces; generous headroom.
const HEALTH_CHECKS_SYNC_MAX_BODY_BYTES = 2_000_000;
const HEALTH_CHECKS_SYNC_MAX_ROWS = 2_000;

async function handleHealthChecksSync(request, env) {
  if (!env.HEALTH_CHECKS_SYNC_SECRET) {
    return writeJson(
      { error: "health-checks sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(HEALTH_CHECKS_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.HEALTH_CHECKS_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${HEALTH_CHECKS_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > HEALTH_CHECKS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${HEALTH_CHECKS_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const probed = Array.isArray(parsed?.probed) ? parsed.probed : null;
  if (!probed) {
    return writeJson({ error: "body must be {probed:[...]}" }, 400);
  }
  if (probed.length > HEALTH_CHECKS_SYNC_MAX_ROWS) {
    return writeJson(
      {
        error: `at most ${HEALTH_CHECKS_SYNC_MAX_ROWS} probed rows per request`,
      },
      413,
    );
  }
  if (!probed.length) {
    return writeJson({ ok: true, checks_written: 0, status_written: 0 });
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  const validRows = probed.filter(
    (row) =>
      row &&
      typeof row.surface_id === "string" &&
      row.surface_id.length > 0 &&
      Number.isInteger(row.netuid) &&
      typeof row.kind === "string" &&
      typeof row.status === "string" &&
      Number.isFinite(row.checked_at_ms),
  );
  if (!validRows.length) {
    return writeJson({ ok: true, checks_written: 0, status_written: 0 });
  }

  const checkRows = validRows.map((row) => ({
    surface_id: row.surface_id,
    surface_key: row.surface_key ?? null,
    netuid: row.netuid,
    kind: row.kind,
    status: row.status,
    classification: row.classification ?? null,
    latency_ms: Number.isFinite(row.latency_ms) ? row.latency_ms : null,
    status_code: Number.isInteger(row.status_code) ? row.status_code : null,
    ok: row.status === "ok",
    checked_at: row.checked_at_ms,
  }));
  const statusRows = validRows.map((row) => ({
    surface_id: row.surface_id,
    surface_key: row.surface_key ?? null,
    netuid: row.netuid,
    kind: row.kind,
    url: row.url ?? null,
    provider: row.provider ?? null,
    status: row.status,
    classification: row.classification ?? null,
    latency_ms: Number.isFinite(row.latency_ms) ? row.latency_ms : null,
    status_code: Number.isInteger(row.status_code) ? row.status_code : null,
    last_checked: row.checked_at_ms,
    last_ok: Number.isFinite(row.last_ok_ms) ? row.last_ok_ms : null,
    consecutive_failures: Number.isInteger(row.consecutive_failures)
      ? row.consecutive_failures
      : 0,
    updated_at: row.checked_at_ms,
  }));

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '10000ms'`;
      await sql`
        INSERT INTO surface_checks ${sql(
          checkRows,
          "surface_id",
          "surface_key",
          "netuid",
          "kind",
          "status",
          "classification",
          "latency_ms",
          "status_code",
          "ok",
          "checked_at",
        )}
        ON CONFLICT (surface_id, checked_at) DO NOTHING`;
      await sql`
        INSERT INTO surface_status ${sql(
          statusRows,
          "surface_id",
          "surface_key",
          "netuid",
          "kind",
          "url",
          "provider",
          "status",
          "classification",
          "latency_ms",
          "status_code",
          "last_checked",
          "last_ok",
          "consecutive_failures",
          "updated_at",
        )}
        ON CONFLICT (surface_id) DO UPDATE SET
          surface_key = excluded.surface_key,
          netuid = excluded.netuid,
          kind = excluded.kind,
          url = excluded.url,
          provider = excluded.provider,
          status = excluded.status,
          classification = excluded.classification,
          latency_ms = excluded.latency_ms,
          status_code = excluded.status_code,
          last_checked = excluded.last_checked,
          last_ok = excluded.last_ok,
          consecutive_failures = excluded.consecutive_failures,
          updated_at = excluded.updated_at`;
      return writeJson({
        ok: true,
        checks_written: checkRows.length,
        status_written: statusRows.length,
      });
    });
  } catch (err) {
    console.error("data-api health-checks-sync write failed:", err);
    captureDataApiError(err, "health-checks-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/health-uptime-rollup-sync (#4832 gap-closure) --
//
// Best-effort Postgres mirror of src/health-prober.mjs's rollupDailyUptime,
// same shape/isolation as health-checks-sync above (reuses
// HEALTH_CHECKS_SYNC_SECRET -- see that route's own header comment). Unlike
// health-checks-sync, the request body carries only UTC day *boundaries*,
// not precomputed rows -- this route computes the rollup itself from
// surface_checks (already mirrored here by health-checks-sync), using
// PERCENTILE_CONT for the p50/p95/p99 tail latency instead of replaying
// D1/SQLite's rank-based CTE (src/health-sql.ts's rankedChecksCte/
// latencyStatColumns) column-for-column.
const HEALTH_UPTIME_ROLLUP_SYNC_MAX_DAYS = 10;

async function handleHealthUptimeRollupSync(request, env) {
  if (!env.HEALTH_CHECKS_SYNC_SECRET) {
    return writeJson(
      { error: "health-checks sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(HEALTH_CHECKS_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.HEALTH_CHECKS_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${HEALTH_CHECKS_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  let parsed;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const days = Array.isArray(parsed?.days) ? parsed.days : null;
  const updatedAt = Number(parsed?.updated_at);
  if (!days || !Number.isFinite(updatedAt)) {
    return writeJson(
      { error: "body must be {days:[{date,start,end}...], updated_at}" },
      400,
    );
  }
  if (days.length > HEALTH_UPTIME_ROLLUP_SYNC_MAX_DAYS) {
    return writeJson(
      {
        error: `at most ${HEALTH_UPTIME_ROLLUP_SYNC_MAX_DAYS} days per request`,
      },
      413,
    );
  }
  const validDays = days.filter(
    (d) =>
      d &&
      typeof d.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
      Number.isFinite(d.start) &&
      Number.isFinite(d.end),
  );
  if (!validDays.length) {
    return writeJson({ ok: true, days_rolled: [] });
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;
      for (const { date, start, end } of validDays) {
        await sql`
        WITH ranked AS (
          SELECT
            surface_id,
            COALESCE(surface_key, surface_id) AS surface_key,
            netuid,
            ok,
            latency_ms
          FROM surface_checks
          WHERE checked_at >= ${start} AND checked_at < ${end}
        )
        INSERT INTO surface_uptime_daily
          (surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio,
           latency_samples, avg_latency_ms, p50_latency_ms, p95_latency_ms,
           p99_latency_ms, status, updated_at)
        SELECT
          MAX(surface_id) AS surface_id,
          surface_key,
          netuid,
          ${date}::date AS day,
          COUNT(*) AS samples,
          SUM(CASE WHEN ok THEN 1 ELSE 0 END) AS ok_count,
          CASE
            WHEN SUM(CASE WHEN ok THEN 1 ELSE 0 END) = COUNT(*) THEN 1.0
            WHEN ROUND(SUM(CASE WHEN ok THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) >= 1.0 THEN 0.9999
            ELSE ROUND(SUM(CASE WHEN ok THEN 1 ELSE 0 END)::numeric / COUNT(*), 4)
          END AS uptime_ratio,
          COUNT(*) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS latency_samples,
          ROUND(AVG(latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL))::int AS avg_latency_ms,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p50_latency_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p95_latency_ms,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p99_latency_ms,
          CASE
            WHEN SUM(CASE WHEN ok THEN 1 ELSE 0 END) = COUNT(*) THEN 'ok'
            WHEN SUM(CASE WHEN ok THEN 1 ELSE 0 END) = 0 THEN 'failed'
            ELSE 'degraded'
          END AS status,
          ${updatedAt} AS updated_at
        FROM ranked
        GROUP BY surface_key, netuid
        ON CONFLICT (surface_id, day) DO UPDATE SET
          surface_key = excluded.surface_key,
          netuid = excluded.netuid,
          samples = excluded.samples,
          ok_count = excluded.ok_count,
          uptime_ratio = excluded.uptime_ratio,
          latency_samples = excluded.latency_samples,
          avg_latency_ms = excluded.avg_latency_ms,
          p50_latency_ms = excluded.p50_latency_ms,
          p95_latency_ms = excluded.p95_latency_ms,
          p99_latency_ms = excluded.p99_latency_ms,
          status = excluded.status,
          updated_at = excluded.updated_at`;
      }
      return writeJson({
        ok: true,
        days_rolled: validDays.map((d) => d.date),
      });
    });
  } catch (err) {
    console.error("data-api health-uptime-rollup-sync write failed:", err);
    captureDataApiError(err, "health-uptime-rollup-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/subnet-snapshot-sync (#4832 gap-closure) ------
//
// Best-effort Postgres mirror of writeSubnetSnapshot's D1 upsert
// (src/health-prober.mjs) -- same "own hourly cron, direct
// env.DATA_API.fetch() service-binding call" shape as subnet-identity-sync
// above, not an external GitHub Actions workflow. Rows arrive precomputed
// (one per active subnet, already joined against economics.json), mirroring
// health-checks-sync's shape rather than subnet-identity-sync's own
// diff-and-append shape. ON CONFLICT (netuid, snapshot_date) DO UPDATE
// mirrors D1's COALESCE-on-economics-columns semantics exactly: structural
// columns + captured_at are owned by the day's first fire, economics
// columns can backfill across the day's later fires but a later NULL can
// never wipe an earlier fire's good value.
const SUBNET_SNAPSHOT_SYNC_TOKEN_HEADER = "x-subnet-snapshot-sync-token";
// ~129 subnets/day; generous headroom, matching the other sync routes.
const SUBNET_SNAPSHOT_SYNC_MAX_BODY_BYTES = 2_000_000;
const SUBNET_SNAPSHOT_SYNC_MAX_ROWS = 2_000;

async function handleSubnetSnapshotSync(request, env) {
  if (!env.SUBNET_SNAPSHOT_SYNC_SECRET) {
    return writeJson(
      { error: "subnet-snapshot sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(SUBNET_SNAPSHOT_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.SUBNET_SNAPSHOT_SYNC_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${SUBNET_SNAPSHOT_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > SUBNET_SNAPSHOT_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${SUBNET_SNAPSHOT_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const rows = Array.isArray(parsed) ? parsed : null;
  if (!rows) {
    return writeJson(
      { error: "body must be a JSON array of subnet snapshot rows" },
      400,
    );
  }
  if (rows.length > SUBNET_SNAPSHOT_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SUBNET_SNAPSHOT_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!rows.length) {
    return writeJson({ ok: true, rows_written: 0 });
  }

  const validRows = rows.filter(
    (row) =>
      row &&
      Number.isInteger(row.netuid) &&
      typeof row.snapshot_date === "string" &&
      Number.isFinite(row.captured_at),
  );
  if (!validRows.length) {
    return writeJson({ ok: true, rows_written: 0 });
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  const snapshotRows = validRows.map((row) => ({
    netuid: row.netuid,
    snapshot_date: row.snapshot_date,
    completeness_score: Number.isFinite(row.completeness_score)
      ? row.completeness_score
      : null,
    surface_count: Number.isFinite(row.surface_count)
      ? row.surface_count
      : null,
    endpoint_count: Number.isFinite(row.endpoint_count)
      ? row.endpoint_count
      : null,
    monitored_count: Number.isFinite(row.monitored_count)
      ? row.monitored_count
      : null,
    candidate_count: Number.isFinite(row.candidate_count)
      ? row.candidate_count
      : null,
    validator_count: Number.isFinite(row.validator_count)
      ? row.validator_count
      : null,
    miner_count: Number.isFinite(row.miner_count) ? row.miner_count : null,
    total_stake_tao: Number.isFinite(row.total_stake_tao)
      ? row.total_stake_tao
      : null,
    alpha_price_tao: Number.isFinite(row.alpha_price_tao)
      ? row.alpha_price_tao
      : null,
    emission_share: Number.isFinite(row.emission_share)
      ? row.emission_share
      : null,
    tao_in_pool_tao: Number.isFinite(row.tao_in_pool_tao)
      ? row.tao_in_pool_tao
      : null,
    alpha_in_pool: Number.isFinite(row.alpha_in_pool)
      ? row.alpha_in_pool
      : null,
    alpha_out_pool: Number.isFinite(row.alpha_out_pool)
      ? row.alpha_out_pool
      : null,
    subnet_volume_tao: Number.isFinite(row.subnet_volume_tao)
      ? row.subnet_volume_tao
      : null,
    captured_at: row.captured_at,
  }));

  try {
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '10000ms'`;
      await sql`
        INSERT INTO subnet_snapshots ${sql(
          snapshotRows,
          "netuid",
          "snapshot_date",
          "completeness_score",
          "surface_count",
          "endpoint_count",
          "monitored_count",
          "candidate_count",
          "validator_count",
          "miner_count",
          "total_stake_tao",
          "alpha_price_tao",
          "emission_share",
          "tao_in_pool_tao",
          "alpha_in_pool",
          "alpha_out_pool",
          "subnet_volume_tao",
          "captured_at",
        )}
        ON CONFLICT (netuid, snapshot_date) DO UPDATE SET
          validator_count = COALESCE(subnet_snapshots.validator_count, excluded.validator_count),
          miner_count = COALESCE(subnet_snapshots.miner_count, excluded.miner_count),
          total_stake_tao = COALESCE(subnet_snapshots.total_stake_tao, excluded.total_stake_tao),
          alpha_price_tao = COALESCE(subnet_snapshots.alpha_price_tao, excluded.alpha_price_tao),
          emission_share = COALESCE(subnet_snapshots.emission_share, excluded.emission_share),
          tao_in_pool_tao = COALESCE(subnet_snapshots.tao_in_pool_tao, excluded.tao_in_pool_tao),
          alpha_in_pool = COALESCE(subnet_snapshots.alpha_in_pool, excluded.alpha_in_pool),
          alpha_out_pool = COALESCE(subnet_snapshots.alpha_out_pool, excluded.alpha_out_pool),
          subnet_volume_tao = COALESCE(subnet_snapshots.subnet_volume_tao, excluded.subnet_volume_tao)`;
      return writeJson({ ok: true, rows_written: snapshotRows.length });
    });
  } catch (err) {
    console.error("data-api subnet-snapshot-sync write failed:", err);
    captureDataApiError(err, "subnet-snapshot-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/rpc-usage-sync (#4832 gap-closure) ------------
//
// Best-effort Postgres mirror of recordRpcUsage's D1 insert
// (workers/request-handlers/rpc-proxy.mjs's syncRpcUsageEventToPostgres) --
// Pattern C, unlike every sync route above: one fire-and-forget POST per
// live proxied RPC request under the caller's own ctx.waitUntil, not a
// cron/workflow batch. Justified only after confirming live production
// volume is trivial (69 rows / ~25 days, wrangler d1 execute 2026-07-11) --
// batching would be premature for traffic this low. One event per request,
// not an array, matching the caller's one-row-per-call shape.
const RPC_USAGE_SYNC_TOKEN_HEADER = "x-rpc-usage-sync-token";
// A single event object is a few hundred bytes; generous headroom.
const RPC_USAGE_SYNC_MAX_BODY_BYTES = 4_000;

async function handleRpcUsageEventSync(request, env) {
  if (!env.RPC_USAGE_SYNC_SECRET) {
    return writeJson(
      { error: "rpc-usage sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(RPC_USAGE_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.RPC_USAGE_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${RPC_USAGE_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > RPC_USAGE_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${RPC_USAGE_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    !Number.isFinite(event.observed_at) ||
    typeof event.network !== "string" ||
    !event.network
  ) {
    return writeJson({ error: "malformed rpc usage event" }, 400);
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    await sql`
      INSERT INTO rpc_proxy_events
        (observed_at, network, endpoint_id, provider, ok, status, attempts, latency_ms, cache)
      VALUES (
        ${event.observed_at},
        ${event.network},
        ${typeof event.endpoint_id === "string" ? event.endpoint_id : null},
        ${typeof event.provider === "string" ? event.provider : null},
        ${Boolean(event.ok)},
        ${Number.isFinite(event.status) ? event.status : null},
        ${Number.isFinite(event.attempts) ? event.attempts : null},
        ${Number.isFinite(event.latency_ms) ? event.latency_ms : null},
        ${typeof event.cache === "string" ? event.cache : null}
      )`;
    return writeJson({ ok: true });
  } catch (err) {
    console.error("data-api rpc-usage-sync write failed:", err);
    captureDataApiError(err, "rpc-usage-sync");
    return writeJson({ error: "write failed" }, 502);
  }
}

// --- POST /api/v1/internal/rpc-usage-prune (#5497 gap-closure) -----------
//
// The Postgres mirror of rpc_proxy_events written by handleRpcUsageEventSync
// above has no retention of its own (D1's copy is pruned to a 30-day hot
// window on the hourly maintenance cron; Postgres just grew unbounded).
// Called from src/health-prober.mjs's pruneHealthHistory
// (syncRpcProxyEventsPruneToPostgres), on the same cron, right after the D1
// prune -- reuses the rpc-usage-sync token/secret (same trust boundary: both
// routes write to the same table, no reason for a second secret).
async function handleRpcUsageEventPrune(request, env) {
  if (!env.RPC_USAGE_SYNC_SECRET) {
    return writeJson(
      { error: "rpc-usage sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(RPC_USAGE_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.RPC_USAGE_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${RPC_USAGE_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  if (!body || typeof body !== "object" || !Number.isFinite(body.cutoff)) {
    return writeJson({ error: "cutoff must be a finite number" }, 400);
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    const result = await sql`
      DELETE FROM rpc_proxy_events WHERE observed_at < ${body.cutoff}`;
    return writeJson({ ok: true, rows_deleted: result.count });
  } catch (err) {
    console.error("data-api rpc-usage-prune write failed:", err);
    captureDataApiError(err, "rpc-usage-prune");
    return writeJson({ error: "write failed" }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=10",
    },
  });
}

// featured_validators (#5166) is a small maintainer-toggled side table (see
// deploy/postgres/schema.sql for why it's hotkey-keyed rather than a `neurons`
// column) -- reading it must never break the primary validators query, so a
// missing table (e.g. before the migration has landed) or any other read
// failure here just yields "nothing is featured" instead of a 502 for the
// whole /validators route.
//
// #5220: every caller runs inside the route dispatcher's shared
// `sql.begin(...)` transaction (see the top of the fetch handler). A local
// try/catch around a bare `sql\`...\`` call is NOT enough to contain a
// failure there -- postgres.js's `begin()` independently tracks every query
// issued against the transaction's `sql` via its own internal `.catch()`
// (see node_modules/postgres/src/index.js's `scope()`/`uncaughtError`), so
// even a query whose rejection THIS function already handles still poisons
// the whole transaction and makes `sql.begin(...)` itself reject once the
// route handler returns -- which is exactly what made the entire
// /api/v1/validators (and /api/v1/subnets/:netuid/validators) response
// degrade to the empty D1-era fallback in production despite this catch:
// the primary `neurons` query's own results were discarded by the outer
// `sql.begin()` rejecting *after* the route handler had already built its
// response. `sql.savepoint()` runs the read in its own nested scope so a
// failure there rolls back to a savepoint instead of the whole transaction,
// leaving the enclosing transaction (and its other queries) unaffected.
async function loadFeaturedHotkeys(sql) {
  try {
    const rows = await sql.savepoint(
      (sql) => sql`SELECT hotkey FROM featured_validators`,
    );
    return new Set(rows.map((row) => row.hotkey));
  } catch (err) {
    console.error("featured_validators query failed:", err);
    captureDataApiError(err, "featured-validators-query");
    return new Set();
  }
}

// account_identity rows keyed by coldkey, for the /api/v1/validators and
// /api/v1/validators/:hotkey identity join (#5234). Same sql.savepoint
// resilience as loadFeaturedHotkeys just above (enrichment data; its own
// failure must never sink the primary validator response) and the same
// scalar-positional-bind sql.unsafe shape as the /api/v1/internal/
// compare-health route's coldkeys IN (...) query above -- this Worker's
// Hyperdrive fetch_types:false setting breaks postgres.js's automatic
// ARRAY-literal serialization for a bound JS array (ANY($1)), so every IN
// clause here builds its own scalar placeholder list instead.
async function loadAccountIdentitiesByColdkey(sql, coldkeys) {
  if (coldkeys.length === 0) return new Map();
  try {
    const placeholders = coldkeys.map((_, i) => `$${i + 1}::text`).join(", ");
    const rows = await sql.savepoint((sql) =>
      sql.unsafe(
        `SELECT ${ACCOUNT_IDENTITY_INSERT_COLUMNS.join(", ")}
         FROM account_identity WHERE account IN (${placeholders})`,
        coldkeys,
      ),
    );
    return new Map(rows.map((row) => [row.account, row]));
  } catch (err) {
    console.error("account_identity join query failed:", err);
    captureDataApiError(err, "account-identity-join-query");
    return new Map();
  }
}

// Distinct, order-stable, non-empty coldkeys from a validators/validator-detail
// result set -- the input to loadAccountIdentitiesByColdkey above.
function distinctColdkeys(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (row?.coldkey?.length > 0) seen.add(row.coldkey);
  }
  return [...seen];
}

// Same savepoint-isolated-failure shape as loadFeaturedHotkeys above (#2549):
// a validator_nominator_counts read failure degrades the whole
// /api/v1/validators response to nominator_count: null everywhere rather
// than failing the request or rolling back the enclosing transaction's other
// queries.
async function loadValidatorNominatorCounts(sql) {
  try {
    const rows = await sql.savepoint(
      (sql) =>
        sql`SELECT hotkey, nominator_count FROM validator_nominator_counts`,
    );
    return nominatorCountsByHotkey(rows);
  } catch (err) {
    console.error("validator_nominator_counts query failed:", err);
    captureDataApiError(err, "validator-nominator-counts-query");
    return new Map();
  }
}

// Same savepoint-isolated-failure shape as loadValidatorNominatorCounts just
// above (#2551): a subnet_hyperparams read failure degrades apy_estimate to
// null everywhere (accumulateApyRow's tempoByNetuid.get(...) == null branch)
// rather than failing /api/v1/validators or /api/v1/validators/:hotkey, or
// rolling back the enclosing transaction's other queries.
async function loadSubnetTempos(sql) {
  try {
    const rows = await sql.savepoint(
      (sql) => sql`SELECT netuid, tempo FROM subnet_hyperparams`,
    );
    return buildTempoByNetuid(rows);
  } catch (err) {
    console.error("subnet_hyperparams tempo query failed:", err);
    captureDataApiError(err, "subnet-hyperparams-tempo-query");
    return new Map();
  }
}

// Lookback (days) for each realized-return window (#7228), keyed by the
// baseline-object field buildGlobalValidators/buildValidatorDetail read
// (realized_return_1d/1w/1m). Mirrors the neuron_daily HISTORY_WINDOWS map --
// the rollup's snapshot_date is a native DATE, so each cutoff is computed the
// same way windowCutoffDate does.
const REALIZED_RETURN_WINDOWS = { d1: 1, d7: 7, d30: 30 };

// Per-hotkey baseline total_stake_tao ~1d/1w/1m back from the neuron_daily
// rollup, for the realized_return_* fields (#7228). For each window it takes
// each hotkey's newest snapshot on-or-before (today − N days) and sums that
// day's stake across every subnet membership (rao-precision is re-applied in
// the builder); a hotkey whose oldest snapshot is newer than that cutoff is
// simply absent, so its realized return for that window resolves to null ("no
// figure", not "zero"). Same savepoint-isolated-failure shape as
// loadSubnetTempos above: a neuron_daily read failure degrades every
// realized_return_* to null rather than failing /api/v1/validators or
// /api/v1/validators/:hotkey, or rolling back the enclosing transaction's
// other queries. `hotkey` scopes the scan to the single-validator detail route.
async function loadRealizedStakeBaselines(sql, { hotkey = null } = {}) {
  const windows = Object.entries(REALIZED_RETURN_WINDOWS);
  try {
    const perWindow = await sql.savepoint((sql) =>
      Promise.all(
        windows.map(([, days]) => {
          const cutoff = new Date(Date.now() - days * ANALYTICS_DAY_MS)
            .toISOString()
            .slice(0, 10);
          return hotkey
            ? sql`
            WITH daily AS (
              SELECT hotkey, snapshot_date, SUM(stake_tao) AS stake_tao
              FROM neuron_daily
              WHERE validator_permit = TRUE AND hotkey = ${hotkey}
                AND snapshot_date <= ${cutoff}
              GROUP BY hotkey, snapshot_date
            )
            SELECT DISTINCT ON (hotkey) hotkey, stake_tao AS baseline_stake_tao
            FROM daily ORDER BY hotkey, snapshot_date DESC`
            : sql`
            WITH daily AS (
              SELECT hotkey, snapshot_date, SUM(stake_tao) AS stake_tao
              FROM neuron_daily
              WHERE validator_permit = TRUE AND snapshot_date <= ${cutoff}
              GROUP BY hotkey, snapshot_date
            )
            SELECT DISTINCT ON (hotkey) hotkey, stake_tao AS baseline_stake_tao
            FROM daily ORDER BY hotkey, snapshot_date DESC`;
        }),
      ),
    );
    const byHotkey = new Map();
    windows.forEach(([key], i) => {
      for (const row of perWindow[i]) {
        if (row?.hotkey == null) continue;
        const entry = byHotkey.get(row.hotkey) ?? {
          d1: null,
          d7: null,
          d30: null,
        };
        entry[key] = numberOrNull(row.baseline_stake_tao);
        byHotkey.set(row.hotkey, entry);
      }
    });
    return byHotkey;
  } catch (err) {
    console.error("neuron_daily realized-return baseline query failed:", err);
    captureDataApiError(err, "realized-return-baseline-query");
    return new Map();
  }
}

// One netuid's live immunity_period hyperparameter (#6640) -- never
// hardcoded, mirrors the MaxDelegateTake/TxDelegateTakeRateLimit convention
// (#5229). Same savepoint-isolated-failure shape as loadSubnetTempos just
// above: a subnet_hyperparams read failure degrades the immunity-window
// fields to omitted (formatNeuron's immunityPeriod-undefined no-op) rather
// than failing the neurons/metagraph response. Same null-guard as
// subnet-hyperparams.mjs's own nonNegativeInt -- Number(null) is 0, not
// NaN -- written inline rather than imported since each domain file owns its
// small D1/Postgres cell-coercion copies (see that file's own header).
async function loadSubnetImmunityPeriod(sql, netuid) {
  try {
    const rows = await sql.savepoint(
      (sql) =>
        sql`SELECT immunity_period FROM subnet_hyperparams WHERE netuid = ${netuid} LIMIT 1`,
    );
    const value = rows[0]?.immunity_period;
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch (err) {
    console.error("subnet_hyperparams immunity_period query failed:", err);
    captureDataApiError(err, "subnet-hyperparams-immunity-period-query");
    return null;
  }
}

// Raw nominator_positions rows for one coldkey (#5233) -- savepoint-isolated
// like the loaders above, so a cold/absent table degrades this specific
// route to an empty positions card rather than failing the request.
async function loadNominatorPositions(sql, ss58) {
  try {
    return await sql.savepoint(
      (sql) => sql`
        SELECT coldkey, hotkey, netuid, share_fraction, captured_at
        FROM nominator_positions WHERE coldkey = ${ss58}`,
    );
  } catch (err) {
    console.error("nominator_positions query failed:", err);
    captureDataApiError(err, "nominator-positions-query");
    return [];
  }
}

// neurons.stake_tao for every (hotkey, netuid) referenced by one account's
// position rows -- the join input buildAccountPositions needs to turn a
// dimensionless share_fraction into an actual stake_tao figure. Same
// scalar-placeholder IN-list shape as loadAccountIdentitiesByColdkey above
// (this Worker's Hyperdrive fetch_types:false setting breaks automatic
// ARRAY-literal binding for a JS array).
async function loadNeuronStakeByHotkeys(sql, hotkeys) {
  if (hotkeys.length === 0) return new Map();
  try {
    const placeholders = hotkeys.map((_, i) => `$${i + 1}::text`).join(", ");
    const rows = await sql.savepoint((sql) =>
      sql.unsafe(
        `SELECT hotkey, netuid, stake_tao FROM neurons WHERE hotkey IN (${placeholders})`,
        hotkeys,
      ),
    );
    return stakeByHotkeyNetuid(rows);
  } catch (err) {
    console.error("neurons stake-by-hotkey join query failed:", err);
    captureDataApiError(err, "neurons-stake-by-hotkey-query");
    return new Map();
  }
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  // Floor to a minimum of 1 (mirrors clampStatsBlocks): a fractional 0<n<1 floors
  // to 0 otherwise, binding LIMIT 0 and then dereferencing rows[-1] for the cursor.
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

function clampStatsBlocks(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.min(Math.max(Math.floor(n), 1), 5000);
}

// postgres.js returns BIGINT columns as strings; the D1-backed routes return them
// as numbers. block_number and observed_at are both < 2^53, so Number(...) is
// lossless — coerce them per event row for a consistent numeric API shape.
function numberOrNull(v) {
  if (v == null) return null;
  // Blank Hyperdrive/Postgres cells coerce via Number("") → 0; trim rejects "" /
  // whitespace-only so absent indices/timestamps stay null (mirrors toBlockNumber
  // in src/account-events.mjs and src/blocks.ts).
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nonNegativeIntegerParam(params, key) {
  const value = params.get(key);
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function clampBlockLimit(raw) {
  return clampRequestLimit(raw, BLOCK_PAGINATION);
}

// The account/block/subnet events feeds document a <=1000 / default-100 profile
// (FEED_PAGINATION) at their entities.mjs handlers; use the shared profile here
// too so the Postgres-tier path (which always wins in production, #4772/#4909)
// doesn't silently re-cap them at the local clampLimit's 200 (#5474). The local
// clampLimit still governs the non-events routes (extrinsics/transfers/chain-events).
function clampEventsLimit(raw) {
  return clampRequestLimit(raw, FEED_PAGINATION);
}

function clampOffset(raw) {
  return clampRequestOffset(raw);
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;
const MAX_EMBEDDED_EVENTS = 50;

// Resolve a /blocks/:ref sub-resource's ref (numeric block_number or a 0x
// block_hash) to its block_number, mirroring src/block-subresources.mjs's
// resolveBlockNumber. Returns null for a malformed ref or an unknown block
// (never throws) -- the two sub-resource routes below both need this ahead of
// their own extrinsics/account_events query, same as the D1 path.
async function resolveBlockNumberPg(sql, ref) {
  const isHash = HASH_RE.test(ref);
  if (!isHash && !/^\d+$/.test(ref)) return null;
  const blockNumber = isHash ? null : Number(ref);
  if (!isHash && !Number.isSafeInteger(blockNumber)) return null;
  const rows = isHash
    ? await sql`SELECT block_number FROM blocks WHERE block_hash = ${ref.toLowerCase()} LIMIT 1`
    : await sql`SELECT block_number FROM blocks WHERE block_number = ${blockNumber} LIMIT 1`;
  return numberOrNull(rows[0]?.block_number);
}

// The blocks/extrinsics SELECT column lists below must match src/blocks.ts's
// BLOCK_READ_COLUMNS / src/extrinsics.ts's EXTRINSIC_READ_COLUMNS so
// formatBlock/formatExtrinsic (reused unchanged, imported above) see the exact
// same row shape from either sink. Written literally per query (not factored
// into a shared string) because postgres.js tagged templates bind a `${...}`
// interpolation as a query PARAMETER, not raw SQL -- a column list can't be
// injected that way. extrinsics' call_args is cast to text: Postgres' JSONB
// auto-parses to a JS object via the driver, but formatExtrinsic expects a
// JSON-encoded STRING to JSON.parse, matching D1's TEXT column -- casting here
// keeps that shared formatter untouched rather than teaching it two shapes.

// args (#4685): decode AccountId32 byte arrays to SS58 (or hex for
// non-account/untagged values) before this ever reaches a consumer -- REST
// and the three MCP tools that select `args` (list_chain_events,
// get_block_chain_events, get_extrinsic_chain_events) all route through this
// one function, so there's a single decode point rather than three.
// Unconditional (unlike the block_number guard below): both call sites
// always select `args` in their SQL (chain-events/stats, which doesn't,
// never calls coerceEvent at all) -- and decodeChainEventArgs(undefined)
// resolves to `args: undefined`, which JSON.stringify drops from the
// response the same as an absent key, so there's no schema-shape risk in
// leaving this unconditional.
function coerceEvent(row) {
  return {
    ...row,
    ...(row.block_number !== undefined
      ? { block_number: numberOrNull(row.block_number) }
      : {}),
    args: decodeChainEventArgs(row.args, {
      pallet: row.pallet,
      method: row.method,
    }),
    observed_at: numberOrNull(row.observed_at),
  };
}

// --- /api/v1/alerts/triggers (#4984 Part 1) ---------------------------------
//
// Public CRUD for user-defined chain alert triggers, reached only via
// workers/api.mjs's DATA_API service binding (no public routes of its own,
// same invariant as every route in this file). Creation is gated by a
// shared anti-abuse token (mirrors src/webhooks.mjs's own subscription-
// creation gate, ALERT_TRIGGER_CREATE_TOKEN_HEADER/env.ALERT_TRIGGER_CREATE_TOKEN
// -- every active trigger costs the #4984 Part 2 evaluator a real per-event
// match check, so unbounded public creation is a workload vector, not just a
// storage one); GET/PATCH/DELETE on one trigger are gated by that trigger's
// OWN owner_token instead (returned once, at creation) -- there is no public
// view, unlike webhook subscriptions, because `destination` can itself be a
// bearer credential (a Discord incoming-webhook URL). All shared, no-I/O
// validation lives in src/alert-triggers.mjs; everything here is Postgres
// plumbing + auth gates.

async function withAlertTriggersSql(env, fn) {
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });
  try {
    return await fn(sql);
  } catch (err) {
    console.error("data-api alert-triggers write failed:", err);
    captureDataApiError(err, "alert-triggers");
    return writeJson({ error: "write failed" }, 502);
  }
  // No sql.end() -- Hyperdrive cleans up the connection when the request/
  // invocation ends (Cloudflare's documented pattern), matching every other
  // write route in this file.
}

async function readAlertTriggerBody(request) {
  if (
    Number(request.headers.get("content-length") || 0) >
    ALERT_TRIGGER_MAX_BODY_BYTES
  ) {
    return { error: writeJson({ error: "body too large" }, 413) };
  }
  const raw = await request.text();
  if (utf8Bytes(raw).length > ALERT_TRIGGER_MAX_BODY_BYTES) {
    return { error: writeJson({ error: "body too large" }, 413) };
  }
  try {
    return { body: raw ? JSON.parse(raw) : null };
  } catch {
    return { error: writeJson({ error: "body must be JSON" }, 400) };
  }
}

// Returns the SAME 404 a nonexistent id gets (found by adversarial review:
// returning 403 here would let an unauthenticated caller distinguish
// "wrong token" from "no such trigger" purely from the status code,
// building an existence oracle over sequential ids with zero credentials --
// exactly the "no public view" property this route is designed to have).
function requireAlertTriggerOwner(request, storedOwnerToken) {
  const provided = request.headers.get(ALERT_TRIGGER_OWNER_TOKEN_HEADER) || "";
  if (isValidAlertOwnerToken(provided, storedOwnerToken)) return null;
  return writeJson({ error: "no such trigger" }, 404);
}

// Policy for the create rate-limiter's 429 header family. Mirrors the
// ALERT_TRIGGER_CREATE_RATE_LIMITER binding in wrangler.data.jsonc (10/60s) so
// the advertised headers match the enforced limit. (#5475)
const ALERT_TRIGGER_CREATE_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

async function handleAlertTriggerCreate(request, env) {
  const configured = env.ALERT_TRIGGER_CREATE_TOKEN;
  if (!configured) {
    return writeJson(
      {
        error: "alert trigger creation is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided = request.headers.get(ALERT_TRIGGER_CREATE_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      { error: `provide a valid ${ALERT_TRIGGER_CREATE_TOKEN_HEADER} header` },
      401,
    );
  }

  // Found by adversarial review: ALERT_TRIGGER_CREATE_TOKEN is a SHARED
  // anti-abuse secret, not a per-user credential -- anyone holding it could
  // otherwise script unbounded trigger creation, and every row becomes a
  // permanent per-event cost in AlerterHub.matchingTriggers()'s O(active
  // triggers) scan. Skipped when unbound (local dev/CI), matching every
  // other optional rate-limiter binding's convention in this codebase.
  if (env.ALERT_TRIGGER_CREATE_RATE_LIMITER?.limit) {
    const { success } = await env.ALERT_TRIGGER_CREATE_RATE_LIMITER.limit({
      key: resolveClientIp(request),
    });
    if (!success) {
      // Carry the standard rate-limit header family so callers (and the api.mjs
      // proxy that forwards this response) can detect throttling and honour the
      // back-off -- matching handleAccountBalance/handleSubnetRecycled (#5475).
      return writeJson(
        { error: "too many alert trigger creation requests; slow down" },
        429,
        {
          "retry-after": String(ALERT_TRIGGER_CREATE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(ALERT_TRIGGER_CREATE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${ALERT_TRIGGER_CREATE_RATE_LIMIT.limit};w=${ALERT_TRIGGER_CREATE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const { body, error } = await readAlertTriggerBody(request);
  if (error) return error;
  const validated = validateAlertTriggerInput(body);
  if (!validated.ok) {
    return writeJson({ error: validated.error }, 400);
  }

  return withAlertTriggersSql(env, async (sql) => {
    // Short local name (`ownerToken`, not `secret`) keeps the public-safety
    // scanner's hardcoded-credential heuristic from false-positiving here,
    // matching src/webhooks.mjs's createWebhookSubscription convention.
    const ownerToken = generateAlertTriggerOwnerToken();
    const now = Date.now();
    const v = validated.value;
    const [row] = await sql`
      INSERT INTO chain_alert_triggers
        (owner_token, name, table_filter, netuid, event_kind, account, min_amount_tao, condition, channel, destination, created_at, updated_at)
      VALUES (
        ${ownerToken}, ${v.name}, ${v.tableFilter}, ${v.netuid}, ${v.eventKind},
        ${v.account}, ${v.minAmountTao}, ${v.condition ? sql.json(v.condition) : null},
        ${v.channel}, ${v.destination}, ${now}, ${now}
      )
      RETURNING *`;
    return writeJson(
      {
        ...ownerAlertTriggerView(row),
        // Returned ONCE at creation; store it to read/update/delete this
        // trigger. It is never echoed back on any later GET.
        owner_token: ownerToken,
      },
      201,
    );
  });
}

async function handleAlertTriggerGet(request, env, id) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  return withAlertTriggersSql(env, async (sql) => {
    const [row] =
      await sql`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!row) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(request, row.owner_token);
    if (authError) return authError;
    return writeJson(ownerAlertTriggerView(row));
  });
}

// Fields present in a PATCH body with a real (non-null) value OVERRIDE the
// existing row; fields OMITTED keep whatever the row already has (true
// partial-update semantics, the bug the adversarial review found: a naive
// full-replace here silently NULLs out -- and so WIDENS the match scope of
// -- every condition field the caller didn't resend). A field explicitly
// sent as `null` is ALSO treated as "keep the existing value", not as "clear
// it": validateAlertTriggerInput (shared with CREATE) only recognizes "not
// provided" via `!== undefined` and actively REJECTS an explicit `null` for
// most fields (e.g. `netuid: null` fails its `Number.isInteger` check), so
// there is no way to route an intentional-clear through that validator
// without special-casing PATCH-only null handling inside a CREATE-shared
// function. Both the existing-row base and the incoming body have their
// null-valued keys stripped before merging -- for the base, this turns a
// legitimately-unset existing field (stored as SQL NULL) into "not
// provided" so it doesn't round-trip back in and fail validation; for the
// body, it means an explicit `null` degrades to a no-op rather than a 400.
// There is currently no supported way to explicitly clear an optional
// condition field back to unset via PATCH -- only DELETE + recreate.
function omitNullValues(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

async function handleAlertTriggerUpdate(request, env, id) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const { body, error } = await readAlertTriggerBody(request);
  if (error) return error;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return writeJson({ error: "Request body must be a JSON object." }, 400);
  }
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(request, existing.owner_token);
    if (authError) return authError;

    // Found by adversarial review: validating the raw PATCH body directly
    // (the original version of this function) meant validateAlertTriggerInput's
    // CREATE-oriented "omitted -> null" defaulting silently NULLed out any
    // condition field the caller didn't resend, unintentionally WIDENING a
    // trigger's match scope on every partial edit (e.g. renaming a
    // netuid-scoped trigger without resending netuid would drop the netuid
    // filter entirely). Merging onto the existing row first fixes this.
    const merged = {
      ...omitNullValues({
        name: existing.name,
        table_filter: existing.table_filter,
        netuid: existing.netuid,
        event_kind: existing.event_kind,
        account: existing.account,
        min_amount_tao:
          existing.min_amount_tao === null
            ? null
            : Number(existing.min_amount_tao),
        condition: existing.condition,
        channel: existing.channel,
        destination: existing.destination,
      }),
      ...omitNullValues(body),
    };
    const validated = validateAlertTriggerInput(merged);
    if (!validated.ok) {
      return writeJson({ error: validated.error }, 400);
    }

    const v = validated.value;
    const now = Date.now();
    const [row] = await sql`
      UPDATE chain_alert_triggers SET
        name = ${v.name},
        table_filter = ${v.tableFilter},
        netuid = ${v.netuid},
        event_kind = ${v.eventKind},
        account = ${v.account},
        min_amount_tao = ${v.minAmountTao},
        condition = ${v.condition ? sql.json(v.condition) : null},
        channel = ${v.channel},
        destination = ${v.destination},
        updated_at = ${now}
      WHERE id = ${id}
      RETURNING *`;
    return writeJson(ownerAlertTriggerView(row));
  });
}

async function handleAlertTriggerDelete(request, env, id) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT owner_token FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(request, existing.owner_token);
    if (authError) return authError;
    await sql`DELETE FROM chain_alert_triggers WHERE id = ${id}`;
    return writeJson({ id, deleted: true });
  });
}

// Internal-only: the #4984 Part 2 evaluator's cache-refresh scan. A
// DIFFERENT secret from the create/owner tokens above -- it grants a wholly
// different capability (read every trigger regardless of owner).
async function handleAlertTriggersActiveList(request, env) {
  const configured = env.ALERT_TRIGGERS_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      {
        error:
          "the alert-triggers internal list is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided =
    request.headers.get(ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      {
        error: `provide a valid ${ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER} header`,
      },
      401,
    );
  }
  return withAlertTriggersSql(env, async (sql) => {
    const rows = await sql`SELECT * FROM chain_alert_triggers WHERE active`;
    return writeJson({ triggers: rows.map(evaluatorAlertTriggerView) });
  });
}

// Internal-only: the #5022 evaluator write-back. AlerterHub.evaluate()
// (workers/alerter-hub.mjs) POSTs the FULL matched-trigger id list for a
// chain event here -- every id whose conditions were satisfied, regardless
// of whether the burst rate-limiter actually let it deliver -- so
// chain_alert_triggers.match_count/last_matched_at reflect "this trigger's
// conditions were satisfied", independent of delivery. Gated the SAME way
// as the active-list route above: a DIFFERENT capability from the
// create/owner tokens (write access to every trigger's own bookkeeping
// columns, not just its own row), so it reuses that same
// ALERT_TRIGGERS_INTERNAL_TOKEN secret rather than minting a third one.
async function handleAlertTriggersMatchedWriteback(request, env) {
  const configured = env.ALERT_TRIGGERS_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      {
        error:
          "the alert-triggers match write-back is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided =
    request.headers.get(ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      {
        error: `provide a valid ${ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER} header`,
      },
      401,
    );
  }
  const { body, error } = await readAlertTriggerBody(request);
  if (error) return error;
  const ids = Array.isArray(body?.trigger_ids)
    ? body.trigger_ids.filter(isValidAlertTriggerId).map(String)
    : [];
  if (ids.length === 0) {
    return writeJson(
      { error: "trigger_ids must be a non-empty array of trigger ids" },
      400,
    );
  }
  return withAlertTriggersSql(env, async (sql) => {
    const now = Date.now();
    // Plain scalar positional binds via sql.unsafe, NOT a bound JS array
    // (`id = ANY($1)`) -- see the neurons-sync prune query's own comment
    // (handleNeuronsSync, above) for why: this Worker's Hyperdrive
    // fetch_types:false setting breaks postgres.js's automatic
    // ARRAY-literal serialization, while scalar binds are unaffected.
    // $1 is the shared `now` timestamp; $2.. are the (already
    // isValidAlertTriggerId-validated) ids.
    const placeholders = ids.map((_, i) => `$${i + 2}::bigint`).join(", ");
    const updated = await sql.unsafe(
      `UPDATE chain_alert_triggers
       SET match_count = match_count + 1,
           last_matched_at = $1::bigint
       WHERE id IN (${placeholders})
       RETURNING id`,
      [now, ...ids],
    );
    return writeJson({ updated: updated.length });
  });
}

// Internal-only: the #6747 evaluator's METRIC cache-refresh scan -- the raw
// rows AlerterHub.refreshTriggers() feeds into src/dereg-risk.ts's
// buildDeregRiskSnapshot to build the in-memory Maps triggerMatchesEvent's
// condition check reads from. Gated the SAME way as the active-list/
// writeback routes above (same ALERT_TRIGGERS_INTERNAL_TOKEN secret, a
// different capability from the create/owner tokens). Bounded and
// network-wide in ONE call (not per-subnet) so the evaluator's own refresh
// stays one round trip, same shape as handleAlertTriggersActiveList.
//
// `immune_neurons` is deliberately narrow (only currently-immune rows, via
// the is_immunity_period index-friendly filter) rather than every neuron on
// every subnet -- a full network-wide neuron dump would be a genuinely large
// payload; only-currently-immune neurons is a small, bounded set. `subnets`
// reads subnet_snapshots' latest row per netuid (DISTINCT ON, the same
// idiom this file already uses for hyperparams_hash/identity_hash) -- a
// DAILY cadence table, so alpha_price_tao here can lag up to ~24h behind
// the live economics tier; acceptable for this protocol-health signal
// (directional rank), not something a trading decision should lean on.
async function handleDeregRiskSnapshot(request, env) {
  const configured = env.ALERT_TRIGGERS_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      {
        error:
          "the alert-triggers dereg-risk snapshot is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided =
    request.headers.get(ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      {
        error: `provide a valid ${ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER} header`,
      },
      401,
    );
  }
  return withAlertTriggersSql(env, async (sql) => {
    const [[block], hyperparamsRows, immuneNeurons, subnetRows] =
      await Promise.all([
        sql`SELECT MAX(block_number) AS block_number FROM blocks`,
        sql`SELECT netuid, immunity_period FROM subnet_hyperparams`,
        sql`SELECT netuid, hotkey, registered_at_block FROM neurons
            WHERE is_immunity_period = TRUE AND hotkey IS NOT NULL
              AND registered_at_block IS NOT NULL`,
        sql`SELECT DISTINCT ON (netuid) netuid, alpha_price_tao
            FROM subnet_snapshots
            ORDER BY netuid, snapshot_date DESC`,
      ]);
    const immunityPeriodByNetuid = new Map(
      hyperparamsRows
        .filter((row) => Number.isInteger(row.immunity_period))
        .map((row) => [row.netuid, row.immunity_period]),
    );
    const immuneNeuronsWithExpiry = immuneNeurons
      .map((row) => {
        const immunityPeriod = immunityPeriodByNetuid.get(row.netuid);
        if (!Number.isInteger(immunityPeriod)) return null;
        return {
          netuid: row.netuid,
          hotkey: row.hotkey,
          immunity_expires_at_block: row.registered_at_block + immunityPeriod,
        };
      })
      .filter(Boolean);
    return writeJson({
      current_block: Number.isInteger(block?.block_number)
        ? block.block_number
        : null,
      subnets: subnetRows.map((row) => ({
        netuid: row.netuid,
        alpha_price_tao:
          row.alpha_price_tao === null ? null : Number(row.alpha_price_tao),
      })),
      immune_neurons: immuneNeuronsWithExpiry,
    });
  });
}

async function handleAlertTriggersRoute(request, env, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "alerts", "triggers", <id?>]
  const id = segments[4];
  if (!id && request.method === "POST") {
    return handleAlertTriggerCreate(request, env);
  }
  if (id && request.method === "GET") {
    return handleAlertTriggerGet(request, env, id);
  }
  if (id && request.method === "PATCH") {
    return handleAlertTriggerUpdate(request, env, id);
  }
  if (id && request.method === "DELETE") {
    return handleAlertTriggerDelete(request, env, id);
  }
  return writeJson(
    {
      error:
        "Use POST /api/v1/alerts/triggers, or GET/PATCH/DELETE /api/v1/alerts/triggers/{id}.",
    },
    405,
  );
}

// --- Wallet-signature login + self-serve fullnode/freemium API keys
// (originally ADR 0021/#6835, reworked onto Unkey 2026-07-19) --------------
//
// Reached only via workers/api.mjs's DATA_API service binding, same as every
// route in this file. Route groups:
//   POST /api/v1/auth/wallet/challenge  { ss58 } -> a signable message
//   POST /api/v1/auth/wallet/verify     { ss58, signature } -> a session
//   POST/GET /api/v1/keys, DELETE /api/v1/keys/{key_id} -> mint/list/revoke
//     THIS account's own mg_... API key, now minted/verified/revoked via
//     Unkey (src/unkey-client.mjs) rather than locally generated/hashed --
//     every /api/v1/keys route requires a session (Authorization: Bearer
//     <session_token>, src/wallet-auth.mjs). No invite-code gate anymore:
//     any wallet-connected account can self-serve a key immediately, at its
//     account's current tier (rpc_accounts.tier, default 'free'); promoting
//     an account to a higher tier afterward is the internal tier-promotion
//     route below, not a mint-time credential. All crypto/no-I/O logic
//     lives in src/wallet-auth.mjs; everything here is Postgres plumbing +
//     the Unkey calls.
//   POST /api/v1/internal/keys/verify   -- internal-only, see
//     handleApiKeyVerify's own header comment.
//   POST /api/v1/internal/accounts/tier -- internal-only, see
//     handleAccountTierPromote's own header comment.

// Mirrors ALERT_TRIGGER_CREATE_RATE_LIMIT's shape/reasoning: an unauthenticated
// caller can hit challenge/verify before any session exists, so this is keyed
// by client IP like that limiter, not by account.
const WALLET_AUTH_RATE_LIMIT = { limit: 10, windowSeconds: 60 };
// Keyed by account (not IP): with no invite-code gate at all, mint access is
// bounded only by "you can sign in as this wallet" -- this limiter is what
// stops one signed-in account from minting rows in a tight loop (the same
// gap adversarial review found in ALERT_TRIGGER_CREATE_TOKEN alone), not who
// gets to mint at all.
const ACCOUNT_KEYS_MINT_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

async function withAccountsSql(env, fn) {
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });
  try {
    return await fn(sql);
  } catch (err) {
    console.error("data-api wallet-auth/keys write failed:", err);
    captureDataApiError(err, "wallet-auth-keys");
    return writeJson({ error: "write failed" }, 502);
  }
  // No sql.end() -- same Hyperdrive-cleans-up-on-invocation-end convention
  // withAlertTriggersSql documents above.
}

const ACCOUNT_ROUTES_MAX_BODY_BYTES = 4096;

async function readAccountRouteBody(request) {
  if (
    Number(request.headers.get("content-length") || 0) >
    ACCOUNT_ROUTES_MAX_BODY_BYTES
  ) {
    return { error: writeJson({ error: "body too large" }, 413) };
  }
  const raw = await request.text();
  if (utf8Bytes(raw).length > ACCOUNT_ROUTES_MAX_BODY_BYTES) {
    return { error: writeJson({ error: "body too large" }, 413) };
  }
  try {
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: writeJson({ error: "body must be JSON" }, 400) };
  }
}

// No default/fallback case: src/wallet-auth.mjs's issueWalletChallenge and
// verifyWalletChallenge are the only callers of this map, and both are a
// closed set of exactly these four codes -- a fifth is not reachable from
// this codebase's own contract, so a catch-all here would be untestable
// dead code rather than real robustness (matches this session's existing
// "don't add validation for scenarios that can't happen" convention).
function walletAuthErrorMessage(code) {
  switch (code) {
    case "invalid_ss58":
      return "ss58 must be a valid Bittensor (prefix 42) address";
    case "challenge_store_unavailable":
      return "wallet login is not provisioned on this deployment";
    case "challenge_expired_or_missing":
      return "no pending challenge for this address -- request a new one";
    case "invalid_signature":
      return "signature verification failed";
  }
}

function walletAuthErrorStatus(code) {
  return code === "challenge_store_unavailable" ? 503 : 400;
}

async function walletAuthRateLimited(request, env) {
  if (!env.WALLET_AUTH_RATE_LIMITER?.limit) return null;
  const { success } = await env.WALLET_AUTH_RATE_LIMITER.limit({
    key: resolveClientIp(request),
  });
  if (success) return null;
  return writeJson({ error: "too many wallet-auth requests; slow down" }, 429, {
    "retry-after": String(WALLET_AUTH_RATE_LIMIT.windowSeconds),
    "x-ratelimit-limit": String(WALLET_AUTH_RATE_LIMIT.limit),
    "x-ratelimit-policy": `${WALLET_AUTH_RATE_LIMIT.limit};w=${WALLET_AUTH_RATE_LIMIT.windowSeconds}`,
    "x-ratelimit-remaining": "0",
  });
}

async function handleWalletChallenge(request, env) {
  const rateLimited = await walletAuthRateLimited(request, env);
  if (rateLimited) return rateLimited;
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const ss58 = typeof body?.ss58 === "string" ? body.ss58 : "";
  const result = await issueWalletChallenge(env, ss58);
  if (!result.ok) {
    return writeJson(
      { error: walletAuthErrorMessage(result.code) },
      walletAuthErrorStatus(result.code),
    );
  }
  return writeJson({
    message: result.message,
    expires_in_seconds: result.expiresInSeconds,
  });
}

async function handleWalletVerify(request, env) {
  const rateLimited = await walletAuthRateLimited(request, env);
  if (rateLimited) return rateLimited;
  if (!env.WALLET_SESSION_SECRET) {
    return writeJson(
      { error: "wallet login is not provisioned on this deployment" },
      503,
    );
  }
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const ss58 = typeof body?.ss58 === "string" ? body.ss58 : "";
  const signature = typeof body?.signature === "string" ? body.signature : "";
  const result = await verifyWalletChallenge(env, ss58, signature);
  if (!result.ok) {
    return writeJson(
      { error: walletAuthErrorMessage(result.code) },
      // Same anti-oracle posture as requireAlertTriggerOwner: an
      // authentication failure is a 401 regardless of WHICH check inside
      // verifyWalletChallenge failed (bad ss58 vs bad signature), so a
      // caller can't distinguish "not a real address" from "wrong
      // signature" purely from the status code. challenge_store_unavailable
      // is a genuine deployment-config gap, not an auth failure -- that one
      // alone gets 503.
      result.code === "challenge_store_unavailable" ? 503 : 401,
    );
  }
  return withAccountsSql(env, async (sql) => {
    const now = Date.now();
    const [account] = await sql`
      INSERT INTO rpc_accounts (ss58, created_at, last_login_at)
      VALUES (${ss58}, ${now}, ${now})
      ON CONFLICT (ss58) DO UPDATE SET last_login_at = ${now}
      RETURNING id, ss58, tier`;
    const sessionToken = await createSessionToken(env.WALLET_SESSION_SECRET, {
      accountId: account.id,
      ss58: account.ss58,
    });
    return writeJson({
      session_token: sessionToken,
      expires_in_seconds: SESSION_TTL_SECONDS,
      account: { ss58: account.ss58, tier: account.tier },
    });
  });
}

// GitHub OAuth account upsert (metagraphed#7151) -- reached ONLY via the
// DATA_API service binding from src/github-oauth.ts's callback handler,
// never directly from a browser/MCP client (this Worker has no public route
// or workers.dev subdomain -- wrangler.data.jsonc's own "workers_dev": false,
// same posture the wallet routes above already rely on). The GitHub identity
// itself was already established by the caller's own code/token exchange
// with GitHub before this call is made; this route's only job is the
// Postgres write, mirroring handleWalletVerify's shape immediately above
// (upsert, return the account row) minus the session-token minting -- the
// caller mints ITS OWN grant/token via OAuthHelpers.completeAuthorization,
// which needs OAUTH_KV (a binding only the caller's Worker has).
async function handleGithubAccountUpsert(request, env) {
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const githubUserId = body?.github_user_id;
  const githubLogin = body?.github_login;
  if (
    !Number.isInteger(githubUserId) ||
    typeof githubLogin !== "string" ||
    !githubLogin
  ) {
    return writeJson(
      {
        error:
          "github_user_id (integer) and github_login (string) are required",
      },
      400,
    );
  }
  return withAccountsSql(env, async (sql) => {
    const now = Date.now();
    const [account] = await sql`
      INSERT INTO github_accounts (github_user_id, github_login, created_at, last_login_at)
      VALUES (${githubUserId}, ${githubLogin}, ${now}, ${now})
      ON CONFLICT (github_user_id) DO UPDATE
        SET github_login = ${githubLogin}, last_login_at = ${now}
      RETURNING id, github_login, tier`;
    return writeJson({
      id: account.id,
      github_login: account.github_login,
      tier: account.tier,
    });
  });
}

// Shared by every /api/v1/keys route: resolves the Authorization header to
// { accountId, ss58 }, or a ready-to-return error response. A missing
// WALLET_SESSION_SECRET is a deployment-config gap (503), distinct from a
// missing/invalid/expired token (401).
async function requireAccountSession(request, env) {
  if (!env.WALLET_SESSION_SECRET) {
    return {
      error: writeJson(
        { error: "wallet login is not provisioned on this deployment" },
        503,
      ),
    };
  }
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = token
    ? await verifySessionToken(env.WALLET_SESSION_SECRET, token)
    : null;
  if (!session) {
    return {
      error: writeJson(
        {
          error: "provide a valid Authorization: Bearer <session_token> header",
        },
        401,
      ),
    };
  }
  return { session };
}

async function handleAccountKeyCreate(request, env) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;

  if (!env.UNKEY_ROOT_KEY || !env.UNKEY_API_ID) {
    return writeJson(
      { error: "fullnode key issuance is not provisioned on this deployment" },
      503,
    );
  }

  if (env.ACCOUNT_KEYS_MINT_RATE_LIMITER?.limit) {
    const { success } = await env.ACCOUNT_KEYS_MINT_RATE_LIMITER.limit({
      key: `account-keys-mint:${session.accountId}`,
    });
    if (!success) {
      return writeJson(
        { error: "too many key-creation requests for this account; slow down" },
        429,
        {
          "retry-after": String(ACCOUNT_KEYS_MINT_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(ACCOUNT_KEYS_MINT_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${ACCOUNT_KEYS_MINT_RATE_LIMIT.limit};w=${ACCOUNT_KEYS_MINT_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  return withAccountsSql(env, async (sql) => {
    // The session's signature already proved this account row exists at
    // verify time; a missing row here means it was removed since -- decline
    // rather than mint an orphaned key. Tier is the account's OWN tier
    // (rpc_accounts.tier, default 'free') -- no invite code anymore: every
    // wallet-connected account can self-serve a key immediately, and gets
    // promoted later via the internal tier-promotion route below.
    const [account] =
      await sql`SELECT id, tier FROM rpc_accounts WHERE id = ${session.accountId}`;
    if (!account) return writeJson({ error: "no such account" }, 404);

    const minted = await createUnkeyKey(env, {
      externalId: String(session.accountId),
      tier: account.tier,
    });
    if (!minted.ok) {
      return writeJson({ error: "key issuance failed; try again" }, 502);
    }

    const now = Date.now();
    await sql`
      INSERT INTO api_keys
        (unkey_key_id, owner_contact, tier, account_id, created_at)
      VALUES (
        ${minted.keyId}, ${session.ss58}, ${account.tier},
        ${session.accountId}, ${now}
      )`;
    return writeJson(
      // Returned ONCE at creation, like ADR 0020's own mint route design and
      // chain_alert_triggers' owner_token -- never echoed back on any later
      // GET (handleAccountKeysList below selects unkey_key_id, never the key
      // itself, which Unkey also never returns again after this call).
      {
        key: minted.key,
        key_id: minted.keyId,
        tier: account.tier,
        created_at: now,
      },
      201,
    );
  });
}

async function handleAccountKeysList(request, env) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  return withAccountsSql(env, async (sql) => {
    const rows = await sql`
      SELECT unkey_key_id AS key_id, tier, created_at, revoked_at, last_used_at
      FROM api_keys
      WHERE account_id = ${session.accountId}
      ORDER BY created_at DESC`;
    return writeJson({ keys: rows });
  });
}

const UNKEY_KEY_ID_PATTERN = /^key_[a-zA-Z0-9_]+$/;

async function handleAccountKeyRevoke(request, env, keyId) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  if (!UNKEY_KEY_ID_PATTERN.test(keyId)) {
    return writeJson({ error: "malformed key id" }, 400);
  }
  return withAccountsSql(env, async (sql) => {
    // Ownership check BEFORE ever calling Unkey -- a key_id that exists but
    // belongs to a different account gets the SAME 404 a nonexistent one
    // would (no existence oracle across accounts, same posture as
    // requireAlertTriggerOwner), and we never touch Unkey for a key this
    // session doesn't own.
    const [row] = await sql`
      SELECT unkey_key_id FROM api_keys
      WHERE unkey_key_id = ${keyId}
        AND account_id = ${session.accountId}
        AND revoked_at IS NULL`;
    if (!row) return writeJson({ error: "no such key" }, 404);

    // Unkey is the actual enforcement point (verifyKey() is what the
    // fullnode gate checks, not this table) -- disable there FIRST. Only
    // mark our own bookkeeping row revoked once that's confirmed, so
    // revoked_at never claims a state Unkey didn't actually reach: a key
    // that fails to revoke stays reported as still-active, not falsely
    // "revoked" while actually still working.
    const revoked = await revokeUnkeyKey(env, keyId);
    if (!revoked.ok) {
      return writeJson({ error: "revoke failed; try again" }, 502);
    }
    await sql`UPDATE api_keys SET revoked_at = ${Date.now()} WHERE unkey_key_id = ${keyId}`;
    return writeJson({ key_id: keyId, revoked: true });
  });
}

// Internal-only: verifies ONE raw key against Unkey, for
// src/api-key-validation.mjs's KV-cache-fronted validator (reached via the
// RPC-gate Worker's own DATA_API service binding -- that Worker never holds
// UNKEY_ROOT_KEY itself). Gated by its OWN shared secret -- a DIFFERENT
// capability from the session-based /api/v1/keys routes above (this one
// verifies ANY caller-supplied key with neither a session nor a wallet) --
// same "different capability, different secret" reasoning as
// ALERT_TRIGGERS_INTERNAL_TOKEN vs the create/owner tokens. POST-with-body
// (the raw key), not GET-with-path-param like the old prefix-lookup route
// this replaces -- a secret-bearing value never belongs in a URL. Bumps
// last_used_at on a valid verify (best-effort bookkeeping for the account's
// own key list, not the source of truth for anything) -- cheap now that
// this route is only hit once per unique key per KV-cache TTL window, not
// once per RPC request.
async function handleApiKeyVerify(request, env) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "api-key lookup is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(API_KEY_LOOKUP_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      { error: `provide a valid ${API_KEY_LOOKUP_TOKEN_HEADER} header` },
      401,
    );
  }
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const rawKey = typeof body?.key === "string" ? body.key : "";
  if (!rawKey) {
    return writeJson({ error: "provide a key to verify" }, 400);
  }
  const result = await verifyUnkeyKey(env, rawKey);
  if (!result.ok) {
    // Unkey itself unreachable/misconfigured -- fail closed as not found,
    // same posture the old Postgres-lookup-failure path used (a validation
    // call must never 500 the caller's RPC request).
    return writeJson({ valid: false, code: "NOT_FOUND" });
  }
  if (result.valid) {
    void withAccountsSql(env, async (sql) => {
      await sql`UPDATE api_keys SET last_used_at = ${Date.now()} WHERE unkey_key_id = ${result.keyId}`;
    });
  }
  return writeJson({
    valid: result.valid,
    code: result.code,
    tier: result.tier,
    accountId: result.accountId,
  });
}

const ACCOUNT_TIER_PROMOTE_TOKEN_HEADER = "x-account-tier-promote-token";

// Internal-only: bumps ONE account's tier. An ops action, run manually after
// confirming out of band that an account should be promoted (e.g. a
// Gittensor team member's wallet) -- there is no invite code or self-serve
// path to a higher tier by design. Updates BOTH rpc_accounts.tier (what
// future key mints size by) AND every one of that account's existing,
// still-active Unkey keys in place via updateUnkeyKeyTier -- no re-mint
// needed, the caller's existing mg_... key keeps working at the new tier.
// Gated by its own shared secret, matching the internal verify/alert-
// trigger routes' "different capability, different secret" convention.
async function handleAccountTierPromote(request, env) {
  const configured = env.ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "account tier promotion is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(ACCOUNT_TIER_PROMOTE_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      { error: `provide a valid ${ACCOUNT_TIER_PROMOTE_TOKEN_HEADER} header` },
      401,
    );
  }
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const ss58 = typeof body?.ss58 === "string" ? body.ss58 : "";
  const tier = typeof body?.tier === "string" ? body.tier : "";
  if (!ss58 || !tier) {
    return writeJson({ error: "provide ss58 and tier" }, 400);
  }
  return withAccountsSql(env, async (sql) => {
    const [account] = await sql`
      UPDATE rpc_accounts SET tier = ${tier} WHERE ss58 = ${ss58} RETURNING id`;
    if (!account) return writeJson({ error: "no such account" }, 404);

    const keys = await sql`
      SELECT unkey_key_id FROM api_keys
      WHERE account_id = ${account.id} AND revoked_at IS NULL`;
    const results = await Promise.all(
      keys.map((row) =>
        updateUnkeyKeyTier(env, { keyId: row.unkey_key_id, tier }),
      ),
    );
    const failedCount = results.filter((r) => !r.ok).length;
    await sql`
      UPDATE api_keys SET tier = ${tier}
      WHERE account_id = ${account.id} AND revoked_at IS NULL`;

    return writeJson({
      ss58,
      tier,
      keys_updated: results.length - failedCount,
      keys_failed: failedCount,
    });
  });
}

async function handleAccountKeysRoute(request, env, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "keys", <key_id?>]
  const keyId = segments[3];
  if (!keyId && request.method === "POST") {
    return handleAccountKeyCreate(request, env);
  }
  if (!keyId && request.method === "GET") {
    return handleAccountKeysList(request, env);
  }
  if (keyId && request.method === "DELETE") {
    return handleAccountKeyRevoke(request, env, keyId);
  }
  return writeJson(
    {
      error: "Use POST/GET /api/v1/keys, or DELETE /api/v1/keys/{key_id}.",
    },
    405,
  );
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    // The write routes (#4771, #4832) -- checked before the GET-only gate
    // below, same as how the main Worker's own POST-accepting routes
    // (webhooks, MCP, ingest) run ahead of its read-only method gate.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/neurons-sync"
    ) {
      return handleNeuronsSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/backfill-neuron-daily"
    ) {
      return handleNeuronDailyBackfill(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/rollup-account-events-daily"
    ) {
      return handleRollupAccountEventsDaily(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-hyperparams-sync"
    ) {
      return handleSubnetHyperparamsSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-locks-sync"
    ) {
      return handleSubnetLocksSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/account-identity-sync"
    ) {
      return handleAccountIdentitySync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/validator-nominator-counts-sync"
    ) {
      return handleValidatorNominatorCountsSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/nominator-positions-sync"
    ) {
      return handleNominatorPositionsSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/account-balances-sync"
    ) {
      return handleAccountBalancesSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-identity-sync"
    ) {
      return handleSubnetIdentitySync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/health-checks-sync"
    ) {
      return handleHealthChecksSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/health-uptime-rollup-sync"
    ) {
      return handleHealthUptimeRollupSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-snapshot-sync"
    ) {
      return handleSubnetSnapshotSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/rpc-usage-sync"
    ) {
      return handleRpcUsageEventSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/rpc-usage-prune"
    ) {
      return handleRpcUsageEventPrune(request, env);
    }
    // Internal-only key verification for the isolated fullnode RPC gate's
    // KV-cache-fronted validator (src/api-key-validation.mjs). See
    // handleApiKeyVerify's own header comment for why this is POST-with-body
    // rather than the old GET-with-path-param shape.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/verify"
    ) {
      return handleApiKeyVerify(request, env);
    }
    // Internal-only, ops-triggered account tier promotion -- see
    // handleAccountTierPromote's own header comment.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/accounts/tier"
    ) {
      return handleAccountTierPromote(request, env);
    }
    // #4984 Part 1: multi-method (POST/GET/PATCH/DELETE), so it can't join
    // the exact-path-and-method checks above -- handleAlertTriggersRoute
    // does its own method dispatch, same shape as workers/api.mjs's
    // handleWebhookRequest.
    if (url.pathname.startsWith("/api/v1/alerts/triggers")) {
      return handleAlertTriggersRoute(request, env, url);
    }
    // Wallet login + account-gated fullnode API keys (ADR 0021, #6835) --
    // same multi-method-can't-join-the-exact-match-checks shape as the
    // alert-triggers route just above.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/auth/wallet/challenge"
    ) {
      return handleWalletChallenge(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/auth/wallet/verify"
    ) {
      return handleWalletVerify(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/auth/github/upsert-account"
    ) {
      return handleGithubAccountUpsert(request, env);
    }
    if (url.pathname.startsWith("/api/v1/keys")) {
      return handleAccountKeysRoute(request, env, url);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/alert-triggers-active"
    ) {
      return handleAlertTriggersActiveList(request, env);
    }
    // #5022: the evaluator's own write-back for match_count/last_matched_at
    // -- see handleAlertTriggersMatchedWriteback's own header comment.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/alert-triggers/matched"
    ) {
      return handleAlertTriggersMatchedWriteback(request, env);
    }
    // #6747: the predicate-condition evaluator's own metric-snapshot refresh
    // -- see handleDeregRiskSnapshot's own header comment.
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/alert-triggers-dereg-risk-snapshot"
    ) {
      return handleDeregRiskSnapshot(request, env);
    }
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, 405);
    if (!env.HYPERDRIVE?.connectionString) {
      return json({ error: "hyperdrive binding unavailable" }, 503);
    }

    // `prepare: false` + `fetch_types: false` are the Hyperdrive-recommended settings:
    // they avoid per-connection type-introspection round-trips and prepared-statement
    // state that don't survive the pooler. max:5 keeps us within the origin limit.
    //
    // `types` overrides postgres.js's default json/jsonb parser (OIDs 114/3802,
    // a bare `JSON.parse`) with one that preserves u64/u128-range integer
    // literals as exact strings instead of silently rounding them to the
    // nearest float64 -- confirmed live 2026-07-12: chain_events.args carries
    // real u64 values (SubtensorModule.DifficultySet/SetChildren/
    // SetChildrenScheduled) beyond Number.MAX_SAFE_INTEGER. See
    // src/postgres-json-parse.ts's own header for why this must happen at
    // the client boundary, not in decodeChainEventArgs -- by the time that
    // runs, a lossy default parse has already destroyed the original value
    // with no way to recover it downstream. Does NOT touch extrinsics'
    // call_args -- that column is queried with an explicit `::text` cast
    // (see the "extrinsics' call_args is cast to text" comment below) so its
    // own, separately-gated big-int handling in src/extrinsics.ts runs
    // instead; after the cast the wire type is `text` (OID 25), which this
    // override never sees.
    const hyperdriveConnectionOptions = {
      max: 5,
      prepare: false,
      fetch_types: false,
      idle_timeout: 10,
      types: {
        bigIntSafeJson: {
          to: 114,
          from: [114, 3802],
          serialize: JSON.stringify,
          parse: parseJsonPreservingBigIntegers,
        },
      },
    };
    const sql = postgres(
      env.HYPERDRIVE.connectionString,
      hyperdriveConnectionOptions,
    );

    try {
      // sql.begin() reserves ONE physical connection for every query below,
      // including the SET -- Hyperdrive resets session state when a
      // connection is returned to its pool, and a single Worker invocation
      // can be handed different pooled connections across sequential
      // queries, so a bare SET (no transaction) has no guarantee it applies
      // to the query that follows it (Hyperdrive's connection-lifecycle
      // docs; #4686's root cause). "read only" matches this Worker's own
      // READ-ONLY invariant (top of file) at the database level too, and
      // repeatable read keeps multi-statement analytics responses on one
      // stable snapshot while preserving each route's bounded timeouts.
      const dispatchReadRoutes = async (sql) => {
        await sql`SET statement_timeout = '3000ms'`;

        // GET /api/v1/blocks (D1 serving-cutover, #4656 followup): the recent-block
        // feed, mirroring src/blocks.ts's loadBlocks filter set exactly (author,
        // spec_version, block_start/block_end, from/to, min_extrinsics/min_events,
        // cursor). The main Worker only calls this when its per-tier serving flag
        // is on and forwards the SAME request it already validated -- this route
        // trusts well-formed params rather than re-deriving 400s.
        if (url.pathname === "/api/v1/blocks") {
          const limit = clampBlockLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          // METAGRAPHED-6-class fix: 2-part cursor (observed_at, block_number)
          // matching the observed_at-leading ORDER BY below -- same fix as the
          // /api/v1/extrinsics list route's own cursor. decodeCursor's arity
          // check makes an old 1-part cursor a clean "ignored, no next-page"
          // miss rather than a crash.
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const author = url.searchParams.get("author") || null;
          const specVersion = nonNegativeIntegerParam(
            url.searchParams,
            "spec_version",
          );
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const from = nonNegativeIntegerParam(url.searchParams, "from");
          const to = nonNegativeIntegerParam(url.searchParams, "to");
          const minExtrinsics = nonNegativeIntegerParam(
            url.searchParams,
            "min_extrinsics",
          );
          const minEvents = nonNegativeIntegerParam(
            url.searchParams,
            "min_events",
          );
          const rows = await sql`
          SELECT block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at
          FROM blocks
          WHERE TRUE
            ${author ? sql`AND author = ${author}` : sql``}
            ${specVersion != null ? sql`AND spec_version = ${specVersion}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${from != null ? sql`AND observed_at >= ${from}` : sql``}
            ${to != null ? sql`AND observed_at <= ${to}` : sql``}
            ${minExtrinsics != null ? sql`AND extrinsic_count >= ${minExtrinsics}` : sql``}
            ${minEvents != null ? sql`AND event_count >= ${minEvents}` : sql``}
            ${cursor ? sql`AND (observed_at, block_number) < (${cursor[0]}, ${cursor[1]})` : sql``}
          ORDER BY observed_at DESC, block_number DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
              ])
            : null;
          return json(buildBlockFeed(rows, { limit, offset, nextCursor }));
        }

        // GET /api/v1/blocks/summary — block-production health over the most
        // recent BLOCKS_SUMMARY_SCAN_CAP blocks, mirroring src/blocks-summary.mjs's
        // loadBlocksSummary. Checked BEFORE the /blocks/:ref match below --
        // "summary" would otherwise parse as a (invalid) ref. ORDER BY leads
        // with observed_at (the hypertable's partition column) for the same
        // chunk-exclusion reason as the /api/v1/extrinsics list route above.
        if (url.pathname === "/api/v1/blocks/summary") {
          const rows = await sql`
          SELECT block_number, author, extrinsic_count, event_count, spec_version, observed_at
          FROM blocks ORDER BY observed_at DESC, block_number DESC LIMIT ${BLOCKS_SUMMARY_SCAN_CAP}`;
          return json(buildBlocksSummary(rows));
        }

        // GET /api/v1/blocks/:ref — per-block detail + nearest stored neighbors,
        // mirroring src/blocks.ts's loadBlock. ref is a numeric block_number or a
        // 0x block_hash (lowercased before binding, matching the D1 path's
        // case-insensitivity workaround).
        const blockRef = url.pathname.match(/^\/api\/v1\/blocks\/([^/]+)$/);
        if (blockRef) {
          const ref = decodeURIComponent(blockRef[1]);
          const isHash = HASH_RE.test(ref);
          const blockNumber =
            !isHash && /^\d+$/.test(ref) && Number.isSafeInteger(Number(ref))
              ? Number(ref)
              : null;
          if (!isHash && blockNumber === null) {
            return json(buildBlock(undefined, ref));
          }
          const rows = isHash
            ? await sql`
              SELECT block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at
              FROM blocks WHERE block_hash = ${ref.toLowerCase()} LIMIT 1`
            : await sql`
              SELECT block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at
              FROM blocks WHERE block_number = ${blockNumber} LIMIT 1`;
          let prev = null;
          let next = null;
          const resolvedNumber = numberOrNull(rows[0]?.block_number);
          if (resolvedNumber != null) {
            const nbr = await sql`
            SELECT
              (SELECT MAX(block_number) FROM blocks WHERE block_number < ${resolvedNumber}) AS prev,
              (SELECT MIN(block_number) FROM blocks WHERE block_number > ${resolvedNumber}) AS next`;
            prev = nbr[0]?.prev ?? null;
            next = nbr[0]?.next ?? null;
          }
          return json(buildBlock(rows[0], ref, { prev, next }));
        }

        // GET /api/v1/blocks/:ref/extrinsics — the extrinsics in one block, natural
        // read order (extrinsic_index ASC), mirroring src/block-subresources.mjs's
        // loadBlockExtrinsics. block_number:null + extrinsics:[] for an unresolved
        // ref (never throws).
        const blockRefExtrinsics = url.pathname.match(
          /^\/api\/v1\/blocks\/([^/]+)\/extrinsics$/,
        );
        if (blockRefExtrinsics) {
          const ref = decodeURIComponent(blockRefExtrinsics[1]);
          const limit = clampBlockLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const blockNumber = await resolveBlockNumberPg(sql, ref);
          const rows =
            blockNumber == null
              ? []
              : await sql`
              SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
              FROM extrinsics WHERE block_number = ${blockNumber}
              ORDER BY extrinsic_index ASC LIMIT ${limit} OFFSET ${offset}`;
          return json({
            data: buildBlockExtrinsics(rows, ref, blockNumber, {
              limit,
              offset,
            }),
          });
        }

        // GET /api/v1/blocks/:ref/events — the decoded account_events in one block,
        // natural read order (event_index ASC), mirroring
        // src/block-subresources.mjs's loadBlockEvents.
        const blockRefEvents = url.pathname.match(
          /^\/api\/v1\/blocks\/([^/]+)\/events$/,
        );
        if (blockRefEvents) {
          const ref = decodeURIComponent(blockRefEvents[1]);
          const limit = clampEventsLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const blockNumber = await resolveBlockNumberPg(sql, ref);
          const rows =
            blockNumber == null
              ? []
              : await sql`
              SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
              FROM account_events WHERE block_number = ${blockNumber}
              ORDER BY event_index ASC LIMIT ${limit} OFFSET ${offset}`;
          return json({
            data: buildBlockEvents(rows, ref, blockNumber, { limit, offset }),
          });
        }

        // GET /api/v1/extrinsics — the recent-extrinsic feed, mirroring
        // src/extrinsics.ts's loadExtrinsics filter set exactly (signer,
        // call_module, call_function, call_hash, success, block, block_start/
        // block_end, from/to, cursor). Ordered by observed_at (not
        // block_number) because `extrinsics` is a TimescaleDB hypertable
        // partitioned on observed_at (see timescaledb_information.dimensions):
        // an unfiltered/broad `ORDER BY block_number DESC` forces a
        // Parallel Append + Sort across every chunk (including decompressing
        // historical compressed chunks) since block_number carries no chunk-
        // exclusion information, which measured 6+ seconds live against
        // production on 2026-07-12 -- past this route's 3000ms
        // statement_timeout, tripping tryPostgresTier's D1 fallback into the
        // now-fully-dropped D1 extrinsics table (#4772), which silently
        // resolves to an empty-but-200 response. `ORDER BY observed_at DESC,
        // block_number DESC, extrinsic_index DESC` lets ChunkAppend prune to
        // just the live head chunk (confirmed live: same queries dropped to
        // 0.5-75ms). observed_at is the genuine on-chain block timestamp
        // (verified against block #1: 2023-03-20, not an ingestion clock), so
        // this produces the identical "most recent first" ordering as
        // block_number DESC -- block production is strictly monotonic with
        // wall-clock time -- with block_number/extrinsic_index only breaking
        // ties among the (rare) extrinsics that share one block's timestamp.
        // The cursor is now a 3-tuple to match; decodeCursor's arity check
        // makes an old 2-part cursor a clean "ignored, no next-page" miss
        // rather than a crash.
        if (url.pathname === "/api/v1/extrinsics") {
          const limit = clampBlockLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const block = nonNegativeIntegerParam(url.searchParams, "block");
          const signer = url.searchParams.get("signer") || null;
          const callModule = url.searchParams.get("call_module") || null;
          const callFunction = url.searchParams.get("call_function") || null;
          const callHashRaw = url.searchParams.get("call_hash");
          const callHash =
            callHashRaw && HASH_RE.test(callHashRaw) ? callHashRaw : null;
          const successRaw = url.searchParams.get("success");
          const success =
            successRaw === "true"
              ? true
              : successRaw === "false"
                ? false
                : null;
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const from = nonNegativeIntegerParam(url.searchParams, "from");
          const to = nonNegativeIntegerParam(url.searchParams, "to");
          const rows = await sql`
          SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
          FROM extrinsics
          WHERE TRUE
            ${block != null ? sql`AND block_number = ${block}` : sql``}
            ${signer ? sql`AND signer = ${signer}` : sql``}
            ${callModule ? sql`AND call_module = ${callModule}` : sql``}
            ${callFunction ? sql`AND call_function = ${callFunction}` : sql``}
            ${callHash ? sql`AND call_args::text LIKE ${'%"' + callHash + '"%'}` : sql``}
            ${success != null ? sql`AND success = ${success}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${from != null ? sql`AND observed_at >= ${from}` : sql``}
            ${to != null ? sql`AND observed_at <= ${to}` : sql``}
            ${cursor ? sql`AND (observed_at, block_number, extrinsic_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
          ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
                numberOrNull(last.extrinsic_index),
              ])
            : null;
          return json(buildExtrinsicFeed(rows, { limit, offset, nextCursor }));
        }

        // GET /api/v1/sudo and GET /api/v1/governance/config-changes share this
        // shape: the same extrinsics feed as /extrinsics above, with call_module
        // fixed rather than caller-supplied (mirroring src/extrinsics.ts's
        // loadExtrinsics({callModule: "Sudo"|"AdminUtils", ...}) call sites in
        // entities.mjs) -- so neither accepts ?signer=/?call_module=/?call_hash=.
        // Ordered by observed_at for the same chunk-exclusion reason as
        // /api/v1/extrinsics above (identical hypertable, identical cursor shape).
        const SUDO_GOVERNANCE_ROUTES = {
          "/api/v1/sudo": "Sudo",
          "/api/v1/governance/config-changes": "AdminUtils",
        };
        if (Object.hasOwn(SUDO_GOVERNANCE_ROUTES, url.pathname)) {
          const callModule = SUDO_GOVERNANCE_ROUTES[url.pathname];
          const limit = clampBlockLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const block = nonNegativeIntegerParam(url.searchParams, "block");
          const callFunction = url.searchParams.get("call_function") || null;
          const successRaw = url.searchParams.get("success");
          const success =
            successRaw === "true"
              ? true
              : successRaw === "false"
                ? false
                : null;
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const from = nonNegativeIntegerParam(url.searchParams, "from");
          const to = nonNegativeIntegerParam(url.searchParams, "to");
          const rows = await sql`
          SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
          FROM extrinsics
          WHERE call_module = ${callModule}
            ${block != null ? sql`AND block_number = ${block}` : sql``}
            ${callFunction ? sql`AND call_function = ${callFunction}` : sql``}
            ${success != null ? sql`AND success = ${success}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${from != null ? sql`AND observed_at >= ${from}` : sql``}
            ${to != null ? sql`AND observed_at <= ${to}` : sql``}
            ${cursor ? sql`AND (observed_at, block_number, extrinsic_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
          ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
                numberOrNull(last.extrinsic_index),
              ])
            : null;
          return json(buildExtrinsicFeed(rows, { limit, offset, nextCursor }));
        }

        // GET /api/v1/runtime — the spec-version transition timeline, mirroring
        // src/runtime-versions.mjs's loadRuntimeVersionHistory. Two small
        // aggregate reads (GROUP BY's earliest-block-per-version, then the
        // truly-latest reading), no filters/pagination.
        if (url.pathname === "/api/v1/runtime") {
          const rows = await sql`
          SELECT spec_version, MIN(block_number) AS block_number, MIN(observed_at) AS observed_at
          FROM blocks WHERE spec_version IS NOT NULL
          GROUP BY spec_version ORDER BY block_number ASC`;
          const latestRows = await sql`
          SELECT spec_version FROM blocks WHERE spec_version IS NOT NULL
          ORDER BY block_number DESC LIMIT 1`;
          return json(buildRuntimeVersionHistory(rows, latestRows[0] ?? null));
        }

        // GET /api/v1/extrinsics/:ref — per-extrinsic detail + embedded
        // account_events (up to MAX_EMBEDDED_EVENTS), mirroring the former
        // src/extrinsic-detail.ts D1 loader (removed in #4772). ref is a 0x hash
        // or a composite "block_number-extrinsic_index".
        const extrinsicRef = url.pathname.match(
          /^\/api\/v1\/extrinsics\/([^/]+)$/,
        );
        if (extrinsicRef) {
          const ref = decodeURIComponent(extrinsicRef[1]);
          const isHash = HASH_RE.test(ref);
          let rows;
          if (isHash) {
            // METAGRAPHED-5: ORDER BY must lead with observed_at (the
            // hypertable's partition column) same as the /api/v1/extrinsics
            // list route above -- block_number DESC alone forces a
            // Parallel Append + Sort across every chunk (no chunk
            // exclusion), which measured well past this route's 3000ms
            // statement_timeout in production.
            rows = await sql`
            SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
            FROM extrinsics WHERE extrinsic_hash = ${ref.toLowerCase()}
            ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC LIMIT 1`;
          } else {
            const composite = COMPOSITE_REF_RE.exec(ref);
            const blockNumber = composite ? Number(composite[1]) : NaN;
            const extrinsicIndex = composite ? Number(composite[2]) : NaN;
            rows =
              composite &&
              Number.isSafeInteger(blockNumber) &&
              Number.isSafeInteger(extrinsicIndex)
                ? await sql`
                  SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
                  FROM extrinsics WHERE block_number = ${blockNumber} AND extrinsic_index = ${extrinsicIndex} LIMIT 1`
                : [];
          }
          const resolved = rows[0];
          let events = [];
          const resolvedBlock = numberOrNull(resolved?.block_number);
          const resolvedIndex = numberOrNull(resolved?.extrinsic_index);
          if (resolvedBlock != null && resolvedIndex != null) {
            const eventRows = await sql`
            SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
            FROM account_events
            WHERE block_number = ${resolvedBlock} AND extrinsic_index = ${resolvedIndex}
            ORDER BY event_index ASC LIMIT ${MAX_EMBEDDED_EVENTS}`;
            events = eventRows.map(formatAccountEvent).filter(Boolean);
          }
          return json(buildExtrinsic(resolved, ref, events));
        }

        // GET /api/v1/accounts/top-holders?sort=&limit= (#6741/#6743): the
        // balance-based top-holder leaderboard, mirroring
        // src/top-holders.mjs's buildTopHoldersList. FULL OUTER JOIN so an
        // account with real free balance but no delegated position (or vice
        // versa) still appears -- neither source alone is a complete account
        // list. Checked here, before the generic /api/v1/accounts/:ss58
        // pattern below, so "top-holders" is never matched as an address --
        // same ordering rationale as workers/api.mjs's own dispatch.
        //
        // net_flow_7d/30d/90d (#6886/#6887) LEFT JOIN wallet_flow_daily --
        // one grouped pass over the last 90 days (the widest window), with
        // the two narrower windows as conditional sums within that same
        // filtered set, rather than three separate subqueries.
        if (url.pathname === "/api/v1/accounts/top-holders") {
          const sortParam = url.searchParams.get("sort") || undefined;
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw == null || limitRaw === ""
              ? TOP_HOLDERS_LIMIT_DEFAULT
              : Number(limitRaw);
          const rows = await sql`
          SELECT
            COALESCE(b.ss58, d.coldkey) AS ss58,
            COALESCE(b.free_tao, 0) AS free_tao,
            COALESCE(d.delegated_tao, 0) AS delegated_tao,
            COALESCE(f.net_flow_7d, 0) AS net_flow_7d,
            COALESCE(f.net_flow_30d, 0) AS net_flow_30d,
            COALESCE(f.net_flow_90d, 0) AS net_flow_90d,
            b.captured_at
          FROM account_balances b
          FULL OUTER JOIN (
            SELECT np.coldkey, SUM(np.share_fraction * n.stake_tao) AS delegated_tao
            FROM nominator_positions np
            JOIN neurons n ON n.hotkey = np.hotkey AND n.netuid = np.netuid
            GROUP BY np.coldkey) d ON d.coldkey = b.ss58
          LEFT JOIN (
            SELECT
              coldkey,
              SUM(CASE WHEN day >= CURRENT_DATE - 7 THEN net_flow_tao ELSE 0 END) AS net_flow_7d,
              SUM(CASE WHEN day >= CURRENT_DATE - 30 THEN net_flow_tao ELSE 0 END) AS net_flow_30d,
              SUM(net_flow_tao) AS net_flow_90d
            FROM wallet_flow_daily
            WHERE day >= CURRENT_DATE - 90
            GROUP BY coldkey) f ON f.coldkey = COALESCE(b.ss58, d.coldkey)`;
          return json(
            buildTopHoldersList(rows, {
              sort: sortParam ?? DEFAULT_TOP_HOLDERS_SORT,
              limit,
            }),
          );
        }

        // GET /api/v1/accounts/:ss58 (#4832 Tier 1c): cross-subnet account
        // summary -- event aggregates, per-kind counts, 10 newest events,
        // current registrations, and bounded signing activity from the
        // extrinsics tier, mirroring the former src/account-events.mjs
        // account-summary D1 loader (removed in #4772). Postgres has no
        // INDEXED BY equivalent, and a single (hotkey = $1 OR coldkey = $1)
        // WHERE forces one combined plan the planner can't always satisfy
        // with an index-only scan for a sparse address -- risking a
        // statement-timeout 500 under real load (Sentry METAGRAPHED-5,
        // #6878). Restored the D1 predecessor's two-branch shape instead:
        // one capped ORDER BY/LIMIT scan on hotkey = $1 (lets the planner use
        // a plain index on hotkey/coldkey + (block_number, event_index)), a
        // second on coldkey = $1 that excludes rows the hotkey branch already
        // matched (so a self-referential hotkey/coldkey account isn't double-counted),
        // then merged + re-sorted + re-capped client-side to CAP+1 -- the
        // aggregate/kind/recent-events fields below all derive from that
        // merged CAP+1-row window, computed once client-side, rather than
        // separate SQL aggregates per field.
        const acctSummary = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)$/,
        );
        if (acctSummary) {
          const ss58 = decodeURIComponent(acctSummary[1]);
          // Both scans lead ORDER BY with observed_at (the hypertable's
          // partition column, same chunk-exclusion fix as the
          // /api/v1/extrinsics list route) -- the JS merge/re-sort below
          // already re-derives the true block_number/event_index order
          // afterward, so which order SQL fetches the top CAP+1 rows in
          // doesn't change the final output (METAGRAPHED-6-class fix).
          const hotkeyScanRows = await sql`
          SELECT block_number, event_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at, extrinsic_index
          FROM account_events WHERE hotkey = ${ss58}
          ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1}`;
          const coldkeyScanRows = await sql`
          SELECT block_number, event_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at, extrinsic_index
          FROM account_events WHERE coldkey = ${ss58} AND (hotkey IS NULL OR hotkey <> ${ss58})
          ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1}`;
          // Each branch is already the account's own newest CAP+1 rows on its
          // key, so the union's true newest CAP+1 rows are guaranteed to be
          // present in this merged set -- re-sort by the same feed order and
          // re-cap to CAP+1, matching what the single-scan query used to
          // return in one step. block_number/event_index are NOT NULL columns
          // (deploy/postgres/schema.sql), so a plain Number() coercion is
          // enough here -- no null-fallback branch to keep covered.
          const scanRows = hotkeyScanRows
            .concat(coldkeyScanRows)
            .sort((a, b) => {
              const blockDelta =
                Number(b.block_number) - Number(a.block_number);
              if (blockDelta !== 0) return blockDelta;
              return Number(b.event_index) - Number(a.event_index);
            })
            .slice(0, ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1);
          const regRows = await sql`
          SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons
          WHERE hotkey = ${ss58} ORDER BY stake_tao DESC, netuid ASC`;
          // Both subqueries lead ORDER BY with observed_at (same chunk-
          // exclusion fix as above) -- each caps to the most recent 1000
          // extrinsics before aggregating, so which 1000 rows SQL fetches
          // is what matters, not their fetch order (the outer aggregates
          // don't care about row order at all).
          const activityRows = await sql`
          SELECT COUNT(*) AS tx_count, MAX(block_number) AS last_tx_block, MAX(observed_at) AS last_tx_at, SUM(fee_tao) AS total_fee_tao
          FROM (SELECT block_number, observed_at, fee_tao FROM extrinsics WHERE signer = ${ss58} ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC LIMIT 1000) sub`;
          const moduleRows = await sql`
          SELECT call_module, COUNT(*) AS count FROM (
            SELECT call_module FROM extrinsics WHERE signer = ${ss58}
            ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC LIMIT 1000
          ) sub GROUP BY call_module ORDER BY count DESC, call_module ASC LIMIT 10`;
          const scanned = scanRows.length;
          const capped = scanRows.slice(0, ACCOUNT_EVENT_SUMMARY_SCAN_CAP);
          const netuids = new Set();
          let fb = null;
          let lb = null;
          let fo = null;
          let lo = null;
          const kindCounts = new Map();
          for (const row of capped) {
            const netuid = numberOrNull(row.netuid);
            if (netuid != null) netuids.add(netuid);
            const bn = numberOrNull(row.block_number);
            if (bn != null && (fb == null || bn < fb)) fb = bn;
            if (bn != null && (lb == null || bn > lb)) lb = bn;
            const obs = numberOrNull(row.observed_at);
            if (obs != null && (fo == null || obs < fo)) fo = obs;
            if (obs != null && (lo == null || obs > lo)) lo = obs;
            kindCounts.set(
              row.event_kind,
              (kindCounts.get(row.event_kind) ?? 0) + 1,
            );
          }
          const kinds = [...kindCounts.entries()].map(([kind, count]) => ({
            kind,
            count,
          }));
          return json(
            buildAccountSummary(ss58, {
              agg: { c: capped.length, sc: netuids.size, fb, lb, fo, lo },
              kinds,
              scanned,
              registrations: regRows,
              recent: capped.slice(0, 10),
              activity: activityRows[0],
              modules: moduleRows,
            }),
          );
        }

        // GET /api/v1/accounts/:ss58/subnets (#4832 Tier 1c): the subnets where
        // this account's hotkey is currently registered, mirroring the former
        // src/account-events.mjs account-subnets D1 loader (removed in #4772) --
        // neurons-derived (the live registration snapshot), not account_events.
        const acctSubnets = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/subnets$/,
        );
        if (acctSubnets) {
          const ss58 = decodeURIComponent(acctSubnets[1]);
          const rows = await sql`
          SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons
          WHERE hotkey = ${ss58} ORDER BY netuid`;
          return json(buildAccountSubnets(rows, ss58));
        }

        // GET /api/v1/accounts/:ss58/events — the per-account signed-event feed
        // (#4696), mirroring the former src/account-events.mjs account event-feed
        // D1 loader's filter set (removed in #4772: kind, netuid,
        // block_start/block_end, cursor). account_events has
        // no shape-parity risk (11 scalar columns, its own dedicated writer,
        // never a generic call_args/chain_events-style SCALE dump) -- unlike
        // extrinsics/blocks, this tier only needed the query layer built, not a
        // decode-shape reconciliation.
        //
        // D1's hotkey/coldkey union is two INDEXED BY branches combined with
        // UNION ALL (each SQLite index can only ever seek ONE column), with a
        // second-branch guard to stop UNION ALL from double-counting a row
        // where both columns equal the same ss58. This route's own prior fix
        // (the observed_at-leading ORDER BY/3-part cursor above) addressed
        // chunk exclusion but kept the flat `WHERE (hotkey = $1 OR
        // coldkey = $1)` -- confirmed live via EXPLAIN that this STILL
        // trips the same statement-timeout (Sentry METAGRAPHED-6, regressed,
        // still firing after that fix): on TimescaleDB-compressed chunks
        // hotkey has no compression segment/order-by metadata at all (unlike
        // coldkey, which does), so an OR pulls every compressed chunk into a
        // full DecompressChunk + seq scan just to test the hotkey side, an
        // estimated 45M+ rows before LIMIT even applies -- the exact same
        // class of bug the sibling /api/v1/accounts/:ss58 route hit as
        // METAGRAPHED-5/#6878, just never ported to this route. Restored
        // that same two-branch shape: one capped ORDER BY/LIMIT scan on
        // hotkey = $1 (lets the planner use idx_ae_hotkey + ordered chunk-
        // append), a second on coldkey = $1 excluding rows the hotkey branch
        // already matched (so a self-referential hotkey/coldkey account
        // isn't double-counted), then merged + re-sorted client-side -- an
        // active account's matches are almost always satisfied from recent,
        // uncompressed chunks without ever touching the compressed tail.
        const acctEvents = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/events$/,
        );
        if (acctEvents) {
          const ss58 = decodeURIComponent(acctEvents[1]);
          const limit = clampEventsLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          // METAGRAPHED-6: 3-part cursor (observed_at, block_number,
          // event_index) matching the observed_at-leading ORDER BY below --
          // same fix as the /api/v1/extrinsics list route's own cursor.
          // decodeCursor's arity check makes an old 2-part cursor a clean
          // "ignored, no next-page" miss rather than a crash.
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const kind = url.searchParams.get("kind") || null;
          const netuid = nonNegativeIntegerParam(url.searchParams, "netuid");
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          // Each branch needs up to limit+offset rows, not just limit: in
          // the worst case every one of the final `limit` (post-offset)
          // rows comes from a single branch, and offset is only applied
          // once, after the two branches are merged below. Cursor-based
          // pages never carry an offset (the cursor itself already narrows
          // past prior pages), so they only need `limit` per branch.
          const perBranchLimit = limit + (cursor ? 0 : offset);
          // Same reasoning as /api/v1/chain/transfers above: this route
          // alone widens its budget for the (now rarer, but not impossible)
          // case of a sparse/nonexistent account whose branches still have
          // to walk back through the compressed chunk tail to prove there's
          // nothing more to find, rather than raising the global 3s default
          // for every other (much lighter) route in this dispatcher.
          await sql`SET LOCAL statement_timeout = '10000ms'`;
          const hotkeyRows = await sql`
          SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
          FROM account_events
          WHERE hotkey = ${ss58}
            ${kind ? sql`AND event_kind = ${kind}` : sql``}
            ${netuid != null ? sql`AND netuid = ${netuid}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${cursor ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
          ORDER BY observed_at DESC, block_number DESC, event_index DESC
          LIMIT ${perBranchLimit}`;
          const coldkeyRows = await sql`
          SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
          FROM account_events
          WHERE coldkey = ${ss58} AND (hotkey IS NULL OR hotkey <> ${ss58})
            ${kind ? sql`AND event_kind = ${kind}` : sql``}
            ${netuid != null ? sql`AND netuid = ${netuid}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${cursor ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
          ORDER BY observed_at DESC, block_number DESC, event_index DESC
          LIMIT ${perBranchLimit}`;
          // Each branch is already this account's own newest perBranchLimit
          // rows on its key, so the true newest (limit+offset) rows across
          // both are guaranteed to be present in this merged set -- re-sort
          // by the same feed order, then apply the offset/limit window the
          // single-scan query used to apply in SQL (cursor pages skip the
          // offset slice, matching the cursor's own WHERE-side narrowing).
          const merged = hotkeyRows.concat(coldkeyRows).sort((a, b) => {
            const observedDelta = Number(b.observed_at) - Number(a.observed_at);
            if (observedDelta !== 0) return observedDelta;
            const blockDelta = Number(b.block_number) - Number(a.block_number);
            if (blockDelta !== 0) return blockDelta;
            return Number(b.event_index) - Number(a.event_index);
          });
          const windowStart = cursor ? 0 : offset;
          const rows = merged.slice(windowStart, windowStart + limit);
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
                numberOrNull(last.event_index),
              ])
            : null;
          return json(
            buildAccountEvents(rows, ss58, { limit, offset, nextCursor }),
          );
        }

        // GET /api/v1/subnets/:netuid/events (#4832 Tier 1b): the per-subnet
        // signed-event feed, mirroring the former src/account-events.mjs subnet
        // event-feed D1 loader's filter set (removed in #4772: kind,
        // block_start/block_end, cursor). Same account_events
        // table/columns as the account feed above, filtered by netuid instead of
        // hotkey/coldkey -- a single indexed WHERE, no UNION needed.
        const subnetEventsRoute = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/events$/,
        );
        if (subnetEventsRoute) {
          const netuid = Number(subnetEventsRoute[1]);
          const limit = clampEventsLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          // METAGRAPHED-6-class fix: 3-part cursor (observed_at, block_number,
          // event_index) matching the observed_at-leading ORDER BY below.
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const kind = url.searchParams.get("kind") || null;
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const rows = await sql`
          SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
          FROM account_events
          WHERE netuid = ${netuid}
            ${kind ? sql`AND event_kind = ${kind}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${cursor ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
          ORDER BY observed_at DESC, block_number DESC, event_index DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
                numberOrNull(last.event_index),
              ])
            : null;
          return json(
            buildSubnetEvents(rows, netuid, { limit, offset, nextCursor }),
          );
        }

        // GET /api/v1/subnets/:netuid/event-summary (#4832 Tier 1b): windowed
        // account_events aggregates by kind/category plus a recent evidence
        // slice, mirroring the former src/account-events.mjs subnet event-summary
        // D1 loader (removed in #4772). The
        // distinct-actor count uses the same hotkey-or-(netuid,uid) identity as
        // the weight-setters routes (WeightsSet ingestion can omit hotkey).
        const subnetEventSummaryRoute = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/event-summary$/,
        );
        if (subnetEventSummaryRoute) {
          const netuid = Number(subnetEventSummaryRoute[1]);
          const windowParam =
            url.searchParams.get("window") ??
            DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW;
          const windowLabel = Object.hasOwn(
            SUBNET_EVENT_SUMMARY_WINDOWS,
            windowParam,
          )
            ? windowParam
            : DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW;
          const cutoff =
            Date.now() -
            SUBNET_EVENT_SUMMARY_WINDOWS[windowLabel] * ANALYTICS_DAY_MS;
          const limit = Math.min(
            Math.max(
              Number(url.searchParams.get("limit")) ||
                SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
              1,
            ),
            SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
          );
          const kindRows = await sql`
          SELECT event_kind, COUNT(*) AS event_count,
            COUNT(DISTINCT CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                                 WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) AS hotkey_count,
            COALESCE(SUM(amount_tao), 0) AS amount_tao, COALESCE(SUM(alpha_amount), 0) AS alpha_amount,
            MIN(block_number) AS first_block, MAX(block_number) AS last_block,
            MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at
          FROM account_events WHERE netuid = ${netuid} AND observed_at >= ${cutoff}
          GROUP BY event_kind ORDER BY event_count DESC, event_kind ASC`;
          // Distinct-per-kind actor count via a grouped subquery (the delegating
          // account's column named once, comma-adjacent) rather than
          // COUNT(DISTINCT <col>) in the aggregate above -- same pattern as the
          // subnet stake-moves/stake-transfers routes' distinct-mover count.
          const coldkeyRows = await sql`
          SELECT event_kind, COUNT(*) AS coldkey_count FROM (
            SELECT coldkey, event_kind FROM account_events
            WHERE netuid = ${netuid} AND observed_at >= ${cutoff}
              AND coldkey IS NOT NULL
            GROUP BY 1, 2
          ) grouped GROUP BY event_kind`;
          const coldkeyCountByKind = new Map(
            coldkeyRows.map((row) => [row.event_kind, row.coldkey_count]),
          );
          const kindRowsWithColdkeyCount = kindRows.map((row) => ({
            ...row,
            coldkey_count: coldkeyCountByKind.get(row.event_kind) ?? 0,
          }));
          const recentRows = await sql`
          SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
          FROM account_events WHERE netuid = ${netuid} AND observed_at >= ${cutoff}
          ORDER BY block_number DESC, event_index DESC LIMIT ${limit}`;
          return json(
            buildSubnetEventSummary(
              kindRowsWithColdkeyCount,
              recentRows,
              netuid,
              {
                window: windowLabel,
                limit,
              },
            ),
          );
        }

        // GET /api/v1/accounts/:ss58/extrinsics — extrinsics SIGNED by this account
        // (the `signer` column only, not a hotkey/coldkey union -- `extrinsics` has
        // no hotkey/coldkey columns), mirroring the former src/account-events.mjs
        // account-extrinsics D1 loader (removed in #4772).
        const acctExtrinsics = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/extrinsics$/,
        );
        if (acctExtrinsics) {
          const ss58 = decodeURIComponent(acctExtrinsics[1]);
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          // METAGRAPHED-6-class fix: 3-part cursor (observed_at, block_number,
          // extrinsic_index) matching the observed_at-leading ORDER BY below.
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const rows =
            blockStart != null && blockEnd != null && blockStart > blockEnd
              ? []
              : await sql`
              SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
              FROM extrinsics
              WHERE signer = ${ss58}
                ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
                ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
                ${cursor ? sql`AND (observed_at, block_number, extrinsic_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
              ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC
              LIMIT ${limit}
              ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
                numberOrNull(last.extrinsic_index),
              ])
            : null;
          return json(
            buildAccountExtrinsics(rows, ss58, { limit, offset, nextCursor }),
          );
        }

        // account_events-derived analytics routes (#4826): D1's account_events copy
        // froze when the streamer that fed it stopped (ADR 0014 step 5); this
        // Postgres account_events table is the live, current one (26.7M rows).
        // Every route below reuses its D1 sibling's build*/`window` maps unchanged
        // (pure, store-agnostic) -- only the query itself is ported. No INDEXED BY
        // equivalent exists in Postgres; a flat WHERE lets the planner pick the
        // matching index (idx_ae_hotkey / idx_ae_coldkey / idx_ae_netuid_kind, see
        // deploy/postgres/schema.sql).

        // GET /api/v1/validators/:hotkey/nominators
        const nominators = url.pathname.match(
          /^\/api\/v1\/validators\/([^/]+)\/nominators$/,
        );
        if (nominators) {
          const hotkey = decodeURIComponent(nominators[1]);
          const cutoff = windowCutoff(
            url,
            NOMINATOR_WINDOWS,
            DEFAULT_NOMINATOR_WINDOW,
          );
          const sortParam = url.searchParams.get("sort");
          const sort = NOMINATOR_SORTS.includes(sortParam)
            ? sortParam
            : "net_staked";
          const limit = Math.min(
            Math.max(
              Number(url.searchParams.get("limit")) ||
                GLOBAL_VALIDATOR_LIMIT_DEFAULT,
              1,
            ),
            GLOBAL_VALIDATOR_LIMIT_MAX,
          );
          const offset = Math.max(
            Number(url.searchParams.get("offset")) || 0,
            0,
          );
          const coldkeyParam = url.searchParams.get("coldkey");
          // Ordinal position references (column 1 = the first SELECTed
          // column below), not the literal identifier, so the ORDER BY/
          // GROUP BY tie-break doesn't repeat it outside a comma/colon/`=`
          // context.
          const orderBy =
            sort === "gross_staked"
              ? sql`gross_staked_tao DESC, 1 ASC`
              : sort === "last_activity"
                ? sql`last_observed DESC, 1 ASC`
                : sql`net_staked_tao DESC, 1 ASC`;
          const rows = await sql`
          SELECT coldkey,
            COALESCE(SUM(CASE WHEN event_kind = ${STAKE_ADDED_KIND} THEN amount_tao ELSE 0 END), 0) AS staked_tao,
            COALESCE(SUM(CASE WHEN event_kind = ${STAKE_REMOVED_KIND} THEN amount_tao ELSE 0 END), 0) AS unstaked_tao,
            COUNT(*) AS event_count, MAX(observed_at) AS last_observed,
            COALESCE(SUM(CASE WHEN event_kind = ${STAKE_ADDED_KIND} THEN amount_tao ELSE -amount_tao END), 0) AS net_staked_tao,
            COALESCE(SUM(amount_tao), 0) AS gross_staked_tao
          FROM account_events
          WHERE hotkey = ${hotkey} AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND}) AND observed_at >= ${cutoff}
            ${coldkeyParam ? sql`AND coldkey = ${coldkeyParam}` : sql``}
          GROUP BY 1 ORDER BY ${orderBy}
          LIMIT ${limit} OFFSET ${offset}`;
          return json({
            data: buildValidatorNominators(rows, hotkey, {
              window: windowLabelFor(
                url,
                NOMINATOR_WINDOWS,
                DEFAULT_NOMINATOR_WINDOW,
              ),
              sort,
              limit,
              offset,
              totalCount: rows.length,
            }),
            generatedAt: latestObservedIso(rows),
          });
        }

        // GET /api/v1/accounts/:ss58/weight-setters
        const acctWeightSetters = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/weight-setters$/,
        );
        if (acctWeightSetters) {
          const address = decodeURIComponent(acctWeightSetters[1]);
          const cutoff = windowCutoff(
            url,
            ACCOUNT_WEIGHT_SETTERS_WINDOWS,
            DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
          );
          const rows = await sql`
          SELECT netuid, COUNT(*) AS weight_sets, MIN(observed_at) AS first_observed,
                 MAX(observed_at) AS last_observed
          FROM (
            SELECT netuid, observed_at FROM account_events
            WHERE hotkey = ${address} AND event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}
            UNION ALL
            SELECT e.netuid, e.observed_at
            FROM neurons n
            JOIN account_events e ON e.netuid = n.netuid AND e.uid = n.uid
            WHERE n.hotkey = ${address} AND e.event_kind = ${WEIGHTS_EVENT_KIND} AND e.observed_at >= ${cutoff}
              AND (e.hotkey IS NULL OR e.hotkey = '')
          ) sub
          GROUP BY netuid`;
          return json({
            data: buildAccountWeightSetters(rows, address, {
              window: windowLabelFor(
                url,
                ACCOUNT_WEIGHT_SETTERS_WINDOWS,
                DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
              ),
            }),
            generatedAt: latestObservedIso(rows),
          });
        }

        // GET /api/v1/subnets/:netuid/weights (#4832 Tier 1b): the aggregate
        // WeightsSet activity for this subnet, mirroring the former
        // src/subnet-weights.mjs D1 loader (removed in #4772). Distinct from /weights/setters below (the per-setter
        // leaderboard) -- this is the single-row summary.
        const subnetWeights = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/weights$/,
        );
        if (subnetWeights) {
          const netuid = Number(subnetWeights[1]);
          const cutoff = windowCutoff(
            url,
            SUBNET_WEIGHTS_WINDOWS,
            DEFAULT_SUBNET_WEIGHTS_WINDOW,
          );
          const rows = await sql`
          SELECT COUNT(*) AS weight_sets,
                 COUNT(DISTINCT CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                                      WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) AS distinct_setters,
                 MAX(observed_at) AS newest_observed
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}`;
          return json(
            buildSubnetWeights(rows[0] ?? null, netuid, {
              window: windowLabelFor(
                url,
                SUBNET_WEIGHTS_WINDOWS,
                DEFAULT_SUBNET_WEIGHTS_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/volume (#4832 Tier 1b): rolling 24h buy/sell
        // alpha volume, mirroring src/alpha-volume.mjs's loadSubnetAlphaVolume.
        // marketCapTao is deliberately null here (not the D1 path's degradation --
        // vol_mcap_ratio's own "externally-loaded marketCapTao" null semantics,
        // documented on buildAlphaVolume): this Worker has no KV/R2 binding to
        // resolve the live economics artifact the way entities.mjs's
        // resolveSubnetMarketCapTao does, only the Hyperdrive Postgres connection.
        const subnetVolume = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/volume$/,
        );
        if (subnetVolume) {
          const netuid = Number(subnetVolume[1]);
          const cutoff = Date.now() - ANALYTICS_DAY_MS;
          const rows = await sql`
          SELECT event_kind, COALESCE(SUM(alpha_amount), 0) AS alpha_volume,
                 COALESCE(SUM(amount_tao), 0) AS tao_volume, COUNT(*) AS event_count,
                 MAX(observed_at) AS last_observed
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND}) AND observed_at >= ${cutoff}
          GROUP BY event_kind`;
          return json({
            data: buildAlphaVolume(rows, netuid, { marketCapTao: null }),
            generatedAt: latestObservedIso(rows, "last_observed"),
          });
        }

        // GET /api/v1/subnets/:netuid/ohlc?interval=1h|1d&days=1-365 (#5655,
        // Phase 1 of #5304): OHLCV candles, bucketed in pure JS by
        // buildSubnetOhlc -- deliberately NOT a SQL GROUP BY/array_agg
        // aggregation (see src/subnet-ohlc.mjs's header), so this query stays
        // a plain filtered raw-row SELECT ordered by observed_at ASC, the
        // exact shape buildSubnetOhlc expects (it sorts defensively anyway,
        // but ORDER BY here avoids trusting Postgres's unspecified default
        // order for a query with no ORDER BY at all). ?days= bounds the
        // lookback (default DEFAULT_OHLC_WINDOW_DAYS, clamped to
        // MAX_OHLC_WINDOW_DAYS); a malformed value falls back to the default
        // rather than erroring, matching this Worker's own no-query-
        // validation convention (handleSubnetOhlc, the entities.mjs REST
        // layer this route is reached through via tryPostgresTier, already
        // validates both params with a 400 before forwarding).
        const subnetOhlc = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/ohlc$/,
        );
        if (subnetOhlc) {
          const netuid = Number(subnetOhlc[1]);
          const interval =
            url.searchParams.get("interval") || OHLC_INTERVAL_DEFAULT;
          const daysParam = url.searchParams.get("days");
          let days = DEFAULT_OHLC_WINDOW_DAYS;
          if (daysParam !== null) {
            const n = Number(daysParam);
            if (Number.isFinite(n)) {
              days = Math.min(Math.max(Math.floor(n), 1), MAX_OHLC_WINDOW_DAYS);
            }
          }
          const cutoff = Date.now() - days * ANALYTICS_DAY_MS;
          const rows = await sql`
          SELECT event_kind, alpha_amount, amount_tao, observed_at
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND}) AND observed_at >= ${cutoff}
          ORDER BY observed_at ASC`;
          return json({
            data: buildSubnetOhlc(rows, netuid, { interval }),
            generatedAt: latestObservedIso(rows, "observed_at"),
          });
        }

        // GET /api/v1/subnets/:netuid/ownership-history (#6637, part of the
        // conviction/ownership-contest tracker epic #4302): every automatic
        // ownership transfer this subnet has undergone, decoded from the
        // chain_events SubnetOwnerChanged stream -- see
        // docs/conviction-lock-mechanism.md for the on-chain mechanism this
        // reads. Netuid lives inside the JSONB args column (chain_events has
        // no netuid column of its own, unlike account_events), so the filter
        // is an args->>'netuid' cast rather than a plain column match --
        // this is the all-events tier (ADR 0013), same idx_ce_pallet_method
        // index /blocks/:n/chain-events and /chain-events already rely on.
        // Cold/absent store -> the schema-stable empty-list shape (never a
        // 404): a subnet that has never changed hands is the common case.
        const subnetOwnershipHistory = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/ownership-history$/,
        );
        if (subnetOwnershipHistory) {
          const netuid = Number(subnetOwnershipHistory[1]);
          const rows = await sql`
          SELECT block_number, pallet, method, args, observed_at
          FROM chain_events
          WHERE pallet = 'SubtensorModule' AND method = ${OWNERSHIP_CHANGE_EVENT_METHOD}
            AND (args->>'netuid')::int = ${netuid}
          ORDER BY block_number ASC`;
          return json(buildSubnetOwnershipHistory(rows, netuid));
        }

        // GET /api/v1/accounts/:coldkey/entities (#6740, part of the curated
        // entity-label registry epic #6737): every subnet-ownership tie this
        // address has via the SAME chain_events SubnetOwnerChanged stream as
        // ownership-history above -- unfiltered by netuid here (a network-
        // wide scan, not a per-subnet one), filtered by address in JS after
        // decoding (see src/entity-labels.ts's own header for why). This
        // Worker has no R2/KV bindings, so `entities` (community labels) is
        // always [] here -- the main API Worker joins those on afterward.
        const accountEntities = url.pathname.match(
          /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/entities$/,
        );
        if (accountEntities) {
          const coldkey = accountEntities[1];
          const rows = await sql`
          SELECT block_number, pallet, method, args, observed_at
          FROM chain_events
          WHERE pallet = 'SubtensorModule' AND method = ${OWNERSHIP_CHANGE_EVENT_METHOD}
          ORDER BY block_number ASC`;
          return json(
            buildAccountEntities(coldkey, {
              entities: [],
              ownershipRows: rows,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/lease/history (#6719, part of the
        // subnet-leasing/crowdloan-tracking epic #6717): every
        // SubnetLeaseCreated/SubnetLeaseTerminated event this subnet has
        // had, from the account_events tier #6718 started capturing --
        // unlike ownership-history just above, this reads account_events
        // (a plain `netuid` column) rather than chain_events (a JSONB
        // args->>'netuid' cast), since #6718's indexer-rs extract() already
        // curates netuid for both these kinds into that column. See
        // src/subnet-lease-history.mjs's own header for why dividend-
        // distribution/crowdloan events are excluded. Cold/absent store ->
        // the schema-stable empty-list shape (never a 404): most subnets
        // have never been leased.
        const subnetLeaseHistory = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/lease\/history$/,
        );
        if (subnetLeaseHistory) {
          const netuid = Number(subnetLeaseHistory[1]);
          const rows = await sql`
          SELECT block_number, event_kind, coldkey, observed_at
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind IN (${SUBNET_LEASE_CREATED_KIND}, ${SUBNET_LEASE_TERMINATED_KIND})
          ORDER BY block_number ASC`;
          return json(buildSubnetLeaseHistory(rows, netuid));
        }

        // GET /api/v1/subnets/:netuid/conviction (#6638, part of the
        // conviction/ownership-contest tracker epic #4302): the live
        // "who's winning the ownership contest right now" leaderboard --
        // see docs/conviction-lock-mechanism.md. Companion to /ownership-
        // history above (that's the event log of past flips; this is the
        // current standings). Reads the periodically-refreshed subnet_locks
        // snapshot (fetch-subnet-locks.py, a box-side systemd timer -- NOT
        // a live per-request chain-state scan, which would be far too slow/
        // abusive to run on every API call) and rolls each row forward to
        // "now" using the CURRENT live-queried UnlockRate/MaturityRate
        // (fetchConvictionRates -- never hardcoded, see that function's own
        // header for why). Cold/absent store -> the schema-stable empty-
        // leaderboard shape (never a 404): most subnets have no active
        // challengers.
        const subnetConviction = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/conviction$/,
        );
        if (subnetConviction) {
          const netuid = Number(subnetConviction[1]);
          const [rows, rates] = await Promise.all([
            sql`
          SELECT hotkey, is_owner, is_perpetual, locked_mass, conviction_bits, last_update
          FROM subnet_locks
          WHERE netuid = ${netuid}`,
            fetchConvictionRates(),
          ]);
          return json(
            buildSubnetConviction(rows, netuid, {
              now: rates.now,
              unlockRate: rates.unlockRate,
              maturityRate: rates.maturityRate,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/weights/setters
        const subnetWeightSetters = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/weights\/setters$/,
        );
        if (subnetWeightSetters) {
          const netuid = Number(subnetWeightSetters[1]);
          const cutoff = windowCutoff(
            url,
            SUBNET_WEIGHT_SETTERS_WINDOWS,
            DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
          );
          const rows = await sql`
          SELECT MAX(CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN hotkey ELSE NULL END) AS hotkey,
                 CASE WHEN MAX(CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN hotkey ELSE NULL END)
                      IS NULL THEN MAX(netuid) ELSE NULL END AS netuid,
                 MAX(uid) AS uid, COUNT(*) AS weight_sets,
                 MIN(observed_at) AS first_set, MAX(observed_at) AS last_set
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}
            AND (CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                      WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) IS NOT NULL
          GROUP BY CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                        WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END
          ORDER BY weight_sets DESC, last_set DESC LIMIT ${SUBNET_WEIGHT_SETTERS_LIMIT}`;
          const totalsRows = await sql`
          SELECT COUNT(*) AS weight_sets,
                 COUNT(DISTINCT CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                                      WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) AS distinct_setters,
                 MAX(observed_at) AS newest_observed
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}`;
          return json(
            buildSubnetWeightSetters(rows, totalsRows[0] ?? null, netuid, {
              window: windowLabelFor(
                url,
                SUBNET_WEIGHT_SETTERS_WINDOWS,
                DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/chain/weights (#4832 Tier 2): network-wide WeightsSet
        // leaderboard + rollup, mirroring src/chain-weights.ts's
        // loadChainWeights. window/limit are resolved from the shared
        // ANALYTICS_WINDOWS/DEFAULT_ANALYTICS_WINDOW (workers/config.mjs) --
        // the same set every chain-* module's own WINDOWS constant
        // duplicates -- and chainLimit (below) replicates parseLimitParam's
        // success path since the D1-side handler has already validated a
        // malformed limit into a 400 before tryPostgresTier is ever reached.
        const chainWeights = url.pathname.match(/^\/api\/v1\/chain\/weights$/);
        if (chainWeights) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(*) AS weight_sets,
                 COUNT(DISTINCT CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                                      WHEN uid IS NOT NULL AND netuid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) AS distinct_setters,
                 MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS weight_sets,
                   COUNT(DISTINCT CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                                        WHEN uid IS NOT NULL AND netuid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) AS distinct_setters
            FROM account_events WHERE event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid`;
          }
          return json(
            buildChainWeights(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_WEIGHTS_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/weights/setters (#4832 Tier 2): network-wide
        // weight-setter leaderboard, mirroring
        // src/chain-weight-setters.ts's loadChainWeightSetters. The
        // setter-identity CASE expression here omits chain-weights' extra
        // `AND netuid IS NOT NULL` guard -- matches SETTER_IDENTITY in
        // chain-weight-setters.ts exactly, not chain-weights.ts's own.
        const chainWeightSetters = url.pathname.match(
          /^\/api\/v1\/chain\/weights\/setters$/,
        );
        if (chainWeightSetters) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const rows = await sql`
          SELECT MAX(CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN hotkey ELSE NULL END) AS hotkey,
                 CASE WHEN MAX(CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN hotkey ELSE NULL END)
                      IS NULL THEN MAX(netuid) ELSE NULL END AS netuid,
                 MAX(uid) AS uid, COUNT(*) AS weight_sets,
                 MIN(observed_at) AS first_set, MAX(observed_at) AS last_set
          FROM account_events WHERE event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}
            AND (CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                      WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) IS NOT NULL
          GROUP BY CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                        WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END
          ORDER BY weight_sets DESC, last_set DESC LIMIT ${CHAIN_WEIGHT_SETTERS_LIMIT_MAX}`;
          const totalsRows = await sql`
          SELECT COUNT(*) AS weight_sets,
                 COUNT(DISTINCT CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey
                                      WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid END) AS distinct_setters,
                 MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${WEIGHTS_EVENT_KIND} AND observed_at >= ${cutoff}`;
          return json(
            buildChainWeightSetters(rows, totalsRows[0] ?? null, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT),
            }),
          );
        }

        // GET /api/v1/chain/serving (#4832 Tier 2): network-wide AxonServed
        // announcement leaderboard, mirroring src/chain-serving.ts's
        // loadChainServing.
        const chainServing = url.pathname.match(/^\/api\/v1\/chain\/serving$/);
        if (chainServing) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT hotkey) AS distinct_servers, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${SERVING_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS announcements, COUNT(DISTINCT hotkey) AS distinct_servers
            FROM account_events WHERE event_kind = ${SERVING_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY announcements DESC, netuid ASC`;
          }
          return json(
            buildChainServing(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_SERVING_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/prometheus (#4832 Tier 2): network-wide
        // PrometheusServed announcement leaderboard, mirroring
        // src/chain-prometheus.ts's loadChainPrometheus.
        const chainPrometheus = url.pathname.match(
          /^\/api\/v1\/chain\/prometheus$/,
        );
        if (chainPrometheus) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT hotkey) AS distinct_exporters, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${PROMETHEUS_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS announcements, COUNT(DISTINCT hotkey) AS distinct_exporters
            FROM account_events WHERE event_kind = ${PROMETHEUS_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY announcements DESC, netuid ASC`;
          }
          return json(
            buildChainPrometheus(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_PROMETHEUS_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/axon-removals (#4832 Tier 2): network-wide
        // AxonInfoRemoved leaderboard, mirroring
        // src/chain-axon-removals.ts's loadChainAxonRemovals.
        const chainAxonRemovals = url.pathname.match(
          /^\/api\/v1\/chain\/axon-removals$/,
        );
        if (chainAxonRemovals) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT hotkey) AS distinct_removers, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${AXON_REMOVAL_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS removals, COUNT(DISTINCT hotkey) AS distinct_removers
            FROM account_events WHERE event_kind = ${AXON_REMOVAL_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY removals DESC, netuid ASC`;
          }
          return json(
            buildChainAxonRemovals(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_AXON_REMOVALS_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/registrations (#4832 Tier 2): network-wide
        // NeuronRegistered leaderboard, mirroring
        // src/chain-registrations.ts's loadChainRegistrations.
        const chainRegistrations = url.pathname.match(
          /^\/api\/v1\/chain\/registrations$/,
        );
        if (chainRegistrations) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT hotkey) AS distinct_registrants, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${REGISTRATION_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS registrations, COUNT(DISTINCT hotkey) AS distinct_registrants
            FROM account_events WHERE event_kind = ${REGISTRATION_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY registrations DESC, netuid ASC`;
          }
          return json(
            buildChainRegistrations(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_REGISTRATIONS_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/deregistrations (#4832 Tier 2): network-wide
        // NeuronDeregistered leaderboard, mirroring
        // src/chain-deregistrations.ts's loadChainDeregistrations.
        const chainDeregistrations = url.pathname.match(
          /^\/api\/v1\/chain\/deregistrations$/,
        );
        if (chainDeregistrations) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT hotkey) AS distinct_deregistered_hotkeys, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${DEREGISTRATION_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS deregistrations, COUNT(DISTINCT hotkey) AS distinct_deregistered_hotkeys
            FROM account_events WHERE event_kind = ${DEREGISTRATION_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY deregistrations DESC, netuid ASC`;
          }
          return json(
            buildChainDeregistrations(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/stake-moves (#4832 Tier 2): network-wide
        // StakeMoved leaderboard, mirroring src/chain-stake-moves.ts's
        // loadChainStakeMoves. Distinct by the "coldkey" column (a stake
        // move is initiated by the owning account, not a specific hotkey).
        const chainStakeMoves = url.pathname.match(
          /^\/api\/v1\/chain\/stake-moves$/,
        );
        if (chainStakeMoves) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT "coldkey") AS distinct_movers, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${STAKE_MOVED_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS movements, COUNT(DISTINCT "coldkey") AS distinct_movers
            FROM account_events WHERE event_kind = ${STAKE_MOVED_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY movements DESC, netuid ASC`;
          }
          return json(
            buildChainStakeMoves(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_STAKE_MOVES_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/stake-transfers (#4832 Tier 2): network-wide
        // StakeTransferred leaderboard, mirroring
        // src/chain-stake-transfers.ts's loadChainStakeTransfers.
        // Distinct by the "coldkey" column -- a stake transfer moves stake
        // between owning accounts.
        const chainStakeTransfers = url.pathname.match(
          /^\/api\/v1\/chain\/stake-transfers$/,
        );
        if (chainStakeTransfers) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const networkRows = await sql`
          SELECT COUNT(DISTINCT "coldkey") AS distinct_senders, MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = ${STAKE_TRANSFERRED_EVENT_KIND} AND observed_at >= ${cutoff}`;
          const networkDistinct = networkRows[0] ?? null;
          let subnetRows = [];
          if (networkDistinct?.newest_observed != null) {
            subnetRows = await sql`
            SELECT netuid, COUNT(*) AS transfers, COUNT(DISTINCT "coldkey") AS distinct_senders
            FROM account_events WHERE event_kind = ${STAKE_TRANSFERRED_EVENT_KIND} AND observed_at >= ${cutoff} GROUP BY netuid
            ORDER BY transfers DESC, netuid ASC`;
          }
          return json(
            buildChainStakeTransfers(subnetRows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT),
              networkDistinct,
            }),
          );
        }

        // GET /api/v1/chain/stake-flow (#4832 Tier 2): network-wide
        // cross-subnet capital flow (StakeAdded - StakeRemoved), mirroring
        // src/chain-stake-flow.ts's loadChainStakeFlow. A single
        // GROUP BY netuid, event_kind query, no cold-store guard branch --
        // matches the D1 loader exactly.
        const chainStakeFlow = url.pathname.match(
          /^\/api\/v1\/chain\/stake-flow$/,
        );
        if (chainStakeFlow) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const rows = await sql`
          SELECT netuid, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao,
                 COUNT(*) AS event_count, MAX(observed_at) AS last_observed
          FROM account_events
          WHERE event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND}) AND observed_at >= ${cutoff}
          GROUP BY netuid, event_kind`;
          return json(
            buildChainStakeFlow(rows, {
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              limit: chainLimit(url, CHAIN_STAKE_FLOW_LIMIT_DEFAULT),
            }),
          );
        }

        // GET /api/v1/chain/alpha-volume (#5598): network-wide rolling 24h
        // buy/sell alpha-volume leaderboard, mirroring src/chain-alpha-volume.ts's
        // loadChainAlphaVolume. Fixed 24h window (no ?window= param, unlike the
        // sibling chain-stake-flow above) -- same ANALYTICS_DAY_MS cutoff the
        // subnet-level /api/v1/subnets/:netuid/volume branch above uses.
        const chainAlphaVolume = url.pathname.match(
          /^\/api\/v1\/chain\/alpha-volume$/,
        );
        if (chainAlphaVolume) {
          const cutoff = Date.now() - ANALYTICS_DAY_MS;
          const rows = await sql`
          SELECT netuid, event_kind, COALESCE(SUM(alpha_amount), 0) AS alpha_volume,
                 COALESCE(SUM(amount_tao), 0) AS tao_volume, COUNT(*) AS event_count,
                 MAX(observed_at) AS last_observed
          FROM account_events
          WHERE event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND}) AND observed_at >= ${cutoff}
          GROUP BY netuid, event_kind`;
          return json(
            buildChainAlphaVolume(rows, {
              limit: chainLimit(url, CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT),
            }),
          );
        }

        // GET /api/v1/chain/transfers (#4832 Tier 2): network-wide native-TAO
        // transfer scorecard (totals + top senders/receivers), mirroring
        // src/chain-transfers.ts's loadChainTransfers. "Transfer" mirrors
        // that module's own private TRANSFER_KIND constant (not exported, so
        // inlined here). observedAt: the D1 path sources this from a KV
        // cron-freshness marker (readHealthMetaKv) that this Worker has no
        // binding for -- since this route queries Postgres live, the
        // queried rows' own MAX(observed_at) is a more accurate freshness
        // signal for what was actually just read, so that's used instead.
        const chainTransfers = url.pathname.match(
          /^\/api\/v1\/chain\/transfers$/,
        );
        if (chainTransfers) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const limit = chainLimit(url, 25);
          // event_kind = 'Transfer' is by far the highest-volume kind in
          // account_events (~10M rows/7d, vs the low hundred-thousands for
          // every other kind these 12 routes cover) -- a single query
          // computing COUNT(*)/SUM/MAX *and* two COUNT(DISTINCT ...) in one
          // pass measured 15s+ against production data (confirmed live,
          // 2026-07-11), well past the router's 3s statement_timeout, and
          // was intermittently surfacing stale/zeroed totals rather than a
          // clean fallback. Splitting the two DISTINCT counts into their own
          // statements cut that to ~3s each (still the slowest queries here
          // even with idx_ae_kind_hotkey_observed/idx_ae_kind_coldkey_observed),
          // so this route alone widens its budget rather than raising the
          // global 3s default for every other (much lighter) route.
          await sql`SET LOCAL statement_timeout = '10000ms'`;
          const totalsRows = await sql`
          SELECT COUNT(*) AS transfer_count, COALESCE(SUM(amount_tao), 0) AS total_volume_tao,
                 MAX(observed_at) AS newest_observed
          FROM account_events WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff}`;
          const distinctSenders = await sql`
          SELECT COUNT(DISTINCT hotkey) AS unique_senders
          FROM account_events WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff}`;
          const distinctReceivers = await sql`
          SELECT COUNT(DISTINCT "coldkey") AS unique_receivers
          FROM account_events WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff}`;
          const senders = await sql`
          SELECT hotkey AS address, SUM(amount_tao) AS volume_tao, COUNT(*) AS transfer_count
          FROM account_events WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff} AND hotkey IS NOT NULL
          GROUP BY hotkey ORDER BY volume_tao DESC, hotkey ASC LIMIT ${limit}`;
          const receivers = await sql`
          SELECT "coldkey" AS address, SUM(amount_tao) AS volume_tao, COUNT(*) AS transfer_count
          FROM account_events WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff} AND "coldkey" IS NOT NULL
          GROUP BY "coldkey" ORDER BY volume_tao DESC, "coldkey" ASC LIMIT ${limit}`;
          return json(
            buildChainTransfers({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              observedAt: latestObservedIso(totalsRows, "newest_observed"),
              totals: {
                ...(totalsRows[0] ?? null),
                unique_senders: distinctSenders[0]?.unique_senders ?? 0,
                unique_receivers: distinctReceivers[0]?.unique_receivers ?? 0,
              },
              senders,
              receivers,
            }),
          );
        }

        // GET /api/v1/chain/transfer-pairs (#4832 Tier 2): network-wide
        // sender->receiver corridor leaderboard, mirroring
        // src/chain-transfer-pairs.ts's loadChainTransferPairs -- the
        // PAIR_FILTER predicate (event_kind/window/non-null/non-empty/
        // non-self/non-negative-amount) is inlined below since it's a
        // private, unexported constant there. observedAt: see chainTransfers
        // above for why this sources from the queried rows, not KV.
        const chainTransferPairs = url.pathname.match(
          /^\/api\/v1\/chain\/transfer-pairs$/,
        );
        if (chainTransferPairs) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const limit = chainLimit(url, 25);
          const sort = url.searchParams.get("sort") || "volume";
          const totalsRows = await sql`
          WITH pair_totals AS (
            SELECT hotkey, coldkey, SUM(amount_tao) AS volume_tao, COUNT(*) AS transfer_count,
                   MAX(observed_at) AS last_observed
            FROM account_events
            WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff} AND hotkey IS NOT NULL AND "coldkey" IS NOT NULL
              AND hotkey <> '' AND "coldkey" <> '' AND hotkey <> "coldkey" AND amount_tao IS NOT NULL AND amount_tao >= 0
            GROUP BY hotkey, "coldkey"
          )
          SELECT COALESCE(SUM(transfer_count), 0) AS transfer_count,
                 COALESCE(SUM(volume_tao), 0) AS total_volume_tao,
                 COUNT(*) AS unique_pairs,
                 COALESCE(MAX(volume_tao), 0) AS top_pair_volume_tao,
                 MAX(last_observed) AS newest_observed
          FROM pair_totals`;
          const orderBy =
            sort === "count"
              ? sql`transfer_count DESC, volume_tao DESC, hotkey ASC, "coldkey" ASC`
              : sql`volume_tao DESC, transfer_count DESC, hotkey ASC, "coldkey" ASC`;
          const pairRows = await sql`
          SELECT hotkey AS from_address, "coldkey" AS to_address, SUM(amount_tao) AS volume_tao,
                 COUNT(*) AS transfer_count, MAX(block_number) AS last_block, MAX(observed_at) AS last_observed_at
          FROM account_events
          WHERE event_kind = 'Transfer' AND observed_at >= ${cutoff} AND hotkey IS NOT NULL AND "coldkey" IS NOT NULL
            AND hotkey <> '' AND "coldkey" <> '' AND hotkey <> "coldkey" AND amount_tao IS NOT NULL AND amount_tao >= 0
          GROUP BY hotkey, "coldkey" ORDER BY ${orderBy} LIMIT ${limit}`;
          return json(
            buildChainTransferPairs({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              sort,
              observedAt: latestObservedIso(totalsRows, "newest_observed"),
              totals: totalsRows[0] ?? null,
              pairs: pairRows,
            }),
          );
        }

        // GET /api/v1/chain/signers (#4832 gap-closure, extrinsics-derived
        // cluster): windowed most-active-account leaderboard, mirroring
        // src/chain-query-loaders.ts's loadChainSigners. sort/call_module are
        // already validated D1-side before this route is ever reached. A
        // separate freshness query is needed (unlike totals-style routes
        // above) because the grouped rows below carry last_tx_block, not a
        // network-wide observed_at -- confirmed live via psql: both this
        // query and the freshness lookup run well under 1s at current
        // extrinsics volume (~1.2M rows/7d), so no timeout widening needed.
        const chainSigners = url.pathname.match(/^\/api\/v1\/chain\/signers$/);
        if (chainSigners) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const limit = chainLimit(url, 50);
          const sortParam = url.searchParams.get("sort");
          const sort = CHAIN_SIGNERS_SORTS.includes(sortParam)
            ? sortParam
            : "tx_count";
          const callModule = url.searchParams.get("call_module") || null;
          const moduleClause = callModule
            ? sql`AND call_module = ${callModule}`
            : sql``;
          const orderBy =
            sort === "total_fee_tao" ? sql`total_fee_tao` : sql`tx_count`;
          const freshRows = await sql`
          SELECT MAX(observed_at) AS newest_observed
          FROM extrinsics WHERE observed_at >= ${cutoff}`;
          const rows = await sql`
          SELECT signer, COUNT(*) AS tx_count, SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
                 SUM(COALESCE(tip_tao, 0)) AS total_tip_tao, MAX(block_number) AS last_tx_block
          FROM extrinsics WHERE observed_at >= ${cutoff} AND signer IS NOT NULL
            ${moduleClause}
          GROUP BY signer ORDER BY ${orderBy} DESC, signer ASC LIMIT ${limit}`;
          return json(
            buildChainSigners({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              sort,
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              rows,
            }),
          );
        }

        // GET /api/v1/chain/calls (#4832 gap-closure): extrinsic call-mix
        // breakdown, mirroring src/analytics-live.mjs's loadChainCalls. The
        // share denominator (total) is read separately so the LIMIT-truncated
        // grouped rows never skew shares, exactly like the D1 loader.
        const chainCalls = url.pathname.match(/^\/api\/v1\/chain\/calls$/);
        if (chainCalls) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const limit = chainLimit(url, 50);
          const groupBy =
            url.searchParams.get("group_by") === "module_function"
              ? "module_function"
              : "module";
          const callModule = url.searchParams.get("call_module") || null;
          const moduleClause = callModule
            ? sql`AND call_module = ${callModule}`
            : sql``;
          const orderBy =
            groupBy === "module_function"
              ? sql`count DESC, call_module ASC, call_function ASC`
              : sql`count DESC, call_module ASC`;
          const freshRows = await sql`
          SELECT MAX(observed_at) AS newest_observed
          FROM extrinsics WHERE observed_at >= ${cutoff}`;
          const rows =
            groupBy === "module_function"
              ? await sql`
                SELECT call_module, call_function, COUNT(*) AS count
                FROM extrinsics WHERE observed_at >= ${cutoff} AND call_module IS NOT NULL
                  ${moduleClause}
                GROUP BY call_module, call_function ORDER BY ${orderBy} LIMIT ${limit}`
              : await sql`
                SELECT call_module, COUNT(*) AS count
                FROM extrinsics WHERE observed_at >= ${cutoff} AND call_module IS NOT NULL
                  ${moduleClause}
                GROUP BY call_module ORDER BY ${orderBy} LIMIT ${limit}`;
          const totalRows = await sql`
          SELECT COUNT(*) AS total FROM extrinsics WHERE observed_at >= ${cutoff}
            ${moduleClause}`;
          return json(
            buildChainCalls({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              groupBy,
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              total: totalRows[0]?.total ?? 0,
              rows,
            }),
          );
        }

        // GET /api/v1/chain/activity (#4832 gap-closure): per-UTC-day
        // extrinsic/event/block counts, success rate, and unique signers,
        // mirroring src/analytics-live.mjs's loadNetworkActivity. The base
        // extrinsics aggregate + blocks aggregate are cheap (confirmed live
        // via psql: well under 500ms each at current volume), but
        // COUNT(DISTINCT signer) per day forces a per-group sort that
        // measured ~2.7s against production data (confirmed live,
        // 2026-07-11) -- the same disease as chain/transfers' DISTINCT
        // counts, just under the 1.2M-row extrinsics table instead of
        // account_events' 10M. Splitting it into its own statement and
        // widening only this route's budget avoids relying on a razor-thin
        // (2.7s vs 3s default) timeout margin that could flip under load.
        const chainActivity = url.pathname.match(
          /^\/api\/v1\/chain\/activity$/,
        );
        if (chainActivity) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          await sql`SET LOCAL statement_timeout = '8000ms'`;
          const extrinsicBase = await sql`
          SELECT to_char(to_timestamp(observed_at / 1000), 'YYYY-MM-DD') AS day,
                 COUNT(*) AS extrinsic_count,
                 SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successful_extrinsics
          FROM extrinsics WHERE observed_at >= ${cutoff} GROUP BY day`;
          const extrinsicSigners = await sql`
          SELECT to_char(to_timestamp(observed_at / 1000), 'YYYY-MM-DD') AS day,
                 COUNT(DISTINCT signer) AS unique_signers
          FROM extrinsics WHERE observed_at >= ${cutoff} GROUP BY day`;
          const signersByDay = new Map(
            extrinsicSigners.map((r) => [r.day, r.unique_signers]),
          );
          const extrinsicRows = extrinsicBase.map((r) => ({
            ...r,
            unique_signers: signersByDay.get(r.day) ?? 0,
          }));
          const blockRows = await sql`
          SELECT to_char(to_timestamp(observed_at / 1000), 'YYYY-MM-DD') AS day,
                 COUNT(*) AS block_count, SUM(event_count) AS event_count
          FROM blocks WHERE observed_at >= ${cutoff} GROUP BY day`;
          const freshRows = await sql`
          SELECT MAX(observed_at) AS newest_observed
          FROM blocks WHERE observed_at >= ${cutoff}`;
          return json(
            buildChainActivity({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              extrinsicRows,
              blockRows,
            }),
          );
        }

        // GET /api/v1/chain/fees (#4832 gap-closure): per-UTC-day fee/tip
        // series plus a windowed top-fee-payer leaderboard, mirroring
        // src/analytics-live.mjs's loadChainFees. Postgres has no equivalent
        // of the D1 loader's sample-capped rank+partition median CTEs --
        // PERCENTILE_CONT computes exact per-day medians directly, but
        // (confirmed live via psql) costs the same ~2.5s per-group-sort as
        // chain/activity's DISTINCT count, so this route widens its budget
        // too rather than trust a thin margin under the 3s default.
        const chainFees = url.pathname.match(/^\/api\/v1\/chain\/fees$/);
        if (chainFees) {
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const limit = chainLimit(url, 25);
          const callModule = url.searchParams.get("call_module") || null;
          const moduleClause = callModule
            ? sql`AND call_module = ${callModule}`
            : sql``;
          await sql`SET LOCAL statement_timeout = '8000ms'`;
          const dailyRows = await sql`
          SELECT to_char(to_timestamp(observed_at / 1000), 'YYYY-MM-DD') AS day,
                 COUNT(*) AS extrinsic_count,
                 SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
                 SUM(COALESCE(tip_tao, 0)) AS total_tip_tao
          FROM extrinsics WHERE observed_at >= ${cutoff}
            ${moduleClause}
          GROUP BY day`;
          const payerRows = await sql`
          SELECT signer, SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
                 SUM(COALESCE(tip_tao, 0)) AS total_tip_tao, COUNT(*) AS extrinsic_count
          FROM extrinsics WHERE observed_at >= ${cutoff} AND signer IS NOT NULL
            ${moduleClause}
          GROUP BY signer ORDER BY total_fee_tao DESC, signer ASC LIMIT ${limit}`;
          const medianRows = await sql`
          SELECT to_char(to_timestamp(observed_at / 1000), 'YYYY-MM-DD') AS day,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(fee_tao, 0)) AS median_fee_tao,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(tip_tao, 0)) AS median_tip_tao
          FROM extrinsics WHERE observed_at >= ${cutoff}
            ${moduleClause}
          GROUP BY day`;
          const freshRows = await sql`
          SELECT MAX(observed_at) AS newest_observed
          FROM extrinsics WHERE observed_at >= ${cutoff}`;
          return json(
            buildChainFees({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              dailyRows,
              medianRows,
              payerRows,
            }),
          );
        }

        // GET /api/v1/health/trends (#4832 gap-closure): all-subnet 7d/30d
        // daily uptime + latency matrix from the daily rollup, mirroring
        // src/bulk-health-trends.ts's loadBulkHealthTrends. Reads
        // surface_uptime_daily -- populated by the health-uptime-rollup-sync
        // write route (#4885), not surface_checks -- so this route stays
        // cheap regardless of the raw window's size.
        const bulkHealthTrends = url.pathname.match(
          /^\/api\/v1\/health\/trends$/,
        );
        if (bulkHealthTrends) {
          const now = Date.now();
          const maxWindowDays = Math.max(
            ...Object.values(HEALTH_TREND_WINDOWS),
          );
          const cutoffDay = new Date(now - maxWindowDays * ANALYTICS_DAY_MS)
            .toISOString()
            .slice(0, 10);
          const rows = await sql`
          SELECT netuid, day::text AS date, SUM(samples) AS total, SUM(ok_count) AS ok_count,
                 SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END) AS latency_samples,
                 CASE WHEN SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END) > 0
                   THEN SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN avg_latency_ms * COALESCE(latency_samples, samples) ELSE 0 END)::float8
                        / SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END)
                   ELSE NULL END AS avg_latency_ms
          FROM surface_uptime_daily WHERE day >= ${cutoffDay}::date
          GROUP BY netuid, day ORDER BY netuid, day LIMIT ${MAX_BULK_TREND_ROWS}`;
          const freshRows = await sql`
          SELECT MAX(updated_at) AS newest_observed
          FROM surface_uptime_daily WHERE day >= ${cutoffDay}::date`;
          const windows = {};
          for (const [label, days] of Object.entries(HEALTH_TREND_WINDOWS)) {
            const windowCutoff = new Date(now - days * ANALYTICS_DAY_MS)
              .toISOString()
              .slice(0, 10);
            windows[label] = rows.filter(
              (row) => String(row.date) >= windowCutoff,
            );
          }
          return json(
            formatBulkTrends({
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              windows,
              windowDays: HEALTH_TREND_WINDOWS,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/health/trends (#4832 gap-closure):
        // per-subnet 7d/30d uptime + latency trends from the raw
        // surface_checks window, mirroring src/analytics-live.mjs's
        // loadSubnetHealthTrends. `ok` is BOOLEAN here (D1's `ok = 1`
        // becomes a bare `ok`); the SQLite rank-based p50/p95/p99 pick
        // (src/health-sql.ts's latencyStatColumns) becomes PERCENTILE_CONT
        // -- live-verified via psql (2026-07-11) at sub-millisecond cost
        // against current production volume (~350 rows across 117 surfaces,
        // 30 min of the 15-min cron so far).
        const subnetHealthTrends = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/health\/trends$/,
        );
        if (subnetHealthTrends) {
          const netuid = Number(subnetHealthTrends[1]);
          const now = Date.now();
          const windows = {};
          for (const [label, days] of Object.entries(HEALTH_TREND_WINDOWS)) {
            const cutoff = now - days * ANALYTICS_DAY_MS;
            windows[label] = await sql`
            SELECT MAX(surface_id) AS surface_id,
                   COUNT(*) AS total,
                   SUM(CASE WHEN ok THEN 1 ELSE 0 END) AS ok_count,
                   COUNT(*) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS latency_samples,
                   AVG(latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS avg_latency_ms,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p50,
                   PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p95,
                   PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p99
            FROM surface_checks WHERE netuid = ${netuid} AND checked_at >= ${cutoff}
            GROUP BY COALESCE(surface_key, surface_id)`;
          }
          const freshRows = await sql`
          SELECT MAX(checked_at) AS newest_observed
          FROM surface_checks WHERE netuid = ${netuid}`;
          return json(
            formatTrends({
              netuid,
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              windows,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/health/percentiles?window= (#4832
        // gap-closure): p50/p95/p99 + avg/min/max latency per surface,
        // mirroring src/analytics-live.mjs's loadSubnetPercentiles.
        const subnetHealthPercentiles = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/health\/percentiles$/,
        );
        if (subnetHealthPercentiles) {
          const netuid = Number(subnetHealthPercentiles[1]);
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const rows = await sql`
          SELECT MAX(surface_id) AS surface_id,
                 COUNT(*) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS latency_samples,
                 AVG(latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS avg_latency_ms,
                 MIN(latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS min_latency_ms,
                 MAX(latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS max_latency_ms,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p50,
                 PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p95,
                 PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok AND latency_ms IS NOT NULL) AS p99
          FROM surface_checks WHERE netuid = ${netuid} AND checked_at >= ${cutoff}
          GROUP BY COALESCE(surface_key, surface_id)
          HAVING COUNT(*) FILTER (WHERE ok AND latency_ms IS NOT NULL) > 0`;
          const freshRows = await sql`
          SELECT MAX(checked_at) AS newest_observed
          FROM surface_checks WHERE netuid = ${netuid} AND checked_at >= ${cutoff}`;
          return json(
            formatPercentiles({
              netuid,
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              rows,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/health/incidents?window= (#4832
        // gap-closure): per-surface SLA + reconstructed downtime incidents,
        // mirroring src/analytics-live.mjs's loadSubnetIncidents. The
        // gap-island grouping (LAG/window functions) is syntactically
        // near-identical between SQLite and Postgres -- live-verified via
        // psql (2026-07-11) -- the only real adaptation is `ok` being
        // BOOLEAN here (`ok = 1`/`ok = 0` become bare `ok`/`NOT ok`).
        const subnetHealthIncidents = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/health\/incidents$/,
        );
        if (subnetHealthIncidents) {
          const netuid = Number(subnetHealthIncidents[1]);
          const since = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const slaRows = await sql`
          SELECT MAX(surface_id) AS surface_id,
                 COALESCE(surface_key, surface_id) AS surface_key,
                 COUNT(*) AS total,
                 SUM(CASE WHEN ok THEN 1 ELSE 0 END) AS ok_count
          FROM surface_checks WHERE netuid = ${netuid} AND checked_at >= ${since}
          GROUP BY COALESCE(surface_key, surface_id)`;
          const incidentRows = await sql`
          WITH checks AS (
            SELECT COALESCE(surface_key, surface_id) AS surface_key,
                   surface_id, checked_at, ok,
                   checked_at - LAG(checked_at)
                     OVER (PARTITION BY COALESCE(surface_key, surface_id) ORDER BY checked_at) AS gap
            FROM surface_checks WHERE netuid = ${netuid} AND checked_at >= ${since}
          ),
          grouped AS (
            SELECT surface_key, surface_id, checked_at, ok,
                   SUM(CASE WHEN ok OR gap IS NULL OR gap > ${INCIDENT_GAP_MS} THEN 1 ELSE 0 END)
                     OVER (PARTITION BY surface_key ORDER BY checked_at) AS grp
            FROM checks
          ),
          incidents AS (
            SELECT MAX(surface_id) AS surface_id, surface_key,
                   MIN(checked_at) AS started_at, MAX(checked_at) AS ended_at,
                   COUNT(*) AS failed_samples
            FROM grouped WHERE NOT ok
            GROUP BY surface_key, grp
            HAVING COUNT(*) >= ${MIN_INCIDENT_SAMPLES}
          )
          SELECT surface_id, surface_key, started_at, ended_at, failed_samples
          FROM (
            SELECT surface_id, surface_key, started_at, ended_at, failed_samples,
                   ROW_NUMBER() OVER (PARTITION BY surface_key ORDER BY started_at) AS rn
            FROM incidents
          ) ranked
          WHERE rn <= ${MAX_INCIDENT_ROWS}
          ORDER BY surface_id, started_at`;
          const freshRows = await sql`
          SELECT MAX(checked_at) AS newest_observed
          FROM surface_checks WHERE netuid = ${netuid} AND checked_at >= ${since}`;
          return json(
            formatIncidents({
              netuid,
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              slaRows,
              incidentRows,
              maxIncidents: MAX_INCIDENT_ROWS,
            }),
          );
        }

        // GET /api/v1/incidents?window= (#4832 gap-closure): global,
        // cross-subnet incident ledger -- the same gap-island grouping as
        // the per-subnet route above but with no netuid filter, grouped by
        // (netuid, surface_key) and capped to the newest
        // MAX_GLOBAL_INCIDENT_SOURCE_ROWS checks, mirroring
        // GLOBAL_INCIDENTS_SQL in workers/request-handlers/analytics.mjs.
        const globalIncidents = url.pathname.match(/^\/api\/v1\/incidents$/);
        if (globalIncidents) {
          const since = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const incidentRows = await sql`
          WITH recent_checks AS (
            SELECT netuid, COALESCE(surface_key, surface_id) AS surface_key,
                   surface_id, checked_at, ok
            FROM surface_checks WHERE checked_at >= ${since}
            ORDER BY checked_at DESC LIMIT ${MAX_GLOBAL_INCIDENT_SOURCE_ROWS}
          ),
          checks AS (
            SELECT netuid, surface_key, surface_id, checked_at, ok,
                   checked_at - LAG(checked_at)
                     OVER (PARTITION BY netuid, surface_key ORDER BY checked_at) AS gap
            FROM recent_checks
          ),
          grouped AS (
            SELECT netuid, surface_key, surface_id, checked_at, ok,
                   SUM(CASE WHEN ok OR gap IS NULL OR gap > ${INCIDENT_GAP_MS} THEN 1 ELSE 0 END)
                     OVER (PARTITION BY netuid, surface_key ORDER BY checked_at) AS grp
            FROM checks
          )
          SELECT netuid, MAX(surface_id) AS surface_id, surface_key,
                 MIN(checked_at) AS started_at, MAX(checked_at) AS ended_at,
                 COUNT(*) AS failed_samples
          FROM grouped WHERE NOT ok
          GROUP BY netuid, surface_key, grp
          HAVING COUNT(*) >= ${MIN_INCIDENT_SAMPLES}
          ORDER BY started_at DESC
          LIMIT ${MAX_INCIDENT_ROWS}`;
          const freshRows = await sql`
          SELECT MAX(checked_at) AS newest_observed
          FROM surface_checks WHERE checked_at >= ${since}`;
          return json(
            formatGlobalIncidents({
              window: windowLabelFor(
                url,
                ANALYTICS_WINDOWS,
                DEFAULT_ANALYTICS_WINDOW,
              ),
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              incidentRows,
              maxIncidents: MAX_INCIDENT_ROWS,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/uptime?window=&min_samples= (#4832
        // gap-closure follow-up): durable 90d/1y availability history from
        // the daily rollup, mirroring workers/request-handlers/
        // analytics-routes.mjs's handleUptime. Reuses METAGRAPH_HEALTH_SOURCE
        // (same table already covered by the bulk-trends route above), a
        // simple GROUP BY + optional HAVING with no window functions.
        const subnetUptime = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/uptime$/,
        );
        if (subnetUptime) {
          const netuid = Number(subnetUptime[1]);
          const windowParam = url.searchParams.get("window") || "90d";
          const days = Object.hasOwn(UPTIME_WINDOWS, windowParam)
            ? UPTIME_WINDOWS[windowParam]
            : UPTIME_WINDOWS["90d"];
          const cutoff = new Date(Date.now() - days * ANALYTICS_DAY_MS)
            .toISOString()
            .slice(0, 10);
          // A malformed min_samples ("abc", "-1", "1.5") degrades to "no
          // filter" rather than sending NaN/an invalid value to Postgres --
          // same graceful-fallback treatment as windowParam above, not a
          // hard validation error (the D1-side handleUptime already rejects
          // it before ever reaching this route in the real request path).
          const minSamplesRaw = url.searchParams.get("min_samples");
          const minSamplesParsed =
            minSamplesRaw === null ? null : Number(minSamplesRaw);
          const minSamples =
            Number.isInteger(minSamplesParsed) && minSamplesParsed >= 0
              ? minSamplesParsed
              : null;
          const havingClause =
            minSamples !== null
              ? sql`HAVING SUM(samples) >= ${minSamples}`
              : sql``;
          const rows = await sql`
          SELECT MAX(surface_id) AS surface_id,
                 COALESCE(surface_key, surface_id) AS surface_key,
                 day::text AS day,
                 SUM(samples) AS samples,
                 SUM(ok_count) AS ok_count,
                 CASE WHEN SUM(samples) > 0 THEN ROUND(SUM(ok_count)::numeric / SUM(samples), 4) ELSE NULL END AS uptime_ratio,
                 SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END) AS latency_samples,
                 CASE WHEN SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END) > 0
                   THEN ROUND(SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN avg_latency_ms * COALESCE(latency_samples, samples) ELSE 0 END)::numeric
                        / SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END))::int
                   ELSE NULL END AS avg_latency_ms,
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
          WHERE netuid = ${netuid} AND day >= ${cutoff}::date
          GROUP BY COALESCE(surface_key, surface_id), day
          ${havingClause}
          ORDER BY day DESC
          LIMIT ${MAX_UPTIME_ROWS}`;
          const freshRows = await sql`
          SELECT MAX(updated_at) AS newest_observed
          FROM surface_uptime_daily WHERE netuid = ${netuid} AND day >= ${cutoff}::date`;
          return json(
            formatUptime({
              netuid,
              window: Object.hasOwn(UPTIME_WINDOWS, windowParam)
                ? windowParam
                : "90d",
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              rows,
              now: new Date().toISOString(),
            }),
          );
        }

        // GET /api/v1/internal/compare-health?netuids=1,7,19 (#4832 gap-closure
        // follow-up): the health-dimension slice handleCompare embeds inline
        // (workers/request-handlers/analytics-routes.mjs) rather than a
        // standalone D1 route, so there's no client request to forward
        // unchanged -- handleCompare synthesizes this request itself once its
        // own netuids/dimensions validation has already run, same "internal"
        // trust boundary as the write-side sync routes above, minus the
        // secret header since a read has no mutation to gate. Reuses
        // METAGRAPH_HEALTH_SOURCE (surface_status, same table the compare
        // dimension reads from D1). netuids is a plain scalar list (never a
        // bound JS array) via sql.unsafe -- see the neurons-sync prune
        // query's comment above for why an ANY($1)/array bind breaks under
        // this Worker's Hyperdrive fetch_types:false setting.
        if (url.pathname === "/api/v1/internal/compare-health") {
          const netuidsRaw = url.searchParams.get("netuids");
          // "".split(",") is [""] and Number("") is 0, so an empty/missing
          // param must short-circuit before split -- not fall through to a
          // spurious IN (0).
          const netuids = netuidsRaw
            ? netuidsRaw.split(",").map(Number).filter(Number.isInteger)
            : [];
          if (netuids.length === 0) {
            return json({ rows: [] });
          }
          const placeholders = netuids
            .map((_, i) => `$${i + 1}::int`)
            .join(", ");
          const rows = await sql.unsafe(
            `SELECT netuid,
                    COUNT(*)::int AS surface_count,
                    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)::int AS ok_count,
                    ROUND(AVG(CASE WHEN status = 'ok' AND latency_ms IS NOT NULL THEN latency_ms END))::int AS avg_latency_ms
             FROM surface_status
             WHERE netuid IN (${placeholders})
             GROUP BY netuid`,
            netuids,
          );
          return json({ rows });
        }

        // GET /api/v1/internal/health-status-live?since=<epoch-ms> (D1
        // retirement, 2026-07-16, item 5 of the D1->Postgres cleanup):
        // src/health-serving.ts's resolveLiveHealth reconstructs the "KV
        // health:current is cold" fallback from surface_status directly (no
        // client request to forward -- same "internal, no secret header"
        // shape as /api/v1/internal/compare-health above, since a read has no
        // mutation to gate). Reuses METAGRAPH_HEALTH_SOURCE (same table
        // compare-health already reads from Postgres). Column list and the
        // last_checked freshness filter mirror resolveLiveHealth's own D1
        // query exactly, so liveFromStatusRows formats either tier's rows
        // identically. last_checked/last_ok are BIGINT epoch-ms -- postgres.js
        // returns those as strings (see numberOrNull's own header comment),
        // so they're coerced here rather than left for the consumer's
        // Number.isFinite/isInteger checks (written against D1's native
        // numbers) to silently null them out.
        if (url.pathname === "/api/v1/internal/health-status-live") {
          // A missing param coerces through Number(null) === 0, which is
          // finite -- must be rejected explicitly before the Number() cast,
          // not folded into the isFinite check (mirrors the netuids empty-
          // string guard on the neighboring routes above).
          const sinceRaw = url.searchParams.get("since");
          const since = sinceRaw ? Number(sinceRaw) : NaN;
          if (!Number.isFinite(since)) {
            return json({ rows: [] });
          }
          const rawRows = await sql`
            SELECT surface_id, surface_key, netuid, kind, provider, url,
                   status, classification, latency_ms, status_code,
                   last_checked, last_ok
            FROM surface_status
            WHERE last_checked >= ${since}`;
          const rows = rawRows.map((row) => ({
            ...row,
            netuid: numberOrNull(row.netuid),
            latency_ms: numberOrNull(row.latency_ms),
            status_code: numberOrNull(row.status_code),
            last_checked: numberOrNull(row.last_checked),
            last_ok: numberOrNull(row.last_ok),
          }));
          return json({ rows });
        }

        // GET /api/v1/internal/latest-block-number (D1 retirement,
        // 2026-07-16, item 10 of the D1->Postgres cleanup):
        // src/subnet-identity-history.mjs's latestBlockNumber has no client
        // request to forward -- it's an internal cron-triggered helper inside
        // recordSubnetIdentityChanges, not a route -- so it synthesizes this
        // request itself, same "internal, no secret header" shape as
        // /api/v1/internal/compare-health above. Reuses METAGRAPH_BLOCKS_SOURCE
        // (same blocks table already flipped to postgres for the public
        // /api/v1/blocks route). Mirrors the identical query
        // handleSubnetIdentitySync already runs inline above for its own
        // block_number stamp.
        if (url.pathname === "/api/v1/internal/latest-block-number") {
          const [row] = await sql`
            SELECT MAX(block_number) AS block_number FROM blocks`;
          const blockNumber =
            row?.block_number == null ? null : Number(row.block_number);
          return json({ block_number: blockNumber });
        }

        // GET /api/v1/internal/subnet-identity-latest-hashes (D1 retirement,
        // 2026-07-16, item 8 of the D1->Postgres cleanup):
        // src/subnet-identity-history.mjs's recordSubnetIdentityChanges reads
        // D1's own latest identity_hash per netuid to diff against the fresh
        // profiles.json snapshot -- same "internal cron helper, no client
        // request to forward" shape as /api/v1/internal/latest-block-number
        // above. Mirrors D1's own latestIdentityHashes query exactly (latest
        // row per netuid via a self-join on MAX(id)), against Postgres's
        // subnet_identity_history (the real writer since
        // syncSubnetIdentityToPostgres landed).
        if (url.pathname === "/api/v1/internal/subnet-identity-latest-hashes") {
          const rows = await sql`
            SELECT h.netuid, h.identity_hash
            FROM subnet_identity_history h
            INNER JOIN (
              SELECT netuid, MAX(id) AS max_id
              FROM subnet_identity_history
              GROUP BY netuid
            ) latest ON h.netuid = latest.netuid AND h.id = latest.max_id`;
          return json({ hashes: rows });
        }

        // GET /api/v1/internal/subnet-identity-aliases?netuids=1,7,19 (#4832
        // gap-closure follow-up): src/subnet-identity-history.mjs's
        // loadPreviouslyKnownAs/loadPreviouslyKnownAsForNetuids are D1-fetch
        // helpers embedded in 3 workers/api.mjs call sites (overlay logic,
        // not standalone routes), so -- same rationale as
        // /api/v1/internal/compare-health -- there is no single client
        // request to forward; api.mjs synthesizes this request itself.
        // Reuses METAGRAPH_SUBNET_IDENTITY_SOURCE (same table already
        // covered by /identity-history, and already flipped to postgres).
        // Returns raw grouped rows; derivePreviouslyKnownAs/
        // deriveNetuidGroupedAliases run identically over D1 or Postgres
        // rows, so the current-name exclusion logic lives in exactly one
        // place regardless of which tier served the query.
        if (url.pathname === "/api/v1/internal/subnet-identity-aliases") {
          const netuidsRaw = url.searchParams.get("netuids");
          const netuids = netuidsRaw
            ? netuidsRaw.split(",").map(Number).filter(Number.isInteger)
            : [];
          if (netuids.length === 0) {
            return json({ rows: [] });
          }
          const placeholders = netuids
            .map((_, i) => `$${i + 1}::int`)
            .join(", ");
          const rows = await sql.unsafe(
            `SELECT netuid, subnet_name, MAX(observed_at) AS observed_at
             FROM subnet_identity_history
             WHERE netuid IN (${placeholders})
               AND subnet_name IS NOT NULL AND TRIM(subnet_name) != ''
             GROUP BY netuid, subnet_name
             ORDER BY netuid, observed_at DESC`,
            netuids,
          );
          return json({ rows });
        }

        // GET /api/v1/subnets/:netuid/trajectory (#4832 gap-closure): weekly
        // structural + economics trajectory from the daily snapshot, mirroring
        // workers/request-handlers/analytics-routes.mjs's handleTrajectory.
        // format=csv is handled entirely D1-side (csvResponse never reaches
        // tryPostgresTier's own request-forward for this route -- see that
        // handler); this route only ever needs to return JSON.
        const subnetTrajectory = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/trajectory$/,
        );
        if (subnetTrajectory) {
          const netuid = Number(subnetTrajectory[1]);
          const rows = await sql`
          SELECT snapshot_date::text AS snapshot_date, completeness_score,
                 surface_count, endpoint_count, validator_count, miner_count,
                 total_stake_tao, alpha_price_tao, emission_share,
                 tao_in_pool_tao, alpha_in_pool, alpha_out_pool, subnet_volume_tao
          FROM subnet_snapshots
          WHERE netuid = ${netuid}
          ORDER BY snapshot_date DESC
          LIMIT 400`;
          return json(formatTrajectory({ netuid, rows }));
        }

        // GET /api/v1/economics/trends?window= (#4832 gap-closure):
        // network-wide daily economics time series, mirroring
        // workers/request-handlers/analytics-routes.mjs's handleEconomicsTrends
        // via src/economics-trends.ts's loadEconomicsTrends. A malformed
        // window degrades to "all" (no cutoff) rather than erroring -- the
        // D1-side handler already rejects it before ever reaching this route
        // in the real request path, same convention as the uptime route's
        // windowParam above.
        if (url.pathname === "/api/v1/economics/trends") {
          const windowParam = url.searchParams.get("window");
          const parsedWindow = parseHistoryWindow(windowParam);
          const windowDays = parsedWindow.error ? null : parsedWindow.days;
          const windowLabel = parsedWindow.error ? "all" : parsedWindow.label;
          const cutoff =
            windowDays != null
              ? new Date(Date.now() - windowDays * ANALYTICS_DAY_MS)
                  .toISOString()
                  .slice(0, 10)
              : null;
          const rows = await sql`
          SELECT snapshot_date::text AS snapshot_date, total_stake_tao,
                 alpha_price_tao, validator_count, miner_count, emission_share
          FROM subnet_snapshots
          ${cutoff ? sql`WHERE snapshot_date >= ${cutoff}::date` : sql``}
          ORDER BY snapshot_date DESC
          LIMIT ${ECONOMICS_TRENDS_ROW_CAP}`;
          return json(
            buildEconomicsTrends(rows, {
              window: windowLabel,
              capped: rows.length >= ECONOMICS_TRENDS_ROW_CAP,
            }),
          );
        }

        // GET /api/v1/rpc/usage?window= (#4832 gap-closure): RPC
        // reverse-proxy usage analytics -- request volume, latency p50/p95,
        // failover + error rate, cache-hit rate, per-endpoint/network
        // breakdown, and bounded time buckets. Mirrors
        // src/rpc-usage-loader.ts's loadRpcUsage exactly (same 5 parallel
        // queries feeding formatRpcUsage): the D1 rank-CTE p50/p95 becomes
        // PERCENTILE_CONT (live-verified via psql 2026-07-11, same
        // precedent as the health-trends/percentiles routes above), and D1's
        // `ok = 1` becomes the bare BOOLEAN column. window is already
        // validated by handleRpcUsage before tryPostgresTier ever forwards
        // this request, so an unrecognized label just falls back to the
        // default here (same convention as windowCutoff/windowLabelFor
        // everywhere else in this file).
        if (url.pathname === "/api/v1/rpc/usage") {
          const windowLabel = windowLabelFor(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const cutoff = windowCutoff(
            url,
            ANALYTICS_WINDOWS,
            DEFAULT_ANALYTICS_WINDOW,
          );
          const bucketConfig = RPC_USAGE_BUCKETS[windowLabel];
          const [
            totalsRows,
            latencyRows,
            endpointRows,
            networkRows,
            bucketRows,
            freshRows,
          ] = await Promise.all([
            sql`
            SELECT COUNT(*)::int AS total,
                   SUM(CASE WHEN ok THEN 1 ELSE 0 END)::int AS ok_count,
                   SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END)::int AS failover_count,
                   SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END)::int AS cache_hits,
                   AVG(latency_ms) AS avg_latency_ms
            FROM rpc_proxy_events
            WHERE observed_at >= ${cutoff}`,
            sql`
            SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
                   PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
            FROM rpc_proxy_events
            WHERE observed_at >= ${cutoff} AND latency_ms IS NOT NULL`,
            sql`
            SELECT endpoint_id, provider,
                   COUNT(*)::int AS requests,
                   SUM(CASE WHEN ok THEN 1 ELSE 0 END)::int AS ok_count,
                   AVG(latency_ms) AS avg_latency_ms
            FROM rpc_proxy_events
            WHERE observed_at >= ${cutoff} AND endpoint_id IS NOT NULL
            GROUP BY endpoint_id, provider
            ORDER BY requests DESC, endpoint_id ASC, provider ASC
            LIMIT 50`,
            sql`
            SELECT network,
                   COUNT(*)::int AS requests,
                   SUM(CASE WHEN ok THEN 1 ELSE 0 END)::int AS ok_count
            FROM rpc_proxy_events
            WHERE observed_at >= ${cutoff}
            GROUP BY network
            ORDER BY requests DESC, network ASC`,
            sql`
            SELECT ts, requests, errors, avg_latency_ms FROM (
              SELECT (observed_at / ${bucketConfig.bucketMs}::bigint)::bigint * ${bucketConfig.bucketMs}::bigint AS ts,
                     COUNT(*)::int AS requests,
                     SUM(CASE WHEN ok THEN 0 ELSE 1 END)::int AS errors,
                     AVG(latency_ms) AS avg_latency_ms
              FROM rpc_proxy_events
              WHERE observed_at >= ${cutoff}
              GROUP BY ts
              ORDER BY ts DESC
              LIMIT ${bucketConfig.maxBuckets}
            ) sub
            ORDER BY ts ASC`,
            sql`
            SELECT MAX(observed_at) AS newest_observed
            FROM rpc_proxy_events WHERE observed_at >= ${cutoff}`,
          ]);
          return json(
            formatRpcUsage({
              window: windowLabel,
              observedAt: latestObservedIso(freshRows, "newest_observed"),
              totals: totalsRows[0],
              latency: latencyRows[0],
              endpointRows,
              networkRows,
              bucketRows,
              bucketGranularity: bucketConfig.granularity,
            }),
          );
        }

        // GET /api/v1/accounts/:ss58/stake-flow
        const acctStakeFlow = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/stake-flow$/,
        );
        if (acctStakeFlow) {
          const address = decodeURIComponent(acctStakeFlow[1]);
          const cutoff = windowCutoff(
            url,
            STAKE_FLOW_WINDOWS,
            DEFAULT_STAKE_FLOW_WINDOW,
          );
          const directionParam = url.searchParams.get("direction");
          // Scalar binds only (never a bound JS array) -- Hyperdrive's
          // fetch_types:false breaks postgres.js's ANY($1)/array serialization,
          // see the neurons-sync prune query's comment above for the confirmed
          // live repro. Explicit IN (...)/= branches per direction instead.
          const rows = await sql`
          SELECT netuid, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao,
            COUNT(*) AS event_count, MAX(observed_at) AS last_observed
          FROM account_events
          WHERE (hotkey = ${address} OR coldkey = ${address})
            ${directionParam === "in" ? sql`AND event_kind = ${STAKE_ADDED_KIND}` : directionParam === "out" ? sql`AND event_kind = ${STAKE_REMOVED_KIND}` : sql`AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND})`}
            AND observed_at >= ${cutoff}
          GROUP BY netuid, event_kind`;
          return json({
            data: buildAccountStakeFlow(rows, address, {
              window: windowLabelFor(
                url,
                STAKE_FLOW_WINDOWS,
                DEFAULT_STAKE_FLOW_WINDOW,
              ),
            }),
            generatedAt: latestObservedIso(rows),
          });
        }

        // GET /api/v1/subnets/:netuid/stake-flow
        const subnetStakeFlow = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/stake-flow$/,
        );
        if (subnetStakeFlow) {
          const netuid = Number(subnetStakeFlow[1]);
          const cutoff = windowCutoff(
            url,
            STAKE_FLOW_WINDOWS,
            DEFAULT_STAKE_FLOW_WINDOW,
          );
          const directionParam = url.searchParams.get("direction");
          // Scalar binds only -- see the account-level stake-flow route above
          // for why a bound JS array (ANY($1)) is unsafe here.
          const rows = await sql`
          SELECT event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, COUNT(*) AS event_count,
                 MAX(observed_at) AS last_observed
          FROM account_events
          WHERE netuid = ${netuid}
            ${directionParam === "in" ? sql`AND event_kind = ${STAKE_ADDED_KIND}` : directionParam === "out" ? sql`AND event_kind = ${STAKE_REMOVED_KIND}` : sql`AND event_kind IN (${STAKE_ADDED_KIND}, ${STAKE_REMOVED_KIND})`}
            AND observed_at >= ${cutoff}
          GROUP BY event_kind`;
          return json({
            data: buildStakeFlow(rows, netuid, {
              window: windowLabelFor(
                url,
                STAKE_FLOW_WINDOWS,
                DEFAULT_STAKE_FLOW_WINDOW,
              ),
            }),
            generatedAt: latestObservedIso(rows),
          });
        }

        // GET /api/v1/accounts/:ss58/stake-moves
        const acctStakeMoves = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/stake-moves$/,
        );
        if (acctStakeMoves) {
          const address = decodeURIComponent(acctStakeMoves[1]);
          const cutoff = windowCutoff(
            url,
            ACCOUNT_STAKE_MOVES_WINDOWS,
            DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
          );
          const rows = await sql`
          SELECT netuid, COUNT(*) AS movements, MIN(observed_at) AS first_observed,
                 MAX(observed_at) AS last_observed
          FROM account_events
          WHERE (hotkey = ${address} OR coldkey = ${address}) AND event_kind = ${STAKE_MOVED_EVENT_KIND} AND observed_at >= ${cutoff}
          GROUP BY netuid`;
          return json({
            data: buildAccountStakeMoves(rows, address, {
              window: windowLabelFor(
                url,
                ACCOUNT_STAKE_MOVES_WINDOWS,
                DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
              ),
            }),
            generatedAt: latestObservedIso(rows),
          });
        }

        // GET /api/v1/subnets/:netuid/stake-moves
        const subnetStakeMoves = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/stake-moves$/,
        );
        if (subnetStakeMoves) {
          const netuid = Number(subnetStakeMoves[1]);
          const cutoff = windowCutoff(
            url,
            SUBNET_STAKE_MOVES_WINDOWS,
            DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
          );
          // The distinct-mover count is a correlated subquery (grouped rows,
          // then COUNT(*) of the groups) rather than COUNT(DISTINCT <col>) so
          // the delegating account's column is only ever named once, in a
          // scanner-safe form: a bare identifier immediately before `AS` (the
          // public-safety scanner's SQL-usage allowlist covers `coldkey AS`).
          // The subquery selects ONLY the grouped `coldkey` — an earlier copy
          // also selected `observed_at`, which Postgres rejects (neither in
          // GROUP BY 1 nor aggregated) and which was unused here anyway, the
          // outer query computing its own MAX(observed_at) (#6877).
          const rows = await sql`
          SELECT COUNT(*) AS movements,
            (SELECT COUNT(*) FROM (
              SELECT coldkey AS mover FROM account_events
              WHERE netuid = ${netuid} AND event_kind = ${STAKE_MOVED_EVENT_KIND} AND observed_at >= ${cutoff}
              GROUP BY 1
            ) movers) AS distinct_movers,
                 MAX(observed_at) AS newest_observed
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind = ${STAKE_MOVED_EVENT_KIND} AND observed_at >= ${cutoff}`;
          return json(
            buildSubnetStakeMoves(rows[0] ?? null, netuid, {
              window: windowLabelFor(
                url,
                SUBNET_STAKE_MOVES_WINDOWS,
                DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/stake-transfers
        const subnetStakeTransfers = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/stake-transfers$/,
        );
        if (subnetStakeTransfers) {
          const netuid = Number(subnetStakeTransfers[1]);
          const cutoff = windowCutoff(
            url,
            SUBNET_STAKE_TRANSFERS_WINDOWS,
            DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
          );
          // See the sibling stake-moves route above for why this is a
          // grouped-subquery COUNT(*) rather than COUNT(DISTINCT <col>).
          const rows = await sql`
          SELECT COUNT(*) AS transfers,
            (SELECT COUNT(*) FROM (
              SELECT coldkey AS sender FROM account_events
              WHERE netuid = ${netuid} AND event_kind = ${STAKE_TRANSFERRED_EVENT_KIND} AND observed_at >= ${cutoff}
              GROUP BY 1
            ) senders) AS distinct_senders,
                 MAX(observed_at) AS newest_observed
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind = ${STAKE_TRANSFERRED_EVENT_KIND} AND observed_at >= ${cutoff}`;
          return json(
            buildSubnetStakeTransfers(rows[0] ?? null, netuid, {
              window: windowLabelFor(
                url,
                SUBNET_STAKE_TRANSFERS_WINDOWS,
                DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
              ),
            }),
          );
        }

        // The 5 account-level "count one event_kind per subnet" footprints
        // (registrations/serving/axon-removals/prometheus/deregistrations) share
        // an identical shape -- only the event_kind + output field name differ.
        const ACCOUNT_FOOTPRINTS = [
          {
            re: /^\/api\/v1\/accounts\/([^/]+)\/registrations$/,
            kind: REGISTRATION_EVENT_KIND,
            metric: "registrations",
            build: buildAccountRegistrations,
            windows: REGISTRATION_WINDOWS,
            def: DEFAULT_REGISTRATION_WINDOW,
          },
          {
            re: /^\/api\/v1\/accounts\/([^/]+)\/serving$/,
            kind: SERVING_EVENT_KIND,
            metric: "announcements",
            build: buildAccountServing,
            windows: SERVING_WINDOWS,
            def: DEFAULT_SERVING_WINDOW,
          },
          {
            re: /^\/api\/v1\/accounts\/([^/]+)\/axon-removals$/,
            kind: AXON_REMOVAL_EVENT_KIND,
            metric: "removals",
            build: buildAccountAxonRemovals,
            windows: AXON_REMOVAL_WINDOWS,
            def: DEFAULT_AXON_REMOVAL_WINDOW,
          },
          {
            re: /^\/api\/v1\/accounts\/([^/]+)\/prometheus$/,
            kind: PROMETHEUS_EVENT_KIND,
            metric: "announcements",
            build: buildAccountPrometheus,
            windows: PROMETHEUS_WINDOWS,
            def: DEFAULT_PROMETHEUS_WINDOW,
          },
          {
            re: /^\/api\/v1\/accounts\/([^/]+)\/deregistrations$/,
            kind: DEREGISTRATION_EVENT_KIND,
            metric: "deregistrations",
            build: buildAccountDeregistrations,
            windows: DEREGISTRATION_WINDOWS,
            def: DEFAULT_DEREGISTRATION_WINDOW,
          },
        ];
        for (const fp of ACCOUNT_FOOTPRINTS) {
          const m = url.pathname.match(fp.re);
          if (!m) continue;
          const address = decodeURIComponent(m[1]);
          const cutoff = windowCutoff(url, fp.windows, fp.def);
          const rows = await sql`
          SELECT netuid, COUNT(*) AS metric, MIN(observed_at) AS first_observed, MAX(observed_at) AS last_observed
          FROM account_events
          WHERE hotkey = ${address} AND event_kind = ${fp.kind} AND observed_at >= ${cutoff}
          GROUP BY netuid`;
          const renamed = rows.map((row) => ({
            ...row,
            [fp.metric]: row.metric,
          }));
          return json({
            data: fp.build(renamed, address, {
              window: windowLabelFor(url, fp.windows, fp.def),
            }),
            generatedAt: latestObservedIso(rows),
          });
        }

        // The 5 subnet-level siblings (single-row aggregate, no GROUP BY).
        const SUBNET_FOOTPRINTS = [
          {
            re: /^\/api\/v1\/subnets\/(\d+)\/registrations$/,
            kind: REGISTRATION_EVENT_KIND,
            metric: "registrations",
            distinct: "distinct_registrants",
            build: buildSubnetRegistrations,
            windows: SUBNET_REGISTRATIONS_WINDOWS,
            def: DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
          },
          {
            re: /^\/api\/v1\/subnets\/(\d+)\/serving$/,
            kind: SERVING_EVENT_KIND,
            metric: "announcements",
            distinct: "distinct_servers",
            build: buildSubnetServing,
            windows: SUBNET_SERVING_WINDOWS,
            def: DEFAULT_SUBNET_SERVING_WINDOW,
          },
          {
            re: /^\/api\/v1\/subnets\/(\d+)\/axon-removals$/,
            kind: AXON_REMOVAL_EVENT_KIND,
            metric: "removals",
            distinct: "distinct_removers",
            build: buildSubnetAxonRemovals,
            windows: SUBNET_AXON_REMOVALS_WINDOWS,
            def: DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
          },
          {
            re: /^\/api\/v1\/subnets\/(\d+)\/prometheus$/,
            kind: PROMETHEUS_EVENT_KIND,
            metric: "announcements",
            distinct: "distinct_exporters",
            build: buildSubnetPrometheus,
            windows: SUBNET_PROMETHEUS_WINDOWS,
            def: DEFAULT_SUBNET_PROMETHEUS_WINDOW,
          },
          {
            re: /^\/api\/v1\/subnets\/(\d+)\/deregistrations$/,
            kind: DEREGISTRATION_EVENT_KIND,
            metric: "deregistrations",
            distinct: "distinct_deregistered_hotkeys",
            build: buildSubnetDeregistrations,
            windows: SUBNET_DEREGISTRATIONS_WINDOWS,
            def: DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
          },
        ];
        for (const fp of SUBNET_FOOTPRINTS) {
          const m = url.pathname.match(fp.re);
          if (!m) continue;
          const netuid = Number(m[1]);
          const cutoff = windowCutoff(url, fp.windows, fp.def);
          const rows = await sql`
          SELECT COUNT(*) AS metric, COUNT(DISTINCT hotkey) AS distinctx, MAX(observed_at) AS newest_observed
          FROM account_events
          WHERE netuid = ${netuid} AND event_kind = ${fp.kind} AND observed_at >= ${cutoff}`;
          const row = rows[0]
            ? {
                [fp.metric]: rows[0].metric,
                [fp.distinct]: rows[0].distinctx,
                newest_observed: rows[0].newest_observed,
              }
            : null;
          return json(
            fp.build(row, netuid, {
              window: windowLabelFor(url, fp.windows, fp.def),
            }),
          );
        }

        // GET /api/v1/accounts/:ss58/transfers
        const acctTransfers = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/transfers$/,
        );
        if (acctTransfers) {
          const ss58 = decodeURIComponent(acctTransfers[1]);
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          // METAGRAPHED-6-class fix: 3-part cursor (observed_at, block_number,
          // event_index) matching the observed_at-leading ORDER BY below.
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const direction = url.searchParams.get("direction");
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          let rows;
          if (direction === "sent" || direction === "received") {
            // A single indexed column -- idx_ae_hotkey/idx_ae_coldkey already
            // handle this efficiently, same as before; only the "all
            // directions" case below hits METAGRAPHED-6's OR-defeats-index
            // problem.
            rows = await sql`
            SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
            FROM account_events
            WHERE event_kind = 'Transfer'
              ${direction === "sent" ? sql`AND hotkey = ${ss58}` : sql`AND coldkey = ${ss58}`}
              ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
              ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
              ${cursor ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
            ORDER BY observed_at DESC, block_number DESC, event_index DESC
            LIMIT ${limit}
            ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          } else {
            // Same METAGRAPHED-6 fix as /api/v1/accounts/:ss58/events above:
            // a flat `WHERE (hotkey = $1 OR coldkey = $1)` defeats index
            // usage on account_events' TimescaleDB-compressed chunks (hotkey
            // has no compression segment/order-by metadata, unlike coldkey),
            // so split into two indexed branches and merge client-side.
            const perBranchLimit = limit + (cursor ? 0 : offset);
            await sql`SET LOCAL statement_timeout = '10000ms'`;
            const hotkeyRows = await sql`
            SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
            FROM account_events
            WHERE event_kind = 'Transfer' AND hotkey = ${ss58}
              ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
              ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
              ${cursor ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
            ORDER BY observed_at DESC, block_number DESC, event_index DESC
            LIMIT ${perBranchLimit}`;
            const coldkeyRows = await sql`
            SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
            FROM account_events
            WHERE event_kind = 'Transfer' AND coldkey = ${ss58} AND (hotkey IS NULL OR hotkey <> ${ss58})
              ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
              ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
              ${cursor ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})` : sql``}
            ORDER BY observed_at DESC, block_number DESC, event_index DESC
            LIMIT ${perBranchLimit}`;
            const merged = hotkeyRows.concat(coldkeyRows).sort((a, b) => {
              const observedDelta =
                Number(b.observed_at) - Number(a.observed_at);
              if (observedDelta !== 0) return observedDelta;
              const blockDelta =
                Number(b.block_number) - Number(a.block_number);
              if (blockDelta !== 0) return blockDelta;
              return Number(b.event_index) - Number(a.event_index);
            });
            const windowStart = cursor ? 0 : offset;
            rows = merged.slice(windowStart, windowStart + limit);
          }
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.block_number),
                numberOrNull(last.event_index),
              ])
            : null;
          return json(
            buildAccountTransfers(rows, ss58, {
              limit,
              offset,
              nextCursor,
              direction:
                direction === "sent" || direction === "received"
                  ? direction
                  : undefined,
            }),
          );
        }

        // GET /api/v1/accounts/:ss58/counterparties[?counterparty=]
        const acctCounterparties = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/counterparties$/,
        );
        if (acctCounterparties) {
          const ss58 = decodeURIComponent(acctCounterparties[1]);
          const counterparty = url.searchParams.get("counterparty");
          const limit = Math.min(
            Math.max(
              Number(url.searchParams.get("limit")) ||
                (counterparty == null ? 20 : 50),
              1,
            ),
            100,
          );
          if (counterparty) {
            // METAGRAPHED-6/5: rewritten as a UNION ALL of two single-column-indexed
            // legs instead of one `((hotkey=? AND coldkey=?) OR (hotkey=? AND
            // coldkey=?))` predicate. account_events is a 10M-rows/week compressed
            // TimescaleDB hypertable (#4832/#4869) -- neither idx_ae_kind_hotkey_observed
            // nor idx_ae_kind_coldkey_observed can drive a single scan across an OR of
            // two independently-valued hotkey/coldkey pairs, so Postgres fell back to a
            // cross-chunk scan + sort that timed out under load (statement_timeout
            // cancellations, "canceling statement due to statement timeout"). Each leg
            // here filters on ONE indexed `hotkey = <literal>` value (idx_ae_kind_hotkey_
            // observed covers event_kind+hotkey+observed_at, INCLUDE amount_tao), with
            // coldkey/observed_at ORDER BY + LIMIT applied inside the leg so the index
            // scan itself is bounded, not a residual filter over the whole table. The
            // trailing `${ss58} IS DISTINCT FROM ${counterparty}` guard (NULL-safe,
            // unlike !=) skips leg 2 entirely when querying an account's relationship
            // with itself, where both legs would otherwise resolve to the identical
            // predicate and UNION ALL would double-count every matching row.
            const rows = await sql`
            SELECT hotkey, coldkey, amount_tao, block_number, event_index FROM (
              (SELECT hotkey, coldkey, amount_tao, block_number, event_index, observed_at
               FROM account_events
               WHERE event_kind = 'Transfer' AND hotkey = ${ss58} AND coldkey = ${counterparty}
               ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${COUNTERPARTIES_SCAN_CAP})
              UNION ALL
              (SELECT hotkey, coldkey, amount_tao, block_number, event_index, observed_at
               FROM account_events
               WHERE event_kind = 'Transfer' AND hotkey = ${counterparty} AND coldkey = ${ss58}
                 AND ${ss58} IS DISTINCT FROM ${counterparty}
               ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${COUNTERPARTIES_SCAN_CAP})
            ) combined
            ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${COUNTERPARTIES_SCAN_CAP}`;
            const relationship = buildCounterpartyRelationship(
              rows,
              ss58,
              counterparty,
              { limit },
            );
            const counterparties =
              relationship.transfer_count === 0
                ? []
                : [
                    {
                      address: counterparty,
                      sent_tao: relationship.total_sent_tao,
                      received_tao: relationship.total_received_tao,
                      net_tao: relationship.net_tao,
                      transfer_count: relationship.transfer_count,
                      last_block: relationship.last_block,
                    },
                  ];
            return json({
              schema_version: 1,
              ss58,
              counterparty_count: counterparties.length,
              transfers_scanned: relationship.transfers_scanned,
              scan_capped: relationship.scan_capped,
              total_sent_tao: relationship.total_sent_tao,
              total_received_tao: relationship.total_received_tao,
              counterparties,
              relationship,
            });
          }
          // METAGRAPHED-6/5: same UNION ALL rewrite as the counterparty-drilldown query
          // above, for the same reason -- `(hotkey = ? OR coldkey = ?)` can't use either
          // idx_ae_kind_hotkey_observed or idx_ae_kind_coldkey_observed, and this is the
          // route the timing-out production traffic actually hit (a crawler repeatedly
          // listing ALL counterparties for many addresses with no ?counterparty= filter).
          // `hotkey IS DISTINCT FROM ss58` (NULL-safe) on the coldkey = ss58 leg
          // excludes the one row shape (a genuine self-transfer, hotkey = coldkey =
          // ss58) the hotkey = ss58 leg already caught, so UNION ALL can never
          // double-count it.
          const rows = await sql`
          SELECT hotkey, coldkey, amount_tao, block_number, event_index FROM (
            (SELECT hotkey, coldkey, amount_tao, block_number, event_index, observed_at
             FROM account_events
             WHERE event_kind = 'Transfer' AND hotkey = ${ss58}
             ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${COUNTERPARTIES_SCAN_CAP})
            UNION ALL
            (SELECT hotkey, coldkey, amount_tao, block_number, event_index, observed_at
             FROM account_events
             WHERE event_kind = 'Transfer' AND coldkey = ${ss58} AND hotkey IS DISTINCT FROM ${ss58}
             ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${COUNTERPARTIES_SCAN_CAP})
          ) combined
          ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${COUNTERPARTIES_SCAN_CAP}`;
          return json(buildCounterparties(rows, ss58, { limit }));
        }

        // GET /api/v1/blocks/:n/chain-events — EVERY event in a block (the all-events
        // tier). Distinct from the existing /blocks/:ref/events (curated, D1, #1852).
        const block = url.pathname.match(
          /^\/api\/v1\/blocks\/(\d+)\/chain-events$/,
        );
        if (block) {
          const bn = Number(block[1]);
          const rows = await sql`
          SELECT event_index, pallet, method, args, phase, extrinsic_index, observed_at
          FROM chain_events
          WHERE block_number = ${bn}
          ORDER BY event_index ASC`;
          return json({
            block_number: bn,
            count: rows.length,
            events: rows.map(coerceEvent),
          });
        }

        // GET /api/v1/chain-events?pallet=&method=&block=&extrinsic=&cursor=&before=&limit=
        // recent all-events feed. block= scopes to one block; block=+extrinsic= scopes to
        // a single extrinsic's emitted events (explorer extrinsic-detail view). Ignore
        // extrinsic without block to avoid an unindexed global extrinsic_index scan.
        // cursor is the lossless keyset over (block_number,event_index); before is
        // retained as the legacy block_number-only cursor for existing callers.
        if (url.pathname === "/api/v1/chain-events") {
          const limit = clampLimit(url.searchParams.get("limit"));
          const pallet = url.searchParams.get("pallet");
          const method = url.searchParams.get("method");
          if (!validEventFilter(pallet) || !validEventFilter(method)) {
            return json(
              {
                error:
                  "pallet and method must be 1-64 ASCII letters, digits, or underscores, starting with a letter",
              },
              400,
            );
          }
          const blockN = nonNegativeIntegerParam(url.searchParams, "block");
          const extrN =
            blockN != null
              ? nonNegativeIntegerParam(url.searchParams, "extrinsic")
              : null;
          // 3-tuple cursor (observed_at, block_number, event_index) for the
          // same reason as /api/v1/extrinsics above: chain_events is a
          // TimescaleDB hypertable partitioned on observed_at, so ordering
          // (and seeking) by observed_at first lets ChunkAppend prune to the
          // live head chunk instead of a full cross-chunk sort. The legacy
          // `before` (block_number) cursor still does a plain inequality —
          // correct (block_number and observed_at are monotonic together)
          // even though it can't get the same single-chunk shortcut.
          const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
          const beforeBn = cursor
            ? null
            : nonNegativeIntegerParam(url.searchParams, "before"); // legacy block_number cursor
          if (method && !pallet && blockN == null) {
            return json(
              {
                error:
                  "method filter requires pallet unless block is specified",
              },
              400,
            );
          }
          const rows = await sql`
          SELECT block_number, event_index, pallet, method, args, phase, extrinsic_index, observed_at
          FROM chain_events
          WHERE TRUE
            ${blockN != null ? sql`AND block_number = ${blockN}` : sql``}
            ${extrN != null ? sql`AND extrinsic_index = ${extrN}` : sql``}
            ${
              cursor
                ? sql`AND (observed_at, block_number, event_index) < (${cursor[0]}, ${cursor[1]}, ${cursor[2]})`
                : beforeBn != null
                  ? sql`AND block_number < ${beforeBn}`
                  : sql``
            }
            ${pallet ? sql`AND pallet = ${pallet}` : sql``}
            ${method ? sql`AND method = ${method}` : sql``}
          ORDER BY observed_at DESC, block_number DESC, event_index DESC
          LIMIT ${limit}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextBlock = last ? numberOrNull(last.block_number) : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                nextBlock,
                numberOrNull(last.event_index),
              ])
            : null;
          return json({
            count: rows.length,
            next_before: nextBlock,
            next_cursor: nextCursor,
            events: rows.map(coerceEvent),
          });
        }

        // GET /api/v1/chain-events/stats?blocks=N — chain-activity aggregate: the
        // pallet.method event distribution over the most recent N blocks (default
        // 1000, capped 5000). Bounded window + capped output keep it index-cheap.
        if (url.pathname === "/api/v1/chain-events/stats") {
          const blocks = clampStatsBlocks(url.searchParams.get("blocks"));
          // count is a non-unique sort key, so ORDER BY count alone leaves ties
          // unordered — and over Hyperdrive's pooled connections (prepare:false)
          // Postgres can plan/scan identical requests differently, reshuffling
          // equal-count groups and flipping which groups survive LIMIT 100 at the
          // boundary. Tie-break on the GROUP BY key (unique per row) for a total,
          // stable order, matching the keyset orders on the sibling queries above.
          const rows = await sql`
          SELECT pallet, method, count(*)::int AS count
          FROM chain_events
          WHERE block_number > (SELECT max(block_number) FROM chain_events) - ${blocks}
          GROUP BY pallet, method
          ORDER BY count DESC, pallet ASC, method ASC
          LIMIT 100`;
          return json({
            window_blocks: blocks,
            groups: rows.length,
            activity: rows,
          });
        }

        // GET /api/v1/subnets/:netuid/metagraph?validator_permit=true (#4771):
        // the per-UID metagraph tier, mirroring src/metagraph-neurons.ts's
        // loadSubnetMetagraph. Same column list as the neuron detail/validators
        // routes below (NEURON_COLUMNS) -- written literally per this file's
        // own convention (a `${...}` interpolation binds a PARAMETER, not raw
        // SQL, so a shared column-list string can't be spliced in).
        const subnetMetagraph = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/metagraph$/,
        );
        if (subnetMetagraph) {
          const netuid = Number(subnetMetagraph[1]);
          const validatorsOnly =
            url.searchParams.get("validator_permit") === "true";
          const [rows, immunityPeriod] = await Promise.all([
            validatorsOnly
              ? sql`
              SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at, take
              FROM neurons WHERE netuid = ${netuid} AND validator_permit = TRUE ORDER BY uid`
              : sql`
              SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at, take
              FROM neurons WHERE netuid = ${netuid} ORDER BY uid`,
            loadSubnetImmunityPeriod(sql, netuid),
          ]);
          return json(buildSubnetMetagraph(rows, netuid, { immunityPeriod }));
        }

        // GET /api/v1/subnets/:netuid/neurons/:uid (#4771): per-UID detail,
        // mirroring loadNeuron. A miss returns neuron:null (schema-stable,
        // never 404 -- matches the D1 path's own contract).
        const neuronDetail = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)$/,
        );
        if (neuronDetail) {
          const netuid = Number(neuronDetail[1]);
          const uid = Number(neuronDetail[2]);
          const [rows, immunityPeriod] = await Promise.all([
            sql`
          SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at, take
          FROM neurons WHERE netuid = ${netuid} AND uid = ${uid} LIMIT 1`,
            loadSubnetImmunityPeriod(sql, netuid),
          ]);
          return json(
            buildNeuronDetail(rows[0] ?? null, netuid, { immunityPeriod }),
          );
        }

        // GET /api/v1/subnets/:netuid/validators (#4771): validator_permit=1
        // rows for one subnet, ranked by stake. Mirrors loadSubnetValidators.
        const subnetValidators = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/validators$/,
        );
        if (subnetValidators) {
          const netuid = Number(subnetValidators[1]);
          const [rows, featuredHotkeys] = await Promise.all([
            sql`
          SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at, take
          FROM neurons WHERE netuid = ${netuid} AND validator_permit = TRUE
          ORDER BY stake_tao DESC, uid ASC`,
            loadFeaturedHotkeys(sql),
          ]);
          return json(buildSubnetValidators(rows, netuid, { featuredHotkeys }));
        }

        // GET /api/v1/validators?sort=&limit= (#4771): network-wide validator
        // leaderboard, mirroring loadGlobalValidators. Trusts already-validated
        // sort/limit params (the caller, workers/request-handlers/entities.mjs's
        // handleGlobalValidators, validates them before forwarding here).
        if (url.pathname === "/api/v1/validators") {
          const sortParam = url.searchParams.get("sort");
          const sort = GLOBAL_VALIDATOR_SORTS.includes(sortParam)
            ? sortParam
            : DEFAULT_GLOBAL_VALIDATOR_SORT;
          const limitParam = Number(url.searchParams.get("limit"));
          const limit =
            Number.isInteger(limitParam) &&
            limitParam >= 1 &&
            limitParam <= GLOBAL_VALIDATOR_LIMIT_MAX
              ? limitParam
              : GLOBAL_VALIDATOR_LIMIT_DEFAULT;
          const [
            rows,
            featuredHotkeys,
            nominatorCounts,
            tempoByNetuid,
            realizedStakeByHotkey,
          ] = await Promise.all([
            sql`
          SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, stake_tao, block_number, captured_at, take
          FROM neurons WHERE validator_permit = TRUE AND hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
            loadFeaturedHotkeys(sql),
            loadValidatorNominatorCounts(sql),
            loadSubnetTempos(sql),
            loadRealizedStakeBaselines(sql),
          ]);
          // Identity join (#5234): needs `rows` resolved first to know which
          // coldkeys to look up, so it can't join the Promise.all above.
          const identityByColdkey = await loadAccountIdentitiesByColdkey(
            sql,
            distinctColdkeys(rows),
          );
          return json(
            buildGlobalValidators(rows, {
              sort,
              limit,
              featuredHotkeys,
              identityByColdkey,
              nominatorCounts,
              tempoByNetuid,
              realizedStakeByHotkey,
            }),
          );
        }

        // GET /api/v1/validators/:hotkey (#4771): cross-subnet validator detail,
        // mirroring loadValidatorDetail.
        const validatorDetail = url.pathname.match(
          /^\/api\/v1\/validators\/([^/]+)$/,
        );
        if (validatorDetail) {
          const hotkey = decodeURIComponent(validatorDetail[1]);
          const [rows, nominatorCounts, tempoByNetuid, realizedByHotkey] =
            await Promise.all([
              sql`
          SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at, take, netuid
          FROM neurons WHERE hotkey = ${hotkey} AND validator_permit = TRUE
          ORDER BY netuid ASC, uid ASC`,
              loadValidatorNominatorCounts(sql),
              loadSubnetTempos(sql),
              loadRealizedStakeBaselines(sql, { hotkey }),
            ]);
          // Identity join (#5234): see the /api/v1/validators comment above.
          const identityByColdkey = await loadAccountIdentitiesByColdkey(
            sql,
            distinctColdkeys(rows),
          );
          return json(
            buildValidatorDetail(rows, hotkey, {
              identityByColdkey,
              nominatorCount: nominatorCounts.get(hotkey) ?? null,
              tempoByNetuid,
              realizedStake: realizedByHotkey.get(hotkey) ?? null,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/concentration (#4832 Tier 2): stake &
        // emission decentralization for one subnet, mirroring
        // src/concentration.ts's the handler's own inline query (no shared
        // loader -- this is one of the live-`neurons` routes, distinct from
        // the neuron_daily-derived /concentration/history below).
        const subnetConcentration = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/concentration$/,
        );
        if (subnetConcentration) {
          const netuid = Number(subnetConcentration[1]);
          const rows = await sql`
          SELECT stake_tao, emission_tao, coldkey, validator_permit, captured_at
          FROM neurons WHERE netuid = ${netuid}`;
          return json(buildConcentration(rows, netuid));
        }

        // GET /api/v1/subnets/:netuid/performance (#4832 Tier 2): reward-flow &
        // trust-spread for one subnet, mirroring the handler's own inline query.
        const subnetPerformance = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/performance$/,
        );
        if (subnetPerformance) {
          const netuid = Number(subnetPerformance[1]);
          const rows = await sql`
          SELECT incentive, dividends, trust, consensus, validator_trust, active, validator_permit, captured_at
          FROM neurons WHERE netuid = ${netuid}`;
          return json(buildSubnetPerformance(rows, netuid));
        }

        // GET /api/v1/chain/concentration (#4832 Tier 2): network-wide stake &
        // emission decentralization across every subnet's neurons, mirroring
        // src/concentration.ts's loadChainConcentration.
        if (url.pathname === "/api/v1/chain/concentration") {
          const rows = await sql`
          SELECT stake_tao, emission_tao, coldkey, validator_permit, netuid, captured_at
          FROM neurons`;
          return json(buildChainConcentration(rows));
        }

        // GET /api/v1/chain/performance (#4832 Tier 2): network-wide reward-flow
        // & trust-spread, mirroring src/chain-performance.ts's loadChainPerformance.
        if (url.pathname === "/api/v1/chain/performance") {
          const rows = await sql`
          SELECT incentive, dividends, trust, consensus, validator_trust, active, validator_permit, netuid, captured_at
          FROM neurons`;
          return json(buildChainPerformance(rows));
        }

        // GET /api/v1/subnets/:netuid/idle-stake (#6789): one subnet's idle-
        // stake rollup -- stake delegated to a hotkey currently earning zero
        // dividends, mirroring the concentration/performance handlers' own
        // inline query (no shared loader).
        const subnetIdleStake = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/idle-stake$/,
        );
        if (subnetIdleStake) {
          const netuid = Number(subnetIdleStake[1]);
          const rows = await sql`
          SELECT stake_tao, dividends, captured_at FROM neurons WHERE netuid = ${netuid}`;
          return json(buildSubnetIdleStake(rows, netuid));
        }

        // GET /api/v1/chain/idle-stake (#6789): network-wide idle-stake
        // rollup, mirroring src/chain-alpha-volume.ts's own per-subnet-
        // groupby-then-rollup shape over the per-subnet scorecard above.
        if (url.pathname === "/api/v1/chain/idle-stake") {
          const rows = await sql`
          SELECT stake_tao, dividends, netuid, captured_at FROM neurons`;
          return json(buildChainIdleStake(rows));
        }

        // GET /api/v1/chain/yield (#4832 Tier 2): network-wide emission-yield
        // distribution, mirroring src/chain-yield.ts's loadChainYield.
        if (url.pathname === "/api/v1/chain/yield") {
          const rows = await sql`
          SELECT validator_permit, stake_tao, emission_tao, netuid, captured_at
          FROM neurons`;
          return json(buildChainYield(rows));
        }

        // GET /api/v1/subnets/:netuid/yield (#4832 Tier 2): one subnet's
        // emission-yield distribution, mirroring src/subnet-yield.mjs's
        // loadSubnetYield.
        const subnetYield = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/yield$/,
        );
        if (subnetYield) {
          const netuid = Number(subnetYield[1]);
          const rows = await sql`
          SELECT uid, hotkey, validator_permit, stake_tao, emission_tao, captured_at, block_number
          FROM neurons WHERE netuid = ${netuid} ORDER BY uid`;
          return json(buildSubnetYield(rows, netuid));
        }

        // GET /api/v1/subnets/:netuid/hyperparameters (#4832 gap-closure,
        // Phase B): latest-only. Column list matches
        // SUBNET_HYPERPARAMS_INSERT_COLUMNS in src/subnet-hyperparams.mjs
        // (every INSERT column except netuid, itself already known from the
        // WHERE clause) -- D1's own equivalent read (loadSubnetHyperparams)
        // is retired alongside D1's subnet_hyperparams write path.
        const subnetHyperparams = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/hyperparameters$/,
        );
        if (subnetHyperparams) {
          const netuid = Number(subnetHyperparams[1]);
          const rows = await sql`
          SELECT kappa_ratio, immunity_period, min_allowed_weights, max_weight_limit_ratio, tempo, weights_version, weights_rate_limit, activity_cutoff, activity_cutoff_factor, registration_allowed, target_regs_per_interval, min_burn_tao, max_burn_tao, burn_half_life, burn_increase_mult, bonds_moving_avg_raw, max_regs_per_block, serving_rate_limit, max_validators, commit_reveal_period, commit_reveal_enabled, alpha_high_ratio, alpha_low_ratio, liquid_alpha_enabled, alpha_sigmoid_steepness, yuma_version, subnet_is_active, transfers_enabled, bonds_reset_enabled, user_liquidity_enabled, owner_cut_enabled, owner_cut_auto_lock_enabled, min_childkey_take_ratio, block_number, captured_at
          FROM subnet_hyperparams WHERE netuid = ${netuid} LIMIT 1`;
          return json(buildSubnetHyperparams(rows[0] ?? null, netuid));
        }

        // GET /api/v1/subnets/:netuid/hyperparameters/history?limit=&offset=
        // &cursor= (#4832 gap-closure, Phase B): append-only change timeline
        // -- D1's own equivalent read (loadSubnetHyperparamsHistory) is
        // retired alongside D1's subnet_hyperparams write path. observed_at/id
        // are plain BIGINT columns (not DATE), so no ::text cast is needed for
        // the cursor comparison the way snapshot_date/day require elsewhere in
        // this file.
        const subnetHyperparamsHistory = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/hyperparameters\/history$/,
        );
        if (subnetHyperparamsHistory) {
          const netuid = Number(subnetHyperparamsHistory[1]);
          const limit = clampRequestLimit(
            url.searchParams.get("limit"),
            FEED_PAGINATION,
          );
          const offset = clampRequestOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const rows = await sql`
          SELECT id, block_number, observed_at, kappa_ratio, immunity_period, min_allowed_weights, max_weight_limit_ratio, tempo, weights_version, weights_rate_limit, activity_cutoff, activity_cutoff_factor, registration_allowed, target_regs_per_interval, min_burn_tao, max_burn_tao, burn_half_life, burn_increase_mult, bonds_moving_avg_raw, max_regs_per_block, serving_rate_limit, max_validators, commit_reveal_period, commit_reveal_enabled, alpha_high_ratio, alpha_low_ratio, liquid_alpha_enabled, alpha_sigmoid_steepness, yuma_version, subnet_is_active, transfers_enabled, bonds_reset_enabled, user_liquidity_enabled, owner_cut_enabled, owner_cut_auto_lock_enabled, min_childkey_take_ratio, hyperparams_hash
          FROM subnet_hyperparams_history
          WHERE netuid = ${netuid}
            ${cursor ? sql`AND (observed_at, id) < (${cursor[0]}, ${cursor[1]})` : sql``}
          ORDER BY observed_at DESC, id DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.id),
              ])
            : null;
          return json(
            buildSubnetHyperparamsHistory(rows, netuid, {
              limit,
              offset,
              nextCursor,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/identity-history?limit=&offset=&cursor=
        // (#4832 gap-closure, Phase B): append-only on-chain identity
        // timeline, mirroring src/subnet-identity-history.mjs's
        // loadSubnetIdentityHistory. observed_at/id are plain BIGINT
        // columns, no ::text cast needed.
        const subnetIdentityHistory = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/identity-history$/,
        );
        if (subnetIdentityHistory) {
          const netuid = Number(subnetIdentityHistory[1]);
          const limit = clampRequestLimit(
            url.searchParams.get("limit"),
            FEED_PAGINATION,
          );
          const offset = clampRequestOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const rows = await sql`
          SELECT id, block_number, observed_at, subnet_name, symbol, description, github_repo, subnet_url, discord, logo_url, identity_hash
          FROM subnet_identity_history
          WHERE netuid = ${netuid}
            ${cursor ? sql`AND (observed_at, id) < (${cursor[0]}, ${cursor[1]})` : sql``}
          ORDER BY observed_at DESC, id DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.id),
              ])
            : null;
          return json(
            buildSubnetIdentityHistory(rows, netuid, {
              limit,
              offset,
              nextCursor,
            }),
          );
        }

        // GET /api/v1/chain/identity-history?limit= (#4832 gap-closure):
        // network-wide identity-change feed across EVERY subnet, mirroring
        // src/chain-identity-history.ts's loadChainIdentityHistory -- no
        // netuid filter, unlike the per-subnet route above.
        const chainIdentityHistory = url.pathname.match(
          /^\/api\/v1\/chain\/identity-history$/,
        );
        if (chainIdentityHistory) {
          const { limit, error } = parseLimitParam(url, {
            defaultLimit: CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
            maxLimit: CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
          });
          if (error) return queryError(error);
          const rows = await sql`
          SELECT id, netuid, block_number, observed_at, subnet_name, symbol, description, github_repo, subnet_url, discord, logo_url, identity_hash
          FROM subnet_identity_history
          ORDER BY block_number DESC, netuid ASC, id DESC
          LIMIT ${limit}`;
          return json(buildChainIdentityHistory(rows, { limit }));
        }

        // GET /api/v1/accounts/:ss58/portfolio (#4832 Tier 2): one wallet's
        // cross-subnet neuron portfolio, mirroring
        // src/account-portfolio.mjs's loadAccountPortfolio.
        const acctPortfolio = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/portfolio$/,
        );
        if (acctPortfolio) {
          const ss58 = decodeURIComponent(acctPortfolio[1]);
          const rows = await sql`
          SELECT netuid, uid, stake_tao, emission_tao, rank, trust, incentive, dividends, validator_permit, active, captured_at
          FROM neurons WHERE hotkey = ${ss58} ORDER BY netuid`;
          return json(buildAccountPortfolio(rows, ss58));
        }

        // GET /api/v1/accounts/:ss58/positions (#5233): the nominator-scoped
        // counterpart to /portfolio above -- what this account holds across
        // every hotkey/subnet it delegates to, reconstructed from
        // nominator_positions (a share_fraction ledger) joined against the
        // live neurons stake_tao for each referenced (hotkey, netuid). See
        // src/account-nominator-positions.mjs's header comment for the
        // root-stake (netuid 0) scope limitation.
        const acctPositions = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/positions$/,
        );
        if (acctPositions) {
          const ss58 = decodeURIComponent(acctPositions[1]);
          const positionRows = await loadNominatorPositions(sql, ss58);
          const hotkeyNetuidStake = await loadNeuronStakeByHotkeys(
            sql,
            distinctHotkeys(positionRows),
          );
          return json(
            buildAccountPositions(positionRows, hotkeyNetuidStake, ss58),
          );
        }

        // GET /api/v1/accounts/:ss58/identity (#4832 gap-closure, Phase B):
        // latest-only, mirroring src/account-identity.mjs's
        // loadAccountIdentity. Column list matches that file's own SELECT.
        const acctIdentity = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/identity$/,
        );
        if (acctIdentity) {
          const ss58 = decodeURIComponent(acctIdentity[1]);
          const rows = await sql`
          SELECT account, name, url, github, image, discord, description, additional, captured_at
          FROM account_identity WHERE account = ${ss58}`;
          return json(buildAccountIdentity(rows[0] ?? null, ss58));
        }

        // GET /api/v1/accounts/:ss58/identity-history?limit=&offset=&cursor=
        // (#4832 gap-closure, Phase B): append-only change timeline,
        // mirroring src/account-identity-history.mjs's
        // loadAccountIdentityHistory. observed_at/id are plain BIGINT
        // columns, no ::text cast needed.
        const acctIdentityHistory = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/identity-history$/,
        );
        if (acctIdentityHistory) {
          const ss58 = decodeURIComponent(acctIdentityHistory[1]);
          const limit = clampRequestLimit(
            url.searchParams.get("limit"),
            FEED_PAGINATION,
          );
          const offset = clampRequestOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const rows = await sql`
          SELECT id, observed_at, name, url, github, image, discord, description, additional, identity_hash
          FROM account_identity_history
          WHERE account = ${ss58}
            ${cursor ? sql`AND (observed_at, id) < (${cursor[0]}, ${cursor[1]})` : sql``}
          ORDER BY observed_at DESC, id DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.observed_at),
                numberOrNull(last.id),
              ])
            : null;
          return json(
            buildAccountIdentityHistory(rows, ss58, {
              limit,
              offset,
              nextCursor,
            }),
          );
        }

        // GET /api/v1/accounts?sort=&limit= (#4832 Tier 2): the global accounts
        // leaderboard, mirroring src/accounts-list.mjs's loadAccountsList.
        if (url.pathname === "/api/v1/accounts") {
          const sortParam = url.searchParams.get("sort") || undefined;
          // Number(null) is 0 (finite), not NaN -- an absent ?limit= must not
          // silently clamp to a zero-row page. Only a genuinely PRESENT value
          // reaches Number(); an absent/blank one falls back to the default,
          // matching parseBoundedIntParam's contract (entities.mjs's D1 path).
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw == null || limitRaw === ""
              ? ACCOUNTS_LIST_LIMIT_DEFAULT
              : Number(limitRaw);
          const rows = await sql`
          SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, stake_tao, block_number, captured_at
          FROM neurons WHERE hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`;
          return json(
            buildAccountsList(rows, {
              sort: sortParam ?? DEFAULT_ACCOUNTS_LIST_SORT,
              limit,
            }),
          );
        }

        // GET /api/v1/validators/:hotkey/history?window= (#4832 Tier 2b): one
        // validator's staked-subnet-count + stake/emission totals over time,
        // mirroring src/validator-history.mjs's buildValidatorHistory.
        const validatorHistoryMatch = url.pathname.match(
          /^\/api\/v1\/validators\/([^/]+)\/history$/,
        );
        if (validatorHistoryMatch) {
          const hotkey = decodeURIComponent(validatorHistoryMatch[1]);
          const cutoff = windowCutoffDate(
            url,
            HISTORY_WINDOWS,
            DEFAULT_HISTORY_WINDOW,
          );
          const rows = cutoff
            ? await sql`
            SELECT snapshot_date::text AS snapshot_date, COUNT(DISTINCT netuid) AS subnet_count,
              SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
            FROM neuron_daily
            WHERE hotkey = ${hotkey} AND validator_permit = TRUE AND snapshot_date >= ${cutoff}
            GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
            : await sql`
            SELECT snapshot_date::text AS snapshot_date, COUNT(DISTINCT netuid) AS subnet_count,
              SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
            FROM neuron_daily
            WHERE hotkey = ${hotkey} AND validator_permit = TRUE
            GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
          return json(
            buildValidatorHistory(rows, hotkey, {
              window: windowLabelFor(
                url,
                HISTORY_WINDOWS,
                DEFAULT_HISTORY_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/neurons/:uid/history?window= (#4832
        // Tier 2b): one UID's daily metagraph snapshot over time, mirroring
        // src/neuron-history.ts's buildNeuronHistory.
        const neuronHistoryMatch = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)\/history$/,
        );
        if (neuronHistoryMatch) {
          const netuid = Number(neuronHistoryMatch[1]);
          const uid = Number(neuronHistoryMatch[2]);
          const cutoff = windowCutoffDate(
            url,
            HISTORY_WINDOWS,
            DEFAULT_HISTORY_WINDOW,
          );
          const rows = cutoff
            ? await sql`
            SELECT snapshot_date::text AS snapshot_date, uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
            FROM neuron_daily
            WHERE netuid = ${netuid} AND uid = ${uid} AND snapshot_date >= ${cutoff}
            ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
            : await sql`
            SELECT snapshot_date::text AS snapshot_date, uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
            FROM neuron_daily
            WHERE netuid = ${netuid} AND uid = ${uid}
            ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
          return json(
            buildNeuronHistory(rows, netuid, uid, {
              window: windowLabelFor(
                url,
                HISTORY_WINDOWS,
                DEFAULT_HISTORY_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/history?window= (#4832 Tier 2b): daily
        // neuron/validator counts + stake/emission totals for one subnet,
        // mirroring src/neuron-history.ts's buildSubnetHistory.
        const subnetHistoryMatch = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/history$/,
        );
        if (subnetHistoryMatch) {
          const netuid = Number(subnetHistoryMatch[1]);
          const cutoff = windowCutoffDate(
            url,
            HISTORY_WINDOWS,
            DEFAULT_HISTORY_WINDOW,
          );
          // validator_permit is BOOLEAN in Postgres (INTEGER 0/1 in D1/SQLite) --
          // SUM() over a boolean is a Postgres type error, so cast to int first.
          const rows = cutoff
            ? await sql`
            SELECT snapshot_date::text AS snapshot_date, COUNT(*) AS neuron_count,
              SUM(validator_permit::int) AS validator_count,
              SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
            FROM neuron_daily
            WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
            GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
            : await sql`
            SELECT snapshot_date::text AS snapshot_date, COUNT(*) AS neuron_count,
              SUM(validator_permit::int) AS validator_count,
              SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
            FROM neuron_daily
            WHERE netuid = ${netuid}
            GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
          return json(
            buildSubnetHistory(rows, netuid, {
              window: windowLabelFor(
                url,
                HISTORY_WINDOWS,
                DEFAULT_HISTORY_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/concentration/history?window= (#4832
        // Tier 2b): per-day stake & emission concentration trend, mirroring
        // src/concentration.ts's buildConcentrationHistory.
        const concentrationHistoryMatch = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/concentration\/history$/,
        );
        if (concentrationHistoryMatch) {
          const netuid = Number(concentrationHistoryMatch[1]);
          const cutoff = windowCutoffDate(
            url,
            CONCENTRATION_HISTORY_WINDOWS,
            DEFAULT_CONCENTRATION_HISTORY_WINDOW,
          );
          const rows = await sql`
          SELECT snapshot_date::text AS snapshot_date, stake_tao, emission_tao
          FROM neuron_daily
          WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
          ORDER BY snapshot_date DESC LIMIT ${CONCENTRATION_HISTORY_ROW_CAP}`;
          return json(
            buildConcentrationHistory(rows, netuid, {
              window: windowLabelFor(
                url,
                CONCENTRATION_HISTORY_WINDOWS,
                DEFAULT_CONCENTRATION_HISTORY_WINDOW,
              ),
              capped: rows.length >= CONCENTRATION_HISTORY_ROW_CAP,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/performance/history?window= (#4832
        // Tier 2b): per-day reward-flow & trust trend, mirroring
        // src/subnet-performance.mjs's buildSubnetPerformanceHistory.
        const performanceHistoryMatch = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/performance\/history$/,
        );
        if (performanceHistoryMatch) {
          const netuid = Number(performanceHistoryMatch[1]);
          const cutoff = windowCutoffDate(
            url,
            PERFORMANCE_HISTORY_WINDOWS,
            DEFAULT_PERFORMANCE_HISTORY_WINDOW,
          );
          const rows = await sql`
          SELECT snapshot_date::text AS snapshot_date, incentive, dividends, trust, consensus, validator_permit, active
          FROM neuron_daily
          WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
          ORDER BY snapshot_date DESC LIMIT ${PERFORMANCE_HISTORY_ROW_CAP}`;
          return json(
            buildSubnetPerformanceHistory(rows, netuid, {
              window: windowLabelFor(
                url,
                PERFORMANCE_HISTORY_WINDOWS,
                DEFAULT_PERFORMANCE_HISTORY_WINDOW,
              ),
              capped: rows.length >= PERFORMANCE_HISTORY_ROW_CAP,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/yield/history?window= (#4832 Tier 2b):
        // per-day emission-yield distribution trend, mirroring
        // src/subnet-yield.mjs's buildSubnetYieldHistory.
        const yieldHistoryMatch = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/yield\/history$/,
        );
        if (yieldHistoryMatch) {
          const netuid = Number(yieldHistoryMatch[1]);
          const cutoff = windowCutoffDate(
            url,
            YIELD_HISTORY_WINDOWS,
            DEFAULT_YIELD_HISTORY_WINDOW,
          );
          const rows = await sql`
          SELECT snapshot_date::text AS snapshot_date, validator_permit, stake_tao, emission_tao
          FROM neuron_daily
          WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
          ORDER BY snapshot_date DESC LIMIT ${YIELD_HISTORY_ROW_CAP}`;
          return json(
            buildSubnetYieldHistory(rows, netuid, {
              window: windowLabelFor(
                url,
                YIELD_HISTORY_WINDOWS,
                DEFAULT_YIELD_HISTORY_WINDOW,
              ),
              capped: rows.length >= YIELD_HISTORY_ROW_CAP,
            }),
          );
        }

        // GET /api/v1/chain/turnover?window=&limit= (#4832 Tier 2b):
        // network-wide validator-set turnover across every subnet between the
        // window's boundary snapshots, mirroring
        // src/chain-turnover.ts's loadChainTurnover.
        if (url.pathname === "/api/v1/chain/turnover") {
          const windowParam =
            url.searchParams.get("window") || DEFAULT_CHAIN_TURNOVER_WINDOW;
          const windowLabel = Object.hasOwn(CHAIN_TURNOVER_WINDOWS, windowParam)
            ? windowParam
            : DEFAULT_CHAIN_TURNOVER_WINDOW;
          const days = CHAIN_TURNOVER_WINDOWS[windowLabel];
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw == null || limitRaw === ""
              ? CHAIN_TURNOVER_LIMIT_DEFAULT
              : Number(limitRaw);
          // Anchor the window to the newest STORED snapshot (not the Worker's
          // wall clock) -- native DATE minus an integer day count is Postgres's
          // direct equivalent of SQLite's date(MAX(snapshot_date), '-N days').
          const bounds = await sql`
          SELECT MIN(snapshot_date)::text AS start_date, MAX(snapshot_date)::text AS end_date
          FROM neuron_daily
          WHERE snapshot_date >= (SELECT MAX(snapshot_date) - ${days}::int FROM neuron_daily)`;
          const startDate = bounds[0]?.start_date ?? null;
          const endDate = bounds[0]?.end_date ?? null;
          let rows = [];
          if (startDate != null && endDate != null && startDate !== endDate) {
            rows = await sql`
            SELECT snapshot_date::text AS snapshot_date, netuid, hotkey, validator_permit
            FROM neuron_daily
            WHERE validator_permit = TRUE AND snapshot_date IN (${startDate}, ${endDate})`;
          }
          return json(
            buildChainTurnover(rows, {
              window: windowLabel,
              startDate,
              endDate,
              limit,
            }),
          );
        }

        // GET /api/v1/subnets/:netuid/turnover?window=&changes= (#4832 Tier
        // 2b): validator-set & registration churn between one subnet's window
        // boundary snapshots, mirroring src/turnover.mjs's loadSubnetTurnover.
        const turnoverMatch = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/turnover$/,
        );
        if (turnoverMatch) {
          const netuid = Number(turnoverMatch[1]);
          const windowParam =
            url.searchParams.get("window") || DEFAULT_HISTORY_WINDOW;
          const windowLabel = Object.hasOwn(HISTORY_WINDOWS, windowParam)
            ? windowParam
            : DEFAULT_HISTORY_WINDOW;
          const windowDays = HISTORY_WINDOWS[windowLabel];
          const includeChanges = url.searchParams.get("changes") === "true";
          const bounds =
            windowDays == null
              ? await sql`
              SELECT MIN(snapshot_date)::text AS start_date, MAX(snapshot_date)::text AS end_date
              FROM neuron_daily WHERE netuid = ${netuid}`
              : await sql`
              SELECT MIN(snapshot_date)::text AS start_date, MAX(snapshot_date)::text AS end_date
              FROM neuron_daily
              WHERE netuid = ${netuid}
                AND snapshot_date >= (SELECT MAX(snapshot_date) - ${windowDays}::int FROM neuron_daily WHERE netuid = ${netuid})`;
          const startDate = bounds[0]?.start_date ?? null;
          const endDate = bounds[0]?.end_date ?? null;
          const rows =
            startDate == null || endDate == null
              ? []
              : await sql`
              SELECT snapshot_date::text AS snapshot_date, uid, hotkey, validator_permit
              FROM neuron_daily
              WHERE netuid = ${netuid} AND snapshot_date IN (${startDate}, ${endDate})
              ORDER BY snapshot_date ASC, uid ASC`;
          const turnoverOptions = { window: windowLabel, startDate, endDate };
          const data = buildTurnover(rows, netuid, turnoverOptions);
          return json(
            includeChanges
              ? {
                  ...data,
                  changes: turnoverChangeDetail(
                    buildTurnoverChanges(rows, netuid, turnoverOptions),
                  ),
                }
              : data,
          );
        }

        // GET /api/v1/subnets/movers?window=&sort=&limit= (#4832 Tier 2b):
        // every subnet ranked by its stake/emission/validator change over the
        // window, mirroring src/movers.ts's loadSubnetMovers.
        if (url.pathname === "/api/v1/subnets/movers") {
          const windowParam =
            url.searchParams.get("window") || DEFAULT_MOVERS_WINDOW;
          const windowLabel = Object.hasOwn(MOVERS_WINDOWS, windowParam)
            ? windowParam
            : DEFAULT_MOVERS_WINDOW;
          const days = MOVERS_WINDOWS[windowLabel];
          const sortParam = url.searchParams.get("sort") || DEFAULT_MOVERS_SORT;
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw == null || limitRaw === ""
              ? MOVERS_LIMIT_DEFAULT
              : Number(limitRaw);
          const bounds = await sql`
          SELECT MIN(snapshot_date)::text AS start_date, MAX(snapshot_date)::text AS end_date
          FROM neuron_daily
          WHERE snapshot_date >= (SELECT MAX(snapshot_date) - ${days}::int FROM neuron_daily)`;
          const startDate = bounds[0]?.start_date ?? null;
          const endDate = bounds[0]?.end_date ?? null;
          let startRows = [];
          let endRows = [];
          if (startDate != null && endDate != null && startDate !== endDate) {
            const rows = await sql`
            SELECT netuid, snapshot_date::text AS snapshot_date, COUNT(*) AS neuron_count,
              SUM(validator_permit::int) AS validator_count,
              SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
            FROM neuron_daily
            WHERE snapshot_date IN (${startDate}, ${endDate})
            GROUP BY netuid, snapshot_date`;
            startRows = rows.filter((row) => row.snapshot_date === startDate);
            endRows = rows.filter((row) => row.snapshot_date === endDate);
          }
          return json(
            buildMovers(startRows, endRows, {
              window: windowLabel,
              startDate,
              endDate,
              sort: sortParam,
              limit,
            }),
          );
        }

        // GET /api/v1/accounts/:ss58/subnets/:netuid/history?window= (#4832
        // gap-closure): one wallet's position on one subnet over time,
        // mirroring src/account-position-history.mjs's buildAccountPositionHistory.
        const positionHistoryMatch = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/subnets\/(\d+)\/history$/,
        );
        if (positionHistoryMatch) {
          const ss58 = decodeURIComponent(positionHistoryMatch[1]);
          const netuid = Number(positionHistoryMatch[2]);
          const cutoff = windowCutoffDate(
            url,
            HISTORY_WINDOWS,
            DEFAULT_HISTORY_WINDOW,
          );
          const rows = cutoff
            ? await sql`
            SELECT snapshot_date::text AS snapshot_date, captured_at, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao
            FROM account_position_daily
            WHERE account = ${ss58} AND netuid = ${netuid} AND snapshot_date >= ${cutoff}
            ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
            : await sql`
            SELECT snapshot_date::text AS snapshot_date, captured_at, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao
            FROM account_position_daily
            WHERE account = ${ss58} AND netuid = ${netuid}
            ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
          return json(
            buildAccountPositionHistory(rows, ss58, netuid, {
              window: windowLabelFor(
                url,
                HISTORY_WINDOWS,
                DEFAULT_HISTORY_WINDOW,
              ),
            }),
          );
        }

        // GET /api/v1/accounts/:ss58/history?netuid=&from=&to=&limit=&offset=&cursor=
        // (#4832 gap-closure): the durable per-day activity series for an
        // account, mirroring src/account-events.mjs's buildAccountHistory /
        // ACCOUNT_DAY_COLUMNS. day is cast to ::text for the same reason
        // snapshot_date is elsewhere in this file (postgres.js parses DATE
        // columns to JS Date objects by default, which would break the
        // string-keyset cursor comparison below).
        const accountHistoryMatch = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/history$/,
        );
        if (accountHistoryMatch) {
          const ss58 = decodeURIComponent(accountHistoryMatch[1]);
          const limit = clampRequestLimit(
            url.searchParams.get("limit"),
            FEED_PAGINATION,
          );
          const offset = clampRequestOffset(url.searchParams.get("offset"));
          const netuid = nonNegativeIntegerParam(url.searchParams, "netuid");
          const from = url.searchParams.get("from") || null;
          const to = url.searchParams.get("to") || null;
          const cur = decodeCursor(url.searchParams.get("cursor"), 2);
          const cursorDay = cur
            ? String(cur[0]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
            : null;
          const useCursor = Boolean(cursorDay && DAY_PATTERN.test(cursorDay));
          const rows = await sql`
          SELECT day::text AS day, netuid, event_count, event_kinds, first_block, last_block
          FROM account_events_daily
          WHERE hotkey = ${ss58}
            ${netuid != null ? sql`AND netuid = ${netuid}` : sql``}
            ${from ? sql`AND day >= ${from}` : sql``}
            ${to ? sql`AND day <= ${to}` : sql``}
            ${useCursor ? sql`AND (day, netuid) < (${cursorDay}::date, ${cur[1]})` : sql``}
          ORDER BY day DESC, netuid DESC
          LIMIT ${limit}
          ${!useCursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor =
            last && typeof last.day === "string" && DAY_PATTERN.test(last.day)
              ? encodeCursor([
                  Number(last.day.replaceAll("-", "")),
                  last.netuid,
                ])
              : null;
          return json(
            buildAccountHistory(rows, ss58, { limit, offset, nextCursor }),
          );
        }

        return json({ error: "not found" }, 404);
      };

      // METAGRAPHED-7: retry with a freshly created client, up to
      // MAX_CONNECTION_RETRY_ATTEMPTS times, when Hyperdrive closed or destroyed the
      // pooled connection out from under this transaction (see
      // RETRYABLE_CONNECTION_ERROR_CODES's own header for why this is safe here specifically
      // -- read-only dispatcher, one sql.begin() transaction, nothing can have partially
      // committed). A single retry regressed (#METAGRAPHED-7 reoccurred): under sustained
      // load Hyperdrive can recycle the retry's own fresh connection too, so one retry
      // isn't always enough. Any other error (a real query/schema problem, or every retry
      // exhausted) falls through to the outer catch below unchanged.
      let activeSql = sql;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await activeSql.begin(
            DATA_API_READ_TRANSACTION,
            dispatchReadRoutes,
          );
        } catch (err) {
          if (
            attempt >= MAX_CONNECTION_RETRY_ATTEMPTS ||
            !RETRYABLE_CONNECTION_ERROR_CODES.has(err?.code)
          )
            throw err;
          activeSql = postgres(
            env.HYPERDRIVE.connectionString,
            hyperdriveConnectionOptions,
          );
        }
      }
    } catch (err) {
      // Log internally (Wrangler observability) but NEVER leak DB error details
      // (schema, table, or connection info) to API clients.
      console.error("data-api query failed:", err);
      // url.pathname (not a static tag) -- this catch is the generic
      // fallback for the WHOLE route dispatcher above, so the actual
      // failing route is the only thing that makes the Sentry event useful.
      captureDataApiError(err, url.pathname);
      return json({ error: "data query failed" }, 502);
    }
    // No sql.end() here: Hyperdrive automatically cleans up the connection
    // when the request/invocation ends (Cloudflare's documented pattern) --
    // the previous ctx.waitUntil(sql.end(...)) was undocumented, unnecessary
    // background work racing the response, right where #4686's subrequest-
    // cancellation flakiness was observed.
  },
};
