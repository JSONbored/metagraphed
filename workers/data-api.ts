// metagraphed data Worker — store-backed serving, kept SEPARATE from the main
// api.ts Worker (which is near its bundle budget); the main Worker routes the
// relevant paths in via a service binding (DATA_API).
//
// This Worker WAS the serving half of ADR 0013: the Postgres tiers the indexer
// and the Rust backfill wrote, fronted by Cloudflare Hyperdrive. That box was
// destroyed, #9186 removed the HYPERDRIVE binding, and #9193 deleted the code
// behind it -- the postgres.js driver, the ~5,200-line Postgres read
// dispatcher, and the Postgres half of every dual-write sync route. All of it
// sat behind `env.HYPERDRIVE?.connectionString`, which no wrangler config can
// make truthy any more, so none of it could run.
//
// What is left is the store surface: the neurons / subnet-hyperparams /
// account-identity read families (tests/fixtures/sqlite-schema/0007 + 0009), the user-state
// routes (accounts, API keys, usage accounting, alert triggers, push
// subscriptions), the internal sync WRITE routes that land in D1, and the
// TAO/USD index cron. Routes whose store is gone still answer exactly what
// they answered before the deletion -- see dispatchDataApiRequest's own note
// for why that matters to the forward gate.
import { DEFAULT_ACCOUNT_KIND, asAccountKind } from "../src/account-kind.ts";
import { handleRootBasketCaptureSync } from "../src/root-basket-capture-sync.ts";
import {
  accountBalanceSyncRowSchema,
  accountIdentitySyncRowSchema,
  hotkeyAlphaSyncRowSchema,
  neuronSyncRowSchema,
  nominatorCountSyncRowSchema,
  nominatorPositionSyncRowSchema,
  subnetHyperparamsSyncRowSchema,
  subnetIdentitySyncRowSchema,
  subnetOwnershipSyncRowSchema,
  validateSyncRows,
} from "../schemas-src/sync-rows.ts";
import { readJsonObjectBody } from "../schemas-src/json-request.ts";
import { spotPriceTao } from "../src/stake-quote.ts";
import { recordExceptionEvent } from "../src/usage-telemetry.ts";
import { isPathUnder } from "./http.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";
import { maskRouteParams } from "../src/route-label.ts";
import {
  newSpanId,
  newTraceId,
  recordTraceSpan,
  shouldRecordTraceSpan,
} from "../src/tracing.ts";
import { decodeCursor, encodeCursor } from "../src/cursor.ts";
import { buildAccountSubnets } from "../src/account-events.ts";
import {
  buildObservationBatch,
  rowFromBatch,
  type TaoUsdIndexRow,
} from "../src/tao-usd-ingest.ts";
import { TABLE_FRESHNESS_CRON, TAO_USD_INDEX_CRON } from "./config.ts";
import {
  buildConcentration,
  buildChainConcentration,
  buildConcentrationHistory,
  buildSubnetConcentrationRanking,
  parseConcentrationRankingQuery,
  CONCENTRATION_HISTORY_ROW_CAP,
  CONCENTRATION_HISTORY_WINDOWS,
  DEFAULT_CONCENTRATION_HISTORY_WINDOW,
} from "../src/concentration.ts";
import {
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
} from "../src/route-limits.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
  PERFORMANCE_HISTORY_READ_COLUMNS,
  PERFORMANCE_HISTORY_ROW_CAP,
  PERFORMANCE_HISTORY_WINDOWS,
  DEFAULT_PERFORMANCE_HISTORY_WINDOW,
} from "../src/subnet-performance.ts";
import { buildChainPerformance } from "../src/chain-performance.ts";
import {
  buildChainIdleStake,
  buildSubnetIdleStake,
} from "../src/subnet-idle-stake.ts";
import { buildChainYield } from "../src/chain-yield.ts";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
  YIELD_HISTORY_ROW_CAP,
  YIELD_HISTORY_WINDOWS,
  DEFAULT_YIELD_HISTORY_WINDOW,
} from "../src/subnet-yield.ts";
import {
  buildSubnetEmissionSplitHistory,
  EMISSION_SPLIT_HISTORY_ROW_CAP,
} from "../src/emission-split.ts";
import {
  buildSubnetOwnerCapture,
  OWNER_CAPTURE_HISTORY_ROW_CAP,
} from "../src/owner-capture.ts";
import {
  buildSubnetTreasury,
  type TreasuryReadingRow,
} from "../src/treasury-readings.ts";
import {
  buildSubnetCostToParticipate,
  type ComputeDeclarationRow,
} from "../src/cost-to-participate.ts";
import {
  buildSubnetMinerFairness,
  MINER_FAIRNESS_ROW_CAP,
} from "../src/miner-fairness.ts";
import {
  DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
} from "../src/route-limits.ts";
import { buildAccountPortfolio } from "../src/account-portfolio.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  HISTORY_WINDOW_DAYS,
  DEFAULT_HISTORY_WINDOW,
  MAX_HISTORY_POINTS,
  NEURON_DAILY_READ_COLUMNS,
} from "../src/neuron-history.ts";
import { buildValidatorHistory } from "../src/validator-history.ts";
import {
  buildTurnover,
  buildTurnoverChanges,
  turnoverChangeDetail,
} from "../src/turnover.ts";
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
import { buildAccountHolderDirectory } from "../src/account-holder-directory.ts";
import {
  materializationFromUnknown,
  readExplorerDirectoryMaterialization,
  readExplorerDirectoryPointer,
  type ExplorerDirectoryMaterialization,
} from "../src/explorer-directory-materialization.ts";
import { resolveClientIp } from "./config.ts";
import {
  SUBNET_HYPERPARAMS_INSERT_COLUMNS,
  formatSubnetHyperparams,
  buildSubnetHyperparams,
} from "../src/subnet-hyperparams.ts";
import {
  hyperparamsHash,
  buildSubnetHyperparamsHistory,
} from "../src/subnet-hyperparams-history.ts";
import {
  writeHistoricalHyperparams,
  type HistoricalHyperparamsRow,
} from "../src/subnet-hyperparams-backfill.ts";
import {
  ACCOUNT_IDENTITY_INSERT_COLUMNS,
  IDENTITY_FIELDS,
  buildAccountIdentity,
  loadIdentityByColdkeyMap,
} from "../src/account-identity.ts";
import {
  fillConfirmedZeros,
  nominatorCountsByHotkey,
  VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
} from "../src/validator-nominator-summary.ts";
import { tempoByNetuid } from "../src/subnet-tempo.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "../src/account-nominator-positions.ts";
import {
  identityHash,
  buildAccountIdentityHistory,
} from "../src/account-identity-history.ts";
import { identityHash as subnetIdentityHash } from "../src/subnet-identity-history.ts";

// metagraphed#6769: a caught write/query failure (logged via console.error,
// converted to a clean error response) never reaches PostHog's own top-level
// catch -- only a genuinely UNCAUGHT exception would.
//
// metagraphed#7766: Sentry fully removed (was captureException here,
// parallel-run alongside PostHog since #7758; Sentry decommissioned once
// parity was proven). Awaited (not waitUntil) -- callers are already deep in
// an async handler's catch block about to return an error response, with no
// ExecutionContext threaded down to this helper. The cost is a little
// latency on an already-failing request, not silent event loss.
// recordExceptionEvent is a safe no-op with no configured token, so this
// can't newly break any of this file's existing tests.
// #8985: schema drift is one bit of information that recurs on every request.
//
// Postgres reports a missing table as SQLSTATE 42P01 and a missing column as
// 42703. When a migration has not reached production, EVERY request down that
// path raises the identical error -- and capturing each one produced 868,689
// $exception events for `api_usage_rollup` alone (#8960), still running at
// ~5,100/hour. That is real event spend, and it drowned the other errors: the
// `date >= integer` bug (#8961) sat underneath this noise floor for days.
//
// So drift is captured ONCE per isolate per (route, relation) rather than per
// request. The first occurrence still produces a full $exception carrying the
// relation name, so nothing is hidden; the 5,000th adds nothing. console.error
// below stays unconditional -- per-request detail is cheap in logs.
const SCHEMA_DRIFT_SQLSTATES = new Set(["42P01", "42703"]);

// Isolate-scoped. Workers isolates live minutes to hours, so this collapses a
// per-request storm to a handful per hour across the fleet without ever
// silencing a NEW drift (a different relation, or the same one on a different
// route, is a different key and captures again).
const capturedSchemaDrift = new Set<string>();

// One projection build per completed neuron snapshot, shared by every request
// that reaches this isolate while the KV value is being replaced. KV is the
// cross-isolate authority; these promises only prevent a burst of identical
// service-binding requests from doing the same expensive fold concurrently
// before that write becomes visible.
const explorerDirectoryRefreshes = new Map<number, Promise<boolean>>();

// Required by src/module-state-registry.ts's contract: under `isolate: false`
// every test file in a worker shares one module registry, so a Set that
// remembers "already captured" across files would make one file's drift
// suppress another file's expected capture.
//
// NOTE this is registered despite scripts/validate-module-state-resets.ts
// NOT flagging it. That validator's COLLECTION_DECL regex matches `new Set(`
// and this declaration is `new Set<string>(`, so every generically-typed
// module-level collection is invisible to it. The gap is real (see #8988) --
// this reset is here because the state genuinely leaks, not because the gate
// demanded it.
registerModuleStateReset("workers/data-api.ts", () => {
  capturedSchemaDrift.clear();
  explorerDirectoryRefreshes.clear();
});

/** The stable SQLSTATE of a postgres.js error, when it has one. */
function pgSqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True when this error has already been captured for this route+relation in
 * this isolate, i.e. capturing it again would add no information. Records the
 * key as a side effect on first sight.
 */
export function shouldSkipDriftCapture(err: unknown, route: string): boolean {
  const sqlState = pgSqlState(err);
  if (!sqlState || !SCHEMA_DRIFT_SQLSTATES.has(sqlState)) return false;
  // Reaching here means err carried a string `code`, so it is necessarily a
  // non-null object -- no optional chaining below, which would only add a
  // branch that can never be taken.
  //
  // postgres.js exposes the offending relation on the error; fall back to the
  // message so two different missing relations never collapse onto one key.
  // Collapsing them would make the dedupe worse than the storm: the second
  // missing relation on a route would go unreported for the isolate's life.
  const drift = err as { table_name?: unknown; message?: unknown };
  const relation = drift.table_name ?? drift.message ?? "";
  const key = `${route}|${sqlState}|${String(relation)}`;
  if (capturedSchemaDrift.has(key)) return true;
  capturedSchemaDrift.add(key);
  return false;
}

/**
 * Capture a data-api failure as a PostHog $exception.
 *
 * Resolves true when the error was captured and false when it was suppressed
 * as already-seen schema drift. Every caller ignores the result -- it exists so
 * the dedupe branch is OBSERVABLE in a test without mocking the telemetry
 * module. recordExceptionEvent is a no-op without a configured token, so
 * "was it captured" is otherwise indistinguishable from "was it skipped", and
 * the branch that suppresses 868K events would ship untested.
 */
async function captureDataApiError(
  err: unknown,
  route: string,
  env: DataApiEnv,
): Promise<boolean> {
  if (shouldSkipDriftCapture(err, route)) return false;
  await recordExceptionEvent(env, {
    error: err,
    route,
    errorCode: "internal_error",
  });
  return true;
}

export { captureDataApiError as captureDataApiErrorForTest };

/**
 * The low-cardinality route label for this request, or a Worker-level fallback
 * when the URL cannot be parsed (#9440).
 *
 * A malformed URL must not turn one fault into two, so this never throws --
 * the route dimension degrades to naming the Worker rather than vanishing,
 * which is the dimension that was missing entirely before.
 */
function maskedDataApiRoute(request: Request): string {
  try {
    return maskRouteParams(new URL(request.url).pathname);
  } catch {
    return "data-api";
  }
}

/**
 * Capture a fault that escaped every handled path, from the Worker's own
 * `fetch` entry (#9440).
 *
 * Separate from captureDataApiError because the ROUTE is derived differently:
 * the handled sites each name the lane they belong to, while here the only
 * thing known about the fault is which URL was being served -- masked, since a
 * span/exception label keyed on a raw pathname is unaggregatable (#9001).
 *
 * Scheduled through waitUntil when a context exists so an already-failing
 * request is not also made slower; awaited otherwise so a direct call (tests,
 * a binding invocation with no ctx) still records.
 */
async function captureUncaughtDataApiError(
  error: unknown,
  route: string,
  env: DataApiEnv,
  ctx: ExecutionContext | undefined,
): Promise<void> {
  const pending = recordExceptionEvent(env, {
    error,
    route,
    errorCode: "internal_error",
  }).catch(() => false);
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(pending);
    return;
  }
  await pending;
}

const ANALYTICS_DAY_MS = 24 * 60 * 60 * 1000;

// The resolved window label to pass into a build* function's `{ window }` option,
// matching what windowCutoffDate computes the cutoff from (falls back to the
// default for an unrecognized/absent label, same as windowCutoffDate).
function windowLabelFor(
  url: URL,
  windows: Record<string, number | null>,
  defaultLabel: string,
) {
  const label = url.searchParams.get("window") || defaultLabel;
  return Object.hasOwn(windows, label) ? label : defaultLabel;
}

// Resolve a ?window= label to a YYYY-MM-DD cutoff date for a neuron_daily
// `snapshot_date` (a native DATE column, not an epoch-ms timestamp), matching
// the store loaders' `new Date(Date.now() - days*DAY_MS).toISOString().slice(0,10)`
// exactly. A `null` day value (e.g. HISTORY_WINDOW_DAYS.all) means no lower bound.
function windowCutoffDate(
  url: URL,
  windows: Record<string, number | null>,
  defaultLabel: string,
) {
  const label = url.searchParams.get("window") || defaultLabel;
  const days = Object.hasOwn(windows, label)
    ? windows[label]
    : windows[defaultLabel];
  if (days == null) return null;
  return new Date(Date.now() - days * ANALYTICS_DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// #9798: window boundaries computed here rather than in SQL, so no dialect
// function survives into a query two stores have to agree about.
import { shiftIsoDate } from "../src/iso-date-window.ts";
import { isPublicWebhookUrl, timingSafeEqual } from "../src/webhooks.ts";
// #8385: shape-check push key material at intake (see that module).
import { isValidPushKeyMaterial } from "../src/web-push.ts";
import {
  ALERT_DELIVERY_RESPONSE_SNIPPET_MAX_BYTES,
  ALERT_TRIGGER_CREATE_TOKEN_HEADER,
  ALERT_TRIGGER_MAX_BODY_BYTES,
  ALERT_TRIGGER_OWNER_TOKEN_HEADER,
  ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER,
  deliveryRecordView,
  evaluatorAlertTriggerView,
  generateAlertTriggerOwnerToken,
  isValidAlertOwnerToken,
  isValidAlertTriggerId,
  ownerAlertTriggerView,
  validateAlertTriggerInput,
  WATCH_TRIGGER_TOKEN_HEADER,
  WATCH_TRIGGERS_MAX_PER_ADDRESS,
} from "../src/alert-triggers.ts";
import {
  FEED_PAGINATION,
  clampLimit as clampRequestLimit,
  clampOffset as clampRequestOffset,
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
  NEURON_COLUMNS,
  NEURON_INSERT_COLUMNS,
} from "../src/metagraph-neurons.ts";
import { buildValidatorOperatorDirectory } from "../src/validator-operator-directory.ts";
import { mirrorNeuronSnapshotToNeon } from "../src/neurons-neon-write.ts";
import { mirrorChainDetailToNeon } from "../src/chain-detail-neon-write.ts";
import {
  ACCOUNT_IDENTITY_NEON_LANE,
  SUBNET_HYPERPARAMS_NEON_LANE,
  SUBNET_IDENTITY_NEON_LANE,
  SUBNET_IDENTITY_FIELDS,
  SUBNET_IDENTITY_INSERT_COLUMNS,
  SUBNET_OWNERSHIP_COLUMNS,
  SUBNET_OWNERSHIP_NEON_LANE,
  failedTables,
  mirrorFamilyToNeon,
  FAMILY_MIRROR_PLANS,
} from "../src/hyperparams-identity-neon-write.ts";
import {
  coldkeyMaxCapturedAt,
  mirrorNominatorPositionsToNeon,
  POSITION_SOURCE_SELF_STAKE,
  SELF_STAKE_NEON_LANE,
} from "../src/nominator-positions-neon-write.ts";
import {
  LEDGER_MIRROR_PLANS,
  mirrorLedgerToNeon,
} from "../src/ledger-neon-write.ts";
import {
  neuronSnapshotDate,
  neuronSnapshotWrite,
} from "../src/neurons-neon-write.ts";
import { PASS_TABLES } from "../src/pass-completeness.ts";
import {
  explorerDirectoriesSnapshotKey,
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_DIRECTORIES_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
  KV_TAO_USD_CURRENT,
} from "../src/kv-keys.ts";
import { NEON_PRUNE_CRON, runNeonPrune } from "../src/neon-prune.ts";
import { runTableFreshnessWatchdog } from "../src/table-freshness-watchdog.ts";
import { runTaoUsdIndexWatchdog } from "../src/tao-usd-index-watchdog.ts";

import { VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS } from "../src/validator-nominator-counts-staleness-watchdog.ts";
import {
  CHAIN_DETAIL_SYNC_MAX_BODY_BYTES,
  parseChainDetailSync,
} from "../src/chain-detail-sync-payload.ts";
import { chainDetailHead } from "../src/chain-detail-hot-tier.ts";
import { buildAccountPositionHistory } from "../src/account-position-history.ts";
import {
  createUnkeyKey,
  verifyUnkeyKey,
  updateUnkeyKeyTier,
  revokeUnkeyKey,
} from "../src/unkey-client.ts";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";
import {
  applyQuotaSpend,
  quotaResetAt,
  utcDayKey,
} from "../src/daily-quota.ts";
import { TIER_DAILY_UNITS } from "../src/api-tiers.ts";
import { csvRequested, csvResponse } from "./csv.ts";
import {
  BLOCK_REASON_CODES,
  isBlockReasonCode,
  scoreUsageAnomalies,
} from "../src/api-key-abuse.ts";
import { BLOCKLIST_KV_KEY, BLOCKLIST_KV_TTL } from "./tiered-rate-limit.ts";
// FROM THE LEAF, NOT src/mcp-server.ts (#10238). Importing it from there for
// one number pulled the MCP server, src/graphql.ts and workers/api.ts into
// this bundle and pushed it over the Worker startup CPU limit.
import { MCP_TIERED_RATE_LIMIT } from "../src/api-tiers.ts";
// PgSql is the one tagged-template runner shape (#10261/#10228):
// this file used to declare a structurally identical local pair (`D1Sql`)
// so routes could move between stores unchanged; with one store left, the
// duplicate is gone and the import is the contract.
import { createPgSql, type PgSql } from "../src/pg-sql.ts";
import { neonWriteRunner } from "../src/neon-write-buffer.ts";
import type { ChainAlertTriggers } from "../generated/db/types.ts";
import { FEATURED_HOTKEY_SET } from "../generated/featured-validators.ts";
import type { NeuronColumnsRow } from "../src/metagraph-neurons.ts";
import type { NeuronDailyReadRow } from "../src/neuron-history.ts";

/**
 * One neuron-day joined to its subnet's pool, as the history endpoints select
 * it. `stake_alpha`/`emission_alpha` are the raw per-subnet alpha figures
 * under their on-chain column names; the `total_*_tao` pair is the same value
 * PRICED through the pool ratio, which is why those two are the ones that mean
 * TAO (#9051) -- and why they are computed, not column types.
 */
type NeuronDailyPoint = {
  snapshot_date: NeuronDaily["snapshot_date"];
  subnet_count: number;
  netuid: NeuronDaily["netuid"];
  uid: NeuronDaily["uid"];
  stake_alpha: NeuronDaily["stake_tao"];
  emission_alpha: NeuronDaily["emission_tao"];
  validator_trust: NeuronDaily["validator_trust"];
  consensus: NeuronDaily["consensus"];
  dividends: NeuronDaily["dividends"];
  take: NeuronDaily["take"];
  validator_permit: NeuronDaily["validator_permit"];
  subnet_total_stake: SubnetSnapshots["total_stake_tao"];
  total_stake_tao: number | null;
  total_emission_tao: number | null;
};

/**
 * One `neuron_daily` rollup row, per (netuid,) snapshot_date.
 *
 * The scalar members come from the generated table interface, so a column that
 * changes type in Neon changes here. The COUNT/SUM members do NOT: an
 * aggregate over BIGINT returns NUMERIC, which postgres.js hands back as a
 * STRING (#8607), and the column's own type would understate that.
 */
type NeuronDailyRollup = {
  snapshot_date: NeuronDaily["snapshot_date"];
  neuron_count: string | number;
  validator_count: string | number;
  total_stake_tao: string | number | null;
  total_emission_tao: string | number | null;
};
import { recordLaneVerdict } from "../src/lane-health.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import {
  handleDeadLetterBatch,
  isDeadLetterQueue,
} from "../src/dead-letter.ts";
import type { PassTallyInput } from "../src/pass-completeness.ts";
import {
  compressSyncBatchMessage,
  decompressSyncBatchMessage,
  isCompressedSyncBatchBody,
} from "../src/sync-batch-compress.ts";
import {
  classifySyncBatch,
  enqueueSyncBatch,
  packMultiFamilyMessage,
  SYNC_BATCH_MAX_BYTES,
  type SyncBatchFamilyWriters,
  syncBatchRowCount,
  syncLaneUsesQueue,
  validSyncBatchMessage,
  writeSyncBatch,
  type SyncBatchWriters,
} from "../src/sync-batch-queue.ts";
import {
  coercePollerJobOutcome,
  validPollerJobOutcome,
} from "../src/poller-lane-health.ts";
import {
  createSessionToken,
  createTriggerToken,
  issueWalletChallenge,
  SESSION_TTL_SECONDS,
  verifySessionToken,
  verifyTriggerToken,
  verifyWalletChallenge,
  WATCH_TOKEN_TTL_SECONDS,
} from "../src/wallet-auth.ts";
import {
  ACCOUNT_BALANCE_INSERT_COLUMNS,
  HOTKEY_ALPHA_INSERT_COLUMNS,
} from "../src/ledger-neon-write.ts";
import type {
  AccountIdentity,
  AccountIdentityHistory,
  AccountPositionDaily,
  ApiKeyBlocks,
  ApiKeyUsageDaily,
  ApiKeys,
  ApiQuotaDaily,
  ApiUsageRollup,
  ChainAlertDeliveries,
  GithubAccounts,
  NeuronDaily,
  Neurons,
  NominatorPositions,
  RpcAccounts,
  SubnetHyperparams,
  SubnetHyperparamsHistory,
  SubnetOwnership,
  SubnetSnapshots,
  SurfaceStatus,
  ValidatorNominatorCounts,
  WatchPushSubscriptions,
} from "../generated/db/types.ts";

type Row = Record<string, unknown>;

// --- POST /api/v1/internal/neurons-sync (#4771) -----------------------------
// The write path into this Worker's own Postgres for neurons/neuron_daily.
// Reached only via the main Worker's DATA_API service binding (no public
// routes of its own) -- see workers/api.ts's handleNeuronsSyncProxy, which
// forwards the request here unchanged. The shared-secret check below is the
// only auth gate in the whole path, mirroring workers/registry-sync-api.ts's
// shape (shared-secret POST, no R2/HMAC envelope needed since the secret
// header IS the transport's auth).
//
// This is the write path .github/workflows/refresh-metagraph.yml's
// sign-and-stage job POSTs scripts/fetch-metagraph-native.py's output to,
// alongside (not replacing, during the #4771 verification window) the
// existing R2-stage-to-store path. The payload is the SAME bare-array shape
// already produced for D1 (NEURON_INSERT_COLUMNS) -- no new fetch/shape work
// needed, only a new destination.
//
// Collapses the store's two-step architecture (loadStagedNeurons loads the latest
// snapshot; a SEPARATE daily cron, rollupNeuronDaily, later snapshots that
// table into neuron_daily via SQL) into ONE step: every row already carries
// its own captured_at, so this upserts BOTH neurons (latest-only) AND
// neuron_daily (dated) from the same payload in the same transaction. No
// Postgres-side rollup cron is needed, and therefore none of the store's
// archive-then-prune complexity (src/neuron-history.ts, #4770) has an
// equivalent here to build.
const NEURONS_SYNC_TOKEN_HEADER = "x-neurons-sync-token";
// ~33k rows today (129 netuids x <=256 UIDs); generous headroom over that
// (matches the store staging path's MAX_STAGED_NEURON_ROWS/MAX_STAGED_NEURONS_BYTES,
// workers/request-handlers/staging.mjs) without inviting a pathological body.
const NEURONS_SYNC_MAX_BODY_BYTES = 32_000_000;
const NEURONS_SYNC_MAX_ROWS = 50_000;
const NEURONS_SYNC_MAX_STRING_BYTES = 512;
const NEURONS_SYNC_MAX_NETUID = 65_535;
const NEURONS_SYNC_MAX_UID = 65_535;
const NEURONS_SYNC_BOOLEAN_COLUMNS = new Set([
  "active",
  "validator_permit",
  "is_immunity_period",
]);

// Separate from the read path's json() -- a write ack must never carry the
// GET routes' `cache-control: public, max-age=10` (or the CORS wildcard,
// meaningless for a service-binding-only route).
function writeJson(
  data: unknown,
  status: number = 200,
  extraHeaders: Row = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function utf8Bytes(value: unknown) {
  return new TextEncoder().encode(value as string);
}

// Bounds-check one incoming row against NEURON_INSERT_COLUMNS -- the exact
// same trust posture as workers/request-handlers/staging.mjs's
// validStagedNeuronRow (this payload arrives over a different transport, but
// it's the same untrusted-until-checked shape from the same producer script).
/**
 * Floor for a plausible epoch-MILLISECOND capture stamp (#9382).
 *
 * Every `captured_at` reaching these sync endpoints is milliseconds. A
 * seconds-precision value is a unit error rather than a very old capture, and it
 * fails quietly and durably in two ways:
 *
 *  1. `neuronSyncSnapshotDate` derives the row's day from it, so read as
 *     milliseconds a seconds stamp lands 20 days after the epoch and the row is
 *     filed under `1970-01-21`.
 *  2. These tables upsert under a `captured_at <= excluded.captured_at` staleness
 *     guard, so a stamp 1,000x too small is permanently "older" than any correct
 *     one — the bad row can never be corrected in place by a later capture, and the
 *     per-netuid prune compares against it too.
 *
 * One row reached production exactly this way: netuid 1, uid 0, block 8,755,038,
 * `captured_at` 1785715160 (seconds) beside `updated_at` 1785715160521 (the same
 * instant in milliseconds). It belongs to 2026-08-02.
 *
 * 2020-01-01 separates the two units with enormous margin — a seconds stamp would
 * have to represent the year 51,978 to clear it — while sitting comfortably before
 * any real Bittensor capture. Shared by every sync validator below rather than
 * restated, because the defect is the unit, not the table.
 */
export const SYNC_MIN_CAPTURED_AT_MS = Date.UTC(2020, 0, 1);

// One instance per route, each built from the SAME *_INSERT_COLUMNS the writer
// binds, so a schema can never drift from the INSERT it guards (#9564).
const NEURON_SYNC_ROW_SCHEMA = neuronSyncRowSchema({
  columns: NEURON_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxNetuid: NEURONS_SYNC_MAX_NETUID,
  maxUid: NEURONS_SYNC_MAX_UID,
  maxStringBytes: NEURONS_SYNC_MAX_STRING_BYTES,
});

// captured_at is epoch ms; snapshot_date is the UTC day, matching the store's
// rollupNeuronDaily (`date(captured_at / 1000, 'unixepoch')`).
const neuronSyncSnapshotDate = neuronSnapshotDate;

// Coerce one validated row into the exact JS types each Postgres column
// expects: 0/1 -> boolean for the BOOLEAN columns (the fetch script emits
// 0/1 integers, same convention the store's INTEGER columns use), everything else
// passes through (postgres.js binds numbers/strings/nulls as-is).
function coerceNeuronSyncRow(row: Row) {
  const out: Row = {};
  for (const col of NEURON_INSERT_COLUMNS) {
    const value = row[col] ?? null;
    out[col] = NEURONS_SYNC_BOOLEAN_COLUMNS.has(col)
      ? Boolean(Number(value))
      : value;
  }
  return out;
}

function stripClientSnapshotDate(row: Row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const { snapshot_date: _snapshotDate, ...rest } = row;
  return rest;
}

// --- Neurons-family READS on the store (box decommission; tests/fixtures/sqlite-schema/0007) ------
//
async function handleNeuronsSync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  const neuronCheck = validateSyncRows(
    validatedIncoming,
    NEURON_SYNC_ROW_SCHEMA,
    "neuron",
  );
  if (!neuronCheck.ok) {
    return writeJson({ error: neuronCheck.error }, 400);
  }

  const rows = validatedIncoming.map(coerceNeuronSyncRow);
  // Derived by the SAME functions the queue consumer uses (#9636's fan-out
  // means this snapshot can now arrive either way). Two implementations of a
  // prune cutoff would be two chances to compute a different one, and the
  // failure mode there is deleted rows.
  const { dailyRows, positionRows, netuidMaxCapturedAt } = neuronSnapshotWrite(
    rows,
    Date.now(),
  );
  const netuids = [...netuidMaxCapturedAt.keys()];

  // THE PASS DECLARATION (#9812), and this lane's case is different from its
  // four siblings'. Theirs is "a short load looks like a small one" over a flat
  // keyspace. Here the producer packs the snapshot into ~7+ requests grouped by
  // netuid and its posting loop CONTINUES past a failed chunk before bailing at
  // the end -- so the netuids that landed are already written with captured_at
  // advanced, while the rest keep an older stamp. The lane reports failure; the
  // table does not.
  //
  // Recorded in metagraph.rs's own comment: "pass stopped there. The 108
  // subnets behind it kept a stamp that was by then 30 hours old."
  //
  // MAX(captured_at) cannot see it, because it reflects only the netuids that
  // DID land -- 21 of 129 netuids leaves a perfectly fresh-looking stamp.
  //
  // Optional, like every other lane's: a producer that has not been updated
  // must keep working, and inventing a total would mark an unproven load
  // complete -- the one lie this mechanism exists to prevent.
  const neuronsDeclared = declaredPassTotal(
    parsed,
    NEURONS_SYNC_MAX_ROWS * 100,
  );
  if (neuronsDeclared.error) {
    return writeJson({ error: neuronsDeclared.error }, 400);
  }
  const neuronsTally = passTallyFromRows(
    rows,
    neuronsDeclared.total,
    Date.now(),
  );
  if (neuronsTally.error) {
    return writeJson({ error: neuronsTally.error }, 400);
  }
  const pass = neuronsTally.pass ?? null;

  // Enqueue or write, never both -- see handleHotkeyAlphaSync's own note.
  //
  // THE PRUNE IS WHY THIS LANE WAITED (metagraphed-infra#357). Its write
  // DELETES rows for a netuid older than the newest captured_at it saw for that
  // netuid, so a message missing some of a netuid's rows would delete rows it
  // never carried. The packer groups by netuid and asserts `key_complete`
  // because it made that true -- and it still can, because pack_netuid_chunks
  // never SPLITS a netuid across two chunks. (It does chunk, ~7+ requests per
  // pass; the claim here used to be that it never chunked at all, which was the
  // right conclusion from a premise that has not been true for some time.)
  if (syncLaneUsesQueue(env, "neurons")) {
    try {
      await enqueueSyncBatch(env.SYNC_BATCHES!, {
        lane: "neurons",
        capturedAt: pass?.capturedAt ?? (rows[0]!.captured_at as number),
        ...(pass ? { passTotal: pass.expectedRows } : {}),
        rows,
      });
    } catch (err) {
      console.error("data-api neurons enqueue failed:", err);
      await captureDataApiError(err, "neurons-sync-queue", env);
      return writeJson({ error: "enqueue failed" }, 502);
    }
    return writeJson({
      ok: true,
      neurons_written: rows.length,
      neuron_daily_written: dailyRows.length,
      account_position_daily_written: positionRows.length,
      netuids_covered: netuids.length,
      stores: ["queue"],
    });
  }

  // ALL THREE TABLES, OR NONE. This asks neonOwnsNeuronsSnapshot rather than
  // just the binding, and the difference is load-bearing: one pass derives all
  // three tables from one snapshot, so a half-declared family would write the
  // declared tables and leave the others behind -- and no read gate would
  // notice, because each table answers fine on its own.
  //
  // Checked HERE, after parsing and validation, not at the top: a malformed
  // body is a 400 whether or not a store happens to be bound, and answering
  // 503 to it would blame the infrastructure for the caller's payload.
  if (!neonOwnsNeuronsSnapshot(env)) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  // THE NEON WRITE (metagraphed-infra#336), which was a mirror behind a second
  // store and is now the write itself.
  //
  // The ordering it was built with is still the lesson of how the pilot broke:
  // a read moved to Neon while nothing wrote to it, so a public route served a
  // two-day-old snapshot. What changed is the cost of failure -- Neon is the
  // store every route reads, so a pass that did not reach it did not happen,
  // and the check below returns 502 rather than recording a mirror verdict.
  // It still reports its own outcome and cannot throw.
  const neon = await mirrorNeuronSnapshotToNeon(env, ctx, {
    rows,
    dailyRows,
    positionRows,
    // The tally follows the rows into the store that holds them (#10056).
    pass,
    // The deregistration prune's cutoffs (#10184). Derived by the SAME
    // function that produced dailyRows/positionRows above, so the writer and
    // the prune cannot disagree about where the floor is.
    netuidMaxCapturedAt,
  });

  // AUTHORITATIVE ONCE NEON OWNS THE TABLES. During dual-write a Neon failure
  // cost a mirror and a lane verdict, never the pass, because D1 was still the
  // store every route read. Once Neon IS the store that reasoning inverts: a
  // pass that did not reach it did not happen, and reporting ok:true would
  // tell the producer its rows are safe when nothing holds them.
  const failed = Object.entries(neon.results).filter(([, r]) => !r.ok);
  if (!neon.attempted || failed.length > 0) {
    console.error("data-api neurons-sync Neon write failed:", failed);
    await captureDataApiError(
      new Error(
        failed.length > 0
          ? `neon write failed: ${failed.map(([t]) => t).join(", ")}`
          : "neon write not attempted",
      ),
      "neurons-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  if (pass) {
    scheduleExplorerDirectoryRefresh(env, ctx, pass.capturedAt);
  }

  // `stores` stays REPORTED rather than inferred, so a reader can see which
  // store this snapshot actually reached -- which is precisely the question
  // nobody could answer while Neon was frozen.
  return writeJson({
    ok: true,
    neurons_written: rows.length,
    neuron_daily_written: dailyRows.length,
    account_position_daily_written: positionRows.length,
    netuids_covered: netuids.length,
    stores: ["neon"],
    neon: neon.results,
  });
}

// --- POST /api/v1/internal/chain-detail-sync (#9208) ------------------------
//
// The write path into the chain-detail HOT TIER: the rolling window of
// extrinsics / chain_events / account_events that makes block drill-down
// current instead of up to an hour stale. Same delivery pattern as every other
// lane in this file -- the producer decodes, POSTs a token-authed batch, and
// this lands it in the store -- so there is no new topology, only a new destination.
//
// The producer is metagraphed-infra's live-follow poller lane, which follows
// the FINALIZED head and decodes with the SAME shared decoder the hourly R2
// batch lane uses (#9208 requirement 1: one decoder, never two). It batches 2
// blocks per POST, ~350-662 KiB and ~800-3,000 rows.
//
// Everything payload-shaped lives in src/chain-detail-sync-payload.ts and
// everything statement-shaped in src/chain-detail-d1-write.ts; what is left
// here is auth, body size, and the ack -- deliberately, because those three are
// the parts that must match the other sync routes exactly, and the rest is the
// part that benefits from being a pure function.
const CHAIN_DETAIL_SYNC_TOKEN_HEADER = "x-chain-detail-sync-token";

/** Auth gate shared by the sync POST and its head GET: one secret, because
 * both are the same producer on the same trust boundary, and a second secret
 * for a read of one integer would be ceremony. Returns the failing response, or
 * null when the caller is authorised. */
function chainDetailSyncAuth(
  request: Request,
  env: DataApiEnv,
): Response | null {
  if (!env.CHAIN_DETAIL_SYNC_SECRET) {
    return writeJson(
      { error: "chain-detail sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(CHAIN_DETAIL_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.CHAIN_DETAIL_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${CHAIN_DETAIL_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  return null;
}

async function handleChainDetailSync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const denied = chainDetailSyncAuth(request, env);
  if (denied) return denied;

  const raw = await request.text();
  if (utf8Bytes(raw).length > CHAIN_DETAIL_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${CHAIN_DETAIL_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const batch = parseChainDetailSync(parsed, Date.now());
  if (!batch.ok) return writeJson({ error: batch.error }, batch.status);

  // D1 is the binding this path requires UNTIL Neon owns the four families
  // (#10144) -- asked only when the store write below is going to happen, since an
  // unconditional check answered 503 here and never reached the Neon write.
  //
  // Checked HERE, after parsing and validation, not at the top: a malformed
  // body is a 400 whether or not a store happens to be bound, and answering 503
  // to it would blame the infrastructure for the caller's payload. Same
  // ordering, and the same reason, as handleNeuronsSync above.
  // ALL FOUR FAMILIES, OR NONE -- they must land together, so a partial
  // declaration is the "no store" case rather than a weaker version of owned.
  if (!neonOwnsChainDetail(env)) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  // Enqueue or write, never both -- see handleHotkeyAlphaSync's own note.
  //
  // FOUR FAMILIES, ONE MESSAGE (metagraphed-infra#359). blocks, extrinsics,
  // chain events and account events are posted together because they must land
  // together: a block whose drill-down shows no calls is readable and wrong.
  // packMultiFamilyMessage refuses to split them, so an oversize batch throws
  // here rather than silently becoming the split this shape exists to prevent.
  //
  // SENT COMPRESSED, because raw JSON does not fit and cannot be made to: one
  // block measures 476.6 KiB against a 128 KiB cap, and the batch is already
  // one block. gzip takes the same bytes to 40.5 KiB (metagraphed#9759). The
  // budget is checked on the COMPRESSED size -- the only number the transport
  // sees -- and still throws rather than degrading into a split.
  if (syncLaneUsesQueue(env, "chain-detail")) {
    try {
      await env.SYNC_BATCHES!.send(
        await compressSyncBatchMessage(
          packMultiFamilyMessage({
            lane: "chain-detail",
            capturedAt: Date.now(),
            families: {
              blockRows: batch.rows.blockRows,
              extrinsicRows: batch.rows.extrinsicRows,
              chainEventRows: batch.rows.chainEventRows,
              accountEventRows: batch.rows.accountEventRows,
            },
          }),
          SYNC_BATCH_MAX_BYTES,
        ),
        { contentType: "bytes" },
      );
    } catch (err) {
      console.error("data-api chain-detail enqueue failed:", err);
      await captureDataApiError(err, "chain-detail-sync-queue", env);
      return writeJson({ error: "enqueue failed" }, 502);
    }
    return writeJson({
      ok: true,
      blocks_written: batch.rows.blockRows.length,
      extrinsics_written: batch.rows.extrinsicRows.length,
      chain_events_written: batch.rows.chainEventRows.length,
      account_events_written: batch.rows.accountEventRows.length,
      head: batch.rows.head,
      stores: ["queue"],
    });
  }

  let neon: Awaited<ReturnType<typeof mirrorChainDetailToNeon>>;
  try {
    // ONE OF THIS LANE'S TWO WRITERS. The sync-batches queue consumer is the
    // other and mirrors too -- #9728 is the precedent for why covering one of
    // two is worse than covering neither: the row count looks nearly right.
    neon = await mirrorChainDetailToNeon(env, ctx, batch.rows);
  } catch (err) {
    console.error("data-api chain-detail-sync write failed:", err);
    await captureDataApiError(err, "chain-detail-sync-d1", env);
    return writeJson({ error: "store write failed" }, 502);
  }

  // The write's failure IS the pass's failure. Reporting ok:true would tell the
  // producer its blocks are durable when nothing holds them -- and this lane's
  // producer advances its resume head on ok, so a false ok skips those blocks
  // forever rather than retrying them.
  const failed = failedTables(neon);
  if (!neon.attempted || (failed && failed.length > 0)) {
    console.error("data-api chain-detail-sync Neon write failed:", failed);
    await captureDataApiError(
      new Error(
        failed && failed.length > 0
          ? `neon write failed: ${failed.join(", ")}`
          : "neon write not attempted",
      ),
      "chain-detail-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    blocks_written: batch.rows.blockRows.length,
    extrinsics_written: batch.rows.extrinsicRows.length,
    chain_events_written: batch.rows.chainEventRows.length,
    account_events_written: batch.rows.accountEventRows.length,
    head: batch.rows.head,
    stores: ["neon"],
  });
}

// --- GET /api/v1/internal/chain-detail-sync/head (#9208) --------------------
//
// The producer's resume point: the highest block already synced, so a restarted
// lane picks up where it left off instead of re-decoding its whole window or,
// worse, skipping forward and leaving a hole nothing will ever fill.
//
// `head: null` is a real answer, not an error -- an empty tier is exactly the
// state a first deploy is in, and the producer's correct response to it is to
// start from the current finalized head, not to retry.
async function handleChainDetailSyncHead(request: Request, env: DataApiEnv) {
  const denied = chainDetailSyncAuth(request, env);
  if (denied) return denied;
  // DELIBERATELY still a hard refusal, unlike a route that can degrade.
  //
  // Relaxing this check would turn "I cannot tell you" into `head: null`, and
  // `head: null` is a documented real answer that tells the producer to start
  // from the current finalized head. A 503 makes it retry; a wrong null makes
  // it skip, and leaves a hole nothing will ever fill.
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }
  return writeJson({ head: await chainDetailHead(env) });
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

async function handleNeuronDailyBackfill(
  request: Request,
  env: DataApiEnv,
  ctx?: ExecutionContext,
) {
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
  const neuronCheck = validateSyncRows(
    validatedIncoming,
    NEURON_SYNC_ROW_SCHEMA,
    "neuron",
  );
  if (!neuronCheck.ok) {
    return writeJson({ error: neuronCheck.error }, 400);
  }

  const rows = validatedIncoming.map(coerceNeuronSyncRow);
  const dailyRows = rows.map((row: Row) => ({
    ...row,
    snapshot_date: neuronSyncSnapshotDate(row.captured_at),
    updated_at: Date.now(),
  }));
  const positionRows = dailyRows
    .filter((row: Row) => row.hotkey != null)
    .map((row: Row) => ({
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

  // Same write shape as handleNeuronsSync's #9157 port, minus the `neurons`
  // write and the prune this handler must never run (see the header comment
  // above -- that invariant is store-independent).
  //
  // THE INVERSION (#10144). This route was still ordered the way the whole
  // system used to be: write D1, fail the request if that write fails, then
  // mirror to Neon and report `stores: ["d1","neon"]`. Both tables it writes
  // are Neon's outright, so that ordering had the authoritative store in the
  // mirror's position -- a backfill could report success on a store write nothing
  // reads, and a Neon failure was invisible.
  //
  // The same all-or-nothing family gate the sync handler applies, and checked
  // after validation for the same 400-before-503 reasoning.
  if (!neonOwnsNeuronsSnapshot(env)) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  // THE SECOND WRITER, mirrored too (#9717).
  //
  // This route writes the SAME two derived tables handleNeuronsSync does, and
  // for a while only that one mirrored. The gap was measurable and stable:
  // `account_position_daily` for 2026-08-07 held 30,216 rows in the store against
  // 30,124 in Neon -- 92 rows across 69 accounts, unchanged across
  // measurements minutes apart, so not tick skew. `neurons` matched exactly on
  // a content checksum, because it has only one writer.
  //
  // A store is not a mirror of another store until EVERY path that writes the
  // first also writes the second. One unmirrored writer is all it takes to make
  // a cutover serve a quietly incomplete table -- which the row count would
  // have called nearly right.
  //
  // `rows: []` because this route carries no `neurons` rows: the mirror treats
  // an empty table as a clean no-op and still records its verdict, so the
  // absence is visible rather than assumed.
  const neon = await mirrorNeuronSnapshotToNeon(env, ctx, {
    rows: [],
    dailyRows,
    positionRows,
  });

  // Once Neon owns the tables, a backfill that did not reach Neon did not
  // happen -- and the operator replaying a year of history is precisely the
  // caller who must not be told `ok` for rows that landed nowhere. Below the
  // inversion this stays best-effort, exactly as it was.
  //
  // The two tables are named rather than folded over `neon.results`, because
  // the mirror returns `{ attempted: true, results: {} }` when Hyperdrive is
  // unbound -- a failure a "no result said not-ok" test would read as success.
  // Absent has to fail here, not just present-and-false.
  const reason = ["neuron_daily", "account_position_daily"]
    .map((table) => {
      const result = neon.results?.[table];
      if (!result) return `${table}: no Neon write recorded`;
      return result.ok ? null : `${table}: ${result.reason ?? "failed"}`;
    })
    .filter(Boolean)
    .join("; ");
  if (reason) {
    console.error("data-api neuron-daily-backfill Neon write failed:", reason);
    await captureDataApiError(
      new Error(reason),
      "neuron-daily-backfill-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    neuron_daily_written: dailyRows.length,
    account_position_daily_written: positionRows.length,
    stores: ["neon"],
    neon: neon.results,
  });
}

// --- POST /api/v1/internal/rollup-account-events-daily (#4832 gap-closure) -
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// account_events is written continuously by indexer-rs directly into this
// same Postgres instance (not through any Worker route), so unlike
// neurons-sync above there is no existing write request to piggyback the
// rollup onto -- a Worker-native cron (ACCOUNT_EVENTS_ROLLUP_CRON,
// workers/config.ts) dispatches this instead, proxied through the main
// Worker the same way (workers/api.ts's handleRollupAccountEventsDailyProxy,
// called from handleScheduled). Also rolls up wallet_flow_daily (#6886/#6887)
// in the same run -- the account-keyed, per-day net/gross StakeAdded vs
// StakeRemoved rollup GET /api/v1/accounts/top-holders' ?sort=net_flow_*
// reads, sharing this same day-bucket loop rather than a second cron entry
// (same source table, same active-day re-roll window, one Postgres
// round-trip pair per day instead of two separate ticks). Formerly a
// dedicated hourly GitHub Actions workflow (rollup-account-events-daily.yml,
// retired) made the same POST over
// the public internet; the cron dispatch constructs the identical request
// internally instead. Mirrors the store's rollupAccountEventsDaily
// (src/account-events.ts) exactly: re-roll the two active UTC days each
// run (past days are already finalized), upsert idempotently. No request
// body -- this is a trigger-only POST, not a data-carrying sync.

// --- POST /api/v1/internal/subnet-hyperparams-sync (#4832 gap-closure) -----
//
// The write path into subnet_hyperparams + subnet_hyperparams_history,
// reached only via workers/api.ts's handleSubnetHyperparamsSyncProxy (the
// same proxyToDataApi shape as neurons-sync/rollup-account-events-daily
// above) -- now this workflow's SOLE write path, the store's own R2-stage-to-D1
// loader (loadStagedSubnetHyperparams) having been retired alongside D1's
// copy of these two tables. The producer is metagraphed-infra's
// data-refresh-cron job, which POSTs directly here. The retired
// .github/workflows/refresh-subnet-hyperparams.yml (#5157) used to sign and
// stage a {schema_version, hmac_sha256, rows} envelope first; the handler
// below never read either of the first two fields, only rows (or a bare
// array), so nothing changed on this side when that lane went away. The HMAC
// authenticated an R2 object drop across an untrusted intermediate step,
// which a direct POST does not have -- this request is independently
// authenticated by the token header below, matching handleNeuronsSync's own
// request/{rows:[...]} shape.
//
// Every successful upstream fetch covers ALL active subnets in one run (the
// fetch script loops every netuid every time and exits nonzero on any
// missing netuid -- get_subnet_hyperparameters has no bulk variant -- so
// there's no partial-coverage concept to track here), so the prune below is
// a plain NOT IN against this batch's netuids, unlike neurons-sync's
// per-netuid captured_at-scoped prune.
const SUBNET_HYPERPARAMS_SYNC_TOKEN_HEADER = "x-subnet-hyperparams-sync-token";
// ~129 rows today (one per active netuid, root included); generous headroom.
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
const SUBNET_HYPERPARAMS_SYNC_ROW_SCHEMA = subnetHyperparamsSyncRowSchema({
  columns: SUBNET_HYPERPARAMS_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxNetuid: SUBNET_HYPERPARAMS_SYNC_MAX_NETUID,
});

// 0/1 -> boolean for the BOOLEAN columns (see NEURONS_SYNC_BOOLEAN_COLUMNS'
// identical reasoning above); everything else passes through unchanged.
function coerceSubnetHyperparamsSyncRow(row: Row) {
  const out: Row = {};
  for (const col of SUBNET_HYPERPARAMS_INSERT_COLUMNS) {
    const value = row[col] ?? null;
    out[col] = SUBNET_HYPERPARAMS_BOOLEAN_COLUMNS.has(col)
      ? Boolean(Number(value))
      : value;
  }
  return out;
}

/**
 * One incoming hyperparams row, formatted and hashed exactly once -- both
 * stores' history diffs consume this same sequence, so the hash can never
 * diverge between them; only each store's own latest-hash map differs.
 */
interface HashedHyperparamsRow {
  netuid: number;
  block_number: unknown;
  hyperparameters: Row | null;
  hash: string | null;
}

/**
 * The diff-and-append row set for ONE store: rows whose hash moved against
 * that store's own last-recorded history hash. Mutates `latestByNetuid` as it
 * goes so a duplicate netuid within one batch appends once, matching the
 * original in-transaction loop's semantics.
 */
function diffHyperparamsHistory(
  hashedRows: HashedHyperparamsRow[],
  latestByNetuid: Map<number, unknown>,
  observedAt: number,
): Row[] {
  const changedRows: Row[] = [];
  for (const { netuid, block_number, hyperparameters, hash } of hashedRows) {
    if (latestByNetuid.get(netuid) === hash) continue;
    changedRows.push({
      netuid,
      block_number,
      observed_at: observedAt,
      ...hyperparameters,
      hyperparams_hash: hash,
    });
    latestByNetuid.set(netuid, hash);
  }
  return changedRows;
}

async function handleSubnetHyperparamsSync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  const subnetHyperparamsCheck = validateSyncRows(
    incoming,
    SUBNET_HYPERPARAMS_SYNC_ROW_SCHEMA,
    "subnet-hyperparams",
  );
  if (!subnetHyperparamsCheck.ok) {
    return writeJson({ error: subnetHyperparamsCheck.error }, 400);
  }

  const rows = incoming.map(coerceSubnetHyperparamsSyncRow);

  // Hashed ONCE, before either store writes, on the RAW incoming rows
  // (pre-coercion) -- formatSubnetHyperparams' toBooleanFlag(value) tolerates
  // either a 0/1 number or a real boolean, so the hash is domain-identical no
  // matter which store's diff consumes it. Each store then diffs this same
  // sequence against ITS OWN latest-recorded hashes below (the two histories
  // legitimately diverge: D1 starts empty at the cutover).
  const now = Date.now();
  const hashedRows: HashedHyperparamsRow[] = [];
  for (const row of incoming) {
    const hyperparameters = formatSubnetHyperparams(row);
    hashedRows.push({
      netuid: row.netuid,
      block_number: row.block_number ?? null,
      hyperparameters,
      hash: await hyperparamsHash(hyperparameters),
    });
  }

  // BOTH TABLES OF THE FAMILY, OR NONE (#10179): the table and its history are
  // written from one derivation, so a half-declared family would let the two
  // disagree about which revisions exist. Checked HERE, after parsing and
  // validation, not at the top: a malformed body is a 400 whether or not a
  // store happens to be bound.
  if (!neonOwnsFamily(env, SUBNET_HYPERPARAMS_NEON_LANE)) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  let historyAppended: number;
  // Hoisted so the write below sees the SAME diff the history read produced --
  // one derivation, so the table and its history cannot disagree about which
  // revisions exist.
  let neonHistoryRows: Row[];
  const historySql = createPgSql(env.HYPERDRIVE, ctx);
  try {
    // Latest hash per netuid.
    const latest = await historySql<{
      netuid: SubnetHyperparamsHistory["netuid"];
      hyperparams_hash: SubnetHyperparamsHistory["hyperparams_hash"];
    }>`
      SELECT h.netuid AS netuid, h.hyperparams_hash AS hyperparams_hash
      FROM subnet_hyperparams_history h
      JOIN (
        SELECT netuid, MAX(id) AS id
        FROM subnet_hyperparams_history GROUP BY netuid
      ) latest ON latest.id = h.id`;
    const latestByNetuid = new Map<number, unknown>(
      latest.map((row) => [Number(row.netuid), row.hyperparams_hash]),
    );
    const historyRows = diffHyperparamsHistory(hashedRows, latestByNetuid, now);
    neonHistoryRows = historyRows as Row[];
    historyAppended = historyRows.length;
  } catch (err) {
    console.error("data-api subnet-hyperparams-sync history read failed:", err);
    await captureDataApiError(err, "subnet-hyperparams-sync-history", env);
    return writeJson({ error: "history read failed" }, 502);
  }

  const neon = await mirrorFamilyToNeon(
    env,
    ctx,
    SUBNET_HYPERPARAMS_NEON_LANE,
    { rows, historyRows: neonHistoryRows },
  );

  // AUTHORITATIVE. Neon is the store, so a pass that did not reach it did not
  // happen, and ok:true would tell the producer its rows are safe when nothing
  // holds them.
  const failed = failedTables(neon);
  if (!neon.attempted || (failed && failed.length > 0)) {
    console.error(
      "data-api subnet-hyperparams-sync Neon write failed:",
      failed,
    );
    await captureDataApiError(
      new Error(
        failed && failed.length > 0
          ? `neon write failed: ${failed.join(", ")}`
          : "neon write not attempted",
      ),
      "subnet-hyperparams-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    subnet_hyperparams_written: rows.length,
    history_appended: historyAppended,
    stores: ["neon"],
    neon: neon.results,
  });
}

// --- POST /api/v1/internal/subnet-hyperparams-backfill (#5597) ------------
//
// The HISTORICAL counterpart of subnet-hyperparams-sync above. That route is a
// forward-only writer and correct as such, but two of its properties make it
// unusable for a replay: it stamps `observed_at` with `Date.now()` (the payload
// has no field for it), and it diffs each row against the LATEST recorded hash.
// A replay needs the block's own timestamp, and needs no diff at all -- the
// producer already established which blocks changed, by reading the AdminUtils
// extrinsics out of the lakehouse.
//
// SAME SECRET as the sync route, deliberately. The producer is the same poller
// with the same trust level writing the same family; a second secret would be a
// second thing to provision and rotate for no boundary that differs.
const SUBNET_HYPERPARAMS_BACKFILL_MAX_BODY_BYTES = 4_000_000;
const SUBNET_HYPERPARAMS_BACKFILL_MAX_ROWS = 500;

async function handleSubnetHyperparamsBackfill(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
): Promise<Response> {
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

  const raw = await request.text();
  if (utf8Bytes(raw).length > SUBNET_HYPERPARAMS_BACKFILL_MAX_BODY_BYTES) {
    return writeJson(
      {
        error: `body exceeds ${SUBNET_HYPERPARAMS_BACKFILL_MAX_BODY_BYTES} bytes`,
      },
      413,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : ((parsed as { rows?: unknown })?.rows ?? null);
  if (!Array.isArray(incoming)) {
    return writeJson({ error: "expected an array of rows" }, 400);
  }
  if (incoming.length > SUBNET_HYPERPARAMS_BACKFILL_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SUBNET_HYPERPARAMS_BACKFILL_MAX_ROWS} rows` },
      413,
    );
  }

  // The same family gate the sync route applies: the table and its history are
  // one family, and writing history into a store that does not own it would put
  // rows somewhere nothing reads.
  if (!neonOwnsFamily(env, SUBNET_HYPERPARAMS_NEON_LANE)) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  const sql = createPgSql(env.HYPERDRIVE, ctx);
  try {
    const result = await writeHistoricalHyperparams(
      sql,
      incoming as HistoricalHyperparamsRow[],
    );
    // `rejected` is RETURNED, not logged and swallowed: a backfill that
    // silently drops rows is indistinguishable from one that worked, and the
    // producer is the only thing positioned to retry them.
    return writeJson({
      ok: true,
      attempted: result.attempted,
      rejected: result.rejected,
    });
  } catch (err) {
    console.error("data-api subnet-hyperparams-backfill write failed:", err);
    await captureDataApiError(err, "subnet-hyperparams-backfill", env);
    return writeJson({ error: "write failed" }, 500);
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
// headroom, matching the store staging path's MAX_STAGED_ACCOUNT_IDENTITY_ROWS/
// _BYTES.
const ACCOUNT_IDENTITY_SYNC_MAX_BODY_BYTES = 5_000_000;
const ACCOUNT_IDENTITY_SYNC_MAX_ROWS = 20_000;
const ACCOUNT_IDENTITY_SYNC_MAX_STRING_BYTES = 1024;

// Bounds-check one incoming row against ACCOUNT_IDENTITY_INSERT_COLUMNS --
// same trust posture as staging.mjs's validStagedAccountIdentityRow. Unlike
// validSubnetHyperparamsSyncRow, every column but account/captured_at is
// TEXT-only, so a bare number must be actively REJECTED here, not tolerated.
const ACCOUNT_IDENTITY_SYNC_ROW_SCHEMA = accountIdentitySyncRowSchema({
  columns: ACCOUNT_IDENTITY_INSERT_COLUMNS,
  maxStringBytes: ACCOUNT_IDENTITY_SYNC_MAX_STRING_BYTES,
});

// Postgres' TEXT type rejects any embedded NUL byte outright ("invalid byte
// sequence for encoding UTF8: 0x00") -- confirmed live 2026-07-11 against a
// real staged row whose discord/additional fields were a literal U+0000
// placeholder. SQLite's byte-oriented TEXT storage tolerates this silently
// (the store path never needed to guard against it), so this is a Postgres-only
// concern: strip rather than reject, matching the "sanitize a chain-data
// value the sink genuinely can't represent" precedent set by
// weights_rate_limit's u64::MAX widening in subnet-hyperparams-sync.
function stripNullBytes(value: unknown) {
  return typeof value === "string" ? value.replaceAll("\u0000", "") : value;
}

function sanitizeAccountIdentitySyncRow(row: Row) {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = stripNullBytes(value);
  }
  return out;
}

function coerceAccountIdentitySyncRow(row: Row) {
  const out: Row = {};
  for (const col of ACCOUNT_IDENTITY_INSERT_COLUMNS) {
    out[col] = row[col] ?? null;
  }
  return out;
}

/** One sanitized identity row, snapshot-shaped and hashed exactly once --
 * both stores' history diffs consume this same sequence (see
 * HashedHyperparamsRow's identical contract above). */
interface HashedIdentityRow {
  account: string;
  snapshot: Row;
  hash: string | null;
}

/** The diff-and-append row set for ONE store -- the identity twin of
 * diffHyperparamsHistory, keyed by account and without block_number. */
function diffIdentityHistory(
  hashedRows: HashedIdentityRow[],
  latestByAccount: Map<unknown, unknown>,
  observedAt: number,
): Row[] {
  const changedRows: Row[] = [];
  for (const { account, snapshot, hash } of hashedRows) {
    if (latestByAccount.get(account) === hash) continue;
    changedRows.push({
      account,
      observed_at: observedAt,
      ...snapshot,
      identity_hash: hash,
    });
    latestByAccount.set(account, hash);
  }
  return changedRows;
}

async function handleAccountIdentitySync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  const accountIdentityCheck = validateSyncRows(
    incoming,
    ACCOUNT_IDENTITY_SYNC_ROW_SCHEMA,
    "account-identity",
  );
  if (!accountIdentityCheck.ok) {
    return writeJson({ error: accountIdentityCheck.error }, 400);
  }

  // Sanitize BEFORE both the upsert and the history hash so the two stay
  // consistent with each other -- a raw NUL byte would otherwise reach the
  // history INSERT below via the untouched `incoming` rows even after the
  // latest-only table's own values were cleaned.
  const sanitized = incoming.map(sanitizeAccountIdentitySyncRow);
  const rows = sanitized.map(coerceAccountIdentitySyncRow);

  // Hashed ONCE, before either store writes, on the sanitized rows (NUL
  // bytes already stripped above), matching identitySnapshotFromRow's own
  // field selection. Each store diffs this same sequence against ITS OWN
  // latest-recorded hashes below.
  const now = Date.now();
  const hashedRows: HashedIdentityRow[] = [];
  for (const row of sanitized) {
    const snapshot: Row = {};
    for (const field of IDENTITY_FIELDS) snapshot[field] = row[field] ?? null;
    hashedRows.push({
      account: row.account as string,
      snapshot,
      hash: await identityHash(snapshot),
    });
  }

  // Both tables of the family, or none -- see the hyperparams sync above.
  if (!neonOwnsFamily(env, ACCOUNT_IDENTITY_NEON_LANE)) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  let historyAppended: number;
  // Hoisted so the write below sees the SAME diff the history read produced.
  let neonHistoryRows: Row[];
  const historySql = createPgSql(env.HYPERDRIVE, ctx);
  try {
    // Latest hash per account.
    const latest = await historySql<{
      account: AccountIdentityHistory["account"];
      identity_hash: AccountIdentityHistory["identity_hash"];
    }>`
      SELECT h.account AS account, h.identity_hash AS identity_hash
      FROM account_identity_history h
      JOIN (
        SELECT account, MAX(id) AS id
        FROM account_identity_history GROUP BY account
      ) latest ON latest.id = h.id`;
    const latestByAccount = new Map<unknown, unknown>(
      latest.map((row) => [row.account, row.identity_hash]),
    );
    const historyRows = diffIdentityHistory(hashedRows, latestByAccount, now);
    neonHistoryRows = historyRows as Row[];
    historyAppended = historyRows.length;
  } catch (err) {
    console.error("data-api account-identity-sync history read failed:", err);
    await captureDataApiError(err, "account-identity-sync-history", env);
    return writeJson({ error: "history read failed" }, 502);
  }

  const neon = await mirrorFamilyToNeon(env, ctx, ACCOUNT_IDENTITY_NEON_LANE, {
    rows,
    historyRows: neonHistoryRows,
  });

  // AUTHORITATIVE -- see the hyperparams sync for the reasoning.
  const failed = failedTables(neon);
  if (!neon.attempted || (failed && failed.length > 0)) {
    console.error("data-api account-identity-sync Neon write failed:", failed);
    await captureDataApiError(
      new Error(
        failed && failed.length > 0
          ? `neon write failed: ${failed.join(", ")}`
          : "neon write not attempted",
      ),
      "account-identity-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    account_identity_written: rows.length,
    history_appended: historyAppended,
    stores: ["neon"],
    neon: neon.results,
  });
}

// --- POST /api/v1/internal/subnet-identity-sync (#10710) ------------------
//
// The write path this table never had. `subnet_identity_history` was
// D1-primary with a Postgres mirror named `syncSubnetIdentityToPostgres` in
// four places -- and that function was never written. D1 went away, so the
// table has had no writer since, and the reads did not break: a Postgres miss
// degrades to a schema-stable empty feed rather than a 404, so a store with no
// writer read as a healthy, permanently frozen one.
//
// THE PRODUCER IS CHAIN-DIRECT. metagraphed-infra's `subnet-identity` poller
// lane reads SubnetIdentitiesV3 straight from the chain and POSTs the whole
// active set in one buffered request. It has been POSTing here and getting a
// 404 since it shipped. The alternative producer -- deriving changes from the
// hourly profiles artifact -- was rejected because that artifact descends from
// a capture measured 54 days stale, with 82 of the 129 registered netuids
// disagreeing with the chain and 28 renamed.
//
// APPEND-ON-CHANGE, and the history conflicts on (netuid, identity_hash)
// rather than (netuid, observed_at) like its siblings. The producer re-reads
// every identity every pass, so the same revision arrives repeatedly at
// different timestamps; conflicting on the timestamp would append a duplicate
// row every pass and bury the provenance the table exists for.
const SUBNET_IDENTITY_SYNC_TOKEN_HEADER = "x-subnet-identity-sync-token";
// ~129 rows, one per active netuid, each carrying a description and a few
// URLs. Generous headroom on both.
const SUBNET_IDENTITY_SYNC_MAX_BODY_BYTES = 2_000_000;
const SUBNET_IDENTITY_SYNC_MAX_ROWS = 2_000;
const SUBNET_IDENTITY_SYNC_MAX_NETUID = 65_535;
// One identity field. Bounded because these are owner-supplied strings from
// the chain and land in TEXT columns the serving routes render.
const SUBNET_IDENTITY_SYNC_MAX_STRING_BYTES = 4_096;

const SUBNET_IDENTITY_SYNC_ROW_SCHEMA = subnetIdentitySyncRowSchema({
  columns: SUBNET_IDENTITY_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxNetuid: SUBNET_IDENTITY_SYNC_MAX_NETUID,
  maxStringBytes: SUBNET_IDENTITY_SYNC_MAX_STRING_BYTES,
});

async function handleSubnetIdentitySync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of subnet-identity rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > SUBNET_IDENTITY_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SUBNET_IDENTITY_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  const check = validateSyncRows(
    incoming,
    SUBNET_IDENTITY_SYNC_ROW_SCHEMA,
    "subnet-identity",
  );
  if (!check.ok) {
    return writeJson({ error: check.error }, 400);
  }

  // Sanitized BEFORE hashing, so the hash the card stores and the hash the
  // history conflicts on describe the same bytes that were written -- a raw NUL
  // reaching one and not the other would make a revision look new forever.
  const sanitized = (incoming as Row[]).map(sanitizeAccountIdentitySyncRow);

  const rows: Row[] = [];
  const historyRows: Row[] = [];
  for (const row of sanitized) {
    const snapshot: Row = {};
    for (const field of SUBNET_IDENTITY_FIELDS) {
      snapshot[field] = row[field] ?? null;
    }
    const hash = await subnetIdentityHash(snapshot);
    // captured_at on the wire, observed_at in the history table. Required by
    // the schema, so there is no fallback to reach.
    const observedAt = row.captured_at;
    const base: Row = {
      netuid: row.netuid,
      block_number: row.block_number,
      ...snapshot,
      identity_hash: hash,
    };
    rows.push({ ...base, captured_at: observedAt });
    historyRows.push({ ...base, observed_at: observedAt });
  }

  const neon = await mirrorFamilyToNeon(env, ctx, SUBNET_IDENTITY_NEON_LANE, {
    rows,
    historyRows,
  });

  // AUTHORITATIVE: Neon is the only store, so its failure is the request's.
  const failed = failedTables(neon);
  if (!neon.attempted || (failed && failed.length > 0)) {
    console.error("data-api subnet-identity-sync Neon write failed:", failed);
    await captureDataApiError(
      new Error(
        failed && failed.length > 0
          ? `neon write failed: ${failed.join(", ")}`
          : "neon write not attempted",
      ),
      "subnet-identity-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    subnet_identity_written: rows.length,
    history_appended: historyRows.length,
    stores: ["neon"],
    neon: neon.results,
  });
}

// --- POST /api/v1/internal/subnet-ownership-sync (#10836) -----------------
//
// THE LAST LANE THAT WROTE POSTGRES FROM INSIDE THE CONTAINER, and the reason
// this route exists at all. The poller cannot use Hyperdrive: it is a plain
// Linux process, not a Worker isolate, and the pooled connection string is
// only reachable from a Worker. Eight of the eleven lanes already POST here
// and let this Worker -- which holds the HYPERDRIVE binding -- do the write;
// `subnet-ownership` kept a raw DATABASE_URL from the self-hosted box, which
// meant a Neon credential in a container image AND every write bypassing the
// pool that exists to protect Neon's compute.
//
// THE DIFF MOVES FROM RUST INTO THE CONSTRAINT. The producer used to SELECT
// the whole card (`fetch_current_owners`), compare each resolved owner
// (`owner_changed`), and INSERT into the history only on a change. That
// read-then-write cannot come along: two passes overlapping would both read
// the old card and both append. So the route posts every row to both tables
// unconditionally and 0026's unique index on (netuid, owner_hotkey,
// owner_coldkey) decides what is new -- the same move subnet_identity_history
// made with its content hash.
//
// AND THE PRUNE COMES WITH IT. The producer ended each pass with `DELETE FROM
// subnet_ownership WHERE netuid <> ALL($1)`, so a deregistered subnet leaves
// the card. Dropping it would have left dead netuids in a latest-only table
// forever, so it is `plan.prune` here instead -- after the upsert, never
// before, and refused outright on an empty key set (measured: `<> ALL('{}')`
// would delete all 128 rows).
const SUBNET_OWNERSHIP_SYNC_TOKEN_HEADER = "x-subnet-ownership-sync-token";
// ~129 rows of four small scalars. Two orders of magnitude of headroom.
const SUBNET_OWNERSHIP_SYNC_MAX_BODY_BYTES = 500_000;
const SUBNET_OWNERSHIP_SYNC_MAX_ROWS = 2_000;
const SUBNET_OWNERSHIP_SYNC_MAX_NETUID = 65_535;
// The same 128-byte ceiling nominator-positions-sync puts on its SS58 keys.
const SUBNET_OWNERSHIP_SYNC_MAX_KEY_BYTES = 128;

const SUBNET_OWNERSHIP_SYNC_ROW_SCHEMA = subnetOwnershipSyncRowSchema({
  columns: SUBNET_OWNERSHIP_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxNetuid: SUBNET_OWNERSHIP_SYNC_MAX_NETUID,
  maxKeyBytes: SUBNET_OWNERSHIP_SYNC_MAX_KEY_BYTES,
});

async function handleSubnetOwnershipSync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  if (!env.SUBNET_OWNERSHIP_SYNC_SECRET) {
    return writeJson(
      { error: "subnet-ownership sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided =
    request.headers.get(SUBNET_OWNERSHIP_SYNC_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.SUBNET_OWNERSHIP_SYNC_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${SUBNET_OWNERSHIP_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > SUBNET_OWNERSHIP_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${SUBNET_OWNERSHIP_SYNC_MAX_BODY_BYTES} bytes` },
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
          "body must be a JSON array of subnet-ownership rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > SUBNET_OWNERSHIP_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SUBNET_OWNERSHIP_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  const check = validateSyncRows(
    incoming,
    SUBNET_OWNERSHIP_SYNC_ROW_SCHEMA,
    "subnet-ownership",
  );
  if (!check.ok) {
    return writeJson({ error: check.error }, 400);
  }

  const rows = incoming as Row[];
  // A netuid twice in one request is refused HERE rather than left to
  // Postgres. The card upsert would raise "ON CONFLICT DO UPDATE command
  // cannot affect row a second time" and fail the whole pass with a 502 whose
  // text names no netuid -- and this producer's stdout is unreachable, which
  // is the same reason these routes validate shapes at all.
  const netuids = rows.map((row) => row.netuid as number);
  const duplicate = netuids.find((id, i) => netuids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    return writeJson(
      { error: `netuid ${duplicate} appears more than once in this request` },
      400,
    );
  }

  const neon = await mirrorFamilyToNeon(
    env,
    ctx,
    SUBNET_OWNERSHIP_NEON_LANE,
    // The card and the history take the SAME columns (0024 names the
    // timestamp `captured_at` in both), so one row set feeds both. The unique
    // index is what makes the history append-on-change rather than
    // append-every-pass.
    { rows, historyRows: rows, pruneKeys: netuids },
  );

  // AUTHORITATIVE: Neon is the only store, so its failure is the request's.
  // The prune counts -- rows landing while deregistered subnets survive is not
  // a partial success, it is a card that serves owners for subnets that no
  // longer exist.
  const failed = failedTables(neon);
  if (!neon.attempted || failed.length > 0) {
    console.error("data-api subnet-ownership-sync Neon write failed:", failed);
    await captureDataApiError(
      new Error(
        failed.length > 0
          ? `neon write failed: ${failed.join(", ")}`
          : "neon write not attempted",
      ),
      "subnet-ownership-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    subnet_ownership_written: rows.length,
    stores: ["neon"],
    neon: neon.results,
  });
}

// --- POST /api/v1/internal/validator-nominator-counts-sync (#2549) --------
//
// RESTORED ON D1 (#9146). Retired by #9193 when the Postgres table it wrote
// was destroyed with the box; this is the same route against
// tests/fixtures/sqlite-schema/0011_validator_nominator_counts.sql instead.
//
// The write path into validator_nominator_counts -- simpler than
// account-identity-sync above: latest-only, no history table (a nominator
// count is a live gauge, not a fact worth diffing over time yet). Populated by
// its own low-frequency job
// (metagraphed-infra src/bin/poller/jobs/validator_nominators.rs, 24h),
// decoupled from the fast neurons sync -- see that job's and the migration's
// own header comments for why a full SubtensorModule::Alpha scan can't share
// the neurons snapshot's cadence.
//
// THE PRODUCER CHUNKS; THIS ROUTE DOES NOT REASSEMBLE. One scan is ~112,550
// rows, over the per-request cap below, so a scan arrives as several
// independent requests. That is why there is no prune here and no batch-wide
// bookkeeping: each request is a self-contained upsert, and correctness comes
// from buildUpsert's captured_at guard rather than from requests arriving in
// order or at all. A dropped chunk costs those hotkeys one cycle of freshness,
// never a wrong value.
const VALIDATOR_NOMINATOR_COUNTS_SYNC_TOKEN_HEADER =
  "x-validator-nominator-counts-sync-token";

// 50k rows x 3 narrow columns is ~4 MB, putting a full ~113k-row scan at 3
// requests. Body bound first, row bound second -- neither alone is sufficient,
// the same pairing nominator-positions-sync above spells out.
const VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_BODY_BYTES = 8_000_000;
const VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_ROWS = 50_000;
// Same 128-byte ceiling nominator-positions-sync puts on its SS58 keys, for
// the same reason: an address is 48 characters, and the slack is so a future
// address format does not silently fail the whole batch.
const VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_KEY_BYTES = 128;

/**
 * Bounds-check one incoming row against
 * VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS.
 *
 * `nominator_count` is required to be a non-negative integer rather than
 * coerced into one, because the read side (nominatorCountsByHotkey) already
 * discards anything that isn't -- a value this route accepted but every reader
 * silently drops is worse than a 400 the producer can actually see.
 */
const NOMINATOR_COUNT_SYNC_ROW_SCHEMA = nominatorCountSyncRowSchema({
  columns: VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxKeyBytes: VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_KEY_BYTES,
});

/** Project a validated row onto the writer's exact column list and order. */
function coerceNominatorCountSyncRow(row: Row) {
  const out: Row = {};
  for (const col of VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS)
    out[col] = row[col];
  return out;
}

async function handleValidatorNominatorCountsSync(
  request: Request,
  env: DataApiEnv,
  ctx?: ExecutionContext,
) {
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
  // Both envelopes accepted, matching handleNeuronsSync's own tolerance -- the
  // producer sends a bare array, but {rows:[...]} is what every other sync
  // route here speaks and a mismatch is not worth a failed cycle.
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      {
        error:
          "body must be a JSON array of nominator count rows (or {rows:[...]})",
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
  const nominatorCountCheck = validateSyncRows(
    incoming,
    NOMINATOR_COUNT_SYNC_ROW_SCHEMA,
    "nominator count",
  );
  if (!nominatorCountCheck.ok) {
    return writeJson({ error: nominatorCountCheck.error }, 400);
  }

  const rows = incoming.map(coerceNominatorCountSyncRow);

  // THE PASS DECLARATION (metagraphed-infra#346). This lane had none, which is
  // why a short load here was indistinguishable from a validator genuinely
  // losing delegators: a count cannot prove completeness, and only the producer
  // knows how big its scan was. Optional, because a producer that has not been
  // updated must keep working -- and inventing a total would mark an unproven
  // load complete, which is the lie the tally exists to prevent.
  const countsDeclared = declaredPassTotal(
    parsed,
    VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_ROWS * 100,
  );
  if (countsDeclared.error) {
    return writeJson({ error: countsDeclared.error }, 400);
  }
  const countsTally = passTallyFromRows(rows, countsDeclared.total, Date.now());
  if (countsTally.error) {
    return writeJson({ error: countsTally.error }, 400);
  }
  const pass = countsTally.pass ?? null;

  // Enqueue or write, never both -- see handleHotkeyAlphaSync's own note.
  if (syncLaneUsesQueue(env, "validator-nominator-counts")) {
    try {
      await enqueueSyncBatch(env.SYNC_BATCHES!, {
        lane: "validator-nominator-counts",
        capturedAt: pass?.capturedAt ?? (rows[0]!.captured_at as number),
        ...(pass ? { passTotal: pass.expectedRows } : {}),
        rows,
      });
    } catch (err) {
      console.error("data-api validator-nominator-counts enqueue failed:", err);
      await captureDataApiError(err, "vnc-sync-queue", env);
      return writeJson({ error: "enqueue failed" }, 502);
    }
    return writeJson({
      ok: true,
      nominator_counts_written: rows.length,
      stores: ["queue"],
      pass_total: pass?.expectedRows ?? null,
    });
  }

  // NO D1 WRITE, and no store binding requirement: validator_nominator_counts and
  // its pass ledger are Neon's outright (#10116). What used to be a
  // write-then-mirror pair is now one write, below.
  // ONE OF THIS LANE'S TWO WRITERS. The sync-batches queue consumer is the
  // other and mirrors too -- #9728 was a single unmirrored writer leaving a
  // table short while the row count looked nearly right.
  const neon = await mirrorLedgerToNeon(
    env,
    ctx,
    "validator-nominator-counts",
    rows,
    {},
    // The tally follows the rows into whichever store holds them (#10056).
    pass,
  );

  // Neon IS the store, so a pass that did not reach it did not happen.
  if (!neon.result?.ok) {
    const reason = neon.result?.reason ?? "neon write not attempted";
    console.error(
      "data-api validator-nominator-counts-sync Neon write failed:",
      reason,
    );
    await captureDataApiError(
      new Error(reason),
      "validator-nominator-counts-sync-neon",
      env,
    );
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    nominator_counts_written: rows.length,
    stores: ["neon"],
    // Echoed so a producer can see its declaration was understood rather than
    // silently dropped -- the failure mode a purely optional field invites.
    pass_total: pass?.expectedRows ?? null,
  });
}

// --- POST /api/v1/internal/nominator-positions-sync (#5233, revived #9273) --
//
// The per-coldkey position ledger: one row per (coldkey, hotkey, netuid) with
// that account's dimensionless share of the hotkey's alpha-pool shares on that
// subnet, from the poller's SubtensorModule::Alpha full scan. Root (netuid 0)
// is not covered -- Alpha carries no root data at all.
//
// RETIRED with the box (#9193) and REVIVED against D1 here, because nothing
// replaced it: the lakehouse kept the frozen 153,611-row export and the route
// over it has served a stamp that cannot advance ever since, answering
// `positions: 0, total_stake_alpha: 0` for anyone who began delegating after
// the export. Same request/{rows:[...]} shape, same token gate, and the same
// D1-is-required posture as handleSubnetHyperparamsSync above.
//
// A FULL SCAN DOES NOT FIT ONE REQUEST. 153,611 rows is far past any single
// body, so the poster chunks it -- and the prune below is therefore per-coldkey
// rather than a batch-wide sweep (see
// src/nominator-positions-d1-write.ts's header). The poster's contract is that
// an account's positions all land in the same request; one split across two
// requests would have its first half pruned by its second.
const NOMINATOR_POSITIONS_SYNC_TOKEN_HEADER =
  "x-nominator-positions-sync-token";
// 25k rows x ~5 short columns sits well inside the Worker request ceiling and
// puts a full ~154k-row scan at ~7 requests. Body bound first, row bound
// second -- neither alone is sufficient (a few enormous SS58-shaped strings
// pass the row bound; 25k tiny rows pass the byte bound).
const NOMINATOR_POSITIONS_SYNC_MAX_BODY_BYTES = 8_000_000;
const NOMINATOR_POSITIONS_SYNC_MAX_ROWS = 25_000;
const NOMINATOR_POSITIONS_SYNC_MAX_NETUID = 65_535;
// An SS58 address is 48 characters; the ceiling is generous rather than exact
// so a future address format does not silently fail the whole batch.
const NOMINATOR_POSITIONS_SYNC_MAX_KEY_BYTES = 128;

/**
 * Bounds-check one incoming row against NOMINATOR_POSITION_INSERT_COLUMNS.
 *
 * share_fraction is a FRACTION, so it is range-checked, not merely
 * finite-checked: it multiplies a hotkey's whole stake at serve time
 * (buildAccountPositions), so a value of 12 would publish twelve times that
 * hotkey's stake as this account's position. That is the one field here whose
 * garbage would read as a plausible number rather than as an error.
 */
const NOMINATOR_POSITION_SYNC_ROW_SCHEMA = nominatorPositionSyncRowSchema({
  columns: NOMINATOR_POSITION_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxKeyBytes: NOMINATOR_POSITIONS_SYNC_MAX_KEY_BYTES,
  maxNetuid: NOMINATOR_POSITIONS_SYNC_MAX_NETUID,
});

/** Project a validated row onto the writer's exact column list and order. */
function coerceNominatorPositionSyncRow(row: Row) {
  const out: Row = {};
  for (const col of NOMINATOR_POSITION_INSERT_COLUMNS) out[col] = row[col];
  return out;
}

async function handleNominatorPositionsSync(
  request: Request,
  env: DataApiEnv,
  ctx?: ExecutionContext,
) {
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
  const nominatorPositionCheck = validateSyncRows(
    incoming,
    NOMINATOR_POSITION_SYNC_ROW_SCHEMA,
    "nominator-position",
  );
  if (!nominatorPositionCheck.ok) {
    return writeJson({ error: nominatorPositionCheck.error }, 400);
  }

  const rows = incoming.map(coerceNominatorPositionSyncRow);
  const cutoffs = coldkeyMaxCapturedAt(rows);

  // THE PASS DECLARATION (metagraphed-infra#346), and this is the lane where
  // its absence mattered most. `nominator_positions` feeds
  // /accounts/{ss58}/positions, /subnets/{netuid}/holders, /chain/holders, the
  // positions basis of /validators/{hotkey}/nominators, and `delegated_tao` on
  // the top-holders leaderboard. Those already DECLINE while `hotkey_alpha`
  // has no complete pass, because a partial POOL ledger underprices a holder.
  // A partial POSITION ledger silently DROPS them, which is the same failure
  // in a worse direction, and nothing measured it.
  const positionsDeclared = declaredPassTotal(
    parsed,
    NOMINATOR_POSITIONS_SYNC_MAX_ROWS * 100,
  );
  if (positionsDeclared.error) {
    return writeJson({ error: positionsDeclared.error }, 400);
  }
  const positionsTally = passTallyFromRows(
    rows,
    positionsDeclared.total,
    Date.now(),
  );
  if (positionsTally.error) {
    return writeJson({ error: positionsTally.error }, 400);
  }
  const pass = positionsTally.pass ?? null;

  // Enqueue or write, never both -- see handleHotkeyAlphaSync's own note.
  //
  // `key_complete` is not ceremony. The write below PRUNES: it deletes rows
  // for a `coldkey` older than the newest captured_at just seen for that key. Applied to a chunk missing some of those
  // rows, that deletes rows the chunk never carried -- and no retry undoes a
  // delete. The producer's `pack_coldkey_chunks` guarantees a per-coldkey group
  // is never split, with a test a flat slice would fail; asserting it here
  // turns a cross-repo assumption into something the consumer can refuse.
  //
  // Note the guarantee is ALREADY load-bearing on the HTTP path -- `cutoffs`
  // above is computed from one POSTed chunk, not the whole pass. The queue
  // changes the transport, not the contract.
  if (syncLaneUsesQueue(env, "nominator-positions")) {
    try {
      // key_complete is no longer asserted here -- packSyncBatchMessages
      // groups by this lane's prune key and never splits one across messages,
      // so it sets the flag on each message it emits BECAUSE it made the claim
      // true. Asserting it at the call site and slicing blindly downstream is
      // how a claim outlives the property it describes.
      await enqueueSyncBatch(env.SYNC_BATCHES!, {
        lane: "nominator-positions",
        capturedAt: pass?.capturedAt ?? (rows[0]!.captured_at as number),
        ...(pass ? { passTotal: pass.expectedRows } : {}),
        rows,
      });
    } catch (err) {
      console.error("data-api nominator-positions enqueue failed:", err);
      await captureDataApiError(err, "nominator-positions-sync-queue", env);
      return writeJson({ error: "enqueue failed" }, 502);
    }
    return writeJson({
      ok: true,
      nominator_positions_written: rows.length,
      stores: ["queue"],
      pass_total: pass?.expectedRows ?? null,
    });
  }

  // NO D1 WRITE, and no store binding requirement: nominator_positions and its
  // pass ledger are Neon's outright (#10111). The queue consumer below is this
  // lane's other entry point and it does not write D1 either.
  const neon = await mirrorNominatorPositionsToNeon(env, ctx, {
    rows,
    coldkeyMaxCapturedAt: cutoffs,
    pass,
  });

  // Once Neon is the store, a pass that did not reach it did not happen.
  {
    // The PRUNE and the PASS count as well as the write. Rows landing while
    // stale coldkeys survive is not a partial success -- top-holders would
    // serve both. And nominator_positions_passes has no other writer once this
    // inverts, so a tally that did not land leaves a completeness ledger
    // nobody can tell is empty.
    const failed = [neon.write, neon.prune, neon.coverage, neon.pass].filter(
      (r) => r && !r.ok,
    );
    if (!neon.attempted || failed.length > 0) {
      const reason =
        failed
          .map((r) => r?.reason)
          .filter(Boolean)
          .join("; ") || "neon write not attempted while Neon owns the tables";
      console.error(
        "data-api nominator-positions-sync Neon write failed:",
        reason,
      );
      await captureDataApiError(
        new Error(reason),
        "nominator-positions-sync-neon",
        env,
      );
      return writeJson({ error: "neon write failed" }, 502);
    }
  }

  return writeJson({
    ok: true,
    nominator_positions_written: rows.length,
    coldkeys_pruned: cutoffs.size,
    stores: ["neon"],
    // Echoed so a producer can see its declaration was understood rather than
    // silently dropped -- the failure mode a purely optional field invites.
    pass_total: pass?.expectedRows ?? null,
  });
}

// --- POST /api/v1/internal/self-stake-sync (#10845) -----------------------
//
// THE SAME TABLE AS nominator-positions-sync, AND NOT THE SAME ROUTE, which is
// the whole point (metagraphed-infra#473).
//
// `self-stake` fills a gap `validator-nominators`' Alpha scan cannot: an owner's
// own stake on their own hotkey frequently has NO `SubtensorModule::Alpha`
// entry -- `{bits: 0}` on ~91% of one hotkey's registered pairs -- even when
// the runtime-computed stake is large. Those rows belong in
// `nominator_positions`, because a validator's own stake is often its largest
// position and eight surfaces read that table.
//
// BUT IT CANNOT REUSE THE OTHER ROUTE, and reusing it would delete data. That
// route PRUNES per `coldkey`: every row for a posted `coldkey` older than the
// newest captured_at that same `coldkey` carries in the request. And
// `validator-nominators` may do
// that because `pack_coldkey_chunks` never splits a `coldkey`. `self-stake`
// cannot: its rows are absent from the Alpha scan BY CONSTRUCTION, so they are
// always "older than this pass" from the other lane's point of view, and any
// owner who also nominates elsewhere would lose their self-stake row within a
// day of it being written.
//
// So each producer owns a PRUNE DOMAIN -- 0027's `source` column -- and this
// route writes `source='self-stake'` and prunes only that. `source` is stamped
// by the writer, never accepted from the wire: a producer that could name its
// own source could claim the other lane's domain and delete its rows.
//
// NO PASS TALLY, unlike its sibling. `nominator_positions_passes` records
// completeness of a full keyspace scan; self-stake is a targeted read over
// registered (hotkey, netuid) pairs and declaring it complete would corrupt
// the ledger the other lane's consumers gate on.
const SELF_STAKE_SYNC_TOKEN_HEADER = "x-self-stake-sync-token";
// One runtime API call per (hotkey, netuid) pair makes this lane WEEKLY and
// far smaller than the Alpha scan, but the ceilings match its sibling's so a
// producer cannot be surprised by a different limit on the same table.
const SELF_STAKE_SYNC_MAX_BODY_BYTES = 8_000_000;
const SELF_STAKE_SYNC_MAX_ROWS = 25_000;

async function handleSelfStakeSync(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  if (!env.SELF_STAKE_SYNC_SECRET) {
    return writeJson(
      { error: "self-stake sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(SELF_STAKE_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.SELF_STAKE_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${SELF_STAKE_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > SELF_STAKE_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${SELF_STAKE_SYNC_MAX_BODY_BYTES} bytes` },
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
          "body must be a JSON array of self-stake position rows (or {rows:[...]})",
      },
      400,
    );
  }
  if (incoming.length > SELF_STAKE_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${SELF_STAKE_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  // The SAME row schema as its sibling, deliberately: same table, same columns,
  // same bounds. A second schema would be a second place for the shape to drift
  // from the writer's own INSERT column list.
  const check = validateSyncRows(
    incoming,
    NOMINATOR_POSITION_SYNC_ROW_SCHEMA,
    "self-stake position",
  );
  if (!check.ok) {
    return writeJson({ error: check.error }, 400);
  }

  const rows = incoming.map(coerceNominatorPositionSyncRow);
  const cutoffs = coldkeyMaxCapturedAt(rows);

  const neon = await mirrorNominatorPositionsToNeon(env, ctx, {
    rows,
    coldkeyMaxCapturedAt: cutoffs,
    source: POSITION_SOURCE_SELF_STAKE,
    lane: SELF_STAKE_NEON_LANE,
  });

  // AUTHORITATIVE, and the prune counts as much as the write: rows landing
  // while this lane's own superseded rows survive is a ledger that
  // double-counts an owner's stake.
  {
    const failed = [neon.write, neon.prune].filter((r) => r && !r.ok);
    if (!neon.attempted || failed.length > 0) {
      const reason =
        failed
          .map((r) => r?.reason)
          .filter(Boolean)
          .join("; ") || "neon write not attempted while Neon owns the table";
      console.error("data-api self-stake-sync Neon write failed:", reason);
      await captureDataApiError(new Error(reason), "self-stake-sync-neon", env);
      return writeJson({ error: "neon write failed" }, 502);
    }
  }

  return writeJson({
    ok: true,
    self_stake_positions_written: rows.length,
    coldkeys_pruned: cutoffs.size,
    stores: ["neon"],
  });
}

// --- POST /api/v1/internal/account-balances-sync (#6742, revived #9478) ----
//
// Chain-wide free/reserved balance snapshot, one row per account with a
// nonzero balance --
// metagraphed-infra's services/indexer-rs/src/bin/poller/jobs/account_balances.rs's
// own header comment on why this reads System::Account directly rather than
// reconstructing balance from transfer/fee/stake events (a direct state read
// can't drift; event-replay can, one missed mutation path at a time).
//
// RETIRED with the box (#9193) and REVIVED against D1 here, because this lane
// came out of the decommission worse off than the two 0011/0012 revived: they
// each had a frozen lakehouse export to fall back on, and `account_balances`
// had no D1 table at all. /api/v1/accounts/top-holders has answered from a
// one-shot materialization taken 2026-08-02 ever since, with a `captured_at`
// that cannot advance -- an account that has moved TAO since is misreported and
// one first funded since is absent. Same request/{rows:[...]} shape, same token
// gate, and the same D1-is-required posture as handleNominatorPositionsSync
// above.
//
// A FULL PASS DOES NOT FIT ONE REQUEST. 542,618 System::Account entries at the
// producer's own last live measurement puts a pass at ~22 requests against the
// caps below. Unlike nominator-positions, the chunking is a plain flat slice
// and needs no packing rule: rows are keyed on (ss58) alone and this lane never
// prunes, so a row may land in any request in any order.
const ACCOUNT_BALANCES_SYNC_TOKEN_HEADER = "x-account-balances-sync-token";
// Matched to the nominator-positions siblings rather than re-derived: 25k rows
// x 4 short columns sits well inside the Worker request ceiling. Body bound
// first, row bound second -- neither alone is sufficient (a few enormous
// SS58-shaped strings pass the row bound; 25k tiny rows pass the byte bound).
const ACCOUNT_BALANCES_SYNC_MAX_BODY_BYTES = 8_000_000;
const ACCOUNT_BALANCES_SYNC_MAX_ROWS = 25_000;
// An SS58 address is 48 characters; the ceiling is generous rather than exact
// so a future address format does not silently fail the whole batch.
const ACCOUNT_BALANCES_SYNC_MAX_KEY_BYTES = 128;
// A ceiling on the producer's declared `pass_total` (#9511). Every account that
// has ever held a balance measured 364,266 on 2026-08-05 against 554,136
// System::Account entries, so ten million is roughly 27x headroom -- generous
// enough to survive a decade of growth, tight enough that a garbage value
// cannot declare a pass that never completes and pins the reader on an older
// one forever.
const ACCOUNT_BALANCES_SYNC_MAX_PASS_TOTAL = 10_000_000;

/**
 * Bounds-check one incoming row against ACCOUNT_BALANCE_INSERT_COLUMNS.
 *
 * Both balances are required to be finite and NON-NEGATIVE rather than merely
 * numeric. A negative balance is not a thing System::Account can hold, and the
 * one consumer of this column (src/top-holders.ts's `numberOrZero`) would
 * silently clamp it to 0 -- so a value this route accepted and every reader
 * quietly rewrote is worse than a 400 the producer can actually see.
 * `Number.isFinite` also rejects the JSON-hostile cases outright: a NaN or
 * Infinity arriving as null would otherwise bind as NULL against a NOT NULL
 * column and fail the whole 25,000-row batch at the database instead of here.
 */
const ACCOUNT_BALANCE_SYNC_ROW_SCHEMA = accountBalanceSyncRowSchema({
  columns: ACCOUNT_BALANCE_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxKeyBytes: ACCOUNT_BALANCES_SYNC_MAX_KEY_BYTES,
});

/** Project a validated row onto the writer's exact column list and order. */
function coerceAccountBalanceSyncRow(row: Row) {
  const out: Row = {};
  for (const col of ACCOUNT_BALANCE_INSERT_COLUMNS) out[col] = row[col];
  return out;
}

/**
 * Parse and validate a producer's declared pass size (metagraphed-infra#346).
 *
 * ONE IMPLEMENTATION for the lanes that gained a tally, rather than the
 * account-balances route's inline copy repeated twice more. `undefined` means
 * "not declared", which is legal — a producer may post without declaring, and
 * INVENTING a total would mark an unproven load complete, which is the precise
 * lie the tally exists to prevent.
 *
 * Returns an error string rather than a Response so the caller keeps its own
 * status codes and message shape.
 */
function declaredPassTotal(
  parsed: unknown,
  maxTotal: number,
): { total?: number; error?: string } {
  const total = Array.isArray(parsed)
    ? undefined
    : (parsed as { pass_total?: unknown } | null)?.pass_total;
  if (total === undefined) return {};
  if (
    !Number.isInteger(total) ||
    (total as number) <= 0 ||
    (total as number) > maxTotal
  ) {
    return {
      error: `pass_total must be a positive integer no greater than ${maxTotal}`,
    };
  }
  return { total: total as number };
}

/**
 * Turn a declaration plus this request's rows into a tally, or refuse.
 *
 * REQUIRES EXACTLY ONE captured_at, which is what makes the tally meaningful:
 * two stamps in one request would credit rows to whichever one this code
 * happened to pick, and a reader would trust a total that was never delivered
 * under that key. Same rule handleAccountBalancesSync applies to its own lane.
 */
function passTallyFromRows(
  rows: Row[],
  declaredTotal: number | undefined,
  nowMs: number,
): { pass?: PassTallyInput; error?: string } {
  if (declaredTotal === undefined) return {};
  const stamps = new Set<number>(rows.map((row) => row.captured_at as number));
  if (stamps.size !== 1) {
    return {
      error:
        "a request declaring pass_total must carry exactly one captured_at",
    };
  }
  if (declaredTotal < rows.length) {
    return {
      error: "pass_total cannot be smaller than this request's row count",
    };
  }
  return {
    pass: {
      capturedAt: [...stamps][0]!,
      expectedRows: declaredTotal,
      receivedRows: rows.length,
      nowMs,
    },
  };
}

async function handleAccountBalancesSync(
  request: Request,
  env: DataApiEnv,
  // Kept in the signature, unused: the router passes it positionally to every
  // handler, and the Neon mirror this route used to run moved to the queue
  // consumer with the write (metagraphed-infra#353).
  _ctx?: ExecutionContext,
) {
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
  // OPTIONAL, and absent on the bare-array envelope: how many rows the whole
  // pass will deliver (#9511). The producer knows this before its first request
  // because it buffers the walk, and it is the only way a reader can tell a
  // complete ledger from a partial one -- 147,000 well-formed rows look exactly
  // like 542,618 well-formed rows, only fewer.
  const declaredTotal = Array.isArray(parsed) ? undefined : parsed?.pass_total;
  if (
    declaredTotal !== undefined &&
    (!Number.isInteger(declaredTotal) ||
      declaredTotal <= 0 ||
      declaredTotal > ACCOUNT_BALANCES_SYNC_MAX_PASS_TOTAL)
  ) {
    return writeJson(
      {
        error: `pass_total must be a positive integer no greater than ${ACCOUNT_BALANCES_SYNC_MAX_PASS_TOTAL}`,
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
  const accountBalanceCheck = validateSyncRows(
    incoming,
    ACCOUNT_BALANCE_SYNC_ROW_SCHEMA,
    "account-balance",
  );
  if (!accountBalanceCheck.ok) {
    return writeJson({ error: accountBalanceCheck.error }, 400);
  }

  const rows = incoming.map(coerceAccountBalanceSyncRow);

  // A declared pass is keyed on its own captured_at, which the producer stamps
  // once at scan start and repeats across every chunk. Requiring exactly one
  // here is what makes the tally meaningful: two stamps in a request would
  // credit rows to whichever one this code happened to pick, and the reader
  // would trust a total that was never delivered under that key.
  let pass: PassTallyInput | null = null;
  if (declaredTotal !== undefined) {
    const stamps = new Set<number>(
      rows.map((row: Row) => row.captured_at as number),
    );
    if (stamps.size !== 1) {
      return writeJson(
        {
          error:
            "a request declaring pass_total must carry exactly one captured_at",
        },
        400,
      );
    }
    if (declaredTotal < rows.length) {
      return writeJson(
        { error: "pass_total cannot be smaller than this request's row count" },
        400,
      );
    }
    pass = {
      capturedAt: [...stamps][0]!,
      expectedRows: declaredTotal as number,
      receivedRows: rows.length,
      nowMs: Date.now(),
    };
  }

  // ENQUEUE-ONLY (metagraphed-infra#353). The inline D1 write that used to
  // stand behind a `syncLaneUsesQueue` check is gone, and this route no longer
  // touches D1 at all -- the sync-batches consumer owns the write, the pass
  // tally and the Neon mirror.
  //
  // THE LANE THAT CAUSED THE INCIDENT, so the bar for deleting its rollback was
  // evidence rather than confidence. `D1_ERROR: D1 DB is overloaded` aborted a
  // pass at 147,000 of 364,000 rows and took `wallet-auth` and `tao-usd-index`
  // down with it on the shared database. Since the 2026-08-06 cutover it has
  // run SIX consecutive complete passes on the queue -- 364,644 / 364,654 /
  // 364,668 / 364,747 / 364,819 / 364,817 rows, each `completed_at` stamped --
  // which is what #353 asked for before the `else` branch could go.
  //
  // WHAT ROLLBACK MEANS NOW. Dropping this lane from SYNC_QUEUE_LANES no longer
  // restores an inline write; it makes the route enqueue to a queue nothing is
  // routed to, which fails loudly rather than quietly writing. Reverting this
  // commit is the rollback.
  //
  // The declared pass rides along unchanged. A queue knows a message was
  // delivered; it does not know whether a producer's whole SCAN arrived, and
  // that second fact is the one that caught the truncation.
  if (!env.SYNC_BATCHES) {
    return writeJson({ error: "sync-batches queue unavailable" }, 503);
  }
  try {
    await enqueueSyncBatch(env.SYNC_BATCHES, {
      lane: "account-balances",
      capturedAt: pass?.capturedAt ?? (rows[0]!.captured_at as number),
      ...(pass ? { passTotal: pass.expectedRows } : {}),
      rows,
    });
  } catch (err) {
    console.error("data-api account-balances enqueue failed:", err);
    await captureDataApiError(err, "account-balances-sync-queue", env);
    // 502, not 200: the producer must retry a chunk that was never accepted,
    // and reporting success here would lose it silently.
    return writeJson({ error: "enqueue failed" }, 502);
  }
  return writeJson({
    ok: true,
    account_balances_written: rows.length,
    stores: ["queue"],
    // Echoed so a producer can see its declaration was understood rather than
    // silently dropped -- the failure mode a purely optional field invites.
    pass_total: pass?.expectedRows ?? null,
  });
}

// --- POST /api/v1/internal/hotkey-alpha-sync (#9502) ----------------------
//
// The (hotkey, netuid) alpha-pool ledger `delegated_tao` needs. A staker's
// `nominator_positions.share_fraction` is a dimensionless slice of a pool, and
// nothing in either store held the pool total to value it against:
// `neurons.stake_tao` covers only hotkeys registered on that exact subnet,
// which is 512 of the 13,724 (hotkey, netuid) pairs the positions name, so
// only 22.8% of position rows and 27.7% of staking accounts priced at all
// (#9502).
//
// Recomputing the leaderboard from that join is not a staleness problem that
// a label fixes: it puts an account the frozen snapshot ranks at 81,185 TAO at
// 0 and drops another out of the payload entirely. A ranking cannot carry a
// per-row degraded flag the way the per-account route does, which is why the
// column waited for this table rather than shipping wrong.
//
// The producer reads `SubtensorModule::TotalHotkeyAlpha(hotkey, netuid)`
// directly, the same posture as account-balances above: a direct state read
// cannot drift, event-replay can.
//
// A FULL PASS DOES NOT FIT ONE REQUEST -- the sibling Alpha scan is ~762,577
// entries -- so this takes the same {rows:[...]} shape, the same token gate,
// and the same flat chunking as account-balances: rows are keyed on
// (hotkey, netuid) and this lane never prunes, so a row may land in any
// request in any order.
const HOTKEY_ALPHA_SYNC_TOKEN_HEADER = "x-hotkey-alpha-sync-token";
const HOTKEY_ALPHA_SYNC_MAX_BODY_BYTES = 8_000_000;
const HOTKEY_ALPHA_SYNC_MAX_ROWS = 25_000;
const HOTKEY_ALPHA_SYNC_MAX_KEY_BYTES = 128;
// A ceiling on the producer's declared `pass_total` (#9502), the twin of
// ACCOUNT_BALANCES_SYNC_MAX_PASS_TOTAL. `TotalHotkeyAlpha` is keyed
// (hotkey, netuid) against the sibling `Alpha` scan's
// (coldkey, hotkey, netuid), so its true size is a fraction of that scan's
// 762,577 -- ten million is ample headroom while still small enough that a
// garbage value cannot declare a pass that never completes and pin the reader
// on an older one forever.
const HOTKEY_ALPHA_SYNC_MAX_PASS_TOTAL = 10_000_000;

/**
 * Bounds-check one incoming row against HOTKEY_ALPHA_INSERT_COLUMNS.
 *
 * `total_alpha` must be finite and NON-NEGATIVE: a negative alpha pool is not
 * a thing the chain can hold, and a NaN or Infinity arriving as null would
 * bind as NULL against a NOT NULL column and fail the whole batch at the
 * database rather than here, where the producer can see it. A genuine 0 IS
 * accepted -- an emptied pool is a real measurement, and the producer's own
 * skip rule is what keeps those out, not this validator.
 *
 * `netuid` is bounded to a non-negative integer for the same reason the
 * balance columns are bounded: the composite primary key means a junk netuid
 * silently creates a parallel row rather than updating the intended one.
 */
const HOTKEY_ALPHA_SYNC_ROW_SCHEMA = hotkeyAlphaSyncRowSchema({
  columns: HOTKEY_ALPHA_INSERT_COLUMNS,
  minCapturedAtMs: SYNC_MIN_CAPTURED_AT_MS,
  maxKeyBytes: HOTKEY_ALPHA_SYNC_MAX_KEY_BYTES,
});

/** Project a validated row onto the writer's exact column list and order. */
function coerceHotkeyAlphaSyncRow(row: Row) {
  const out: Row = {};
  for (const col of HOTKEY_ALPHA_INSERT_COLUMNS) out[col] = row[col];
  return out;
}

async function handleHotkeyAlphaSync(
  request: Request,
  env: DataApiEnv,
  ctx?: ExecutionContext,
) {
  if (!env.HOTKEY_ALPHA_SYNC_SECRET) {
    return writeJson(
      { error: "hotkey-alpha sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(HOTKEY_ALPHA_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.HOTKEY_ALPHA_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${HOTKEY_ALPHA_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > HOTKEY_ALPHA_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${HOTKEY_ALPHA_SYNC_MAX_BODY_BYTES} bytes` },
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
          "body must be a JSON array of hotkey-alpha rows (or {rows:[...]})",
      },
      400,
    );
  }
  // OPTIONAL, and absent on the bare-array envelope: how many rows the whole
  // pass will deliver (#9502). The producer knows this before its first request
  // because it buffers the walk, and it is the only way a reader can tell a
  // complete pool ledger from a partial one -- absence in `hotkey_alpha` is
  // ambiguous by design (a genuine zero pool is skipped, not written), so no
  // count over the table can recover completeness. See
  // tests/fixtures/sqlite-schema/0021_hotkey_alpha_passes.sql.
  const declaredTotal = Array.isArray(parsed) ? undefined : parsed?.pass_total;
  if (
    declaredTotal !== undefined &&
    (!Number.isInteger(declaredTotal) ||
      declaredTotal <= 0 ||
      declaredTotal > HOTKEY_ALPHA_SYNC_MAX_PASS_TOTAL)
  ) {
    return writeJson(
      {
        error: `pass_total must be a positive integer no greater than ${HOTKEY_ALPHA_SYNC_MAX_PASS_TOTAL}`,
      },
      400,
    );
  }
  if (incoming.length > HOTKEY_ALPHA_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${HOTKEY_ALPHA_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  const hotkeyAlphaCheck = validateSyncRows(
    incoming,
    HOTKEY_ALPHA_SYNC_ROW_SCHEMA,
    "hotkey-alpha",
  );
  if (!hotkeyAlphaCheck.ok) {
    return writeJson({ error: hotkeyAlphaCheck.error }, 400);
  }

  const rows = incoming.map(coerceHotkeyAlphaSyncRow);

  // A declared pass is keyed on its own captured_at, which the producer stamps
  // once at scan start and repeats across every chunk. Requiring exactly one
  // here is what makes the tally meaningful: two stamps in a request would
  // credit rows to whichever one this code happened to pick, and the reader
  // would trust a total that was never delivered under that key.
  let pass: PassTallyInput | null = null;
  if (declaredTotal !== undefined) {
    const stamps = new Set<number>(
      rows.map((row: Row) => row.captured_at as number),
    );
    if (stamps.size !== 1) {
      return writeJson(
        {
          error:
            "a request declaring pass_total must carry exactly one captured_at",
        },
        400,
      );
    }
    if (declaredTotal < rows.length) {
      return writeJson(
        { error: "pass_total cannot be smaller than this request's row count" },
        400,
      );
    }
    pass = {
      capturedAt: [...stamps][0]!,
      expectedRows: declaredTotal as number,
      receivedRows: rows.length,
      nowMs: Date.now(),
    };
  }

  // ENQUEUE OR WRITE, NEVER BOTH (metagraphed-infra#348). The producer is a
  // Rust container that cannot hold queue credentials, so the switch lives
  // here rather than in the producer: the route either hands the chunk to the
  // queue or writes it directly, and `syncLaneUsesQueue` is the single place
  // that decides. Dual-writing would double exactly the D1 load that caused the
  // saturation this migration exists to fix, and duplicate arrivals would
  // corrupt the completeness tally -- `received_rows` against a declared
  // `pass_total` is what caught a ledger publishing 147,000 of 364,000 rows
  // while looking fresh.
  //
  // WHY THIS IS THE USEFUL HALF OF THE MIGRATION. The problem was never the
  // HTTP hop; it was the D1 WRITE landing unthrottled. Moving that write onto
  // the consumer puts it behind `max_concurrency`, which is the backpressure
  // the producer's one-second sleep was standing in for.
  if (syncLaneUsesQueue(env, "hotkey-alpha")) {
    try {
      await enqueueSyncBatch(env.SYNC_BATCHES!, {
        lane: "hotkey-alpha",
        capturedAt: rows[0]!.captured_at as number,
        ...(pass ? { passTotal: pass.expectedRows } : {}),
        rows,
      });
    } catch (err) {
      console.error("data-api hotkey-alpha-sync enqueue failed:", err);
      await captureDataApiError(err, "hotkey-alpha-sync-queue", env);
      // 502, not 200: the producer must retry a chunk that was never accepted,
      // and reporting success here would lose it silently.
      return writeJson({ error: "enqueue failed" }, 502);
    }
    return writeJson({
      ok: true,
      hotkey_alpha_written: rows.length,
      stores: ["queue"],
      pass_total: pass?.expectedRows ?? null,
    });
  }

  // Checked HERE, after validation, not at the top: a malformed body is a 400
  // whether or not a store happens to be bound (handleAccountBalancesSync's
  // own 400-before-503 reasoning).
  if (!neonOwnsLedger(env, "hotkey-alpha")) {
    return writeJson({ error: "no store bound for this route" }, 503);
  }

  // ONE OF THIS LANE'S TWO WRITERS. The sync-batches queue consumer is the
  // other -- #9728 was a single unmirrored writer leaving a table short while
  // the row count looked nearly right. THE PASS RIDES ALONG: it did not, so
  // the store's tally filled while hotkey_alpha_passes stayed empty in Neon.
  const neon = await mirrorLedgerToNeon(
    env,
    ctx,
    "hotkey-alpha",
    rows,
    {},
    pass,
  );

  // Neon is the store, so a pass that did not reach it did not happen.
  if (!neon.result?.ok) {
    const reason = neon.result?.reason ?? "neon write not attempted";
    console.error("data-api hotkey-alpha-sync Neon write failed:", reason);
    await captureDataApiError(new Error(reason), "hotkey-alpha-sync-neon", env);
    return writeJson({ error: "neon write failed" }, 502);
  }

  return writeJson({
    ok: true,
    hotkey_alpha_written: rows.length,
    stores: ["neon"],
    // Echoed so a producer can see its declaration was understood rather than
    // silently dropped -- the failure mode a purely optional field invites.
    pass_total: pass?.expectedRows ?? null,
  });
}

// --- POST /api/v1/internal/poller-lane-health-sync -------------------------
//
// The poller reporting its OWN job outcomes (metagraphed-infra#343 phase 1).
// See src/poller-lane-health.ts for why: `hotkey_alpha` failed 95 seconds into
// every run for ten hours and nothing anywhere said so, because container
// stderr has no queryable destination and every staleness watchdog keys on a
// MAX(captured_at) that a never-successful lane does not have.
//
// SMALL BODY, NO PASS ACCOUNTING. This is one row per tick, not a bulk load, so
// it needs none of the chunking or completeness machinery the data lanes carry.
const POLLER_LANE_HEALTH_TOKEN_HEADER = "x-poller-lane-health-sync-token";
const POLLER_LANE_HEALTH_MAX_BODY_BYTES = 64_000;
const POLLER_LANE_HEALTH_MAX_ROWS = 50;

async function handlePollerLaneHealthSync(request: Request, env: DataApiEnv) {
  if (!env.POLLER_LANE_HEALTH_SYNC_SECRET) {
    return writeJson(
      {
        error: "poller lane-health sync is not provisioned on this deployment",
      },
      503,
    );
  }
  const provided = request.headers.get(POLLER_LANE_HEALTH_TOKEN_HEADER) || "";
  if (
    !provided ||
    !timingSafeEqual(provided, env.POLLER_LANE_HEALTH_SYNC_SECRET)
  ) {
    return writeJson(
      { error: `provide a valid ${POLLER_LANE_HEALTH_TOKEN_HEADER} header` },
      401,
    );
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > POLLER_LANE_HEALTH_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${POLLER_LANE_HEALTH_MAX_BODY_BYTES} bytes` },
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
      { error: "body must be a JSON array of outcomes (or {rows:[...]})" },
      400,
    );
  }
  if (incoming.length > POLLER_LANE_HEALTH_MAX_ROWS) {
    return writeJson(
      { error: `at most ${POLLER_LANE_HEALTH_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!incoming.length || !incoming.every(validPollerJobOutcome)) {
    return writeJson({ error: "rows must match the outcome shape" }, 400);
  }
  // Whichever store holds lane_health (#10127). Every one of this repo's 27
  // watchdogs already writes its verdicts through laneHealthStore; this route
  // was the one writer still reaching for the store binding by name, so the
  // poller's job outcomes were the only verdicts that would have stopped
  // landing when D1 went away -- and recordLaneVerdict swallows failures, so
  // they would have stopped silently.
  const laneDb = laneHealthStore(env);
  if (!laneDb) {
    return writeJson({ error: "no lane_health store bound" }, 503);
  }

  // recordLaneVerdict swallows its own failures by design -- an alarm whose
  // recording can break the alarm is worse than the bug. So the count of rows
  // that actually landed is reported rather than assumed.
  let written = 0;
  for (const row of incoming.map(coercePollerJobOutcome)) {
    if (await recordLaneVerdict(laneDb, row)) written += 1;
  }
  return writeJson({
    ok: true,
    lane_health_written: written,
    // "d1" left this ack with the flag (#10051): the answer was already a
    // dead vocabulary reporting a deleted store.
    stores: ["neon"],
  });
}

function json(data: unknown, status: number = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=10",
    },
  });
}

// postgres.js returns BIGINT columns as strings; the store-backed routes return them
// as numbers. block_number and observed_at are both < 2^53, so Number(...) is
// lossless — coerce them per event row for a consistent numeric API shape.
function numberOrNull(v: unknown) {
  if (v == null) return null;
  // Blank Hyperdrive/Postgres cells coerce via Number("") → 0; trim rejects "" /
  // whitespace-only so absent indices/timestamps stay null (mirrors toBlockNumber
  // in src/account-events.ts and src/blocks.ts).
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- /api/v1/alerts/triggers (#4984 Part 1) ---------------------------------
//
// Public CRUD for user-defined chain alert triggers, reached only via
// workers/api.ts's DATA_API service binding (no public routes of its own,
// same invariant as every route in this file). Creation is gated by a
// shared anti-abuse token (mirrors src/webhooks.ts's own subscription-
// creation gate, ALERT_TRIGGER_CREATE_TOKEN_HEADER/env.ALERT_TRIGGER_CREATE_TOKEN
// -- every active trigger costs the #4984 Part 2 evaluator a real per-event
// match check, so unbounded public creation is a workload vector, not just a
// storage one); GET/PATCH/DELETE on one trigger are gated by that trigger's
// OWN owner_token instead (returned once, at creation) -- there is no public
// view, unlike webhook subscriptions, because `destination` can itself be a
// bearer credential (a Discord incoming-webhook URL). All shared, no-I/O
// validation lives in src/alert-triggers.ts; everything here is D1
// plumbing + auth gates.

// --- User-state D1 runner ---------------------------------------------------
//
// The user-state tables (accounts, API keys, usage accounting, alert
// triggers, push subscriptions, TAO/USD index) live on the bounded D1
// database (tests/fixtures/sqlite-schema/0004_user_state.sql), not the chain-data Postgres
// tier -- they are the box's last functional tenants and D1 is exactly their
// lane (small, transactional, user/config state). The runner below is a
// tagged-template shim over the store's prepare/bind/all so the ~40 existing call
// sites keep their postgres.js-era shape: `sql\`SELECT ... ${value}\``
// becomes prepare("SELECT ... ?").bind(value).all() and resolves to the
// result rows.
//
// Bind-value coercion replaces what the postgres.js driver (and its
// sql.json()) used to do implicitly: booleans become 0/1 (the schema's
// INTEGER CHECK columns), undefined becomes NULL, and arrays/plain objects
// are stringified into the TEXT-holding-JSON columns that replaced
// text[]/jsonb. Readers of those JSON columns parse at the consumption site
// via parseJsonColumn below.

/**
 * The WRITE half of parseJsonColumn: a value on its way into a TEXT column that
 * holds JSON.
 *
 * EXPLICIT BECAUSE node-postgres DOES NOT DO THIS FOR ARRAYS. `pg` serializes a
 * JS array as a Postgres ARRAY LITERAL -- `["a","b"]` becomes `{"a","b"}` --
 * which is not JSON, so parseJsonColumn's `JSON.parse` throws and its catch
 * degrades the column to null. For `chain_alert_triggers.table_filter` that is
 * worse than losing the value: triggerMatchesEvent skips the table check when
 * tableFilter is falsy, so a trigger scoped to one table would fire on every
 * table instead.
 *
 * It happened to work while these routes ran on D1, because the deleted
 * createD1Sql stringified array and object binds before binding them. Nothing
 * replaced that when the runner changed, and no route-level test sent a
 * table_filter through create or PATCH, so the gap was invisible. `pg` DOES
 * JSON-stringify plain objects, which is why `condition` survived -- but
 * relying on a driver's object handling for a column we control is the same
 * bet, so both go through here.
 */
function jsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** A TEXT column holding JSON, parsed where the row value is consumed.
 * Null-safe; a non-string value passes through untouched (it is already
 * parsed -- e.g. a PATCH body field merged over the row), and unparseable text
 * degrades to null rather than throwing inside a read path. */
function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The schema's INTEGER-0/1 booleans, back to real booleans for the shared
 * view/validation helpers (src/alert-triggers.ts) whose checks -- `active !==
 * false`, `success === true` -- predate the port and expect JS booleans. */
function rowBool(value: unknown): boolean {
  return value === true || value === 1;
}

/** One chain_alert_triggers row, D1 shape -> the shape every consumer
 * (ownerAlertTriggerView, evaluatorAlertTriggerView,
 * mergeAlertTriggerUpdateBody, validateAlertTriggerInput) already expects:
 * table_filter/condition parsed from their TEXT-JSON columns, active a real
 * boolean. */
// Takes the GENERATED table row. It took `Row`, and an interface has no index
// signature, so every caller reading a real `ChainAlertTriggers` out of the
// store had to be laundered through `Record<string, any>` first (#10782).
function normalizeAlertTriggerRow(row: ChainAlertTriggers): Row;
function normalizeAlertTriggerRow(
  row: ChainAlertTriggers | undefined,
): Row | null;
function normalizeAlertTriggerRow(
  row: ChainAlertTriggers | undefined,
): Row | null {
  if (!row) return null;
  return {
    ...row,
    table_filter: parseJsonColumn(row.table_filter),
    condition: parseJsonColumn(row.condition),
    active: rowBool(row.active),
  };
}

/** One chain_alert_deliveries row: success is INTEGER 0/1 on D1, and
 * deliveryRecordView's `success === true` check needs the boolean. */
function normalizeDeliveryRow(row: ChainAlertDeliveries): Row {
  return { ...row, success: rowBool(row.success) };
}

/**
 * The tables each user-state helper touches, named so the runner choice is a
 * property of the DATA rather than of the helper.
 *
 * `userStateRunner` below requires EVERY table in the group to be listed in
 * NEON_SOLE_STORE_TABLES before it hands out a Postgres runner. That is the
 * same all-or-nothing rule the read gate used to apply per route (deleted in
 * #10051), and for the same reason: one runner serves the whole callback, so a
 * half-listed group would send a statement to a store where its table does not
 * exist. Naming the tables is what makes that impossible to get wrong by
 * accident -- a table added to one of these groups cannot move until someone
 * puts its name in the flag.
 */
/**
 * The three tables one neurons snapshot writes.
 *
 * All or nothing, the same rule every other group in this file follows: the
 * pass writes them from ONE derivation, so a half-listed group would leave
 * neuron_daily in the store while its parent moved and the two would never agree
 * again.
 */
export const NEURONS_SNAPSHOT_TABLES = [
  "neurons",
  "neuron_daily",
  "account_position_daily",
] as const;

/**
 * Whether Neon is the ONLY store behind a neurons snapshot on this deployment.
 *
 * When true the store write is skipped outright and the Neon write becomes
 * authoritative -- its failure is the request's failure, where during
 * dual-write it was only a lane verdict. That inversion is the point: while D1
 * still served reads, a Neon failure had to cost a mirror and not the pass;
 * once Neon is the store, a pass that did not reach it did not happen.
 */
export function neonOwnsNeuronsSnapshot(env: DataApiEnv): boolean {
  // the ownership term collapsed with the flag (#10051): Neon is the only
  // store, so durability is the binding question alone.
  return Boolean(env.HYPERDRIVE?.connectionString);
}

/**
 * Whether Neon is the ONLY store behind one hyperparams/identity family.
 *
 * BOTH tables of the family, never one. The sync derives its history rows by
 * reading the CURRENT latest hash out of the history table and diffing -- so a
 * family split across stores would diff against the wrong store's history and
 * append revisions that already exist, or miss ones that do not. The pair moves
 * together or not at all.
 */
/** Whether Neon solely owns the nominator-positions pair. Shared by BOTH of
 * this lane's writers -- #9728 was a single unmirrored writer leaving the table
 * 92 rows short while the count looked nearly right. The pass ledger moves with
 * the rows: a tally in one store describing rows in the other answers a
 * question about nothing. */
/**
 * Whether Neon solely owns a ledger lane's table AND its pass ledger.
 *
 * BOTH, because a completeness tally in one store describing rows in the other
 * answers a question about nothing (#10056). Lanes with no pass table pass a
 * single-element list and behave as before.
 *
 * This existed as a FLAG before it existed as a code path: #10098 named
 * validator_nominator_counts sole-store while both its writers still wrote D1,
 * so the flag claimed a cutover that had not happened. Inert rather than
 * dangerous -- D1 kept its rows and the mirror kept Neon's -- but a flag that
 * lies about which store owns a table is how the next change gets it wrong.
 */
export function neonOwnsLedger(env: DataApiEnv, lane: string): boolean {
  const tables = [LEDGER_MIRROR_PLANS[lane]?.table, PASS_TABLES[lane]].filter(
    (t): t is string => Boolean(t),
  );
  if (!tables.length) return false;
  // the ownership term collapsed with the flag (#10051): Neon is the only
  // store, so durability is the binding question alone.
  return Boolean(env.HYPERDRIVE?.connectionString);
}

export function neonOwnsNominatorPositions(env: DataApiEnv): boolean {
  // the ownership term collapsed with the flag (#10051): Neon is the only
  // store, so durability is the binding question alone.
  return Boolean(env.HYPERDRIVE?.connectionString);
}

/** Whether Neon solely owns every chain_detail table. Shared by BOTH of this
 * lane's writers -- #9728 is the precedent for why covering one of two is worse
 * than covering neither: the row count looks nearly right. */
export function neonOwnsChainDetail(env: DataApiEnv): boolean {
  // the ownership term collapsed with the flag (#10051): Neon is the only
  // store, so durability is the binding question alone.
  return Boolean(env.HYPERDRIVE?.connectionString);
}

export function neonOwnsFamily(env: DataApiEnv, lane: string): boolean {
  const plan = FAMILY_MIRROR_PLANS[lane];
  if (!plan) return false;
  // the ownership term collapsed with the flag (#10051): Neon is the only
  // store, so durability is the binding question alone.
  return Boolean(env.HYPERDRIVE?.connectionString);
}

export const ALERT_TRIGGER_TABLES = [
  "chain_alert_triggers",
  "chain_alert_deliveries",
  // withAlertTriggersSql is ALSO the runner for the five web-push handlers
  // (#8385), which read and write this table and nothing in the alert pair.
  // Named here because the group is the unit that moves: leaving it out would
  // let the two alert tables be listed, send the push handlers to Postgres
  // with them, and have those handlers query a table the flag never claimed.
  "watch_push_subscriptions",
] as const;

export const ACCOUNT_STATE_TABLES = [
  "rpc_accounts",
  "github_accounts",
  "api_keys",
  "api_key_blocks",
  "api_key_usage_daily",
  "api_quota_daily",
  "api_usage_rollup",
] as const;

/**
 * The runner for a user-state group: Postgres once Neon solely owns every
 * table in it, D1 until then.
 *
 * `PgSql` and `PgSql` are structurally identical -- a tagged template plus
 * `unsafe(text, values)`, both resolving to `Record<string, unknown>[]` -- so
 * this returns one type and the ~17 callbacks below are untouched by the move.
 * That is the whole reason the user-state tier can change stores without
 * changing a single statement: every one of its writes is already ordinary SQL
 * (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`), which means the same
 * text on either side.
 *
 * Returns null when neither store is available, which the callers turn into
 * the 503 they already returned for a missing store binding.
 */
export function userStateRunner(
  env: DataApiEnv,
  ctx: ExecutionContext,
  // Kept for call-site clarity about which tables ride the runner; the
  // per-table ownership question collapsed with the flag (#10051).
  _tables: readonly string[],
): PgSql | null {
  // the ownership term collapsed with the flag (#10051).
  if (env.HYPERDRIVE?.connectionString) {
    return createPgSql(env.HYPERDRIVE, ctx);
  }
  return null;
}

async function withAlertTriggersSql(
  env: DataApiEnv,
  ctx: ExecutionContext,
  fn: (sql: PgSql) => Promise<Response>,
) {
  const sql = userStateRunner(env, ctx, ALERT_TRIGGER_TABLES);
  if (!sql) {
    // userStateRunner is store-neutral (#10106): nothing back from it means
    // NEITHER store is bound, so naming D1 here pointed at the wrong half of
    // a two-store answer.
    return writeJson({ error: "no user-state store bound" }, 503);
  }
  try {
    return await fn(sql);
  } catch (err) {
    console.error("data-api alert-triggers write failed:", err);
    await captureDataApiError(err, "alert-triggers", env);
    return writeJson({ error: "write failed" }, 502);
  }
}

async function readAlertTriggerBody(request: Request) {
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
function requireAlertTriggerOwner(
  request: Request,
  storedOwnerToken: string | null,
) {
  const provided = request.headers.get(ALERT_TRIGGER_OWNER_TOKEN_HEADER) || "";
  if (isValidAlertOwnerToken(provided, storedOwnerToken)) return null;
  return writeJson({ error: "no such trigger" }, 404);
}

// Policy for the create rate-limiter's 429 header family. Mirrors the
// ALERT_TRIGGER_CREATE_RATE_LIMITER binding in wrangler.data.jsonc (10/60s) so
// the advertised headers match the enforced limit. (#5475)
const ALERT_TRIGGER_CREATE_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

// #8374: a create request authorizes via EITHER the shared operator secret
// (ownerSs58: null -- the pre-#8374 path, entirely unchanged) OR a
// wallet-verified watch token (ownerSs58: the token's ss58, enforced against
// WATCH_TRIGGERS_MAX_PER_ADDRESS below). Exactly one header, never both --
// presenting both is far more likely a caller bug than a real "try either"
// intent, so it's rejected rather than silently preferring one.
async function resolveAlertTriggerCreateAuth(
  request: Request,
  env: DataApiEnv,
): Promise<
  { ok: true; ownerSs58: string | null } | { ok: false; response: Response }
> {
  const operatorToken =
    request.headers.get(ALERT_TRIGGER_CREATE_TOKEN_HEADER) || "";
  const watchToken = request.headers.get(WATCH_TRIGGER_TOKEN_HEADER) || "";

  if (operatorToken && watchToken) {
    return {
      ok: false,
      response: writeJson(
        {
          error: `provide at most one of ${ALERT_TRIGGER_CREATE_TOKEN_HEADER} or ${WATCH_TRIGGER_TOKEN_HEADER}`,
        },
        400,
      ),
    };
  }

  if (watchToken) {
    const tokenSecret = env.WATCH_TRIGGER_TOKEN_SECRET;
    if (!tokenSecret) {
      return {
        ok: false,
        response: writeJson(
          {
            error:
              "wallet-verified alert issuance is not provisioned on this deployment",
          },
          503,
        ),
      };
    }
    const verified = await verifyTriggerToken(tokenSecret, watchToken);
    if (!verified) {
      return {
        ok: false,
        response: writeJson(
          { error: `invalid or expired ${WATCH_TRIGGER_TOKEN_HEADER}` },
          401,
        ),
      };
    }
    return { ok: true, ownerSs58: verified.ss58 };
  }

  const configured = env.ALERT_TRIGGER_CREATE_TOKEN;
  if (!configured) {
    return {
      ok: false,
      response: writeJson(
        {
          error: "alert trigger creation is not provisioned on this deployment",
        },
        503,
      ),
    };
  }
  if (!operatorToken || !timingSafeEqual(operatorToken, configured)) {
    return {
      ok: false,
      response: writeJson(
        {
          error: `provide a valid ${ALERT_TRIGGER_CREATE_TOKEN_HEADER} or ${WATCH_TRIGGER_TOKEN_HEADER} header`,
        },
        401,
      ),
    };
  }
  return { ok: true, ownerSs58: null };
}

async function handleAlertTriggerCreate(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const auth = await resolveAlertTriggerCreateAuth(request, env);
  if (!auth.ok) return auth.response;
  const ownerSs58 = auth.ownerSs58;

  // Found by adversarial review: ALERT_TRIGGER_CREATE_TOKEN is a SHARED
  // anti-abuse secret, not a per-user credential -- anyone holding it could
  // otherwise script unbounded trigger creation, and every row becomes a
  // permanent per-event cost in AlerterHub.matchingTriggers()'s O(active
  // triggers) scan. Skipped when unbound (local dev/CI), matching every
  // other optional rate-limiter binding's convention in this codebase.
  // Applies regardless of which auth path above succeeded -- the IP-level
  // throttle is a defense-in-depth layer independent of the per-address cap
  // the wallet-verified flow additionally gets below.
  if (env.ALERT_TRIGGER_CREATE_RATE_LIMITER?.limit) {
    const { success } = await env.ALERT_TRIGGER_CREATE_RATE_LIMITER.limit({
      key: resolveClientIp(request),
    });
    if (!success) {
      // Carry the standard rate-limit header family so callers (and the api.ts
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

  return withAlertTriggersSql(env, ctx, async (sql) => {
    if (ownerSs58) {
      const counted = await sql<{ count: string | number }>`
        SELECT COUNT(*) AS count FROM chain_alert_triggers
        WHERE owner_ss58 = ${ownerSs58} AND active`;
      if (Number(counted[0]?.count ?? 0) >= WATCH_TRIGGERS_MAX_PER_ADDRESS) {
        return writeJson(
          {
            error: `this address already has ${WATCH_TRIGGERS_MAX_PER_ADDRESS} active triggers -- the maximum per verified address. Delete one to create another.`,
          },
          403,
        );
      }
    }
    // Short local name (`ownerToken`, not `secret`) keeps the public-safety
    // scanner's hardcoded-credential heuristic from false-positiving here,
    // matching src/webhooks.ts's createWebhookSubscription convention.
    const ownerToken = generateAlertTriggerOwnerToken();
    const now = Date.now();
    const v = validated.value;
    const [row] = await sql<ChainAlertTriggers>`
      INSERT INTO chain_alert_triggers
        (owner_token, name, table_filter, netuid, event_kind, account, min_amount_tao, condition, channel, destination, active, owner_ss58, created_at, updated_at)
      VALUES (
        ${ownerToken}, ${v.name}, ${jsonColumn(v.tableFilter)}, ${v.netuid}, ${v.eventKind},
        ${v.account}, ${v.minAmountTao}, ${jsonColumn(v.condition ?? null)},
        ${v.channel}, ${v.destination}, ${v.active}, ${ownerSs58}, ${now}, ${now}
      )
      RETURNING *`;
    return writeJson(
      {
        ...ownerAlertTriggerView(normalizeAlertTriggerRow(row)),
        // Returned ONCE at creation; store it to read/update/delete this
        // trigger. It is never echoed back on any later GET.
        owner_token: ownerToken,
      },
      201,
    );
  });
}

async function handleAlertTriggerGet(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const [row] =
      await sql<ChainAlertTriggers>`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!row) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(request, row.owner_token);
    if (authError) return authError;
    return writeJson(ownerAlertTriggerView(normalizeAlertTriggerRow(row)));
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
function omitNullValues(obj: Row) {
  const out: Row = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

// Shared by both PATCH routes (owner-token, watch-token) -- see
// handleAlertTriggerUpdate's own comment for why the existing row is merged
// onto the incoming body rather than validating the raw PATCH body directly
// (a naive full-replace silently NULLs out/widens every condition field the
// caller didn't resend). `active` is included in the base like every other
// column -- it is never null (NOT NULL DEFAULT true), so omitNullValues
// never strips it, meaning an update that doesn't mention `active` always
// preserves the row's current pause/resume state.
function mergeAlertTriggerUpdateBody(existing: Row, body: Row): Row {
  return {
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
      active: existing.active,
    }),
    ...omitNullValues(body),
  };
}

async function runAlertTriggerUpdate(sql: PgSql, id: string, merged: Row) {
  const validated = validateAlertTriggerInput(merged);
  if (!validated.ok) {
    return writeJson({ error: validated.error }, 400);
  }
  const v = validated.value;
  const now = Date.now();
  const [row] = await sql<ChainAlertTriggers>`
    UPDATE chain_alert_triggers SET
      name = ${v.name},
      table_filter = ${jsonColumn(v.tableFilter)},
      netuid = ${v.netuid},
      event_kind = ${v.eventKind},
      account = ${v.account},
      min_amount_tao = ${v.minAmountTao},
      condition = ${jsonColumn(v.condition ?? null)},
      channel = ${v.channel},
      destination = ${v.destination},
      active = ${v.active},
      updated_at = ${now}
    WHERE id = ${id}
    RETURNING *`;
  return writeJson(ownerAlertTriggerView(normalizeAlertTriggerRow(row)));
}

async function handleAlertTriggerUpdate(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const { body, error } = await readAlertTriggerBody(request);
  if (error) return error;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return writeJson({ error: "Request body must be a JSON object." }, 400);
  }
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const [existing] =
      await sql<ChainAlertTriggers>`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(request, existing.owner_token);
    if (authError) return authError;
    const merged = mergeAlertTriggerUpdateBody(
      normalizeAlertTriggerRow(existing),
      body,
    );
    return runAlertTriggerUpdate(sql, id, merged);
  });
}

async function handleAlertTriggerDelete(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const [existing] = await sql<
      Pick<ChainAlertTriggers, "owner_token">
    >`SELECT owner_token FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(request, existing.owner_token);
    if (authError) return authError;
    await sql<never>`DELETE FROM chain_alert_triggers WHERE id = ${id}`;
    return writeJson({ id, deleted: true });
  });
}

// Internal-only: the #4984 Part 2 evaluator's cache-refresh scan. A
// DIFFERENT secret from the create/owner tokens above -- it grants a wholly
// different capability (read every trigger regardless of owner).
async function handleAlertTriggersActiveList(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const rows =
      await sql<ChainAlertTriggers>`SELECT * FROM chain_alert_triggers WHERE active`;
    return writeJson({
      triggers: rows.map((row) =>
        evaluatorAlertTriggerView(normalizeAlertTriggerRow(row)),
      ),
    });
  });
}

// Internal-only: the #5022 evaluator write-back. AlerterHub.evaluate()
// (workers/alerter-hub.ts) POSTs the FULL matched-trigger id list for a
// chain event here -- every id whose conditions were satisfied, regardless
// of whether the burst rate-limiter actually let it deliver -- so
// chain_alert_triggers.match_count/last_matched_at reflect "this trigger's
// conditions were satisfied", independent of delivery. Gated the SAME way
// as the active-list route above: a DIFFERENT capability from the
// create/owner tokens (write access to every trigger's own bookkeeping
// columns, not just its own row), so it reuses that same
// ALERT_TRIGGERS_INTERNAL_TOKEN secret rather than minting a third one.
async function handleAlertTriggersMatchedWriteback(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const now = Date.now();
    // Plain scalar positional binds via sql.unsafe -- the statement text is
    // built dynamically (one `?` per already-isValidAlertTriggerId-validated
    // id), which a tagged template can't express. The first bind is the
    // shared `now` timestamp.
    //
    // CHUNKED, because the Workers store binding caps a statement at 100 bound
    // parameters. AlerterHub.evaluate() posts every matched trigger id in one
    // call and the active-trigger load has no LIMIT, so a broad table_filter
    // across ~100 active triggers bound 101 values, D1 threw "too many SQL
    // variables", and the 502 lost the ENTIRE batch's match_count and
    // last_matched_at into a console.error. 90 leaves the same margin under
    // 100 that src/neurons-d1-write.ts uses for this exact limit; the `now`
    // bind is what makes the ceiling 90 ids rather than 91.
    const CHUNK = 90;
    let updatedCount = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(", ");
      const updated = await sql.unsafe<Pick<ChainAlertTriggers, "id">>(
        `UPDATE chain_alert_triggers
         SET match_count = match_count + 1,
             last_matched_at = ?
         WHERE id IN (${placeholders})
         RETURNING id`,
        [now, ...slice],
      );
      updatedCount += updated.length;
    }
    return writeJson({ updated: updatedCount });
  });
}

// How many chain_alert_deliveries rows handleAlertTriggersDeliveryLogWrite
// keeps per trigger -- matches #8375's own "last 20 deliveries" deliverable,
// so the Alert Center never needs a separate retention/pagination story.
const ALERT_TRIGGER_DELIVERY_LOG_RETAIN = 20;

// Internal-only: the #8375 evaluator write-back for the Alert Center's
// delivery history. AlerterHub.evaluate() (workers/alerter-hub.ts) POSTs one
// record per delivery ATTEMPT (not per match -- a rate-limited match never
// reaches here, matching handleAlertTriggersMatchedWriteback's own
// "matched" vs "delivered" distinction). Gated the SAME way as the
// active-list/matched-writeback/dereg-risk routes above (same
// ALERT_TRIGGERS_INTERNAL_TOKEN secret).
async function handleAlertTriggersDeliveryLogWrite(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.ALERT_TRIGGERS_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      {
        error:
          "the alert-triggers delivery-log write-back is not provisioned on this deployment",
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
  const records = Array.isArray(body?.records)
    ? body.records.filter(
        (r: unknown) =>
          r &&
          typeof r === "object" &&
          isValidAlertTriggerId((r as Row).trigger_id) &&
          Number.isInteger((r as Row).delivered_at),
      )
    : [];
  if (records.length === 0) {
    return writeJson(
      { error: "records must be a non-empty array of delivery outcomes" },
      400,
    );
  }
  return withAlertTriggersSql(env, ctx, async (sql) => {
    // Distinct trigger ids touched by this batch -- pruned to the most
    // recent ALERT_TRIGGER_DELIVERY_LOG_RETAIN rows each, after every insert
    // in the batch lands, so a single request never leaves a trigger's
    // history over the retention bound mid-batch.
    const triggerIds = new Set<string>();
    for (const r of records as Row[]) {
      const responseSnippet =
        typeof r.response_snippet === "string"
          ? r.response_snippet.slice(
              0,
              ALERT_DELIVERY_RESPONSE_SNIPPET_MAX_BYTES,
            )
          : null;
      await sql<never>`
        INSERT INTO chain_alert_deliveries
          (trigger_id, delivered_at, success, status_code, retry_count, response_snippet)
        VALUES (
          ${String(r.trigger_id)}, ${r.delivered_at}, ${r.success === true},
          ${Number.isInteger(r.status_code) ? r.status_code : null}, 0,
          ${responseSnippet}
        )`;
      triggerIds.add(String(r.trigger_id));
    }
    for (const triggerId of triggerIds) {
      await sql<never>`
        DELETE FROM chain_alert_deliveries
        WHERE trigger_id = ${triggerId}
          AND id NOT IN (
            SELECT id FROM chain_alert_deliveries
            WHERE trigger_id = ${triggerId}
            ORDER BY delivered_at DESC
            LIMIT ${ALERT_TRIGGER_DELIVERY_LOG_RETAIN}
          )`;
    }
    return writeJson({ inserted: records.length });
  });
}

async function handleAlertTriggersRoute(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  url: URL,
) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "alerts", "triggers", <id?>]
  const id = segments[4];
  // A trailing sub-path is NOT part of any route here, and dropping it silently
  // let /alerts/triggers/{id}/deliveries reach the DELETE branch and destroy the
  // trigger -- a plausible URL to try, since the sibling watch surface really
  // does expose /watch/triggers/{id}/deliveries. `!sub` is the same guard
  // handleWatchTriggersRoute already applies for exactly this reason; anything
  // with a fifth segment falls through to the 405 below.
  const sub = segments[5];
  if (!id && !sub && request.method === "POST") {
    return handleAlertTriggerCreate(request, env, ctx);
  }
  if (id && !sub && request.method === "GET") {
    return handleAlertTriggerGet(request, env, ctx, id);
  }
  if (id && !sub && request.method === "PATCH") {
    return handleAlertTriggerUpdate(request, env, ctx, id);
  }
  if (id && !sub && request.method === "DELETE") {
    return handleAlertTriggerDelete(request, env, ctx, id);
  }
  return writeJson(
    {
      error:
        "Use POST /api/v1/alerts/triggers, or GET/PATCH/DELETE /api/v1/alerts/triggers/{id}.",
    },
    405,
  );
}

// #8375: Alert Center -- the address-scoped counterpart to
// handleAlertTriggersRoute above. Every route here authorizes via a
// wallet-verified WATCH_TRIGGER_TOKEN_HEADER (src/wallet-auth.ts's
// createTriggerToken/verifyTriggerToken, the SAME token
// resolveAlertTriggerCreateAuth already accepts for trigger creation) rather
// than a trigger's own owner_token -- a verified address manages every
// trigger IT created, without needing to have squirreled away each one's
// individual owner_token. A request never sees another address' triggers:
// every lookup below filters/checks by `owner_ss58 = <verified ss58>`, and a
// mismatch returns the SAME 404 a nonexistent id gets (requireAlertTriggerOwner's
// own anti-oracle posture, applied here too).
async function requireVerifiedWatchSs58(
  request: Request,
  env: DataApiEnv,
): Promise<{ ok: true; ss58: string } | { ok: false; response: Response }> {
  const tokenSecret = env.WATCH_TRIGGER_TOKEN_SECRET;
  if (!tokenSecret) {
    return {
      ok: false,
      response: writeJson(
        {
          error:
            "wallet-verified alert issuance is not provisioned on this deployment",
        },
        503,
      ),
    };
  }
  const token = request.headers.get(WATCH_TRIGGER_TOKEN_HEADER) || "";
  const verified = await verifyTriggerToken(tokenSecret, token);
  if (!verified) {
    return {
      ok: false,
      response: writeJson(
        { error: `invalid or expired ${WATCH_TRIGGER_TOKEN_HEADER}` },
        401,
      ),
    };
  }
  return { ok: true, ss58: verified.ss58 };
}

async function handleWatchTriggersList(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const rows = await sql<ChainAlertTriggers>`
      SELECT * FROM chain_alert_triggers
      WHERE owner_ss58 = ${auth.ss58}
      ORDER BY created_at DESC`;
    return writeJson({
      triggers: rows.map((row) =>
        ownerAlertTriggerView(normalizeAlertTriggerRow(row)),
      ),
    });
  });
}

async function handleWatchTriggerUpdate(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  const { body, error } = await readAlertTriggerBody(request);
  if (error) return error;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return writeJson({ error: "Request body must be a JSON object." }, 400);
  }
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const [existing] =
      await sql<ChainAlertTriggers>`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing || existing.owner_ss58 !== auth.ss58) {
      return writeJson({ error: "no such trigger" }, 404);
    }
    const merged = mergeAlertTriggerUpdateBody(
      normalizeAlertTriggerRow(existing),
      body,
    );
    return runAlertTriggerUpdate(sql, id, merged);
  });
}

async function handleWatchTriggerDelete(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const [existing] = await sql<{
      owner_ss58: ChainAlertTriggers["owner_ss58"];
    }>`SELECT owner_ss58 FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing || existing.owner_ss58 !== auth.ss58) {
      return writeJson({ error: "no such trigger" }, 404);
    }
    await sql<never>`DELETE FROM chain_alert_triggers WHERE id = ${id}`;
    return writeJson({ id, deleted: true });
  });
}

async function handleWatchTriggerDeliveries(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const [existing] = await sql<{
      owner_ss58: ChainAlertTriggers["owner_ss58"];
    }>`SELECT owner_ss58 FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing || existing.owner_ss58 !== auth.ss58) {
      return writeJson({ error: "no such trigger" }, 404);
    }
    const rows = await sql<ChainAlertDeliveries>`
      SELECT * FROM chain_alert_deliveries
      WHERE trigger_id = ${id}
      ORDER BY delivered_at DESC
      LIMIT ${ALERT_TRIGGER_DELIVERY_LOG_RETAIN}`;
    return writeJson({
      deliveries: rows.map((row) =>
        deliveryRecordView(normalizeDeliveryRow(row)),
      ),
    });
  });
}

async function handleWatchTriggersRoute(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  url: URL,
) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "watch", "triggers", <id?>, <"deliveries"?>]
  const id = segments[4];
  const sub = segments[5];
  if (!id && request.method === "GET") {
    return handleWatchTriggersList(request, env, ctx);
  }
  if (id && sub === "deliveries" && request.method === "GET") {
    return handleWatchTriggerDeliveries(request, env, ctx, id);
  }
  if (id && !sub && request.method === "PATCH") {
    return handleWatchTriggerUpdate(request, env, ctx, id);
  }
  if (id && !sub && request.method === "DELETE") {
    return handleWatchTriggerDelete(request, env, ctx, id);
  }
  return writeJson(
    {
      error:
        "Use GET /api/v1/watch/triggers, PATCH/DELETE /api/v1/watch/triggers/{id}, or GET /api/v1/watch/triggers/{id}/deliveries.",
    },
    405,
  );
}

// --- Web-push device subscriptions (#8385) ---------------------------------
//
// The `webpush` alert channel's delivery targets, bound to the SAME T6
// wallet-verified address the watch triggers use (requireVerifiedWatchSs58
// above) -- so "my devices" is answerable without an accounts system.
//
// Privacy: p256dh/auth are the subscriber's own key material. They are
// accepted on write and used at delivery time, but NEVER returned by the
// read route -- a device list only needs enough metadata for a human to
// recognise which device to revoke.

// #8385 requirement 1's decided cap.
const WATCH_PUSH_MAX_DEVICES_PER_ADDRESS = 3;
// Coarse label only; the raw UA string is neither needed nor stored in full.
const WATCH_PUSH_USER_AGENT_MAX = 120;

/** The device fields safe to hand back to the owner. Deliberately omits
 * p256dh/auth -- see this section's header comment. */
function pushSubscriptionView(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    endpoint: String(row.endpoint ?? ""),
    user_agent: row.user_agent ?? null,
    created_at: row.created_at != null ? Number(row.created_at) : null,
    last_used_at: row.last_used_at != null ? Number(row.last_used_at) : null,
  };
}

async function handleWatchPushSubscriptionsList(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, ctx, async (sql) => {
    const rows = await sql<{
      id: WatchPushSubscriptions["id"];
      endpoint: WatchPushSubscriptions["endpoint"];
      user_agent: WatchPushSubscriptions["user_agent"];
      created_at: WatchPushSubscriptions["created_at"];
      last_used_at: WatchPushSubscriptions["last_used_at"];
    }>`
      SELECT id, endpoint, user_agent, created_at, last_used_at
      FROM watch_push_subscriptions
      WHERE address = ${auth.ss58}
      ORDER BY created_at DESC`;
    return writeJson({
      subscriptions: rows.map(pushSubscriptionView),
      max_devices: WATCH_PUSH_MAX_DEVICES_PER_ADDRESS,
    });
  });
}

async function handleWatchPushSubscriptionCreate(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJsonObjectBody(request);
  if (!body) return writeJson({ error: "body must be a JSON object" }, 400);

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.p256dh === "string" ? body.p256dh : "";
  const authKey = typeof body.auth === "string" ? body.auth : "";
  // Same public-https guard the webhook/webpush destinations use: a
  // VAPID-signed request must never be aimed at a private address.
  if (!isPublicWebhookUrl(endpoint)) {
    return writeJson(
      { error: "endpoint must be a public https:// push-service URL" },
      400,
    );
  }
  if (!p256dh || !authKey) {
    return writeJson({ error: "p256dh and auth are required" }, 400);
  }
  // Shape-check the key material up front so a malformed subscription fails
  // at intake rather than silently at every future delivery.
  if (!isValidPushKeyMaterial(p256dh, authKey)) {
    return writeJson(
      { error: "p256dh or auth is not valid base64url key material" },
      400,
    );
  }

  const userAgent =
    typeof body.user_agent === "string" && body.user_agent.trim()
      ? body.user_agent.trim().slice(0, WATCH_PUSH_USER_AGENT_MAX)
      : null;
  const now = Date.now();

  return withAlertTriggersSql(env, ctx, async (sql) => {
    // Read the OWNER, not just existence. An endpoint is globally unique, so
    // without this check a verified address could POST an endpoint already
    // registered to someone else and the upsert below would silently reassign
    // it: the original owner loses their device, the taker skips their own
    // device cap, and the taker's alert triggers start pushing to a browser
    // that never subscribed to them. Ownership is the thing being enforced
    // here -- existence alone is not enough.
    const existing = await sql<{
      id: WatchPushSubscriptions["id"];
      address: WatchPushSubscriptions["address"];
    }>`
      SELECT id, address FROM watch_push_subscriptions WHERE endpoint = ${endpoint}`;
    const owner = existing[0]?.address as string | undefined;

    if (owner !== undefined && owner !== auth.ss58) {
      return writeJson(
        { error: "that endpoint is already registered to another account" },
        409,
      );
    }

    // Only a genuinely NEW device counts against the cap. Re-subscribing the
    // same browser reissues the same endpoint, so charging it again would
    // make a routine key rotation look like "device limit reached".
    if (existing.length === 0) {
      const count = await sql<{ n: string | number }>`
        SELECT COUNT(*) AS n FROM watch_push_subscriptions
        WHERE address = ${auth.ss58}`;
      const n = Number(count[0]?.n ?? 0);
      if (n >= WATCH_PUSH_MAX_DEVICES_PER_ADDRESS) {
        return writeJson(
          {
            error: `device limit reached (${WATCH_PUSH_MAX_DEVICES_PER_ADDRESS}) — remove a device first`,
          },
          409,
        );
      }
    }

    const rows = await sql<{
      id: WatchPushSubscriptions["id"];
      endpoint: WatchPushSubscriptions["endpoint"];
      user_agent: WatchPushSubscriptions["user_agent"];
      created_at: WatchPushSubscriptions["created_at"];
      last_used_at: WatchPushSubscriptions["last_used_at"];
    }>`
      INSERT INTO watch_push_subscriptions
        (address, endpoint, p256dh, auth, user_agent, created_at)
      VALUES (${auth.ss58}, ${endpoint}, ${p256dh}, ${authKey}, ${userAgent}, ${now})
      ON CONFLICT (endpoint) DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent
      WHERE watch_push_subscriptions.address = EXCLUDED.address
      RETURNING id, endpoint, user_agent, created_at, last_used_at`;
    // Defense in depth: `address` is no longer reassignable at all (dropped
    // from the SET list), and the WHERE means a conflicting row owned by
    // anyone else updates nothing and returns no row. The explicit check
    // above should already have caught that, so reaching here means a race --
    // treat it the same way rather than emitting a 201 with an empty body.
    if (rows.length === 0) {
      return writeJson(
        { error: "that endpoint is already registered to another account" },
        409,
      );
    }
    return writeJson({ subscription: pushSubscriptionView(rows[0]!) }, 201);
  });
}

async function handleWatchPushSubscriptionDelete(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  id: string,
) {
  if (!/^[0-9]{1,19}$/.test(id)) {
    return writeJson({ error: "malformed subscription id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, ctx, async (sql) => {
    // Scoped by address: another address' id returns the same 404 a
    // nonexistent one does (the anti-oracle posture the trigger routes use).
    const rows = await sql<{ id: WatchPushSubscriptions["id"] }>`
      DELETE FROM watch_push_subscriptions
      WHERE id = ${id} AND address = ${auth.ss58}
      RETURNING id`;
    if (rows.length === 0)
      return writeJson({ error: "subscription not found" }, 404);
    return writeJson({ deleted: true, id: String(rows[0]!.id) });
  });
}

// Internal-only (AlerterHub via the DATA_API service binding, same
// ALERT_TRIGGERS_INTERNAL_TOKEN gate the active-trigger list uses): resolve a
// push endpoint to its crypto material at delivery time, and prune a device
// the push service reported as gone (#8385 requirement 4).
//
// NOT public: this is the one place p256dh/auth leave the database, and only
// over the internal binding -- the owner-facing GET deliberately omits them.
async function handleInternalPushSubscription(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  url: URL,
) {
  // Same inline gate the sibling internal routes use (no shared helper
  // exists; matching their shape rather than introducing one here).
  const configured = env.ALERT_TRIGGERS_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "internal push routes are not provisioned" },
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

  if (request.method === "GET") {
    const endpoint = url.searchParams.get("endpoint") || "";
    if (!endpoint) return writeJson({ error: "endpoint is required" }, 400);
    return withAlertTriggersSql(env, ctx, async (sql) => {
      const rows = await sql<{
        endpoint: WatchPushSubscriptions["endpoint"];
        p256dh: WatchPushSubscriptions["p256dh"];
        auth: WatchPushSubscriptions["auth"];
      }>`
        SELECT endpoint, p256dh, auth FROM watch_push_subscriptions
        WHERE endpoint = ${endpoint}`;
      const row = rows[0];
      if (!row) return writeJson({ subscription: null });
      // Best-effort liveness stamp so the device list can show "last used".
      await sql<never>`
        UPDATE watch_push_subscriptions SET last_used_at = ${Date.now()}
        WHERE endpoint = ${endpoint}`;
      return writeJson({
        subscription: {
          endpoint: String(row.endpoint),
          p256dh: String(row.p256dh),
          auth: String(row.auth),
        },
      });
    });
  }

  if (request.method === "DELETE") {
    const body = await readJsonObjectBody(request);
    if (!body) return writeJson({ error: "body must be a JSON object" }, 400);
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) return writeJson({ error: "endpoint is required" }, 400);
    return withAlertTriggersSql(env, ctx, async (sql) => {
      await sql<never>`DELETE FROM watch_push_subscriptions WHERE endpoint = ${endpoint}`;
      // Idempotent: pruning an already-pruned device is a success, not a 404
      // -- the caller is fire-and-forget and must never see a spurious error.
      return writeJson({ pruned: true });
    });
  }

  return writeJson({ error: "Use GET or DELETE." }, 405);
}

async function handleWatchPushSubscriptionsRoute(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  url: URL,
) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "watch", "push-subscriptions", <id?>]
  const id = segments[4];
  if (!id && request.method === "GET") {
    return handleWatchPushSubscriptionsList(request, env, ctx);
  }
  if (!id && request.method === "POST") {
    return handleWatchPushSubscriptionCreate(request, env, ctx);
  }
  if (id && request.method === "DELETE") {
    return handleWatchPushSubscriptionDelete(request, env, ctx, id);
  }
  return writeJson(
    {
      error:
        "Use GET/POST /api/v1/watch/push-subscriptions or DELETE /api/v1/watch/push-subscriptions/{id}.",
    },
    405,
  );
}

// --- Wallet-signature login + self-serve fullnode/freemium API keys
// (originally ADR 0021/#6835, reworked onto Unkey 2026-07-19) --------------
//
// Reached only via workers/api.ts's DATA_API service binding, same as every
// route in this file. Route groups:
//   POST /api/v1/auth/wallet/challenge  { ss58 } -> a signable message
//   POST /api/v1/auth/wallet/verify     { ss58, signature } -> a session
//   POST/GET /api/v1/keys, DELETE /api/v1/keys/{key_id} -> mint/list/revoke
//     THIS account's own mg_... API key, now minted/verified/revoked via
//     Unkey (src/unkey-client.ts) rather than locally generated/hashed --
//     every /api/v1/keys route requires a session (Authorization: Bearer
//     <session_token>, src/wallet-auth.ts). No invite-code gate anymore:
//     any wallet-connected account can self-serve a key immediately, at its
//     account's current tier (rpc_accounts.tier, default 'free'); promoting
//     an account to a higher tier afterward is the internal tier-promotion
//     route below, not a mint-time credential. All crypto/no-I/O logic
//     lives in src/wallet-auth.ts; everything here is Postgres plumbing +
//     the Unkey calls.
//   POST /api/v1/internal/keys/verify   -- internal-only, see
//     handleApiKeyVerify's own header comment.
//   POST /api/v1/internal/accounts/tier -- internal-only, see
//     handleAccountTierPromote's own header comment.
//   POST /api/v1/auth/github/upsert-account -- internal-only (#8820), gated
//     with the same internal-token pair; see handleGithubAccountUpsert's own
//     header comment.

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

async function withAccountsSql<T>(
  env: DataApiEnv,
  ctx: ExecutionContext,
  fn: (sql: PgSql) => Promise<T>,
): Promise<T | Response> {
  const sql = userStateRunner(env, ctx, ACCOUNT_STATE_TABLES);
  if (!sql) {
    // Store-neutral, same as withAlertTriggersSql above.
    return writeJson({ error: "no user-state store bound" }, 503);
  }
  try {
    return await fn(sql);
  } catch (err) {
    console.error("data-api wallet-auth/keys write failed:", err);
    await captureDataApiError(err, "wallet-auth-keys", env);
    return writeJson({ error: "write failed" }, 502);
  }
}

const ACCOUNT_ROUTES_MAX_BODY_BYTES = 4096;

async function readAccountRouteBody(request: Request) {
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

// No default/fallback case: src/wallet-auth.ts's issueWalletChallenge and
// verifyWalletChallenge are the only callers of this map, and both are a
// closed set of exactly these four codes -- a fifth is not reachable from
// this codebase's own contract, so a catch-all here would be untestable
// dead code rather than real robustness (matches this session's existing
// "don't add validation for scenarios that can't happen" convention).
function walletAuthErrorMessage(code: string) {
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

function walletAuthErrorStatus(code: string) {
  return code === "challenge_store_unavailable" ? 503 : 400;
}

async function walletAuthRateLimited(request: Request, env: DataApiEnv) {
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

async function handleWalletChallenge(request: Request, env: DataApiEnv) {
  const rateLimited = await walletAuthRateLimited(request, env);
  if (rateLimited) return rateLimited;
  // #8640: fail fast on the SAME precondition /verify enforces. Without this
  // the challenge succeeds on a deployment with no WALLET_SESSION_SECRET, so
  // the UI happily asks the user to produce a wallet signature -- a real
  // browser-extension prompt, for a message that /verify is then guaranteed to
  // reject with 503. Reported from production, where exactly that happened:
  // challenge returned 200, the user signed, and the flow died at the last
  // step. Checking the same secret here turns a wasted signature into an
  // upfront, accurate "not provisioned".
  if (!env.WALLET_SESSION_SECRET) {
    return writeJson(
      { error: "wallet login is not provisioned on this deployment" },
      503,
    );
  }
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

async function handleWalletVerify(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const rateLimited = await walletAuthRateLimited(request, env);
  if (rateLimited) return rateLimited;
  const sessionSecret = env.WALLET_SESSION_SECRET;
  if (!sessionSecret) {
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
  return withAccountsSql(env, ctx, async (sql) => {
    const now = Date.now();
    const [account] = await sql<{
      id: RpcAccounts["id"];
      ss58: RpcAccounts["ss58"];
      tier: RpcAccounts["tier"];
    }>`
      INSERT INTO rpc_accounts (ss58, created_at, last_login_at)
      VALUES (${ss58}, ${now}, ${now})
      ON CONFLICT (ss58) DO UPDATE SET last_login_at = ${now}
      RETURNING id, ss58, tier`;
    const sessionToken = await createSessionToken(sessionSecret, {
      accountId: Number(account.id),
      ss58: String(account.ss58),
    });
    return writeJson({
      session_token: sessionToken,
      expires_in_seconds: SESSION_TTL_SECONDS,
      account: { ss58: account.ss58, tier: account.tier },
    });
  });
}

// #8374: wallet-verified alert-trigger issuance -- the same challenge/verify
// shape as handleWalletChallenge/handleWalletVerify immediately above
// (same rate limiter, same body reader, same error-code mapping), scoped by
// the "watch" purpose so a signature over one flow's challenge can't verify
// the other's (src/wallet-auth.ts). Unlike the RPC login flow, success here
// does NOT touch rpc_accounts or mint a session -- it mints a
// stand-alone, stateless trigger-creation token
// (src/wallet-auth.ts's createTriggerToken) with no Postgres write of its
// own; the write happens later, at actual trigger creation
// (handleAlertTriggerCreate above), which is also where the
// WATCH_TRIGGERS_MAX_PER_ADDRESS cap is enforced.
//   POST /api/v1/watch/challenges  { ss58 } -> a signable message
//   POST /api/v1/watch/tokens      { ss58, signature } -> a trigger token

async function handleWatchChallenge(request: Request, env: DataApiEnv) {
  const rateLimited = await walletAuthRateLimited(request, env);
  if (rateLimited) return rateLimited;
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const ss58 = typeof body?.ss58 === "string" ? body.ss58 : "";
  const result = await issueWalletChallenge(env, ss58, "watch");
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

async function handleWatchTokenMint(request: Request, env: DataApiEnv) {
  const rateLimited = await walletAuthRateLimited(request, env);
  if (rateLimited) return rateLimited;
  const tokenSecret = env.WATCH_TRIGGER_TOKEN_SECRET;
  if (!tokenSecret) {
    return writeJson(
      {
        error:
          "wallet-verified alert issuance is not provisioned on this deployment",
      },
      503,
    );
  }
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const ss58 = typeof body?.ss58 === "string" ? body.ss58 : "";
  const signature = typeof body?.signature === "string" ? body.signature : "";
  const result = await verifyWalletChallenge(env, ss58, signature, "watch");
  if (!result.ok) {
    return writeJson(
      { error: walletAuthErrorMessage(result.code) },
      // Same anti-oracle posture as handleWalletVerify: a failure is 401
      // regardless of which check inside verifyWalletChallenge failed,
      // except the genuine deployment-config gap (503).
      result.code === "challenge_store_unavailable" ? 503 : 401,
    );
  }
  const token = await createTriggerToken(tokenSecret, { ss58 });
  return writeJson({
    token,
    expires_in_seconds: WATCH_TOKEN_TTL_SECONDS,
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
//
// #8820: gated with the same internal-token check every other internal write
// route in this file carries (handleApiKeyVerify's shape), so the route's
// safety no longer depends on the negative fact that workers/api.ts happens
// not to forward /api/v1/auth/* -- if that prefix is ever widened, this route
// is still not an unauthenticated account-rebinding primitive. The caller is
// our own Worker over the service binding, which already reads this secret, so
// the existing internal-token pair (not a new secret) is the right gate.
async function handleGithubAccountUpsert(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "github account upsert is not provisioned on this deployment" },
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
  return withAccountsSql(env, ctx, async (sql) => {
    const now = Date.now();
    const [account] = await sql<{
      id: GithubAccounts["id"];
      github_login: GithubAccounts["github_login"];
      tier: GithubAccounts["tier"];
    }>`
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

// The CURRENT tier of a GitHub OAuth account, by account id (#11562).
//
// WHY A ROUTE AND NOT A CLAIM BAKED INTO THE OAUTH GRANT. `props` is minted
// once by completeAuthorization and stored with the grant, so a tier carried
// there would not move until the user re-consented -- and the first thing that
// will ever change a tier is a subscription upgrade, which has to take effect
// on the next request rather than the next login. The API-key path already has
// the property this preserves, and src/api-tiers.ts states it: the tier is read
// from the lookup on every request, so a server-side change lands WITHOUT
// re-issuing the credential, bounded only by the cache TTL in front of it.
//
// Same internal-token gate as handleGithubAccountUpsert above, for the same
// reason -- the only caller is our own Worker over the DATA_API service
// binding, and it already reads this secret.
async function handleGithubAccountTier(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "github account lookup is not provisioned on this deployment" },
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
  // Number, not string: `id` is `integer`, and a non-numeric value must not
  // reach the query as a coerced NaN. An absent or malformed id is answered
  // `found: false` rather than 400 -- the caller's next move is identical
  // either way (fall back to the anonymous ceiling), and a 400 would invite it
  // to treat a shape problem as an outage.
  // POSITIVE integer, not merely an integer: `Number(null)` is 0, which passes
  // Number.isInteger and would reach the query as a real-looking id. Ids are
  // identity-generated and start at 1, so 0 and negatives are never accounts.
  const accountId = Number(body?.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return writeJson({ found: false });
  }
  return withAccountsSql(env, ctx, async (sql) => {
    const [account] = await sql<{ tier: GithubAccounts["tier"] }>`
      SELECT tier FROM github_accounts WHERE id = ${accountId} LIMIT 1`;
    // A deleted or unknown account is `found: false`, NOT a default tier. The
    // caller must not be able to mistake "we could not find you" for "you are
    // on free" -- those differ the moment `free` stops being the bottom rung.
    return account
      ? writeJson({ found: true, tier: account.tier })
      : writeJson({ found: false });
  });
}

// Shared by every /api/v1/keys route: resolves the Authorization header to
// { accountId, ss58 }, or a ready-to-return error response. A missing
// WALLET_SESSION_SECRET is a deployment-config gap (503), distinct from a
// missing/invalid/expired token (401).
async function requireAccountSession(request: Request, env: DataApiEnv) {
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

async function handleAccountKeyCreate(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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

  return withAccountsSql(env, ctx, async (sql) => {
    // The session's signature already proved this account row exists at
    // verify time; a missing row here means it was removed since -- decline
    // rather than mint an orphaned key. Tier is the account's OWN tier
    // (rpc_accounts.tier, default 'free') -- no invite code anymore: every
    // wallet-connected account can self-serve a key immediately, and gets
    // promoted later via the internal tier-promotion route below.
    const [account] = await sql<{
      id: RpcAccounts["id"];
      tier: RpcAccounts["tier"];
    }>`SELECT id, tier FROM rpc_accounts WHERE id = ${session.accountId}`;
    if (!account) return writeJson({ error: "no such account" }, 404);

    const minted = await createUnkeyKey(env, {
      externalId: String(session.accountId),
      tier: account.tier,
    });
    if (!minted.ok) {
      return writeJson({ error: "key issuance failed; try again" }, 502);
    }

    const now = Date.now();
    await sql<never>`
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

async function handleAccountKeysList(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  return withAccountsSql(env, ctx, async (sql) => {
    const rows = await sql<{
      key_id: ApiKeys["unkey_key_id"];
      tier: ApiKeys["tier"];
      created_at: ApiKeys["created_at"];
      revoked_at: ApiKeys["revoked_at"];
      last_used_at: ApiKeys["last_used_at"];
    }>`
      SELECT unkey_key_id AS key_id, tier, created_at, revoked_at, last_used_at
      FROM api_keys
      WHERE account_id = ${session.accountId}
      ORDER BY created_at DESC`;
    return writeJson({ keys: rows });
  });
}

const UNKEY_KEY_ID_PATTERN = /^key_[a-zA-Z0-9_]+$/;

async function handleAccountKeyRevoke(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  keyId: string,
) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  if (!UNKEY_KEY_ID_PATTERN.test(keyId)) {
    return writeJson({ error: "malformed key id" }, 400);
  }
  return withAccountsSql(env, ctx, async (sql) => {
    // Ownership check BEFORE ever calling Unkey -- a key_id that exists but
    // belongs to a different account gets the SAME 404 a nonexistent one
    // would (no existence oracle across accounts, same posture as
    // requireAlertTriggerOwner), and we never touch Unkey for a key this
    // session doesn't own.
    const [row] = await sql<{ unkey_key_id: ApiKeys["unkey_key_id"] }>`
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
    await sql<never>`UPDATE api_keys SET revoked_at = ${Date.now()} WHERE unkey_key_id = ${keyId}`;
    return writeJson({ key_id: keyId, revoked: true });
  });
}

// Internal-only: verifies ONE raw key against Unkey, for
// src/api-key-validation.ts's KV-cache-fronted validator (reached via the
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
async function handleApiKeyVerify(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
    void withAccountsSql(env, ctx, async (sql) => {
      await sql<never>`UPDATE api_keys SET last_used_at = ${Date.now()} WHERE unkey_key_id = ${result.keyId}`;
    });
  }
  return writeJson({
    valid: result.valid,
    code: result.code,
    tier: result.tier,
    accountId: result.accountId,
  });
}

// Internal-only: increments ONE account's daily usage counter for the
// self-serve usage dashboard (#8386). Reuses the SAME shared secret as
// handleApiKeyVerify above (API_KEY_LOOKUP_INTERNAL_TOKEN) rather than
// minting a new one: recording usage for a request whose key this Worker
// already validated is a strictly SMALLER capability than verifying an
// arbitrary caller-supplied key in the first place, so it sits inside the
// same trust boundary, not a new one (unlike ACCOUNT_TIER_PROMOTE_TOKEN_HEADER
// above, which grants a materially different, higher-privilege capability
// and correctly gets its own secret). Fire-and-forget from the caller's side
// (workers/api.ts's recordApiKeyUsage, via ctx.waitUntil) -- a failure here
// must never affect the request that triggered it, so this always returns
// 200 even on a swallowed write error; there is nothing for the caller to
// react to either way.
async function handleApiKeyUsageIncrement(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      {
        error: "api-key usage recording is not provisioned on this deployment",
      },
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
  const accountId = Number(body?.account_id);
  const route = typeof body?.route === "string" ? body.route.slice(0, 128) : "";
  // #11573: WHICH identity system `account_id` belongs to. Absent means `rpc`,
  // which is what every caller meant before the discriminator existed; an
  // unrecognised value is rejected rather than defaulted, because silently
  // filing a github id under `rpc` is the collision this column exists to end.
  const accountKind =
    body?.account_kind === undefined
      ? DEFAULT_ACCOUNT_KIND
      : asAccountKind(body.account_kind);
  // #8609: a REJECTED request increments rejected_count instead of
  // request_count. Only a literal true counts -- anything else is a success,
  // so a malformed flag can never silently erase real usage.
  const rejected = body?.rejected === true;
  if (!Number.isFinite(accountId) || !route || accountKind === null) {
    return writeJson(
      { error: "provide account_id, route and a known account_kind" },
      400,
    );
  }
  try {
    await withAccountsSql(env, ctx, async (sql) => {
      const day = new Date().toISOString().slice(0, 10);
      await sql<never>`
        INSERT INTO api_key_usage_daily
          (account_kind, account_id, day, route, request_count, rejected_count)
        VALUES (
          ${accountKind}, ${accountId}, ${day}, ${route},
          ${rejected ? 0 : 1}, ${rejected ? 1 : 0}
        )
        ON CONFLICT (account_kind, account_id, day, route)
        DO UPDATE SET
          request_count =
            api_key_usage_daily.request_count + EXCLUDED.request_count,
          rejected_count =
            api_key_usage_daily.rejected_count + EXCLUDED.rejected_count`;
    });
  } catch {
    // Best-effort counter -- never surfaces a failure to the caller (see
    // header comment above).
  }
  return writeJson({ ok: true });
}

// Internal-only: spends COST units against ONE account's daily quota (#8608)
// and reports whether the spend was allowed. Same shared secret and same trust
// boundary as handleApiKeyUsageIncrement above, for the same reason -- the
// caller has already validated the key this spend is attributed to.
//
// Unlike that handler this one is NOT fire-and-forget: workers/tiered-rate-
// limit.ts awaits the verdict before letting the request through, so the
// response body is load-bearing and errors must be distinguishable from a
// clean rejection. The caller fails OPEN on anything non-200 (see
// spendDailyQuota) -- an unprovisioned or unhappy quota store must never
// become an outage for a paying caller -- so a 503 here is a real signal, not
// a swallowed one.
async function handleApiQuotaSpend(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "quota accounting is not provisioned on this deployment" },
      503,
    );
  }
  if (request.headers.get(API_KEY_LOOKUP_TOKEN_HEADER) !== configured) {
    return writeJson(
      { error: `provide a valid ${API_KEY_LOOKUP_TOKEN_HEADER} header` },
      401,
    );
  }
  const body = await readJsonObjectBody(request);
  if (!body) return writeJson({ error: "invalid body" }, 400);
  const accountId = Number(body.account_id);
  const cost = Number(body.cost);
  const limit = Number(body.limit);
  // #11573: see handleApiKeyUsageIncrement -- absent means `rpc`, unrecognised
  // is a 400. A quota row is a bill; filing one under the wrong identity system
  // debits someone else.
  const accountKind =
    body.account_kind === undefined
      ? DEFAULT_ACCOUNT_KIND
      : asAccountKind(body.account_kind);
  if (
    !Number.isInteger(accountId) ||
    accountId <= 0 ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    accountKind === null
  ) {
    return writeJson(
      { error: "provide account_id, cost, limit and a known account_kind" },
      400,
    );
  }

  const now = Date.now();
  const day = utcDayKey(now);

  // A single request costing more than the whole day's allowance can never be
  // satisfied, and must be rejected WITHOUT touching the counter. This is not
  // just an optimisation: the SQL below guards the conflict path only, so on
  // the first spend of a day (no existing row, hence no conflict) the plain
  // INSERT would otherwise succeed and bank an over-limit balance.
  if (cost > limit) {
    return writeJson(applyQuotaSpend(0, cost, limit, now));
  }

  const result = await withAccountsSql(env, ctx, async (sql) => {
    // The SPEND is one guarded upsert -- atomic on its own. The WHERE guard
    // is applyQuotaSpend's reject rule expressed as a conflict predicate:
    // when the new total would exceed the limit the DO UPDATE does not fire,
    // so no rows come back AND the counter is left untouched. (The Postgres
    // version wrapped this in a data-modifying CTE to also read the rejected
    // balance in the same snapshot; SQLite has no data-modifying CTEs, so the
    // reject path reads the unchanged balance in a follow-up SELECT --
    // enforcement is still the single guarded statement, only the 429's
    // advisory `spent` readout could in principle race a concurrent spend.)
    const attempt = await sql<{ units_spent: ApiQuotaDaily["units_spent"] }>`
      INSERT INTO api_quota_daily
        (account_kind, account_id, day, units_spent, updated_at)
      VALUES (${accountKind}, ${accountId}, ${day}, ${cost}, ${now})
      ON CONFLICT (account_kind, account_id, day) DO UPDATE
        SET units_spent = api_quota_daily.units_spent + EXCLUDED.units_spent,
            updated_at = ${now}
        WHERE api_quota_daily.units_spent + EXCLUDED.units_spent <= ${limit}
      RETURNING units_spent`;
    const spent = attempt[0]?.units_spent;
    if (spent != null) {
      return applyQuotaSpend(Number(spent) - cost, cost, limit, now);
    }
    const [current] = await sql<{ units_spent: ApiQuotaDaily["units_spent"] }>`
      SELECT units_spent FROM api_quota_daily
      WHERE account_kind = ${accountKind}
        AND account_id = ${accountId}
        AND day = ${day}`;
    return applyQuotaSpend(Number(current?.units_spent ?? 0), cost, limit, now);
  });
  return result instanceof Response ? result : writeJson(result);
}

// Internal-only: fold a batch of usage observations into api_usage_rollup
// (#8597). Same shared secret and trust boundary as the usage counter above --
// recording that traffic happened is a strictly smaller capability than
// verifying a key.
//
// BATCHED on purpose -- and, since #8823, actually batched. This comment used
// to claim the caller coalesced "a request's observations", which described
// nothing: workers/api.ts handed foldObservations a single-element array per
// request, so a burst of N requests to one family really was N subrequests and
// N upserts contending on one row. The caller now buffers observations in the
// isolate (USAGE_ROLLUP_FLUSH_COUNT / _AGE_MS) and folds the whole batch, so a
// burst arrives here as one POST carrying one bucket per (day, family, shape).
// Every bucket in a batch is still upserted individually inside one
// withAccountsSql call, so one Postgres client serves the whole batch.
// Fire-and-forget from the caller's side, so this always returns 200 even on a
// swallowed write error -- a usage-rollup miss must never affect the request
// that triggered it, and there is nothing for the caller to react to either
// way.
async function handleUsageRollupIncrement(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "usage rollup is not provisioned on this deployment" },
      503,
    );
  }
  if (request.headers.get(API_KEY_LOOKUP_TOKEN_HEADER) !== configured) {
    return writeJson(
      { error: `provide a valid ${API_KEY_LOOKUP_TOKEN_HEADER} header` },
      401,
    );
  }
  const body = await readJsonObjectBody(request);
  if (!body) return writeJson({ error: "invalid body" }, 400);
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  if (buckets.length === 0) return writeJson({ ok: true, applied: 0 });
  try {
    await withAccountsSql(env, ctx, async (sql) => {
      for (const bucket of buckets as Row[]) {
        const day = typeof bucket?.day === "string" ? bucket.day : null;
        const family =
          typeof bucket?.family === "string"
            ? bucket.family.slice(0, 200)
            : null;
        const shape =
          typeof bucket?.cost_shape === "string" ? bucket.cost_shape : null;
        const count = Number(bucket?.request_count);
        const keyed = Number(bucket?.keyed_count) || 0;
        // A malformed bucket is skipped, never allowed to abort the batch --
        // one bad row must not discard the other 177 families' counts.
        if (
          !day ||
          !family ||
          !shape ||
          !Number.isFinite(count) ||
          count <= 0
        ) {
          continue;
        }
        await sql<never>`
          INSERT INTO api_usage_rollup
            (day, route_family, cost_shape, request_count, keyed_count)
          VALUES (${day}, ${family}, ${shape}, ${count}, ${keyed})
          ON CONFLICT (day, route_family, cost_shape)
          DO UPDATE SET
            request_count = api_usage_rollup.request_count + EXCLUDED.request_count,
            keyed_count = api_usage_rollup.keyed_count + EXCLUDED.keyed_count`;
      }
    });
  } catch {
    // Best-effort counter -- see header.
  }
  return writeJson({ ok: true, applied: buckets.length });
}

// Internal-only READ path (#8597): "requests per route family per day, by cost
// shape". This is the deliverable -- the point of the issue is to make the
// pricing question cheap to RE-ASK, so it must be answerable without a deploy
// or an SSH session.
async function handleUsageRollupRead(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const configured = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "usage rollup is not provisioned on this deployment" },
      503,
    );
  }
  if (request.headers.get(API_KEY_LOOKUP_TOKEN_HEADER) !== configured) {
    return writeJson(
      { error: `provide a valid ${API_KEY_LOOKUP_TOKEN_HEADER} header` },
      401,
    );
  }
  const url = new URL(request.url);
  const days = Math.min(
    365,
    Math.max(1, Number(url.searchParams.get("days")) || 30),
  );
  const since = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const groupBy =
    url.searchParams.get("group_by") === "shape" ? "shape" : "family";
  const result = await withAccountsSql(env, ctx, async (sql) => {
    const rows =
      groupBy === "shape"
        ? await sql<{
            route_family?: undefined;
            cost_shape: ApiUsageRollup["cost_shape"];
            request_count: ApiUsageRollup["request_count"] | null;
            keyed_count: ApiUsageRollup["keyed_count"] | null;
          }>`
            SELECT cost_shape,
                   SUM(request_count) AS request_count,
                   SUM(keyed_count) AS keyed_count
            FROM api_usage_rollup
            WHERE day >= ${since}
            GROUP BY cost_shape
            ORDER BY SUM(request_count) DESC`
        : await sql<{
            route_family: ApiUsageRollup["route_family"];
            cost_shape: ApiUsageRollup["cost_shape"];
            request_count: ApiUsageRollup["request_count"] | null;
            keyed_count: ApiUsageRollup["keyed_count"] | null;
          }>`
            SELECT route_family, cost_shape,
                   SUM(request_count) AS request_count,
                   SUM(keyed_count) AS keyed_count
            FROM api_usage_rollup
            WHERE day >= ${since}
            GROUP BY route_family, cost_shape
            ORDER BY SUM(request_count) DESC
            LIMIT 500`;
    // SUM() over BIGINT returns NUMERIC, which postgres.js hands back as a
    // STRING -- the #8607 trap. Coerced here so the readout is arithmetic-ready
    // rather than relying on every consumer to remember.
    const total = rows.reduce((sum, row) => sum + Number(row.request_count), 0);
    const totalKeyed = rows.reduce(
      (sum, row) => sum + Number(row.keyed_count),
      0,
    );
    return writeJson({
      window_days: days,
      since,
      group_by: groupBy,
      total_requests: total,
      total_keyed: totalKeyed,
      // The single number ADR 0022 is waiting on: what fraction of traffic is
      // keyless. If this is overwhelming, the memo's "don't price the edge"
      // recommendation holds; if not, Option (a) comes back into play.
      keyless_share:
        total > 0 ? Number(((total - totalKeyed) / total).toFixed(4)) : null,
      rows: rows.map((row) => ({
        ...(row.route_family === undefined
          ? {}
          : { route_family: row.route_family }),
        cost_shape: row.cost_shape,
        request_count: Number(row.request_count),
        keyed_count: Number(row.keyed_count),
      })),
    });
  });
  // withAccountsSql returns T | Response, and this callback's T is already a
  // Response (writeJson), so the union collapses -- no unwrapping branch to
  // write, and none to leave untested.
  return result;
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
async function handleAccountTierPromote(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
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
  return withAccountsSql(env, ctx, async (sql) => {
    const [account] = await sql<{ id: RpcAccounts["id"] }>`
      UPDATE rpc_accounts SET tier = ${tier} WHERE ss58 = ${ss58} RETURNING id`;
    if (!account) return writeJson({ error: "no such account" }, 404);

    const keys = await sql<{ unkey_key_id: ApiKeys["unkey_key_id"] }>`
      SELECT unkey_key_id FROM api_keys
      WHERE account_id = ${account.id} AND revoked_at IS NULL`;
    const results = await Promise.all(
      keys.map((row) =>
        updateUnkeyKeyTier(env, { keyId: String(row.unkey_key_id), tier }),
      ),
    );
    const failedCount = results.filter((r) => !r.ok).length;
    await sql<never>`
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

const API_KEY_BLOCK_TOKEN_HEADER = "x-api-key-block-token";

/**
 * Refresh the cached blocklist the edge reads (#8611).
 *
 * Written straight after the ledger write rather than left to expire, so a
 * block takes effect as fast as KV propagates instead of waiting out
 * BLOCKLIST_KV_TTL. The TTL then only bounds how stale things can get if THIS
 * write fails -- it is the safety net, not the mechanism.
 *
 * Best-effort: a KV hiccup must not fail the block itself. The row is the
 * source of truth and the next refresh will pick it up.
 */
async function refreshBlocklistSnapshot(env: DataApiEnv, sql: PgSql) {
  const rows = await sql<{
    account_kind: string;
    account_id: ApiKeyBlocks["account_id"];
    reason_code: ApiKeyBlocks["reason_code"];
    blocked_at: ApiKeyBlocks["blocked_at"];
  }>`
    SELECT account_kind, account_id, reason_code, blocked_at
    FROM api_key_blocks
    WHERE unblocked_at IS NULL
    ORDER BY account_kind, account_id`;
  const snapshot = {
    generated_at: new Date().toISOString(),
    blocks: rows.map((row) => ({
      // account_id is BIGINT -- postgres.js returns it as a STRING, and
      // evaluateBlock compares with Number(). Coerced here so the SNAPSHOT is
      // already the right shape rather than relying on every reader to
      // remember (the #8607 trap).
      accountId: Number(row.account_id),
      // #11573: WHICH identity system that id belongs to. Narrowed rather than
      // passed through, so a value the database somehow holds outside the
      // vocabulary cannot reach evaluateBlock as an unmatchable string and
      // silently un-block someone. Falling back to `rpc` matches the column
      // default and the compatibility reading on the consumer side.
      accountKind: asAccountKind(row.account_kind) ?? DEFAULT_ACCOUNT_KIND,
      reasonCode: row.reason_code,
      blockedAt: Number(row.blocked_at),
    })),
  };
  try {
    await env.METAGRAPH_CONTROL?.put(
      BLOCKLIST_KV_KEY,
      JSON.stringify(snapshot),
      { expirationTtl: BLOCKLIST_KV_TTL },
    );
  } catch {
    // Ledger already written; the periodic refresh is the backstop.
  }
  return snapshot.blocks.length;
}

function requireBlockToken(request: Request, env: DataApiEnv) {
  const configured = env.API_KEY_BLOCK_INTERNAL_TOKEN;
  if (!configured) {
    return writeJson(
      { error: "key blocking is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(API_KEY_BLOCK_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return writeJson(
      { error: `provide a valid ${API_KEY_BLOCK_TOKEN_HEADER} header` },
      401,
    );
  }
  return null;
}

// Internal-only: block ONE account's API access (#8611).
//
// Its own shared secret, not the key-verify one, following the same
// "different capability, different secret" rule as handleAccountTierPromote
// above -- cutting off a paying customer is a materially higher-privilege act
// than recording that one made a request.
//
// Account-level, not key-level: blocking a single key of an abusive account
// just invites minting another. Reversible by design, with the whole history
// kept -- see the api_key_blocks comment in schema.sql.
async function handleApiKeyBlock(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const denied = requireBlockToken(request, env);
  if (denied) return denied;
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const accountId = Number(body?.account_id);
  const reasonCode = body?.reason_code;
  // #11573: a block is scoped to (kind, id). Absent means `rpc`, which is what
  // every block written before the discriminator meant; an unrecognised value
  // is refused rather than defaulted, because blocking the wrong identity
  // system cuts off an unrelated account entirely.
  const accountKind =
    body?.account_kind === undefined
      ? DEFAULT_ACCOUNT_KIND
      : asAccountKind(body.account_kind);
  if (!Number.isInteger(accountId) || accountId <= 0 || accountKind === null) {
    return writeJson(
      { error: "provide a valid account_id and a known account_kind" },
      400,
    );
  }
  if (!isBlockReasonCode(reasonCode)) {
    return writeJson(
      {
        error: "provide a known reason_code",
        reason_codes: Object.keys(BLOCK_REASON_CODES),
      },
      400,
    );
  }
  const note = typeof body?.note === "string" ? body.note.slice(0, 2000) : null;
  const blockedBy =
    typeof body?.blocked_by === "string" ? body.blocked_by.slice(0, 200) : null;
  return withAccountsSql(env, ctx, async (sql) => {
    // ON CONFLICT DO NOTHING against the one-active-block-per-account partial
    // unique index: blocking an already-blocked account is a no-op rather than
    // an error, so an ops action that gets retried or double-clicked stays
    // idempotent instead of 500ing.
    const [row] = await sql<{ id: ApiKeyBlocks["id"] }>`
      INSERT INTO api_key_blocks
        (account_kind, account_id, reason_code, note, blocked_at, blocked_by)
      VALUES (
        ${accountKind}, ${accountId}, ${reasonCode}, ${note},
        ${Date.now()}, ${blockedBy}
      )
      ON CONFLICT DO NOTHING
      RETURNING id`;
    const active = await refreshBlocklistSnapshot(env, sql);
    return writeJson({
      account_kind: accountKind,
      account_id: accountId,
      reason_code: reasonCode,
      already_blocked: !row,
      active_blocks: active,
    });
  });
}

// Internal-only: lift a block (#8611). The false-positive path, and the reason
// api_key_blocks is an append-only ledger rather than a boolean column -- this
// closes the row instead of deleting it, so "blocked in error on the 3rd,
// lifted on the 4th, here is why" stays answerable months later.
async function handleApiKeyUnblock(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const denied = requireBlockToken(request, env);
  if (denied) return denied;
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const accountId = Number(body?.account_id);
  // #11573: must name the same (kind, id) the block was written against, or an
  // unblock silently matches nothing and the caller is told it worked.
  const accountKind =
    body?.account_kind === undefined
      ? DEFAULT_ACCOUNT_KIND
      : asAccountKind(body.account_kind);
  if (!Number.isInteger(accountId) || accountId <= 0 || accountKind === null) {
    return writeJson(
      { error: "provide a valid account_id and a known account_kind" },
      400,
    );
  }
  // Required, not optional. An unblock with no stated reason is how a
  // false-positive review becomes unauditable a month later.
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!note) {
    return writeJson(
      { error: "provide a note explaining why the block is being lifted" },
      400,
    );
  }
  return withAccountsSql(env, ctx, async (sql) => {
    const [row] = await sql<{ id: ApiKeyBlocks["id"] }>`
      UPDATE api_key_blocks
      SET unblocked_at = ${Date.now()}, unblocked_note = ${note.slice(0, 2000)}
      WHERE account_kind = ${accountKind}
        AND account_id = ${accountId}
        AND unblocked_at IS NULL
      RETURNING id`;
    const active = await refreshBlocklistSnapshot(env, sql);
    return writeJson({
      account_id: accountId,
      unblocked: Boolean(row),
      active_blocks: active,
    });
  });
}

// Internal-only: the review queue (#8611). Anomaly signals for recently-active
// keyed accounts, strongest first, alongside their current block state.
// READ-ONLY on purpose -- nothing here blocks anyone. Signals rank a queue; a
// human decides, using handleApiKeyBlock above. An automated block on a
// heuristic like "used many route families" would eventually cut off a
// legitimate integration doing exactly what the API is for.
async function handleApiKeyAnomalies(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const denied = requireBlockToken(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const days = Math.min(
    30,
    Math.max(1, Number(url.searchParams.get("days")) || 7),
  );
  const since = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return withAccountsSql(env, ctx, async (sql) => {
    const usage = await sql<{
      account_id: ApiKeyUsageDaily["account_id"];
      day: ApiKeyUsageDaily["day"];
      route: ApiKeyUsageDaily["route"];
      request_count: ApiKeyUsageDaily["request_count"];
    }>`
      SELECT account_id, day, route, request_count
      FROM api_key_usage_daily
      WHERE day >= ${since}
      ORDER BY account_id, day`;
    const blocked = await sql<{
      account_id: ApiKeyBlocks["account_id"];
      reason_code: ApiKeyBlocks["reason_code"];
    }>`
      SELECT account_id, reason_code FROM api_key_blocks
      WHERE unblocked_at IS NULL`;
    const blockedBy = new Map(
      blocked.map((row) => [Number(row.account_id), row.reason_code]),
    );

    const byAccount = new Map<number, Map<string, Record<string, number>>>();
    for (const row of usage) {
      const id = Number(row.account_id);
      const perDay = byAccount.get(id) ?? new Map();
      const routes = perDay.get(row.day) ?? {};
      routes[String(row.route)] = Number(row.request_count);
      perDay.set(row.day, routes);
      byAccount.set(id, perDay);
    }

    const flagged = [];
    for (const [accountId, perDay] of byAccount) {
      const usageDays = [...perDay].map(([day, routes]) => ({ day, routes }));
      // The tier ceiling as a per-DAY number. MCP's keyed tier is the widest
      // surface a key can spend against, so it is the honest denominator for
      // "riding the ceiling" rather than any one narrower route's limit.
      const signals = scoreUsageAnomalies(
        usageDays,
        MCP_TIERED_RATE_LIMIT.keyed.limit * 1440,
      );
      if (signals.length === 0) continue;
      flagged.push({
        account_id: accountId,
        signals,
        top_score: signals[0].score,
        blocked_reason_code: blockedBy.get(accountId) ?? null,
      });
    }
    flagged.sort((a, b) => b.top_score - a.top_score);
    return writeJson({
      window_days: days,
      accounts_seen: byAccount.size,
      flagged_count: flagged.length,
      flagged,
    });
  });
}

// Session-gated usage dashboard (#8386): the calling account's own last 7
// days of request counts by day, plus the top routes across that window --
// scoped to account_id, never key_id, since api_key_usage_daily is recorded
// per-account (a key's identity resolves to its account before the counter
// write, same as the tiered rate limiter's own accountId-keying) rather than
// per-individual-key. An account with several active keys sees combined
// usage across all of them, which matches "how much of my headroom am I
// using" better than a per-key split would.
const USAGE_DASHBOARD_WINDOW_DAYS = 7;

// Session-gated block status for the calling account (#8611): "tenant-visible
// status on the dashboard".
//
// Deliberately narrow. It reports THAT the account is blocked, the reason code,
// and when -- never the internal `note`, which is written by a maintainer for
// maintainers and can name a person, a ticket or a suspicion. The unblock path
// is a support conversation, not a self-serve button, so there is nothing to
// action here beyond knowing.
async function handleAccountKeyStatus(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  return withAccountsSql(env, ctx, async (sql) => {
    const [row] = await sql<{
      reason_code: ApiKeyBlocks["reason_code"];
      blocked_at: ApiKeyBlocks["blocked_at"];
    }>`
      SELECT reason_code, blocked_at FROM api_key_blocks
      WHERE account_id = ${session.accountId} AND unblocked_at IS NULL
      LIMIT 1`;
    if (!row) return writeJson({ blocked: false });
    const reasonCode = isBlockReasonCode(row.reason_code)
      ? row.reason_code
      : "abuse_manual";
    return writeJson({
      blocked: true,
      reason_code: reasonCode,
      // The published sentence for the code, so the dashboard never has to
      // keep its own copy of these strings in sync.
      message: BLOCK_REASON_CODES[reasonCode],
      blocked_at: Number(row.blocked_at),
    });
  });
}

async function handleAccountKeyUsage(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  url: URL,
) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  return withAccountsSql(env, ctx, async (sql) => {
    const since = new Date(
      Date.now() - USAGE_DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const rows = await sql<{
      day: ApiKeyUsageDaily["day"];
      route: ApiKeyUsageDaily["route"];
      request_count: ApiKeyUsageDaily["request_count"];
      rejected_count: ApiKeyUsageDaily["rejected_count"];
    }>`
      SELECT day, route, request_count, rejected_count
      FROM api_key_usage_daily
      WHERE account_id = ${session.accountId} AND day >= ${since}
      ORDER BY day DESC`;
    const byDay = new Map<string, { count: number; rejected: number }>();
    const byRoute = new Map<string, { count: number; rejected: number }>();
    for (const row of rows) {
      const count = Number(row.request_count);
      // rejected_count was added after the table's first rows landed, so an
      // un-migrated row yields null. Coerce to 0 rather than NaN, which
      // would poison every total downstream (#8607's trap).
      const rejected = Number(row.rejected_count ?? 0) || 0;
      const dayKey = String(row.day);
      const day = byDay.get(dayKey) ?? { count: 0, rejected: 0 };
      day.count += count;
      day.rejected += rejected;
      byDay.set(dayKey, day);
      const routeKey = String(row.route);
      const route = byRoute.get(routeKey) ?? { count: 0, rejected: 0 };
      route.count += count;
      route.rejected += rejected;
      byRoute.set(routeKey, route);
    }

    // #8609: quota headroom read from api_quota_daily -- the SAME table the
    // enforcement gate writes (#8608). The issue's acceptance bar is that the
    // dashboard's numbers AGREE with the enforcement layer's counters, so this
    // deliberately reads the enforcement store rather than re-deriving a
    // parallel total from api_key_usage_daily, which counts requests while the
    // quota counts COST UNITS and would disagree by construction.
    const today = new Date().toISOString().slice(0, 10);
    const [quotaRow] = await sql<{ units_spent: ApiQuotaDaily["units_spent"] }>`
      SELECT units_spent FROM api_quota_daily
      WHERE account_id = ${session.accountId} AND day = ${today}`;
    const unitsSpent = Number(quotaRow?.units_spent ?? 0) || 0;
    // The tier is NOT on the session token -- it is server-side state that can
    // change without re-issuing a key (#8608), so reading it from the session
    // would show a stale ceiling after a promotion. rpc_accounts.tier is the
    // same column the gate's own key lookup resolves against.
    const [accountRow] = await sql<{ tier: RpcAccounts["tier"] }>`
      SELECT tier FROM rpc_accounts WHERE id = ${session.accountId}`;
    const tier = typeof accountRow?.tier === "string" ? accountRow.tier : null;
    // The account's own tier ceiling, from the same config the gate enforces.
    // Absent when the tier has no daily cap (free is uncapped by design), in
    // which case there is no headroom to report -- reporting 0 or Infinity
    // would both read as "you are at your limit".
    const dailyUnits = TIER_DAILY_UNITS[tier ?? ""];
    const days = [...byDay.entries()]
      .map(([day, v]) => ({ day, count: v.count, rejected: v.rejected }))
      .sort((a, b) => b.day.localeCompare(a.day));
    const topRoutes = [...byRoute.entries()]
      .map(([route, v]) => ({ route, count: v.count, rejected: v.rejected }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ?format=csv exports the tenant's OWN rows -- the issue's export
    // deliverable. Day-grained, because that is the grain the tenant can
    // reconcile against their own logs.
    if (csvRequested(url, request)) {
      return csvResponse(
        days,
        `metagraphed-usage-${today}`,
        "short",
        request,
        ["day", "count", "rejected"],
        // A tenant's own usage is private and changes continuously, so it must
        // never sit in a shared cache the way public artifact exports do.
        // csvResponse has no "no-store" profile, so the header is set here
        // explicitly rather than picking the least-wrong shared profile.
        { "cache-control": "no-store", "x-robots-tag": "noindex" },
      );
    }

    return writeJson({
      window_days: USAGE_DASHBOARD_WINDOW_DAYS,
      tier,
      quota:
        dailyUnits === undefined
          ? null
          : {
              units_spent: unitsSpent,
              daily_units: dailyUnits,
              remaining: Math.max(0, dailyUnits - unitsSpent),
              resets_at: quotaResetAt(Date.now()),
            },
      days,
      top_routes: topRoutes,
      rejected_total: days.reduce((sum, d) => sum + d.rejected, 0),
    });
  });
}

async function handleAccountKeysRoute(
  request: Request,
  env: DataApiEnv,
  ctx: ExecutionContext,
  url: URL,
) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "keys", <key_id?>, <"usage"?>]
  const keyId = segments[3];
  if (!keyId && request.method === "POST") {
    return handleAccountKeyCreate(request, env, ctx);
  }
  if (!keyId && request.method === "GET") {
    return handleAccountKeysList(request, env, ctx);
  }
  if (keyId === "usage" && request.method === "GET") {
    return handleAccountKeyUsage(request, env, ctx, url);
  }
  if (keyId === "status" && request.method === "GET") {
    return handleAccountKeyStatus(request, env, ctx);
  }
  if (keyId && request.method === "DELETE") {
    return handleAccountKeyRevoke(request, env, ctx, keyId);
  }
  return writeJson(
    {
      error:
        "Use POST/GET /api/v1/keys, GET /api/v1/keys/usage, GET /api/v1/keys/status, or DELETE /api/v1/keys/{key_id}.",
    },
    405,
  );
}

// --- Neurons-family store read routes (box decommission; tests/fixtures/sqlite-schema/0007) --
//
// The D1 twins of every neurons/neuron_daily/account_position_daily read the
// deleted Postgres dispatcher served, matched whenever METAGRAPH_NEURONS_SOURCE
// is off "postgres" (see neuronsServedFromStore's own header).
//
// THIS IS NO LONGER A TRANSLATION TABLE, and reading it as one is what broke
// the cutover twice. It was written when these queries had exactly one store to
// satisfy, so each row recorded how a Postgres idiom had been re-rendered for
// SQLite. Then #9784 gave the same query text a second store to run against,
// and every one-directional rendering below became a live hazard: the SQLite
// side is now the ONLY side, executed verbatim against both dialects. A
// rendering that is merely correct for D1 served a wrong answer on Neon.
//
// So the surviving rule is ONE PORTABLE RENDERING, not two dialects kept in
// sync. Each entry says what both stores accept and why the alternatives are
// out -- and `tests/neon-sql-portability.test.ts` fails the build if a query on
// a movable route reacquires one:
//   - snapshot_date needs no ::cast -- it is TEXT 'YYYY-MM-DD' in both, and
//     lexicographic comparison IS date order for ISO dates in both.
//   - `validator_permit = TRUE`, never `= 1`. D1 stored the column INTEGER 0/1
//     and Neon declares it BOOLEAN, because the mirror writes real JS booleans.
//     Postgres rejects `boolean = integer` outright, so `= 1` made the query
//     throw, the `?? buildGlobalValidators([])` fallback swallowed it, and
//     /validators served an EMPTY leaderboard at 200 OK until #9802 rolled the
//     flag back. `TRUE` is a keyword in both (SQLite aliases it to 1).
//   - `SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END)`, never
//     `SUM(validator_permit)`. Postgres has no SUM over boolean at all; the
//     CASE is portable because SQLite reads a nonzero integer as true and
//     Postgres reads the boolean directly.
//   - DISTINCT ON (k) ... ORDER BY k, d is Postgres-only -- use ROW_NUMBER()
//     OVER (PARTITION BY k ORDER BY d DESC) = 1, or a group-wise-MAX join,
//     which both dialects have.
//   - A window boundary is computed in TypeScript and BOUND, never shifted in
//     SQL (#9798). `date(MAX(snapshot_date), '-N days')` is SQLite's and
//     Postgres has no equivalent, so the subquery yielded nothing and two
//     routes served an empty 200 (#9792). See neuronDailyWindowBounds.
//
// The two regressions share one shape worth naming: neither raised an error a
// caller could see. Both returned a schema-stable 200 with zero rows, which is
// indistinguishable from "no data yet" -- so nothing but a row-count baseline
// caught them.
//
// Cross-tier joins: subnet_snapshots has a live D1 home (tests/fixtures/sqlite-schema/
// 0002_observations.sql), so the alpha_price_tao joins/loads port for real.
// The remaining enrichment side tables (featured_validators, account_identity)
// have NO D1 home yet -- their families are frozen or port separately -- so the
// twins pass each builder the degraded value the retired Postgres loader's own
// catch branch produced (empty set/map, null), rather than issuing a query that
// can only ever throw. Wire the real reads in when those tables land on the store.
//
// subnet_hyperparams' TEMPO no longer belongs to that list either (#9342). It
// landed on the store in tests/fixtures/sqlite-schema/0009 and is populated for every subnet, but both
// validator handlers kept passing `tempoByNetuid: new Map()` -- the placeholder
// this comment told them to pass. An empty map means every lookup misses, and
// accumulateApyRow skips a membership whose tempo is unresolved, so apy_estimate
// was `null` and apy_estimate_eligible_subnet_count was 0 on EVERY served
// response. A degraded placeholder that outlives the gap it stood in for reads
// exactly like a real absence, which is why it survived this long.
//
// validator_nominator_counts NO LONGER BELONGS TO THAT LIST. It landed on D1
// in tests/fixtures/sqlite-schema/0012, so the real read is wired below and this tier answers
// nominator_count itself -- completely, since #9334 reads absence from a fresh
// scan as a confirmed zero. The serving Worker's lakehouse overlay that covered
// the gap in the meantime (#9146) is gone with #9337: it could only ever fire
// on a null count, and there are none left to fill.
type NeuronsStoreRouteHandler = (
  sql: PgSql,
  env: DataApiEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

// The D1 twin of loadAlphaPricesByNetuid (#9051): netuid -> latest
// alpha_price_tao. Group-wise-MAX join instead of DISTINCT ON, same
// degrade-to-empty-map failure contract (every non-root row is then excluded
// from the totals rather than counted 1:1).
// netuid -> tempo(blocks) from the subnet_hyperparams tier (#9342), for
// accumulateApyRow to annualize each membership's emission_tao.
//
// Same degrade-to-empty-map contract as its siblings: a cold or absent table
// yields an empty map, every lookup misses, and apy_estimate serves as null --
// which is exactly what a caller got unconditionally before this was wired.
// tempoByNetuid() drops tempo=0 rather than storing it, since a zero-length
// epoch divides into an infinite epochsPerYear downstream.
//
// ROOT IS INCLUDED, deliberately, and that is verified against the chain rather
// than inferred from our capture. subnet_hyperparams holds 129 rows -- netuid 0
// plus the 128 real subnets -- and reading finney storage directly confirms root
// is a genuine network with a genuine tempo, not a capture artefact:
//
//   SubtensorModule::NetworksAdded(0) = true
//   SubtensorModule::Tempo(0)  = 100     (ours: 100)
//   SubtensorModule::Tempo(1)  = 99      (ours: 99)
//   SubtensorModule::Tempo(64) = 360     (ours: 360)
//
// It is kept because every sibling enrichment in this same builder already treats
// a root membership as real: loadStoreAlphaPricesByNetuid gives netuid 0 a price of
// 1, and the leaderboard counts a root-only validator. Dropping root would make
// apy_estimate silently ignore the root position of exactly the large validators
// whose stake is mostly there.
//
// The one wart is the OUTPUT field's name, `apy_estimate_eligible_subnet_count`,
// which counts root among "subnets" when root is not one. That name predates this
// fix and renaming a published field is a contract change, not a bug fix -- so it
// is left alone and called out rather than quietly redefined here.
async function loadSubnetTemposFromStore(
  sql: PgSql,
  env: DataApiEnv,
): Promise<Map<number, number>> {
  try {
    const rows = await sql<{
      netuid: SubnetHyperparams["netuid"];
      tempo: SubnetHyperparams["tempo"];
    }>`SELECT netuid, tempo FROM subnet_hyperparams`;
    return tempoByNetuid(rows as Array<Record<string, unknown>>);
  } catch (err) {
    console.error("subnet_hyperparams tempo query failed:", err);
    await captureDataApiError(err, "subnet-hyperparams-tempo-query", env);
    return new Map();
  }
}

async function loadStoreAlphaPricesByNetuid(
  sql: PgSql,
  env: DataApiEnv,
): Promise<Map<number, number | null>> {
  try {
    const rows = await sql<{
      netuid: SubnetSnapshots["netuid"];
      alpha_price_tao: SubnetSnapshots["alpha_price_tao"];
      tao_in_pool_tao: SubnetSnapshots["tao_in_pool_tao"];
      alpha_in_pool: SubnetSnapshots["alpha_in_pool"];
    }>`
      SELECT s.netuid AS netuid, s.alpha_price_tao AS alpha_price_tao,
        s.tao_in_pool_tao AS tao_in_pool_tao, s.alpha_in_pool AS alpha_in_pool
      FROM subnet_snapshots s
      JOIN (
        SELECT netuid, MAX(snapshot_date) AS snapshot_date
        FROM subnet_snapshots GROUP BY netuid
      ) latest
        ON latest.netuid = s.netuid AND latest.snapshot_date = s.snapshot_date`;
    // #9408 follow-up: mark at SPOT, derived from the reserves on this same row,
    // rather than at alpha_price_tao -- which is the chain's MOVING price, byte-
    // identical to moving_price_pinned on the live tier.
    //
    // The difference is not academic. Measured on netuid 64's own snapshots:
    //
    //   2026-08-04  moving 0.084773044  spot 0.084866808   (-0.11%)
    //   2026-08-03  moving 0.084084102  spot 0.085180046   (-1.29%)
    //
    // A lagging average is the wrong mark for "what is this position worth", and it
    // lags hardest exactly when the market has moved. The reserves were already being
    // selected past -- the spot is one division away.
    //
    // spotPriceTao is shared with /stake-quote and the economics card, so all three
    // mean the same thing by "spot", including root's 1:1 (no AMM, price 1 by
    // definition). It returns null for an unusable pool rather than 0, and the map's
    // existing contract already excludes a null-priced membership from the totals --
    // which under-reports rather than mis-denominates, the same trade as before.
    return new Map(
      rows.map((row) => [
        Number(row.netuid),
        spotPriceTao(
          Number(row.netuid),
          row.tao_in_pool_tao,
          row.alpha_in_pool,
        ),
      ]),
    );
  } catch (err) {
    console.error("subnet_snapshots alpha-price query failed:", err);
    await captureDataApiError(err, "subnet-snapshots-alpha-price-query", env);
    return new Map();
  }
}

// hotkey -> nominator_count for every permitted validator, from the store table
// tests/fixtures/sqlite-schema/0012 created (#9146).
//
// CORRELATED SUBQUERY, NOT AN IN LIST, and that is load-bearing rather than
// stylistic: the leaderboard covers ~1,031 hotkeys and the Workers store binding
// caps a statement at 100 bound parameters, so an inlined key list would need
// chunking into a dozen round trips (what the lakehouse reader has to do,
// having no join to reach for). Joining against `neurons` inside SQLite costs
// ZERO bound parameters and one query, and keeps the filter exactly in step
// with the leaderboard's own `validator_permit = TRUE AND hotkey IS NOT NULL`.
//
// Same degrade-to-empty-map contract as loadStoreAlphaPricesByNetuid above: on
// any failure every nominator_count stays null, which is precisely the state
// this tier served before the table existed -- so a broken read is a lost
// enrichment, never a wrong number.
//
// ABSENCE MEANS ZERO, BUT ONLY FROM A FRESH SCAN (#9314). The producer emits a
// row only for hotkeys it saw holding stake in SubtensorModule::Alpha, and it
// has never once recorded a zero -- measured 2026-08-03, `WHERE
// nominator_count = 0` returns nothing across 112,550 rows. So 471 of the 1,028
// permitted validators have no row, and reading that as "unknown" understated
// what we actually know: the producer's pass over Alpha is EXHAUSTIVE, so a
// permitted validator absent from a completed pass genuinely has zero distinct
// coldkeys staked to it.
//
// The freshness gate is what makes that inference safe rather than reckless.
// Against a stale or truncated table the same absence means "we have not
// looked recently", and publishing 0 for it would be a confident wrong number
// -- the exact failure this family's own doctrine says is worse than an absent
// one. So the zero-fill is conditioned on the scan being within the SAME
// threshold the staleness watchdog alarms on, imported rather than restated so
// the two can never disagree about what "fresh" means.
async function loadNominatorCountsFromStore(
  sql: PgSql,
  env: DataApiEnv,
): Promise<Map<string, number>> {
  try {
    // LEFT JOIN from the permitted set, not an inner read of the counts table:
    // the rows with no match are precisely the ones the zero-fill is about, so
    // they have to survive the query to be seen at all.
    const rows = await sql<{
      hotkey: Neurons["hotkey"];
      nominator_count: ValidatorNominatorCounts["nominator_count"] | null;
      scan_at: ValidatorNominatorCounts["captured_at"] | null;
    }>`
      SELECT n.hotkey AS hotkey,
             c.nominator_count AS nominator_count,
             (SELECT MAX(captured_at) FROM validator_nominator_counts) AS scan_at
      FROM (
        SELECT DISTINCT hotkey FROM neurons
        WHERE validator_permit = TRUE AND hotkey IS NOT NULL
      ) n
      LEFT JOIN validator_nominator_counts c ON c.hotkey = n.hotkey`;
    return fillConfirmedZeros(
      rows,
      nominatorCountsByHotkey(rows),
      Date.now(),
      VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    );
  } catch (err) {
    console.error("validator_nominator_counts query failed:", err);
    await captureDataApiError(err, "validator-nominator-counts-query", env);
    return new Map();
  }
}

// The single-hotkey twin of the above, for /api/v1/validators/{hotkey}. Same
// rule: a real row wins, absence from a FRESH scan is a confirmed zero, and
// absence from a stale one stays null.
async function loadNominatorCountFromStore(
  sql: PgSql,
  hotkey: string,
  env: DataApiEnv,
): Promise<number | null> {
  try {
    const rows = await sql.unsafe<{
      hotkey: ValidatorNominatorCounts["hotkey"];
      nominator_count: ValidatorNominatorCounts["nominator_count"] | null;
      scan_at: ValidatorNominatorCounts["captured_at"] | null;
    }>(
      "SELECT ? AS hotkey," +
        " (SELECT nominator_count FROM validator_nominator_counts WHERE hotkey = ?) AS nominator_count," +
        " (SELECT MAX(captured_at) FROM validator_nominator_counts) AS scan_at",
      [hotkey, hotkey],
    );
    const counts = fillConfirmedZeros(
      rows,
      nominatorCountsByHotkey(rows),
      Date.now(),
      VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS,
    );
    return counts.get(hotkey) ?? null;
  } catch (err) {
    console.error("validator_nominator_counts detail query failed:", err);
    await captureDataApiError(
      err,
      "validator-nominator-count-detail-query",
      env,
    );
    return null;
  }
}

// Pure matcher: resolves a pathname to its D1 route handler (or null for
// every non-neurons-family route, which then flows on to the dispatcher's
// remaining tiers unchanged). Split from execution so the caller can check
// the binding exactly once, after a route has actually matched.
/**
 * The runner every route in the three blocks below uses.
 *
 * This used to be `routeStore`, which asked NEON_READ_LANES whether the route
 * was allowed on Neon yet and returned undefined -- a 503 -- when it was not.
 * That question had an answer while D1 was the other side of it. It has none
 * now: Neon is the only store these handlers can reach, so the flag could not
 * send a read anywhere else, only refuse it.
 *
 * A GATE THAT CAN ONLY FAIL CLOSED IS NOT A SAFETY PROPERTY, it is an outage
 * waiting on a typo. All 32 routes the three matchers accept were named in
 * NEON_READ_ROUTE_TABLES and every table they declared was named in
 * NEON_READ_LANES in all three configs, so the gate answered yes 32 times out
 * of 32 -- while dropping any single table from the flag would have 503'd up to
 * 19 routes at once. The flag's own doc said a typo in it "does not fail, warn,
 * or degrade", which was survivable when the fallback was another store.
 *
 * What remains is the question that still has two answers: is a store bound at
 * all. The callers keep the 503 for that, which is why this returns undefined
 * rather than throwing (#10162 -- a runner over an absent binding was worse).
 */
function routeRunner(
  env: DataApiEnv,
  ctx: ExecutionContext,
): PgSql | undefined {
  return env.HYPERDRIVE ? createPgSql(env.HYPERDRIVE, ctx) : undefined;
}

/**
 * The `[start, end]` snapshot dates of an N-day window over `neuron_daily`,
 * anchored on the newest row the table HAS rather than on the clock.
 *
 * WHY IT IS TWO QUERIES AND NOT ONE (#9798). This used to be a single statement
 * whose WHERE clause read `snapshot_date >= (SELECT date(MAX(snapshot_date),
 * '-N days') FROM neuron_daily)`. `date(x, '-N days')` is SQLite's; Postgres
 * has no such function, so the moment #9784 moved these routes to Neon the
 * subquery yielded nothing, `>=` matched nothing, and `/subnets/{netuid}/
 * history` and `/subnets/movers` each served a schema-stable 200 with ZERO rows
 * until #9792 rolled the flag back.
 *
 * Splitting it removes the dialect from the question rather than translating
 * it: reading a MAX is portable, `shiftIsoDate` is arithmetic, and binding a
 * date literal is portable. There is no date function left for two dialects to
 * disagree about, which is why this cannot regress the way the last one did.
 *
 * The extra round trip buys that outright. Both statements are single-row
 * aggregate reads against the table's own index, on a path that already issues
 * a second, far heavier query for the rows themselves.
 *
 * ANCHORED ON THE DATA, deliberately -- see iso-date-window.ts. Shifting from
 * `Date.now()` (what windowCutoffDate does for the history routes) would return
 * a SHORT window whenever the producer has fallen a day behind, which is the
 * failure this whole family is being watched for.
 *
 * Returns nulls when the table (or the netuid's slice of it) is empty, which is
 * exactly what the NULL subquery used to produce -- every caller already
 * branches on that.
 *
 * EXPORTED FOR ASSERTION rather than for a caller:
 * only two of its four query shapes are reachable from today's routes
 * (`CHAIN_TURNOVER_WINDOWS`/`MOVERS_WINDOWS` are `Record<string, number>`, so a
 * chain-wide call can never carry a null window, while HISTORY_WINDOW_DAYS's
 * `all: null` makes the per-netuid one). Leaving the other two untested because
 * no current caller reaches them is how a window function ends up wrong the
 * first time a route needs it -- and annotating them out of coverage would say
 * the same thing more quietly.
 */
export async function neuronDailyWindowBounds(
  sql: PgSql,
  days: number | null,
  netuid: number | null = null,
): Promise<{ startDate: string | null; endDate: string | null }> {
  const maxRows =
    netuid == null
      ? await sql<{
          end_date: NeuronDaily["snapshot_date"] | null;
        }>`SELECT MAX(snapshot_date) AS end_date FROM neuron_daily`
      : await sql<{
          end_date: NeuronDaily["snapshot_date"] | null;
        }>`SELECT MAX(snapshot_date) AS end_date FROM neuron_daily WHERE netuid = ${netuid}`;
  const endDate = (maxRows[0]?.end_date ?? null) as string | null;
  if (endDate == null) return { startDate: null, endDate: null };

  // A null window means "everything", so there is no cutoff to bind and the
  // start is the table's own minimum.
  const cutoff = days == null ? null : shiftIsoDate(endDate, -days);
  const minRows =
    netuid == null
      ? cutoff == null
        ? await sql<{
            start_date: NeuronDaily["snapshot_date"] | null;
          }>`SELECT MIN(snapshot_date) AS start_date FROM neuron_daily`
        : await sql<{
            start_date: NeuronDaily["snapshot_date"] | null;
          }>`SELECT MIN(snapshot_date) AS start_date FROM neuron_daily WHERE snapshot_date >= ${cutoff}`
      : cutoff == null
        ? await sql<{
            start_date: NeuronDaily["snapshot_date"] | null;
          }>`SELECT MIN(snapshot_date) AS start_date FROM neuron_daily WHERE netuid = ${netuid}`
        : await sql<{
            start_date: NeuronDaily["snapshot_date"] | null;
          }>`SELECT MIN(snapshot_date) AS start_date FROM neuron_daily WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}`;
  return {
    startDate: (minRows[0]?.start_date ?? null) as string | null,
    endDate,
  };
}

/**
 * The subnet's burn hotkey, or null when it burns nothing (#11094).
 *
 * A subnet with SubtensorModule.MinerBurned > 0 routes that fraction of miner
 * incentive to the SubtensorModule.SubnetOwnerHotkey UID -- verified against
 * SN13 (owner uid 162, incentive 0.715557 vs MinerBurned 0.7155707) and the
 * zero cases (SN53/SN75, owner UIDs at incentive 0). Both halves are chain
 * captures already in this database: the newest ownership row and the newest
 * snapshot's burned fraction. Null -- no exclusion anywhere -- when either
 * half is missing or the fraction is zero, so a subnet with no burn is
 * untouched and a gap in the capture never invents one.
 */
async function resolveBurnHotkey(
  sql: PgSql,
  netuid: number,
): Promise<string | null> {
  const owner = await sql<{ owner_hotkey: string | null }>`
    SELECT owner_hotkey FROM subnet_ownership
    WHERE netuid = ${netuid}
    ORDER BY captured_at DESC
    LIMIT 1`;
  const hotkey = owner[0]?.owner_hotkey;
  if (!hotkey) return null;
  const snapshot = await sql<{ miner_burned_fraction: number | null }>`
    SELECT miner_burned_fraction FROM subnet_snapshots
    WHERE netuid = ${netuid}
    ORDER BY snapshot_date DESC
    LIMIT 1`;
  const fraction = Number(snapshot[0]?.miner_burned_fraction ?? 0);
  return Number.isFinite(fraction) && fraction > 0 ? hotkey : null;
}

async function loadGlobalValidatorsFromStore(
  sql: PgSql,
  env: DataApiEnv,
  sort: string,
  limit: number,
  includeAll = false,
) {
  const [rows, priceByNetuid, nominatorCounts, tempos, identityByColdkey] =
    await Promise.all([
      sql<{
        netuid: Neurons["netuid"];
        uid: Neurons["uid"];
        hotkey: Neurons["hotkey"];
        coldkey: Neurons["coldkey"];
        validator_trust: Neurons["validator_trust"];
        emission_tao: Neurons["emission_tao"];
        stake_tao: Neurons["stake_tao"];
        block_number: Neurons["block_number"];
        captured_at: Neurons["captured_at"];
        take: Neurons["take"];
      }>`
      SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, stake_tao, block_number, captured_at, take
      FROM neurons WHERE validator_permit = TRUE AND hotkey IS NOT NULL
      ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
      loadStoreAlphaPricesByNetuid(sql, env),
      loadNominatorCountsFromStore(sql, env),
      loadSubnetTemposFromStore(sql, env),
      loadIdentityByColdkeyMap((statement, parameters) =>
        sql.unsafe<AccountIdentityStoreRow>(statement, parameters),
      ),
    ]);
  return buildGlobalValidators(rows, {
    sort,
    limit,
    includeAll,
    priceByNetuid,
    featuredHotkeys: new Set(),
    identityByColdkey,
    nominatorCounts,
    tempoByNetuid: tempos,
  });
}

// Precompute account and validator directories for single-read
// cold paths; advance the versioned fallback pointer only after both are stored.
export { materializationFromUnknown };

async function latestCompletedNeuronSnapshot(
  sql: PgSql,
): Promise<number | null> {
  const rows = await sql<{ captured_at: number | string | null }>`
    SELECT captured_at FROM neurons_passes
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1`;
  const capturedAt = Number(rows[0]?.captured_at);
  return Number.isSafeInteger(capturedAt) && capturedAt > 0 ? capturedAt : null;
}

// Build both browser directories once per complete neuron snapshot. The final
// boundary check prevents an in-place partial pass from publishing mixed data.
export async function refreshExplorerDirectoryMaterialization(
  env: DataApiEnv,
  ctx: ExecutionContext,
  capturedAt: number,
): Promise<boolean> {
  if (!env.METAGRAPH_CONTROL) return false;
  const existing = explorerDirectoryRefreshes.get(capturedAt);
  if (existing) return existing;

  const promise = (async () => {
    const previousPointer = await readExplorerDirectoryPointer(
      env.METAGRAPH_CONTROL,
    );
    if (previousPointer?.captured_at === capturedAt) {
      if (previousPointer.route_values_ready) return true;
      const previous = await readExplorerDirectoryMaterialization(
        env.METAGRAPH_CONTROL,
      );
      if (previous?.captured_at === capturedAt) {
        await Promise.all([
          env.METAGRAPH_CONTROL.put(
            KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
            JSON.stringify(previous.accounts),
          ),
          env.METAGRAPH_CONTROL.put(
            KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
            JSON.stringify(previous.validators),
          ),
        ]);
        await env.METAGRAPH_CONTROL.put(
          KV_EXPLORER_DIRECTORIES_CURRENT,
          JSON.stringify({
            schema_version: 1,
            captured_at: capturedAt,
            route_values_ready: true,
          }),
        );
        return true;
      }
    }
    const sql = routeRunner(env, ctx);
    if (!sql) return false;
    const latest = await latestCompletedNeuronSnapshot(sql);
    const newestRows = await sql<{ captured_at: number | string | null }>`
      SELECT MAX(captured_at) AS captured_at FROM neurons`;
    const newestCapturedAt = Number(newestRows[0]?.captured_at);
    if (
      latest !== capturedAt ||
      !Number.isSafeInteger(newestCapturedAt) ||
      newestCapturedAt !== capturedAt
    ) {
      return false;
    }

    const [accountRows, priceByNetuid, globalValidators] = await Promise.all([
      sql<{
        netuid: Neurons["netuid"];
        uid: Neurons["uid"];
        hotkey: Neurons["hotkey"];
        coldkey: Neurons["coldkey"];
        validator_permit: Neurons["validator_permit"];
        emission_tao: Neurons["emission_tao"];
        stake_tao: Neurons["stake_tao"];
        block_number: Neurons["block_number"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, stake_tao, block_number, captured_at
        FROM neurons WHERE hotkey IS NOT NULL
        ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
      loadStoreAlphaPricesByNetuid(sql, env),
      loadGlobalValidatorsFromStore(
        sql,
        env,
        "total_stake",
        GLOBAL_VALIDATOR_LIMIT_MAX,
        true,
      ),
    ]);
    const accounts = buildAccountHolderDirectory(accountRows, {
      priceByNetuid,
    });
    const validators = buildValidatorOperatorDirectory(globalValidators);

    // Refuse publication if a newer in-place pass began during the fold.
    const finalLatest = await latestCompletedNeuronSnapshot(sql);
    const finalRows = await sql<{ captured_at: number | string | null }>`
      SELECT MAX(captured_at) AS captured_at FROM neurons`;
    const finalCapturedAt = Number(finalRows[0]?.captured_at);
    if (finalLatest !== capturedAt || finalCapturedAt !== capturedAt) {
      return false;
    }

    const value: ExplorerDirectoryMaterialization = {
      schema_version: 1,
      captured_at: capturedAt,
      accounts,
      validators,
    };
    await Promise.all([
      env.METAGRAPH_CONTROL.put(
        explorerDirectoriesSnapshotKey(capturedAt),
        JSON.stringify(value),
      ),
      env.METAGRAPH_CONTROL.put(
        KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
        JSON.stringify(accounts),
      ),
      env.METAGRAPH_CONTROL.put(
        KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
        JSON.stringify(validators),
      ),
    ]);
    await env.METAGRAPH_CONTROL.put(
      KV_EXPLORER_DIRECTORIES_CURRENT,
      JSON.stringify({
        schema_version: 1,
        captured_at: capturedAt,
        route_values_ready: true,
      }),
    );
    if (
      previousPointer &&
      previousPointer.captured_at !== capturedAt &&
      typeof env.METAGRAPH_CONTROL.delete === "function"
    ) {
      try {
        await env.METAGRAPH_CONTROL.delete(
          explorerDirectoriesSnapshotKey(previousPointer.captured_at),
        );
      } catch (error) {
        // Cleanup is not part of publication.
        console.error(
          "explorer directory materialization cleanup failed:",
          error,
        );
      }
    }
    return true;
  })().finally(() => {
    explorerDirectoryRefreshes.delete(capturedAt);
  });
  explorerDirectoryRefreshes.set(capturedAt, promise);
  return promise;
}

function scheduleExplorerDirectoryRefresh(
  env: DataApiEnv,
  ctx: ExecutionContext,
  capturedAt: number | Promise<number>,
) {
  ctx.waitUntil(
    Promise.resolve(capturedAt)
      .then((stamp) => refreshExplorerDirectoryMaterialization(env, ctx, stamp))
      .catch((error) => {
        console.error("explorer directory publication failed:", error);
      }),
  );
}

function matchNeuronsStoreRoute(url: URL): NeuronsStoreRouteHandler | null {
  // Internal freshness stamp, bounded by the latest complete pass.
  if (url.pathname === "/api/v1/internal/neurons-snapshot-stamp") {
    return async (sql, env, ctx) => {
      const capturedAt = await latestCompletedNeuronSnapshot(sql);
      if (capturedAt === null) return json({ captured_at: null });

      // Keep the ready hot path to one tiny pointer read.
      const pointer = await readExplorerDirectoryPointer(env.METAGRAPH_CONTROL);
      if (pointer?.captured_at === capturedAt && pointer.route_values_ready) {
        return json({ captured_at: capturedAt });
      }

      // Keep serving the last complete stamp while this background fold runs.
      // Legacy pointers reach this once to backfill the route-specific values.
      ctx.waitUntil(
        refreshExplorerDirectoryMaterialization(env, ctx, capturedAt).catch(
          (error) => {
            console.error("explorer directory materialization failed:", error);
            return false;
          },
        ),
      );
      const servedStamp = pointer?.captured_at;
      return json({
        captured_at:
          typeof servedStamp === "number" && servedStamp < capturedAt
            ? servedStamp
            : capturedAt,
      });
    };
  }

  // GET /api/v1/subnets/:netuid/metagraph -- twin of the Postgres route of
  // the same name below. immunity_period comes from subnet_hyperparams,
  // which has no D1 home: null is loadSubnetImmunityPeriod's own degraded
  // value (formatNeuron then omits the immunity-window fields).
  const subnetMetagraph = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/metagraph$/,
  );
  if (subnetMetagraph) {
    return async (sql) => {
      const netuid = Number(subnetMetagraph[1]);
      const validatorsOnly =
        url.searchParams.get("validator_permit") === "true";
      const rows = validatorsOnly
        ? await sql.unsafe<NeuronColumnsRow>(
            `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = TRUE ORDER BY uid`,
            [netuid],
          )
        : await sql.unsafe<NeuronColumnsRow>(
            `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? ORDER BY uid`,
            [netuid],
          );
      return json(
        buildSubnetMetagraph(rows, netuid, {
          immunityPeriod: null,
          burnHotkey: await resolveBurnHotkey(sql, netuid),
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/neurons/:uid/history -- checked before the
  // non-history detail match below would swallow... (distinct regexes, but
  // kept adjacent for the same reading order as the Postgres dispatcher).
  const neuronHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)\/history$/,
  );
  if (neuronHistoryMatch) {
    return async (sql) => {
      const netuid = Number(neuronHistoryMatch[1]);
      const uid = Number(neuronHistoryMatch[2]);
      const cutoff = windowCutoffDate(
        url,
        HISTORY_WINDOW_DAYS,
        DEFAULT_HISTORY_WINDOW,
      );
      // sql.unsafe, not the tagged form: the tag binds every interpolation as a
      // parameter, so a column-list constant can only be threaded this way --
      // the same reason the neurons reads above use it for NEURON_COLUMNS.
      // Hand-transcribing the list here is what dropped `take` (#9523).
      const rows = cutoff
        ? await sql.unsafe<NeuronDailyReadRow>(
            `SELECT ${NEURON_DAILY_READ_COLUMNS}
          FROM neuron_daily
          WHERE netuid = ? AND uid = ? AND snapshot_date >= ?
          ORDER BY snapshot_date DESC LIMIT ?`,
            [netuid, uid, cutoff, MAX_HISTORY_POINTS],
          )
        : await sql.unsafe<NeuronDailyReadRow>(
            `SELECT ${NEURON_DAILY_READ_COLUMNS}
          FROM neuron_daily
          WHERE netuid = ? AND uid = ?
          ORDER BY snapshot_date DESC LIMIT ?`,
            [netuid, uid, MAX_HISTORY_POINTS],
          );
      return json(
        buildNeuronHistory(rows, netuid, uid, {
          window: windowLabelFor(
            url,
            HISTORY_WINDOW_DAYS,
            DEFAULT_HISTORY_WINDOW,
          ),
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/neurons/:uid
  const neuronDetail = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)$/,
  );
  if (neuronDetail) {
    return async (sql) => {
      const netuid = Number(neuronDetail[1]);
      const uid = Number(neuronDetail[2]);
      const rows = await sql.unsafe<NeuronColumnsRow>(
        `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
        [netuid, uid],
      );
      return json(
        buildNeuronDetail(rows[0] ?? null, netuid, { immunityPeriod: null }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/validators.
  //
  // `featured` was served on every row and was permanently FALSE (#11080). The
  // comment here used to say featured_validators "stays a maintainer-toggled
  // Postgres side table until its own port" and that the empty set was
  // loadFeaturedHotkeys's degraded value -- but loadFeaturedHotkeys did not
  // exist, no producer wrote the table and no reader read it, so a badge for
  // paying partners could not be true. A degraded value nothing can ever
  // upgrade is just a constant.
  //
  // The curation now lives in registry/featured-validators.json, generated to a
  // frozen constant. Registry rather than a live table because it is a
  // commercial arrangement and belongs in a reviewed pull request; a constant
  // rather than a runtime read because this worker sits at the startup CPU
  // limit and a badge must not depend on a fetch succeeding.
  const subnetValidators = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/validators$/,
  );
  if (subnetValidators) {
    return async (sql) => {
      const netuid = Number(subnetValidators[1]);
      const rows = await sql.unsafe<NeuronColumnsRow>(
        `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = TRUE ORDER BY stake_tao DESC, uid ASC`,
        [netuid],
      );
      return json(
        buildSubnetValidators(rows, netuid, {
          featuredHotkeys: FEATURED_HOTKEY_SET,
        }),
      );
    };
  }

  // GET /api/v1/validators/:hotkey/history
  const validatorHistoryMatch = url.pathname.match(
    /^\/api\/v1\/validators\/([^/]+)\/history$/,
  );
  if (validatorHistoryMatch) {
    return async (sql) => {
      const hotkey = decodeURIComponent(validatorHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        HISTORY_WINDOW_DAYS,
        DEFAULT_HISTORY_WINDOW,
      );
      // #9383: scoped to one subnet, the per-(hotkey, netuid) columns become
      // well-defined and are returned alongside the totals. Two things change
      // besides the projection: alpha is reported natively (the TAO conversion is
      // kept too, so the point is comparable with the unscoped series), and the
      // `validator_permit = TRUE` filter is dropped -- a day the permit was lost is
      // the event an operator most needs to see, and filtering it away makes it
      // look identical to a day the poller missed.
      // Same normalisation the account-family routes use for their own netuid
      // filter: absent/blank is "unscoped", and anything that is not a
      // non-negative safe integer is treated as absent rather than guessed at.
      // The public handler rejects a malformed value with a 400 before it ever
      // reaches here; this is the tier's own floor.
      const rawNetuid = url.searchParams.get("netuid");
      const parsedNetuid =
        rawNetuid == null || rawNetuid.trim() === "" ? null : Number(rawNetuid);
      const netuid =
        parsedNetuid != null &&
        Number.isSafeInteger(parsedNetuid) &&
        parsedNetuid >= 0
          ? parsedNetuid
          : null;
      if (netuid != null) {
        const scopedRows = cutoff
          ? await sql<NeuronDailyPoint>`
            SELECT nd.snapshot_date AS snapshot_date, 1 AS subnet_count,
              nd.netuid AS netuid, nd.uid AS uid,
              nd.stake_tao AS stake_alpha, nd.emission_tao AS emission_alpha,
              nd.validator_trust AS validator_trust, nd.consensus AS consensus,
              nd.dividends AS dividends, nd.take AS take,
              nd.validator_permit AS validator_permit,
              s.total_stake_tao AS subnet_total_stake,
              nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END AS total_stake_tao,
              nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END AS total_emission_tao
            FROM neuron_daily nd
            LEFT JOIN subnet_snapshots s
              ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
            WHERE nd.hotkey = ${hotkey} AND nd.netuid = ${netuid} AND nd.snapshot_date >= ${cutoff}
            ORDER BY nd.snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
          : await sql<NeuronDailyPoint>`
            SELECT nd.snapshot_date AS snapshot_date, 1 AS subnet_count,
              nd.netuid AS netuid, nd.uid AS uid,
              nd.stake_tao AS stake_alpha, nd.emission_tao AS emission_alpha,
              nd.validator_trust AS validator_trust, nd.consensus AS consensus,
              nd.dividends AS dividends, nd.take AS take,
              nd.validator_permit AS validator_permit,
              s.total_stake_tao AS subnet_total_stake,
              nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END AS total_stake_tao,
              nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END AS total_emission_tao
            FROM neuron_daily nd
            LEFT JOIN subnet_snapshots s
              ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
            WHERE nd.hotkey = ${hotkey} AND nd.netuid = ${netuid}
            ORDER BY nd.snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
        return json(
          buildValidatorHistory(scopedRows, hotkey, {
            window: windowLabelFor(
              url,
              HISTORY_WINDOW_DAYS,
              DEFAULT_HISTORY_WINDOW,
            ),
            netuid,
          }),
        );
      }
      const rows = cutoff
        ? await sql<{
            snapshot_date: NeuronDaily["snapshot_date"];
            subnet_count: string | number;
            total_stake_tao: string | number | null;
            total_emission_tao: string | number | null;
          }>`
          SELECT nd.snapshot_date AS snapshot_date, COUNT(DISTINCT nd.netuid) AS subnet_count,
            SUM(nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END) AS total_stake_tao,
            SUM(nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END) AS total_emission_tao
          FROM neuron_daily nd
          LEFT JOIN subnet_snapshots s
            ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
          WHERE nd.hotkey = ${hotkey} AND nd.validator_permit = TRUE AND nd.snapshot_date >= ${cutoff}
          GROUP BY nd.snapshot_date ORDER BY nd.snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql<{
            snapshot_date: NeuronDaily["snapshot_date"];
            subnet_count: string | number;
            total_stake_tao: string | number | null;
            total_emission_tao: string | number | null;
          }>`
          SELECT nd.snapshot_date AS snapshot_date, COUNT(DISTINCT nd.netuid) AS subnet_count,
            SUM(nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END) AS total_stake_tao,
            SUM(nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END) AS total_emission_tao
          FROM neuron_daily nd
          LEFT JOIN subnet_snapshots s
            ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
          WHERE nd.hotkey = ${hotkey} AND nd.validator_permit = TRUE
          GROUP BY nd.snapshot_date ORDER BY nd.snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildValidatorHistory(rows, hotkey, {
          window: windowLabelFor(
            url,
            HISTORY_WINDOW_DAYS,
            DEFAULT_HISTORY_WINDOW,
          ),
        }),
      );
    };
  }

  // GET /api/v1/validators?sort=&limit=. Prices, nominator counts, tempos
  // and public account identities come from the current store. Historical stake scans
  // are unnecessary: realized-return fields remain null (#12015).
  if (url.pathname === "/api/v1/validators") {
    return async (sql, env) => {
      const sortParam = url.searchParams.get("sort");
      const sort =
        sortParam !== null && GLOBAL_VALIDATOR_SORTS.includes(sortParam)
          ? sortParam
          : DEFAULT_GLOBAL_VALIDATOR_SORT;
      const limitParam = Number(url.searchParams.get("limit"));
      const limit =
        Number.isInteger(limitParam) &&
        limitParam >= 1 &&
        limitParam <= GLOBAL_VALIDATOR_LIMIT_MAX
          ? limitParam
          : GLOBAL_VALIDATOR_LIMIT_DEFAULT;
      return json(await loadGlobalValidatorsFromStore(sql, env, sort, limit));
    };
  }

  // Website-sized grouped validator directory.
  if (url.pathname === "/api/v1/validators/operators") {
    return async (sql, env, ctx) => {
      const materialized = await readExplorerDirectoryMaterialization(
        env.METAGRAPH_CONTROL,
      );
      if (materialized) {
        // Keep the verified response available if the freshness read fails.
        scheduleExplorerDirectoryRefresh(
          env,
          ctx,
          latestCompletedNeuronSnapshot(sql).then(
            (latest) => latest ?? materialized.captured_at,
          ),
        );
        return json(materialized.validators);
      }
      return json(
        buildValidatorOperatorDirectory(
          await loadGlobalValidatorsFromStore(
            sql,
            env,
            "total_stake",
            GLOBAL_VALIDATOR_LIMIT_MAX,
            true,
          ),
        ),
      );
    };
  }

  // GET /api/v1/validators/:hotkey
  const validatorDetail = url.pathname.match(
    /^\/api\/v1\/validators\/([^/]+)$/,
  );
  if (validatorDetail) {
    return async (sql, env) => {
      const hotkey = decodeURIComponent(validatorDetail[1]);
      const [rows, priceByNetuid, nominatorCount, tempos, identityByColdkey] =
        await Promise.all([
          sql.unsafe<NeuronColumnsRow>(
            `SELECT ${NEURON_COLUMNS}, netuid FROM neurons WHERE hotkey = ? AND validator_permit = TRUE ORDER BY netuid ASC, uid ASC`,
            [hotkey],
          ),
          loadStoreAlphaPricesByNetuid(sql, env),
          loadNominatorCountFromStore(sql, hotkey, env),
          loadSubnetTemposFromStore(sql, env),
          loadIdentityByColdkeyMap((s, p) =>
            sql.unsafe<AccountIdentityStoreRow>(s, p),
          ),
        ]);
      return json(
        buildValidatorDetail(rows, hotkey, {
          identityByColdkey,
          priceByNetuid,
          nominatorCount,
          tempoByNetuid: tempos,
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/concentration/history -- before the plain
  // /concentration match, same as the Postgres dispatcher's ordering.
  const concentrationHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/concentration\/history$/,
  );
  if (concentrationHistoryMatch) {
    return async (sql) => {
      const netuid = Number(concentrationHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        CONCENTRATION_HISTORY_WINDOWS,
        DEFAULT_CONCENTRATION_HISTORY_WINDOW,
      );
      const rows = await sql<{
        snapshot_date: NeuronDaily["snapshot_date"];
        stake_tao: NeuronDaily["stake_tao"];
        emission_tao: NeuronDaily["emission_tao"];
      }>`
        SELECT snapshot_date, stake_tao, emission_tao
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
    };
  }

  // GET /api/v1/subnets/:netuid/concentration
  const subnetConcentration = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/concentration$/,
  );
  if (subnetConcentration) {
    return async (sql) => {
      const netuid = Number(subnetConcentration[1]);
      const rows = await sql<{
        stake_tao: Neurons["stake_tao"];
        emission_tao: Neurons["emission_tao"];
        coldkey: Neurons["coldkey"];
        validator_permit: Neurons["validator_permit"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT stake_tao, emission_tao, coldkey, validator_permit, captured_at
        FROM neurons WHERE netuid = ${netuid}`;
      return json(buildConcentration(rows, netuid));
    };
  }

  // GET /api/v1/subnets/:netuid/performance/history
  const performanceHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/performance\/history$/,
  );
  if (performanceHistoryMatch) {
    return async (sql) => {
      const netuid = Number(performanceHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        PERFORMANCE_HISTORY_WINDOWS,
        DEFAULT_PERFORMANCE_HISTORY_WINDOW,
      );
      const rows = await sql.unsafe<PerformanceHistoryRow>(
        `SELECT ${PERFORMANCE_HISTORY_READ_COLUMNS}
        FROM neuron_daily
        WHERE netuid = ? AND snapshot_date >= ?
        ORDER BY snapshot_date DESC LIMIT ?`,
        [netuid, cutoff, PERFORMANCE_HISTORY_ROW_CAP],
      );
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
    };
  }

  // GET /api/v1/subnets/:netuid/performance
  const subnetPerformance = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/performance$/,
  );
  if (subnetPerformance) {
    return async (sql) => {
      const netuid = Number(subnetPerformance[1]);
      const rows = await sql<{
        incentive: Neurons["incentive"];
        dividends: Neurons["dividends"];
        trust: Neurons["trust"];
        consensus: Neurons["consensus"];
        validator_trust: Neurons["validator_trust"];
        active: Neurons["active"];
        validator_permit: Neurons["validator_permit"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT incentive, dividends, trust, consensus, validator_trust, active, validator_permit, captured_at
        FROM neurons WHERE netuid = ${netuid}`;
      return json(buildSubnetPerformance(rows, netuid));
    };
  }

  // GET /api/v1/chain/concentration
  if (url.pathname === "/api/v1/chain/concentration") {
    return async (sql) => {
      const rows = await sql<{
        stake_tao: Neurons["stake_tao"];
        emission_tao: Neurons["emission_tao"];
        coldkey: Neurons["coldkey"];
        validator_permit: Neurons["validator_permit"];
        netuid: Neurons["netuid"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT stake_tao, emission_tao, coldkey, validator_permit, netuid, captured_at
        FROM neurons`;
      return json(buildChainConcentration(rows));
    };
  }

  // GET /api/v1/chain/concentration/subnets (#9717): the SAME read as
  // /chain/concentration above -- every subnet's neurons, no filter -- kept
  // grouped by netuid instead of collapsed into one network aggregate. Adding
  // no new read class is the point: the rows were always there.
  if (url.pathname === "/api/v1/chain/concentration/subnets") {
    return async (sql) => {
      // Parsed BEFORE the read, with the SAME function api.ts validates with,
      // so the two cannot disagree about what `limit=0` means and a rejected
      // request never costs a ~30,000-row scan. api.ts rejects ahead of the
      // proxy, so this is defence in depth -- but a real 400 rather than an
      // unreachable annotation, so it is testable and a direct data-api call
      // is not a way around validation.
      const query = parseConcentrationRankingQuery(url.searchParams, {
        limitDefault: CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
        limitMax: CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
      });
      if ("error" in query) return json({ error: query.error }, 400);
      const rows = await sql<{
        stake_tao: Neurons["stake_tao"];
        emission_tao: Neurons["emission_tao"];
        coldkey: Neurons["coldkey"];
        hotkey: Neurons["hotkey"];
        validator_permit: Neurons["validator_permit"];
        netuid: Neurons["netuid"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT stake_tao, emission_tao, coldkey, hotkey, validator_permit, netuid, captured_at
        FROM neurons`;
      // #11098/#11094 in bulk: every subnet's burn hotkey in two grouped
      // reads, so the emission lenses and the miner counts apply the same
      // discipline the per-subnet routes do. A netuid missing from either
      // half simply has no map entry -- no exclusion invented.
      const owners = await sql<{ netuid: number; owner_hotkey: string | null }>`
        SELECT DISTINCT ON (netuid) netuid, owner_hotkey
        FROM subnet_ownership
        ORDER BY netuid, captured_at DESC`;
      const fractions = await sql<{
        netuid: number;
        miner_burned_fraction: number | null;
      }>`
        SELECT DISTINCT ON (netuid) netuid, miner_burned_fraction
        FROM subnet_snapshots
        ORDER BY netuid, snapshot_date DESC`;
      const burnHotkeyByNetuid = new Map<number, string>();
      const fractionByNetuid = new Map(
        fractions.map((row) => [row.netuid, Number(row.miner_burned_fraction)]),
      );
      for (const row of owners) {
        const fraction = fractionByNetuid.get(row.netuid);
        if (
          row.owner_hotkey &&
          Number.isFinite(fraction) &&
          (fraction as number) > 0
        ) {
          burnHotkeyByNetuid.set(row.netuid, row.owner_hotkey);
        }
      }
      return json(
        buildSubnetConcentrationRanking(rows, {
          ...query,
          burnHotkeyByNetuid,
        }),
      );
    };
  }

  // GET /api/v1/chain/performance
  if (url.pathname === "/api/v1/chain/performance") {
    return async (sql) => {
      const rows = await sql<{
        incentive: Neurons["incentive"];
        dividends: Neurons["dividends"];
        trust: Neurons["trust"];
        consensus: Neurons["consensus"];
        validator_trust: Neurons["validator_trust"];
        active: Neurons["active"];
        validator_permit: Neurons["validator_permit"];
        netuid: Neurons["netuid"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT incentive, dividends, trust, consensus, validator_trust, active, validator_permit, netuid, captured_at
        FROM neurons`;
      return json(buildChainPerformance(rows));
    };
  }

  // GET /api/v1/subnets/:netuid/idle-stake
  const subnetIdleStake = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/idle-stake$/,
  );
  if (subnetIdleStake) {
    return async (sql) => {
      const netuid = Number(subnetIdleStake[1]);
      const rows = await sql<{
        stake_tao: Neurons["stake_tao"];
        dividends: Neurons["dividends"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT stake_tao, dividends, captured_at FROM neurons WHERE netuid = ${netuid}`;
      return json(buildSubnetIdleStake(rows, netuid));
    };
  }

  // GET /api/v1/chain/idle-stake
  if (url.pathname === "/api/v1/chain/idle-stake") {
    return async (sql) => {
      const rows = await sql<{
        stake_tao: Neurons["stake_tao"];
        dividends: Neurons["dividends"];
        netuid: Neurons["netuid"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT stake_tao, dividends, netuid, captured_at FROM neurons`;
      return json(buildChainIdleStake(rows));
    };
  }

  // GET /api/v1/chain/yield
  if (url.pathname === "/api/v1/chain/yield") {
    return async (sql) => {
      const rows = await sql<{
        validator_permit: Neurons["validator_permit"];
        stake_tao: Neurons["stake_tao"];
        emission_tao: Neurons["emission_tao"];
        netuid: Neurons["netuid"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT validator_permit, stake_tao, emission_tao, netuid, captured_at
        FROM neurons WHERE netuid != 0`;
      return json(buildChainYield(rows));
    };
  }

  // GET /api/v1/subnets/:netuid/emission-split/history -- who received the
  // subnet's emission, per day. Joins the day's subnet_snapshots row for
  // `alpha_out_emission`, which is what turns the per-UID ratio into an
  // absolute daily figure; the join is LEFT so a day the snapshot lane missed
  // still publishes its MEASURED validator/miner split with the reconstructed
  // fields null, rather than dropping the day entirely.
  const emissionSplitHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/emission-split\/history$/,
  );
  if (emissionSplitHistoryMatch) {
    return async (sql) => {
      const netuid = Number(emissionSplitHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
        DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
      );
      const rows = await sql<{
        snapshot_date: NeuronDaily["snapshot_date"];
        uid: NeuronDaily["uid"];
        hotkey: NeuronDaily["hotkey"];
        validator_permit: NeuronDaily["validator_permit"];
        emission_tao: NeuronDaily["emission_tao"];
        alpha_out_emission: SubnetSnapshots["alpha_out_emission"];
        alpha_price_tao: SubnetSnapshots["alpha_price_tao"];
      }>`
        SELECT nd.snapshot_date, nd.uid, nd.hotkey, nd.validator_permit,
               nd.emission_tao, ss.alpha_out_emission, ss.alpha_price_tao
        FROM neuron_daily nd
        LEFT JOIN subnet_snapshots ss
          ON ss.netuid = nd.netuid AND ss.snapshot_date = nd.snapshot_date
        WHERE nd.netuid = ${netuid} AND nd.snapshot_date >= ${cutoff}
        ORDER BY nd.snapshot_date DESC LIMIT ${EMISSION_SPLIT_HISTORY_ROW_CAP}`;
      // #11095: the day's last PRICED tao-usd observation, one row per day.
      // Aggregated in SQL -- the raw series is ~1 row/minute and a 90d window
      // would be ~130k rows read for 90 scalars. Days before the series began
      // (2026-08-02) simply have no row, and the USD legs stay null there.
      // `observed_at` is BIGINT epoch-ms (migration 0003), so the day key is
      // derived through to_timestamp and the cutoff compared in the same unit.
      const cutoffMs = Date.parse(`${cutoff}T00:00:00Z`);
      const usdRows = await sql<{ day: string; usd_per_tao: number | null }>`
        SELECT to_char(to_timestamp(observed_at / 1000.0), 'YYYY-MM-DD') AS day,
               (array_agg(usd_per_tao ORDER BY observed_at DESC))[1] AS usd_per_tao
        FROM tao_usd_index
        WHERE usd_per_tao IS NOT NULL
          AND observed_at >= ${cutoffMs}
        GROUP BY 1`;
      // No guard: the WHERE clause already excludes null prices, to_char
      // cannot emit a null day, and a hypothetical driver NaN would only
      // flow into legs that serialize to null -- the same answer as an
      // unpriced day.
      const usdPerTaoByDay = new Map<string, number>(
        usdRows.map((row) => [row.day, Number(row.usd_per_tao)]),
      );
      return json(
        buildSubnetEmissionSplitHistory(rows, netuid, {
          window: windowLabelFor(
            url,
            SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
            DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
          ),
          capped: rows.length >= EMISSION_SPLIT_HISTORY_ROW_CAP,
          burnHotkey: await resolveBurnHotkey(sql, netuid),
          usdPerTaoByDay,
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/miner-fairness -- whether the registered
  // miners actually earn (#10931).
  //
  // Selects `uid` and `coldkey` on top of what the emission-split read takes:
  // `uid` because persistence is per-UID across days, the owning address
  // because the HEADLINE lens is per controlling entity and a per-UID Gini
  // alone hides a subnet where three operators hold 256 UIDs. No snapshot
  // join -- every figure here is a ratio within the day's own population, so
  // the day's absolute emission is not needed and reading it would tie this
  // route to a lane it does not depend on.
  const minerFairnessMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/miner-fairness$/,
  );
  if (minerFairnessMatch) {
    return async (sql) => {
      const netuid = Number(minerFairnessMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
        DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
      );
      const rows = await sql<{
        snapshot_date: NeuronDaily["snapshot_date"];
        uid: NeuronDaily["uid"];
        coldkey: NeuronDaily["coldkey"];
        validator_permit: NeuronDaily["validator_permit"];
        emission_tao: NeuronDaily["emission_tao"];
      }>`
        SELECT nd.snapshot_date, nd.uid, nd.coldkey, nd.hotkey,
               nd.validator_permit, nd.emission_tao
        FROM neuron_daily nd
        WHERE nd.netuid = ${netuid} AND nd.snapshot_date >= ${cutoff}
        ORDER BY nd.snapshot_date DESC, nd.uid ASC
        LIMIT ${MINER_FAIRNESS_ROW_CAP}`;
      const burnHotkey = await resolveBurnHotkey(sql, netuid);
      // #11091: the CURRENT metagraph beside the window. A window aggregate
      // smooths away a mid-window capture event (SN75: 30d uid gini 0.77
      // while one UID held incentive 0.9908 live), so the builder publishes
      // the same lenses over the live incentive distribution. One bounded
      // read -- a subnet is at most 256 UIDs.
      const liveRows = await sql<{
        uid: Neurons["uid"];
        coldkey: Neurons["coldkey"];
        validator_permit: Neurons["validator_permit"];
        incentive: Neurons["incentive"];
        captured_at: Neurons["captured_at"];
        block_number: Neurons["block_number"];
      }>`
        SELECT n.uid, n.coldkey, n.hotkey, n.validator_permit, n.incentive,
               n.captured_at, n.block_number
        FROM neurons n
        WHERE n.netuid = ${netuid}
        ORDER BY n.uid ASC`;
      return json(
        buildSubnetMinerFairness(rows, netuid, {
          window: windowLabelFor(
            url,
            SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
            DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
          ),
          capped: rows.length >= MINER_FAIRNESS_ROW_CAP,
          liveRows,
          burnHotkey,
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/cost-to-participate -- what this subnet says
  // it takes to run, beside what miners there actually earn (#10932).
  //
  // TWO READS, and the second is shared. The neuron_daily window feeds
  // buildSubnetMinerFairness, whose card the builder projects three fields out
  // of -- never recomputing a distribution src/miner-fairness.ts already owns.
  //
  // The ENTRY COSTS are deliberately absent from this tier. They come from
  // buildSubnetValidatorEconomicsPayload in the API worker, which is the exact
  // composer /validator-economics serves, so the burn and the two floors are
  // the same numbers rather than a second derivation of them.
  const costToParticipateMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/cost-to-participate$/,
  );
  if (costToParticipateMatch) {
    return async (sql) => {
      const netuid = Number(costToParticipateMatch[1]);
      const rows = await sql<ComputeDeclarationRow>`
        SELECT netuid, source_url, read_at_sha, observed_at, first_seen,
               found, spec_version, miner, validator, unscoped
        FROM compute_declarations
        WHERE netuid = ${netuid}
        ORDER BY source_url ASC`;
      const cutoff = new Date(
        Date.now() -
          SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS[
            DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW
          ] *
            86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const fairnessRows = await sql<{
        snapshot_date: NeuronDaily["snapshot_date"];
        uid: NeuronDaily["uid"];
        coldkey: NeuronDaily["coldkey"];
        emission_tao: NeuronDaily["emission_tao"];
        validator_permit: NeuronDaily["validator_permit"];
      }>`
        SELECT snapshot_date, uid, coldkey, emission_tao, validator_permit
        FROM neuron_daily
        WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
        ORDER BY snapshot_date DESC
        LIMIT ${MINER_FAIRNESS_ROW_CAP}`;
      return json(
        buildSubnetCostToParticipate(rows, netuid, {
          minerFairness: buildSubnetMinerFairness(fairnessRows, netuid, {
            window: DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
            capped: fairnessRows.length >= MINER_FAIRNESS_ROW_CAP,
          }),
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/treasury -- what this subnet's own published
  // source declares it allocates (#10933).
  //
  // Selects CANDIDATE rows as well as reviewed ones on purpose: the builder
  // publishes a candidate's read status and withholds its finding, and that
  // read status is the only thing that keeps an empty card from reading as
  // "this subnet takes no treasury cut". Filtering to reviewed here would
  // delete the distinction before the builder could make it.
  const treasuryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/treasury$/,
  );
  if (treasuryMatch) {
    return async (sql) => {
      const netuid = Number(treasuryMatch[1]);
      const rows = await sql<TreasuryReadingRow>`
        SELECT netuid, source_url, read_at_sha, observed_at, first_seen,
               found, declared_share, treasury_address, applies_to,
               evidence_path, review_state, reviewed_at
        FROM treasury_readings
        WHERE netuid = ${netuid}
        ORDER BY source_url ASC`;
      return json(buildSubnetTreasury(rows, netuid));
    };
  }

  // GET /api/v1/subnets/:netuid/owner-capture -- how much of the subnet's
  // emission reaches its owner (#10929).
  //
  // THREE READS, and each one is load-bearing:
  //
  //   1. `subnet_ownership` for the declared `owner_coldkey`. Read HERE rather
  //      than passed in from the calling handler, because smuggling it through
  //      a query parameter would let a caller name any coldkey as the owner and
  //      have this surface report on it as though the chain said so.
  //   2. `neuron_daily` WITH `coldkey` -- the column exists on that table and
  //      the emission-split read simply never selected it. That is the whole
  //      join: which UIDs are the owner's.
  //   3. `nominator_positions` for the stake behind the owner's validator
  //      hotkeys, pinned to the newest captured_at so a half-written pass
  //      cannot mix two snapshots into one fraction.
  //
  // A missing ownership row yields owner_coldkey null and every owner field
  // null -- not zero. "We do not know who owns this" and "the owner runs
  // nothing" are different facts and only one of them is an answer.
  const ownerCaptureMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/owner-capture$/,
  );
  if (ownerCaptureMatch) {
    return async (sql) => {
      const netuid = Number(ownerCaptureMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
        DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
      );
      const ownerRows = await sql<{
        owner_coldkey: SubnetOwnership["owner_coldkey"];
      }>`
        SELECT owner_coldkey FROM subnet_ownership
        WHERE netuid = ${netuid}
        ORDER BY captured_at DESC LIMIT 1`;
      const ownerColdkey = ownerRows[0]?.owner_coldkey ?? null;

      const rows = await sql<{
        snapshot_date: NeuronDaily["snapshot_date"];
        uid: NeuronDaily["uid"];
        hotkey: NeuronDaily["hotkey"];
        coldkey: NeuronDaily["coldkey"];
        validator_permit: NeuronDaily["validator_permit"];
        emission_tao: NeuronDaily["emission_tao"];
        take: NeuronDaily["take"];
        alpha_out_emission: SubnetSnapshots["alpha_out_emission"];
      }>`
        SELECT nd.snapshot_date, nd.uid, nd.hotkey, nd.coldkey,
               nd.validator_permit, nd.emission_tao, nd.take,
               ss.alpha_out_emission
        FROM neuron_daily nd
        LEFT JOIN subnet_snapshots ss
          ON ss.netuid = nd.netuid AND ss.snapshot_date = nd.snapshot_date
        WHERE nd.netuid = ${netuid} AND nd.snapshot_date >= ${cutoff}
        ORDER BY nd.snapshot_date DESC, nd.uid ASC
        LIMIT ${OWNER_CAPTURE_HISTORY_ROW_CAP}`;

      // Only meaningful when we know whose UIDs to look behind, so it is
      // skipped entirely rather than read and discarded.
      const positions = ownerColdkey
        ? await sql<{
            coldkey: NominatorPositions["coldkey"];
            hotkey: NominatorPositions["hotkey"];
            share_fraction: NominatorPositions["share_fraction"];
          }>`
        SELECT np.coldkey, np.hotkey, np.share_fraction
        FROM nominator_positions np
        WHERE np.netuid = ${netuid}
          AND np.captured_at = (
            SELECT MAX(captured_at) FROM nominator_positions
            WHERE netuid = ${netuid}
          )`
        : [];

      return json(
        buildSubnetOwnerCapture(rows, netuid, {
          window: windowLabelFor(
            url,
            SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
            DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
          ),
          capped: rows.length >= OWNER_CAPTURE_HISTORY_ROW_CAP,
          ownerColdkey,
          positions,
        }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/yield/history -- before the plain /yield
  // match, same ordering rationale as concentration above.
  const yieldHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/yield\/history$/,
  );
  if (yieldHistoryMatch) {
    return async (sql) => {
      const netuid = Number(yieldHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        YIELD_HISTORY_WINDOWS,
        DEFAULT_YIELD_HISTORY_WINDOW,
      );
      const rows = await sql<{
        snapshot_date: NeuronDaily["snapshot_date"];
        validator_permit: NeuronDaily["validator_permit"];
        stake_tao: NeuronDaily["stake_tao"];
        emission_tao: NeuronDaily["emission_tao"];
      }>`
        SELECT snapshot_date, validator_permit, stake_tao, emission_tao
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
    };
  }

  // GET /api/v1/subnets/:netuid/yield
  const subnetYield = url.pathname.match(/^\/api\/v1\/subnets\/(\d+)\/yield$/);
  if (subnetYield) {
    return async (sql) => {
      const netuid = Number(subnetYield[1]);
      const rows = await sql<{
        uid: Neurons["uid"];
        hotkey: Neurons["hotkey"];
        validator_permit: Neurons["validator_permit"];
        stake_tao: Neurons["stake_tao"];
        emission_tao: Neurons["emission_tao"];
        captured_at: Neurons["captured_at"];
        block_number: Neurons["block_number"];
      }>`
        SELECT uid, hotkey, validator_permit, stake_tao, emission_tao, captured_at, block_number
        FROM neurons WHERE netuid = ${netuid} ORDER BY uid`;
      return json(buildSubnetYield(rows, netuid));
    };
  }

  // GET /api/v1/accounts/:ss58/portfolio
  const acctPortfolio = url.pathname.match(
    /^\/api\/v1\/accounts\/([^/]+)\/portfolio$/,
  );
  if (acctPortfolio) {
    return async (sql, env) => {
      const ss58 = decodeURIComponent(acctPortfolio[1]);
      const rows = await sql<{
        netuid: Neurons["netuid"];
        uid: Neurons["uid"];
        stake_tao: Neurons["stake_tao"];
        emission_tao: Neurons["emission_tao"];
        rank: Neurons["rank"];
        trust: Neurons["trust"];
        incentive: Neurons["incentive"];
        dividends: Neurons["dividends"];
        validator_permit: Neurons["validator_permit"];
        active: Neurons["active"];
        captured_at: Neurons["captured_at"];
      }>`
        SELECT netuid, uid, stake_tao, emission_tao, rank, trust, incentive, dividends, validator_permit, active, captured_at
        FROM neurons WHERE hotkey = ${ss58} ORDER BY netuid`;
      const priceByNetuid = await loadStoreAlphaPricesByNetuid(sql, env);
      return json(buildAccountPortfolio(rows, ss58, { priceByNetuid }));
    };
  }

  // GET /api/v1/accounts/:ss58/subnets -- neurons-derived (the live
  // registration snapshot), so it moves with the family.
  const acctSubnets = url.pathname.match(
    /^\/api\/v1\/accounts\/([^/]+)\/subnets$/,
  );
  if (acctSubnets) {
    return async (sql) => {
      const ss58 = decodeURIComponent(acctSubnets[1]);
      const rows = await sql<{
        netuid: Neurons["netuid"];
        uid: Neurons["uid"];
        stake_tao: Neurons["stake_tao"];
        validator_permit: Neurons["validator_permit"];
        active: Neurons["active"];
      }>`
        SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons
        WHERE hotkey = ${ss58} ORDER BY netuid`;
      return json(buildAccountSubnets(rows, ss58));
    };
  }

  // GET /api/v1/accounts/:ss58/subnets/:netuid/history -- the
  // account_position_daily reader (#4832 gap-closure), ported with its
  // sibling tables since the same neurons-sync write maintains it.
  const positionHistoryMatch = url.pathname.match(
    /^\/api\/v1\/accounts\/([^/]+)\/subnets\/(\d+)\/history$/,
  );
  if (positionHistoryMatch) {
    return async (sql) => {
      const ss58 = decodeURIComponent(positionHistoryMatch[1]);
      const netuid = Number(positionHistoryMatch[2]);
      const cutoff = windowCutoffDate(
        url,
        HISTORY_WINDOW_DAYS,
        DEFAULT_HISTORY_WINDOW,
      );
      const rows = cutoff
        ? await sql<{
            snapshot_date: AccountPositionDaily["snapshot_date"];
            captured_at: AccountPositionDaily["captured_at"];
            uid: AccountPositionDaily["uid"];
            coldkey: AccountPositionDaily["coldkey"];
            active: AccountPositionDaily["active"];
            validator_permit: AccountPositionDaily["validator_permit"];
            rank: AccountPositionDaily["rank"];
            trust: AccountPositionDaily["trust"];
            incentive: AccountPositionDaily["incentive"];
            dividends: AccountPositionDaily["dividends"];
            stake_tao: AccountPositionDaily["stake_tao"];
            emission_tao: AccountPositionDaily["emission_tao"];
          }>`
          SELECT snapshot_date, captured_at, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao
          FROM account_position_daily
          WHERE account = ${ss58} AND netuid = ${netuid} AND snapshot_date >= ${cutoff}
          ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql<{
            snapshot_date: AccountPositionDaily["snapshot_date"];
            captured_at: AccountPositionDaily["captured_at"];
            uid: AccountPositionDaily["uid"];
            coldkey: AccountPositionDaily["coldkey"];
            active: AccountPositionDaily["active"];
            validator_permit: AccountPositionDaily["validator_permit"];
            rank: AccountPositionDaily["rank"];
            trust: AccountPositionDaily["trust"];
            incentive: AccountPositionDaily["incentive"];
            dividends: AccountPositionDaily["dividends"];
            stake_tao: AccountPositionDaily["stake_tao"];
            emission_tao: AccountPositionDaily["emission_tao"];
          }>`
          SELECT snapshot_date, captured_at, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao
          FROM account_position_daily
          WHERE account = ${ss58} AND netuid = ${netuid}
          ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildAccountPositionHistory(rows, ss58, netuid, {
          window: windowLabelFor(
            url,
            HISTORY_WINDOW_DAYS,
            DEFAULT_HISTORY_WINDOW,
          ),
        }),
      );
    };
  }

  // GET /api/v1/accounts?sort=&limit=
  if (url.pathname === "/api/v1/accounts") {
    return async (sql, env) => {
      const sortParam = url.searchParams.get("sort") || undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit =
        limitRaw == null || limitRaw === ""
          ? ACCOUNTS_LIST_LIMIT_DEFAULT
          : Number(limitRaw);
      const [rows, priceByNetuid] = await Promise.all([
        sql<{
          netuid: Neurons["netuid"];
          uid: Neurons["uid"];
          hotkey: Neurons["hotkey"];
          coldkey: Neurons["coldkey"];
          validator_permit: Neurons["validator_permit"];
          emission_tao: Neurons["emission_tao"];
          stake_tao: Neurons["stake_tao"];
          block_number: Neurons["block_number"];
          captured_at: Neurons["captured_at"];
        }>`
          SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, stake_tao, block_number, captured_at
          FROM neurons WHERE hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
        loadStoreAlphaPricesByNetuid(sql, env),
      ]);
      return json(
        buildAccountsList(rows, {
          sort: sortParam ?? DEFAULT_ACCOUNTS_LIST_SORT,
          limit,
          priceByNetuid,
        }),
      );
    };
  }

  // Website-sized stake, emission and reach rankings.
  if (url.pathname === "/api/v1/accounts/directory") {
    return async (sql, env, ctx) => {
      const materialized = await readExplorerDirectoryMaterialization(
        env.METAGRAPH_CONTROL,
      );
      if (materialized) {
        // Keep the verified response available if the freshness read fails.
        scheduleExplorerDirectoryRefresh(
          env,
          ctx,
          latestCompletedNeuronSnapshot(sql).then(
            (latest) => latest ?? materialized.captured_at,
          ),
        );
        return json(materialized.accounts);
      }
      const [rows, priceByNetuid] = await Promise.all([
        sql<{
          netuid: Neurons["netuid"];
          uid: Neurons["uid"];
          hotkey: Neurons["hotkey"];
          coldkey: Neurons["coldkey"];
          validator_permit: Neurons["validator_permit"];
          emission_tao: Neurons["emission_tao"];
          stake_tao: Neurons["stake_tao"];
          block_number: Neurons["block_number"];
          captured_at: Neurons["captured_at"];
        }>`
          SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, stake_tao, block_number, captured_at
          FROM neurons WHERE hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
        loadStoreAlphaPricesByNetuid(sql, env),
      ]);
      return json(buildAccountHolderDirectory(rows, { priceByNetuid }));
    };
  }

  // GET /api/v1/subnets/:netuid/history
  const subnetHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/history$/,
  );
  if (subnetHistoryMatch) {
    return async (sql) => {
      const netuid = Number(subnetHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        HISTORY_WINDOW_DAYS,
        DEFAULT_HISTORY_WINDOW,
      );
      // validator_permit is already INTEGER 0/1 here, so the Postgres
      // branch's ::int cast simply disappears.
      const rows = cutoff
        ? await sql<NeuronDailyRollup>`
          SELECT snapshot_date, COUNT(*) AS neuron_count,
            SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
            SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
          FROM neuron_daily
          WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
          GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql<NeuronDailyRollup>`
          SELECT snapshot_date, COUNT(*) AS neuron_count,
            SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
            SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
          FROM neuron_daily
          WHERE netuid = ${netuid}
          GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildSubnetHistory(rows, netuid, {
          window: windowLabelFor(
            url,
            HISTORY_WINDOW_DAYS,
            DEFAULT_HISTORY_WINDOW,
          ),
        }),
      );
    };
  }

  // GET /api/v1/chain/turnover?window=&limit=. The window is anchored on the
  // newest row the table HAS, not on the clock -- see neuronDailyWindowBounds,
  // which also explains why the shift no longer happens in SQL.
  if (url.pathname === "/api/v1/chain/turnover") {
    return async (sql) => {
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
      const { startDate, endDate } = await neuronDailyWindowBounds(sql, days);
      let rows: Row[] = [];
      if (startDate != null && endDate != null && startDate !== endDate) {
        rows = await sql<{
          snapshot_date: NeuronDaily["snapshot_date"];
          netuid: NeuronDaily["netuid"];
          hotkey: NeuronDaily["hotkey"];
          validator_permit: NeuronDaily["validator_permit"];
        }>`
          SELECT snapshot_date, netuid, hotkey, validator_permit
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
    };
  }

  // GET /api/v1/subnets/:netuid/turnover?window=&changes=
  const turnoverMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/turnover$/,
  );
  if (turnoverMatch) {
    return async (sql) => {
      const netuid = Number(turnoverMatch[1]);
      const windowParam =
        url.searchParams.get("window") || DEFAULT_HISTORY_WINDOW;
      const windowLabel = Object.hasOwn(HISTORY_WINDOW_DAYS, windowParam)
        ? windowParam
        : DEFAULT_HISTORY_WINDOW;
      const windowDays = HISTORY_WINDOW_DAYS[windowLabel];
      const includeChanges = url.searchParams.get("changes") === "true";
      const { startDate, endDate } = await neuronDailyWindowBounds(
        sql,
        windowDays,
        netuid,
      );
      const rows =
        startDate == null || endDate == null
          ? []
          : await sql<{
              snapshot_date: NeuronDaily["snapshot_date"];
              uid: NeuronDaily["uid"];
              hotkey: NeuronDaily["hotkey"];
              validator_permit: NeuronDaily["validator_permit"];
            }>`
            SELECT snapshot_date, uid, hotkey, validator_permit
            FROM neuron_daily
            WHERE netuid = ${netuid} AND snapshot_date IN (${startDate}, ${endDate})
            ORDER BY snapshot_date ASC, uid ASC`;
      const turnoverOptions = {
        window: windowLabel,
        startDate,
        endDate,
        // What the caller ASKED for, so the payload can say when the store's
        // floor cut it short -- see windowCoverage. `all` is null by
        // construction: it asks for whatever exists.
        requestedDays: windowDays ?? null,
      };
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
    };
  }

  // GET /api/v1/subnets/movers?window=&sort=&limit=
  if (url.pathname === "/api/v1/subnets/movers") {
    return async (sql) => {
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
      const { startDate, endDate } = await neuronDailyWindowBounds(sql, days);
      let startRows: Row[] = [];
      let endRows: Row[] = [];
      if (startDate != null && endDate != null && startDate !== endDate) {
        const rows = await sql<
          NeuronDailyRollup & { netuid: NeuronDaily["netuid"] }
        >`
          SELECT netuid, snapshot_date, COUNT(*) AS neuron_count,
            SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
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
    };
  }

  return null;
}

// --- Hyperparams + account-identity store read routes (box decommission;
// tests/fixtures/sqlite-schema/0009_hyperparams_identity.sql) ------------------------------
//
// The D1 twins of the four family reads the deleted Postgres dispatcher
// served -- the same contract as matchNeuronsStoreRoute above, switched
// per-family on
// METAGRAPH_SUBNET_HYPERPARAMS_SOURCE / METAGRAPH_ACCOUNT_IDENTITY_SOURCE
// (the flags the main Worker's tryDataApiTier callers gate on; unset here
// means D1, exactly like neuronsServedFromStore).
//
// With ONE deliberate addition over the neurons twins: a COLD tier -- the
// route's store table has NO rows at all because no sync has landed since the
// migration -- answers 503 instead of a schema-stable empty. tryDataApiTier
// treats any non-2xx as "degrade to null", which sends the serving handler to
// its next fallback: the lakehouse cold-tier reader
// (src/subnet-hyperparams-cold-tier.ts / src/account-identity-cold-tier.ts),
// the frozen pre-wipe snapshot. A schema-stable empty here would MASK that
// snapshot with nulls for however long the first sync takes. Once one sync
// lands the table is never empty again and this branch never fires; a row
// merely absent from a POPULATED table serves the same schema-stable shape
// the retired Postgres route served (deregistered netuid -> null card,
// account with no identity -> has_identity:false).
// Every column liveFromStatusRows projects (src/health-serving.ts:1918-1936)
// plus consecutive_failures, which only the prober reads. Kept as one list
// because both consumers of this route want the whole surface_status row --
// the serving overlay to render it, the prober to carry it forward.
const HEALTH_STATUS_LIVE_READ_COLUMNS =
  "surface_id, surface_key, netuid, kind, provider, url, status, " +
  "classification, latency_ms, status_code, last_checked, last_ok, " +
  "consecutive_failures";

// GET /api/v1/internal/health-status-live?since=<epoch_ms>
//
// The route two callers in the main Worker have always requested and nothing
// ever answered (#9522): src/health-prober.ts asks with since=0 for the LAST
// known row per surface, and src/health-serving.ts asks with a freshness
// cutoff for its KV-cold serving fallback. Without it, tryDataApiTier
// returned null on every call, so the prober's prior map was empty and it
// rewrote last_ok to null and reset consecutive_failures on every run --
// which in turn made the pool's sustained-down breaker (threshold 2)
// unreachable.
//
// `since` filters on last_checked, the column that records when the row was
// written; since=0 (or absent/unparseable) returns everything, which is what
// "the last known row, however stale" means for the prober's continuity read.
function matchHealthStatusStoreRoute(
  url: URL,
): NeuronsStoreRouteHandler | null {
  if (url.pathname !== "/api/v1/internal/health-status-live") return null;
  return async (sql) => {
    const since = Number(url.searchParams.get("since"));
    const cutoff = Number.isFinite(since) && since > 0 ? since : 0;
    const rows = await sql.unsafe<HealthStatusLiveStoreRow>(
      `SELECT ${HEALTH_STATUS_LIVE_READ_COLUMNS}
       FROM surface_status
       WHERE last_checked >= ?
       ORDER BY surface_id ASC`,
      [cutoff],
    );
    return json({ rows });
  };
}

function storeTierCold() {
  return json({ error: "store tier cold: no sync has landed yet" }, 503);
}

async function storeTableHasRows(
  sql: PgSql,
  table:
    | "subnet_hyperparams"
    | "subnet_hyperparams_history"
    | "account_identity"
    | "account_identity_history",
): Promise<boolean> {
  const rows = await sql.unsafe<{ one: number }>(
    `SELECT 1 AS one FROM ${table} LIMIT 1`,
  );
  return rows.length > 0;
}

// Every INSERT column except netuid (already known from the WHERE clause) --
// the same list the Postgres route below selects.
const SUBNET_HYPERPARAMS_READ_COLUMNS =
  SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1).join(", ");
const SUBNET_HYPERPARAMS_HISTORY_READ_COLUMNS = `id, block_number, observed_at, ${SUBNET_HYPERPARAMS_HISTORY_FIELDS.join(", ")}, hyperparams_hash`;
const ACCOUNT_IDENTITY_READ_COLUMNS =
  ACCOUNT_IDENTITY_INSERT_COLUMNS.join(", ");
const ACCOUNT_IDENTITY_HISTORY_READ_COLUMNS = `id, observed_at, ${IDENTITY_FIELDS.join(", ")}, identity_hash`;

/**
 * The rows those three column lists select, each derived from the very array
 * that builds its SQL text -- so a column added to the list is a column added
 * to the type, with nothing to keep in step by hand.
 */
type AccountIdentityStoreRow = Pick<
  AccountIdentity,
  (typeof ACCOUNT_IDENTITY_INSERT_COLUMNS)[number]
>;
type AccountIdentityHistoryStoreRow = Pick<
  AccountIdentityHistory,
  "id" | "observed_at" | "identity_hash" | (typeof IDENTITY_FIELDS)[number]
>;
type SubnetHyperparamsStoreRow = Pick<
  SubnetHyperparams,
  (typeof SUBNET_HYPERPARAMS_INSERT_COLUMNS)[number]
>;
type SubnetHyperparamsHistoryStoreRow = Pick<
  SubnetHyperparamsHistory,
  | "id"
  | "block_number"
  | "observed_at"
  | "hyperparams_hash"
  | ((typeof SUBNET_HYPERPARAMS_HISTORY_FIELDS)[number] &
      keyof SubnetHyperparamsHistory)
>;
/** The live surface-status row, as HEALTH_STATUS_LIVE_READ_COLUMNS selects it. */
type HealthStatusLiveStoreRow = Pick<
  SurfaceStatus,
  | "surface_id"
  | "surface_key"
  | "netuid"
  | "kind"
  | "provider"
  | "url"
  | "status"
  | "classification"
  | "latency_ms"
  | "status_code"
  | "last_checked"
  | "last_ok"
  | "consecutive_failures"
>;
/** One performance-history day, as PERFORMANCE_HISTORY_READ_COLUMNS selects it. */
type PerformanceHistoryRow = Pick<
  NeuronDaily,
  | "snapshot_date"
  | "incentive"
  | "dividends"
  | "trust"
  | "consensus"
  | "validator_trust"
  | "active"
  | "validator_permit"
>;

function matchHyperparamsIdentityStoreRoute(
  url: URL,
): NeuronsStoreRouteHandler | null {
  // GET /api/v1/subnets/:netuid/hyperparameters -- twin of the Postgres
  // route of the same name below, latest-only single-row lookup.
  const subnetHyperparams = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/hyperparameters$/,
  );
  if (subnetHyperparams) {
    return async (sql) => {
      const netuid = Number(subnetHyperparams[1]);
      const rows = await sql.unsafe<SubnetHyperparamsStoreRow>(
        `SELECT ${SUBNET_HYPERPARAMS_READ_COLUMNS} FROM subnet_hyperparams WHERE netuid = ? LIMIT 1`,
        [netuid],
      );
      if (!rows.length && !(await storeTableHasRows(sql, "subnet_hyperparams")))
        return storeTierCold();
      return json(buildSubnetHyperparams(rows[0] ?? null, netuid));
    };
  }

  // GET /api/v1/subnets/:netuid/hyperparameters/history?limit=&offset=
  // &cursor= -- same FEED_PAGINATION bounds and (observed_at, id) keyset
  // cursor as the Postgres route; SQLite supports the row-value comparison
  // directly, so only the placeholder style moves.
  const subnetHyperparamsHistory = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/hyperparameters\/history$/,
  );
  if (subnetHyperparamsHistory) {
    return async (sql) => {
      const netuid = Number(subnetHyperparamsHistory[1]);
      const limit = clampRequestLimit(
        url.searchParams.get("limit"),
        FEED_PAGINATION,
      );
      const offset = clampRequestOffset(url.searchParams.get("offset"));
      const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
      const rows = cursor
        ? await sql.unsafe<SubnetHyperparamsHistoryStoreRow>(
            `SELECT ${SUBNET_HYPERPARAMS_HISTORY_READ_COLUMNS}
             FROM subnet_hyperparams_history
             WHERE netuid = ? AND (observed_at, id) < (?, ?)
             ORDER BY observed_at DESC, id DESC LIMIT ?`,
            [netuid, cursor[0], cursor[1], limit],
          )
        : await sql.unsafe<SubnetHyperparamsHistoryStoreRow>(
            `SELECT ${SUBNET_HYPERPARAMS_HISTORY_READ_COLUMNS}
             FROM subnet_hyperparams_history
             WHERE netuid = ?
             ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?`,
            [netuid, limit, offset],
          );
      if (
        !rows.length &&
        !(await storeTableHasRows(sql, "subnet_hyperparams_history"))
      )
        return storeTierCold();
      const last = rows.length === limit ? rows[rows.length - 1] : null;
      const nextCursor = last
        ? encodeCursor([numberOrNull(last.observed_at), numberOrNull(last.id)])
        : null;
      return json(
        buildSubnetHyperparamsHistory(rows, netuid, {
          limit,
          offset,
          nextCursor,
        }),
      );
    };
  }

  // GET /api/v1/accounts/:ss58/identity -- latest-only single-row lookup;
  // an absent row in a populated table is has_identity:false, the common
  // case, exactly as the Postgres route serves it.
  const acctIdentity = url.pathname.match(
    /^\/api\/v1\/accounts\/([^/]+)\/identity$/,
  );
  if (acctIdentity) {
    return async (sql) => {
      const ss58 = decodeURIComponent(acctIdentity[1]);
      const rows = await sql.unsafe<AccountIdentityStoreRow>(
        `SELECT ${ACCOUNT_IDENTITY_READ_COLUMNS} FROM account_identity WHERE account = ?`,
        [ss58],
      );
      if (!rows.length && !(await storeTableHasRows(sql, "account_identity")))
        return storeTierCold();
      return json(buildAccountIdentity(rows[0] ?? null, ss58));
    };
  }

  // GET /api/v1/accounts/:ss58/identity-history?limit=&offset=&cursor=
  const acctIdentityHistory = url.pathname.match(
    /^\/api\/v1\/accounts\/([^/]+)\/identity-history$/,
  );
  if (acctIdentityHistory) {
    return async (sql) => {
      const ss58 = decodeURIComponent(acctIdentityHistory[1]);
      const limit = clampRequestLimit(
        url.searchParams.get("limit"),
        FEED_PAGINATION,
      );
      const offset = clampRequestOffset(url.searchParams.get("offset"));
      const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
      const rows = cursor
        ? await sql.unsafe<AccountIdentityHistoryStoreRow>(
            `SELECT ${ACCOUNT_IDENTITY_HISTORY_READ_COLUMNS}
             FROM account_identity_history
             WHERE account = ? AND (observed_at, id) < (?, ?)
             ORDER BY observed_at DESC, id DESC LIMIT ?`,
            [ss58, cursor[0], cursor[1], limit],
          )
        : await sql.unsafe<AccountIdentityHistoryStoreRow>(
            `SELECT ${ACCOUNT_IDENTITY_HISTORY_READ_COLUMNS}
             FROM account_identity_history
             WHERE account = ?
             ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?`,
            [ss58, limit, offset],
          );
      if (
        !rows.length &&
        !(await storeTableHasRows(sql, "account_identity_history"))
      )
        return storeTierCold();
      const last = rows.length === limit ? rows[rows.length - 1] : null;
      const nextCursor = last
        ? encodeCursor([numberOrNull(last.observed_at), numberOrNull(last.id)])
        : null;
      return json(
        buildAccountIdentityHistory(rows, ss58, {
          limit,
          offset,
          nextCursor,
        }),
      );
    };
  }

  return null;
}

// The actual route dispatcher, extracted from the default export's fetch so
// the top-level export (below) can wrap it with a PostHog trace span
// (metagraphed#7768) without indenting this whole function. Tests import
// this raw handler directly (unaffected by the wrapper).
async function dispatchDataApiRequest(
  request: Request,
  env: DataApiEnv,
  // Threaded through for createPgSql, which returns its Hyperdrive connection
  // via waitUntil rather than making the response wait on the teardown.
  ctx: ExecutionContext,
): Promise<Response> {
  {
    const url = new URL(request.url);
    // The write routes (#4771, #4832) -- checked before the GET-only gate
    // below, same as how the main Worker's own POST-accepting routes
    // (webhooks, MCP, ingest) run ahead of its read-only method gate.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/neurons-sync"
    ) {
      return handleNeuronsSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/backfill-neuron-daily"
    ) {
      return handleNeuronDailyBackfill(request, env, ctx);
    }
    // #9208's live-follow lane. The head read is a GET and therefore has to be
    // matched HERE too rather than left to the read dispatcher: the gate below
    // admits GETs, but only for paths it knows, and this one is internal.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/chain-detail-sync"
    ) {
      return handleChainDetailSync(request, env, ctx);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/chain-detail-sync/head"
    ) {
      return handleChainDetailSyncHead(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-hyperparams-sync"
    ) {
      return handleSubnetHyperparamsSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-hyperparams-backfill"
    ) {
      return handleSubnetHyperparamsBackfill(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/account-identity-sync"
    ) {
      return handleAccountIdentitySync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-identity-sync"
    ) {
      return handleSubnetIdentitySync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/subnet-ownership-sync"
    ) {
      return handleSubnetOwnershipSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/validator-nominator-counts-sync"
    ) {
      return handleValidatorNominatorCountsSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/nominator-positions-sync"
    ) {
      return handleNominatorPositionsSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/self-stake-sync"
    ) {
      return handleSelfStakeSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/account-balances-sync"
    ) {
      return handleAccountBalancesSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/hotkey-alpha-sync"
    ) {
      return handleHotkeyAlphaSync(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/root-basket-capture-sync"
    ) {
      return handleRootBasketCaptureSync(request, env, {
        onError: (error) =>
          captureDataApiError(error, "root-basket-capture-sync", env),
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/poller-lane-health-sync"
    ) {
      return handlePollerLaneHealthSync(request, env);
    }
    // Internal-only key verification for the isolated fullnode RPC gate's
    // KV-cache-fronted validator (src/api-key-validation.ts). See
    // handleApiKeyVerify's own header comment for why this is POST-with-body
    // rather than the old GET-with-path-param shape.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/verify"
    ) {
      return handleApiKeyVerify(request, env, ctx);
    }
    // Internal-only usage-counter increment for the self-serve usage
    // dashboard (#8386) -- see handleApiKeyUsageIncrement's own header
    // comment for why it reuses the verify route's shared secret.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/usage"
    ) {
      return handleApiKeyUsageIncrement(request, env, ctx);
    }
    // Internal-only all-traffic usage rollup (#8597) -- the measurement ADR
    // 0022's pricing decision is blocked on. Write is batched+fire-and-forget;
    // read is the maintainer's queryable readout.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/usage-rollup"
    ) {
      return handleUsageRollupIncrement(request, env, ctx);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/usage-rollup"
    ) {
      return handleUsageRollupRead(request, env, ctx);
    }
    // Internal-only daily-quota spend (#8608) -- see handleApiQuotaSpend's own
    // header comment for why it shares the verify route's secret and why,
    // unlike the usage counter above, its response body is load-bearing.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/quota"
    ) {
      return handleApiQuotaSpend(request, env, ctx);
    }
    // Internal-only key-level abuse controls (#8611). Own shared secret --
    // blocking a paying customer is a higher-privilege act than recording a
    // request, so it does not share the verify route's token.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/block"
    ) {
      return handleApiKeyBlock(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/unblock"
    ) {
      return handleApiKeyUnblock(request, env, ctx);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/keys/anomalies"
    ) {
      return handleApiKeyAnomalies(request, env, ctx);
    }
    // Internal-only, ops-triggered account tier promotion -- see
    // handleAccountTierPromote's own header comment.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/accounts/tier"
    ) {
      return handleAccountTierPromote(request, env, ctx);
    }
    // #4984 Part 1: multi-method (POST/GET/PATCH/DELETE), so it can't join
    // the exact-path-and-method checks above -- handleAlertTriggersRoute
    // does its own method dispatch, same shape as workers/api.ts's
    // handleWebhookRequest.
    // isPathUnder, not startsWith: the unbounded prefix matched
    // `/api/v1/alerts/triggersanything` too, and this is the side that actually
    // reaches the create/delete handlers.
    if (isPathUnder(url.pathname, "/api/v1/alerts/triggers")) {
      return handleAlertTriggersRoute(request, env, ctx, url);
    }
    // #8375: the Alert Center's address-scoped counterpart -- GET (list),
    // PATCH/DELETE (single trigger), GET .../deliveries (history), all
    // watch-token authorized. Same "multi-method, can't join the exact-match
    // checks" shape as handleAlertTriggersRoute just above.
    if (isPathUnder(url.pathname, "/api/v1/watch/triggers")) {
      return handleWatchTriggersRoute(request, env, ctx, url);
    }
    // #8385: the same address-scoped shape for web-push device
    // subscriptions (GET list, POST subscribe, DELETE one device).
    if (isPathUnder(url.pathname, "/api/v1/watch/push-subscriptions")) {
      return handleWatchPushSubscriptionsRoute(request, env, ctx, url);
    }
    // #8385: internal-only push-subscription resolve/prune for AlerterHub.
    if (url.pathname === "/api/v1/internal/push-subscription") {
      return handleInternalPushSubscription(request, env, ctx, url);
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
      return handleWalletVerify(request, env, ctx);
    }
    // #8374: self-serve wallet-verified alert-trigger issuance -- same
    // exact-path-and-method dispatch shape as the wallet-login pair above.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/watch/challenges"
    ) {
      return handleWatchChallenge(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/watch/tokens") {
      return handleWatchTokenMint(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/auth/github/upsert-account"
    ) {
      return handleGithubAccountUpsert(request, env, ctx);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/accounts/github/tier"
    ) {
      return handleGithubAccountTier(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/v1/keys")) {
      return handleAccountKeysRoute(request, env, ctx, url);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/alert-triggers-active"
    ) {
      return handleAlertTriggersActiveList(request, env, ctx);
    }
    // #5022: the evaluator's own write-back for match_count/last_matched_at
    // -- see handleAlertTriggersMatchedWriteback's own header comment.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/alert-triggers/matched"
    ) {
      return handleAlertTriggersMatchedWriteback(request, env, ctx);
    }
    // #8375: the evaluator's own delivery-history write-back -- see
    // handleAlertTriggersDeliveryLogWrite's own header comment.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/alert-triggers/deliveries"
    ) {
      return handleAlertTriggersDeliveryLogWrite(request, env, ctx);
    }
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, 405);

    // Neurons-family reads (box decommission) -- these serve with no
    // Postgres tier at all, which is the whole point of the port. Every other
    // route falls through to the gone-tier 503 below. Log + masked-route
    // capture + an opaque 502 that never leaks DB detail.
    const neuronsStoreHandler = matchNeuronsStoreRoute(url);
    if (neuronsStoreHandler) {
      const store = routeRunner(env, ctx);
      if (!store) {
        return json({ error: "no store bound for this route" }, 503);
      }
      try {
        return await neuronsStoreHandler(store, env, ctx);
      } catch (err) {
        console.error("data-api neurons query failed:", err);
        await captureDataApiError(err, maskRouteParams(url.pathname), env);
        return json({ error: "data query failed" }, 502);
      }
    }

    // Probe status on the store (#9522) -- the internal continuity read the prober
    // and the health-serving fallback have both always called. Same envelope
    // as the neurons block above.
    {
      const healthStatusStoreHandler = matchHealthStatusStoreRoute(url);
      if (healthStatusStoreHandler) {
        const store = routeRunner(env, ctx);
        if (!store) {
          return json({ error: "no store bound for this route" }, 503);
        }
        try {
          return await healthStatusStoreHandler(store, env, ctx);
        } catch (err) {
          console.error("data-api health-status store query failed:", err);
          await captureDataApiError(err, maskRouteParams(url.pathname), env);
          return json({ error: "data query failed" }, 502);
        }
      }
    }

    // Hyperparams + account-identity reads on the store (box decommission,
    // tests/fixtures/sqlite-schema/0009) -- the same shape as the neurons block above, with
    // the per-family flag check folded into the matcher (each family switches
    // independently). Same catch envelope: log + masked-route capture + an
    // opaque 502 that never leaks DB detail.
    {
      const hyperparamsIdentityStoreHandler =
        matchHyperparamsIdentityStoreRoute(url);
      if (hyperparamsIdentityStoreHandler) {
        const store = routeRunner(env, ctx);
        if (!store) {
          return json({ error: "no store bound for this route" }, 503);
        }
        try {
          return await hyperparamsIdentityStoreHandler(store, env, ctx);
        } catch (err) {
          console.error(
            "data-api hyperparams/identity store query failed:",
            err,
          );
          await captureDataApiError(err, maskRouteParams(url.pathname), env);
          return json({ error: "data query failed" }, 502);
        }
      }
    }

    // NO BRANCH ABOVE MATCHED. That is all this gate means, and the message
    // now says so.
    //
    // It used to read `hyperdrive binding unavailable`, which was true when
    // #9193 wrote it: #9186 had unbound HYPERDRIVE with the box, so every read
    // route below this point was unreachable and this gate answered all of
    // them. #10060 bound Hyperdrive again -- wrangler.data.jsonc declares it,
    // and the branches above serve /accounts/:ss58/portfolio, /subnets,
    // /identity, the accounts list and the rest straight off Neon through it.
    // The sentence outlived its condition, so a 503 from here read as "the
    // database link is down" when it actually meant "this Worker has no
    // handler for that path" -- a wrong diagnosis waiting for whoever met it
    // next, and it was collected at least once.
    //
    // The STATUS is deliberately unchanged, because the forward gate depends
    // on it: tryDataApiTier's callers in the main Worker read a non-2xx here
    // as "this tier declines" and fall through to the store/lakehouse tiers.
    // Only the message moves; nothing reads the body but a human.
    return json({ error: "no handler on the data tier for this route" }, 503);
  }
}

// --- TAO/USD index ingestion (#8600, ADR 0025) ----------------------------
//
// One minute-cadence tick: read the Ethereum height, read every pool at that
// exact height in one batch, compute, append.
//
// FOUR THINGS REQUIREMENT 4 ASKS FOR, AND WHERE EACH ONE LIVES.
//
//   (a) One failing read must not fail the run. Every read is independently
//       optional inside decodeObservation -- a pool whose price or balance
//       does not come back is excluded WITH A REASON, and the other pools
//       still produce an index. Nothing here needs a try/catch to achieve
//       that; the decoder is total.
//   (b) Which pools were healthy is recorded. The `pools` JSONB holds every
//       pool the tick looked at, contributors and rejects alike.
//   (c) Never on a user-facing path. This runs from `scheduled`, not `fetch`.
//   (d) Idempotent. observed_at is the BLOCK's timestamp, so a re-run of the
//       same height collides on the primary key and DO NOTHING is a real
//       no-op rather than a near-duplicate insert.
//
// RATE-LIMIT DISCIPLINE (requirement 5). Two HTTP requests per tick -- one
// eth_getBlockByNumber, one 7-call batch -- so 2,880 requests/day against
// whatever endpoint ETH_RPC_URL names. No surveyed public endpoint publishes a
// numeric ceiling to cite; this is the ceiling WE impose, and it is the number
// that matters for staying well inside an unstated one.
const TAO_USD_RPC_TIMEOUT_MS = 10_000;

async function ethRpc(
  url: string,
  body: unknown,
  timeoutMs = TAO_USD_RPC_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`eth rpc HTTP ${response.status}`);
  return response.json();
}

/**
 * The height and timestamp every call in the tick is pinned to. Parses only --
 * a header of `{number: "0x0"}` gets past this and is refused where every
 * other unusable observation is refused, on one code path with one meaning.
 */
export function decodeBlockHeader(
  payload: unknown,
): { blockTag: string; blockNumber: number; timestampSeconds: number } | null {
  const result = (payload as { result?: unknown })?.result as
    { number?: unknown; timestamp?: unknown } | undefined;
  if (!result) return null;
  const { number: rawNumber, timestamp: rawTimestamp } = result;
  if (typeof rawNumber !== "string" || typeof rawTimestamp !== "string")
    return null;
  const blockNumber = Number.parseInt(rawNumber, 16);
  const timestampSeconds = Number.parseInt(rawTimestamp, 16);
  // NaN means the strings were not hex at all, so there is no tag to pin to.
  // Whether the parsed values are USABLE is buildIndexRow's judgement and is
  // not repeated here: two validators for one condition is how a guard becomes
  // unreachable and stops being exercised.
  if (Number.isNaN(blockNumber) || Number.isNaN(timestampSeconds)) return null;
  return { blockTag: rawNumber, blockNumber, timestampSeconds };
}

/**
 * The lane name this write reports and buffers under (#10677).
 *
 * Named like the `src/*-neon-write.ts` lanes because it now behaves like one:
 * same runner, same flag, same fire-and-forget contract.
 */
export const TAO_USD_INDEX_NEON_LANE = "tao-usd-index";

export async function writeTaoUsdIndexRow(
  env: DataApiEnv,
  row: TaoUsdIndexRow,
  ctx?: ExecutionContext,
): Promise<{ written: boolean; skipped?: boolean; reason?: string }> {
  // The provenance array is stringified into the JSON-holding TEXT `pools`
  // column.
  //
  // NO `RETURNING`, AND THAT IS THE POINT (#10677). This used to return the
  // written block_number and report `inserted: written.length > 0`, which made
  // it the one Neon writer whose result the caller consumed -- and therefore
  // the one writer that could not be deferred through the write-behind buffer
  // (src/neon-write-buffer.ts refuses a RETURNING statement rather than hand
  // back an empty result that reads as "already present"). Since this fires
  // every 60s it was also the single lane most able to keep the compute awake
  // on its own, so the asymmetry cost the whole buffer its saving.
  //
  // Losing the inserted/duplicate distinction costs nothing real: the Workers
  // runtime discards a scheduled() return value, so the only consumer was this
  // repo's own tests, and `ON CONFLICT DO NOTHING` already makes a re-run of
  // one height a genuine no-op. Whether heights are actually landing is
  // measured where it belongs -- src/tao-usd-index-watchdog.ts reads the table.
  //
  // `ctx` is required because createPgSql returns the pooled connection
  // through waitUntil; without one this would leak a connection per tick, so
  // it declines rather than writing.
  const sql = neonWriteRunner(
    env,
    ctx ?? null,
    TAO_USD_INDEX_NEON_LANE,
    env.HYPERDRIVE,
  );
  if (!sql) {
    return { written: false, skipped: true, reason: "no store bound" };
  }
  await sql.unsafe(
    `INSERT INTO tao_usd_index
      (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (block_number, observed_at) DO NOTHING`,
    [
      row.block_number,
      row.observed_at,
      row.usd_per_tao,
      row.price_basis,
      row.eth_usd,
      row.pool_count,
      JSON.stringify(row.pools),
    ],
  );
  return { written: true };
}

/**
 * Mirror the newest reading into KV so /api/v1/economics can price alpha in USD
 * without a database read (#10381).
 *
 * ONLY THE FIELDS A CONSUMER NEEDS TO MULTIPLY AND AUDIT: the rate, when it was
 * taken, the block it was pinned to, and the basis. `pools` stays out -- it is
 * the audit trail for /api/v1/network/tao-usd, where it belongs, and copying it
 * per minute into a hot key would grow the value for a field nothing on this
 * path reads.
 *
 * Best-effort throughout. A KV that refuses leaves the durable row untouched
 * and the consumer falls back to declining a USD figure, which is the correct
 * behaviour anyway -- see taoUsdUsable in src/alpha-usd.ts, where an absent
 * reading is `no_index_reading` rather than a silent zero.
 */
async function writeTaoUsdCurrentKv(env: DataApiEnv, row: TaoUsdIndexRow) {
  const kv = env.METAGRAPH_CONTROL;
  if (!kv?.put) return;
  try {
    await kv.put(
      KV_TAO_USD_CURRENT,
      JSON.stringify({
        usd_per_tao: row.usd_per_tao,
        // ISO, NOT the raw epoch-ms this row carries. `TaoUsdReading`
        // declares a string and `taoUsdUsable` grades it with `Date.parse`,
        // which returns NaN for a stringified integer -- and an unparseable
        // stamp is graded `index_stale` by design. Writing the number here made
        // a once-a-minute cache read as permanently stale, so every USD field
        // on /economics and the volume routes declined.
        observed_at: new Date(row.observed_at).toISOString(),
        block_number: row.block_number,
        price_basis: row.price_basis,
      }),
    );
  } catch (err) {
    // Logged, never thrown: the series is already durable by this point.
    console.error("data-api tao-usd current KV write failed:", err);
  }
}

export async function ingestTaoUsdIndex(
  env: DataApiEnv,
  ctx?: ExecutionContext,
): Promise<Row> {
  if (!env.ETH_RPC_URL) {
    return { ok: false, skipped: true, reason: "ETH_RPC_URL not configured" };
  }
  try {
    const header = decodeBlockHeader(
      await ethRpc(env.ETH_RPC_URL, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
    );
    // Without a height there is no idempotency key, and a row keyed on "now"
    // is worse than no row: it is one this tick can never recognise again.
    if (!header) return { ok: false, reason: "block_header_unreadable" };

    const batch = await ethRpc(
      env.ETH_RPC_URL,
      buildObservationBatch(header.blockTag),
    );
    const row = rowFromBatch({
      blockNumber: header.blockNumber,
      blockTimestampSeconds: header.timestampSeconds,
      response: batch,
    });
    if (!row) return { ok: false, reason: "observation_unusable" };

    const { written } = await writeTaoUsdIndexRow(env, row, ctx);
    // The hot-path copy, beside the durable row (#10381). Best-effort and
    // AFTER the Neon write, in that order deliberately: KV is a cache of the
    // series, so a KV failure must never cost a minute of the series itself.
    // The series is what a caller can audit; this is only what saves them a
    // database read.
    await writeTaoUsdCurrentKv(env, row);
    return {
      ok: true,
      // `written`, not `inserted` (#10677): the statement no longer RETURNs, so
      // this reports that the write was issued rather than whether the height
      // was new. ON CONFLICT DO NOTHING makes a repeat a real no-op, and
      // src/tao-usd-index-watchdog.ts measures the table for what actually
      // landed.
      written,
      block_number: row.block_number,
      usd_per_tao: row.usd_per_tao,
      price_basis: row.price_basis,
      pool_count: row.pool_count,
    };
  } catch (err) {
    // A tick that cannot run is one missing minute of a minute-cadence series,
    // not an outage. It is reported so a persistent failure is visible, and
    // the next tick is a full retry of the same work.
    console.error("data-api tao-usd-index tick failed:", err);
    await captureDataApiError(err, "tao-usd-index", env);
    return { ok: false, reason: "tick_failed" };
  }
}

/**
 * Every cron expression this Worker handles, and the lane each one runs.
 *
 * DATA, AND THE DISPATCHER READS IT -- so the set cannot drift from the
 * branches below, and tests/data-api-crons-have-handlers.test.ts can compare it
 * against wrangler.data.jsonc in BOTH directions.
 *
 * The reverse direction is the one that was missing. Every cron gate in tests/
 * asserted constant -> declared-in-wrangler; a declared expression whose
 * constant had been deleted could not fail any of them. Three had been in that
 * state since D1 was retired (#10814), firing ~23 no-op invocations an hour.
 */
export const DATA_API_CRON_LANES: Readonly<Record<string, string>> = {
  [TAO_USD_INDEX_CRON]: "tao-usd-index",
  [NEON_PRUNE_CRON]: "neon-prune",
  [TABLE_FRESHNESS_CRON]: "table-freshness + tao-usd-index watchdog",
};

export default {
  // #8600: the data-api Worker's first cron. It lives here rather than on the
  // api Worker for the same locality reason it always has -- this Worker owns
  // the tick end to end (RPC reads + the tao_usd_index write, on Neon through
  // Hyperdrive) -- routing a write through a service binding to
  // reach another Worker is the hop #4832 removed, not one to add back.
  async scheduled(
    controller: ScheduledController,
    env: DataApiEnv,
    ctx: ExecutionContext,
  ) {
    // Declined BEFORE the branches, against the declared set, so an expression
    // nobody handles is refused in one place rather than falling through three
    // comparisons to a default that looks deliberate.
    if (!controller?.cron || !(controller.cron in DATA_API_CRON_LANES)) {
      return { ok: false, skipped: true, reason: "unknown cron" };
    }
    if (controller?.cron === TABLE_FRESHNESS_CRON) {
      // Reads MAX(<timestamp>) per table and writes one verdict, all on Neon
      // through Hyperdrive. This line read "D1 only" until #10223 -- which is
      // exactly the kind of stale marker that sends an investigation looking
      // for a dead store instead of at the verdict (#10635).
      const bag = env;
      // The TAO/USD index rides this cron rather than its own (#8603). Its
      // staleness bound already lives in TABLE_FRESHNESS, the store is already
      // reachable here, and a NEW cron expression would need
      // `wrangler triggers deploy` to take effect -- Workers Builds deploys
      // code, not schedules. A watchdog that silently never runs is the exact
      // failure it was built to catch, so it reuses a schedule known to fire.
      const [freshness] = await Promise.all([
        runTableFreshnessWatchdog(bag),
        runTaoUsdIndexWatchdog(bag),
      ]);
      return freshness;
    }
    if (controller?.cron === NEON_PRUNE_CRON) {
      // Neon's retention for the rolling windows (#9891). Built as a prune
      // independent of D1's, back when there were two stores computing the same
      // boundary from the same constant; D1 is gone, so this is now simply the
      // prune. Kept separate from the lane that produces the rows it trims for
      // the original reason -- a prune that waits on its producer stops pruning
      // the moment the producer breaks.
      return runNeonPrune(env, ctx);
    }
    // Unreachable for anything DECLARED and branched, and deliberately kept:
    // it is the net under `DATA_API_CRON_LANES` gaining an entry whose branch
    // nobody wrote. Without it that expression would fall through to
    // `ingestTaoUsdIndex` and run the wrong lane on the wrong schedule, which
    // is a worse failure than the no-op this whole issue is about.
    if (controller.cron !== TAO_USD_INDEX_CRON) {
      return { ok: false, skipped: true, reason: "declared but unhandled" };
    }
    return ingestTaoUsdIndex(env, ctx);
  },
  async fetch(
    request: Request,
    env: DataApiEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // metagraphed#7768: PostHog distributed tracing (alpha), one root span
    // per request -- replaces @sentry/cloudflare's automatic withSentry() HTTP
    // instrumentation. Off by default (POSTHOG_TRACES_SAMPLE_RATE unset --
    // see src/tracing.ts's own header for why); set it as a deployed var to
    // match Sentry's old 0.05. This is the Worker that actually runs the
    // leaderboard/chain-events Postgres queries the original rollout's
    // tracesSampleRate comment called out as the highest-value place to have
    // span visibility.
    // #9440: the uncaught-fault capture runs REGARDLESS of trace sampling,
    // and outside the sampled block below, because tracing is off by default
    // on this Worker (its config sets no rate at all) -- so putting error
    // capture inside the sampled path would mean an unhandled fault here is
    // recorded exactly never. captureDataApiError covers the ~18 handled
    // sites; this covers everything that escapes them, which is the class
    // that has no stack anywhere today.
    //
    // Same shape as withUsageTelemetry's catch in workers/api.ts: observe and
    // rethrow, never handle.
    //
    // The pre-dispatch sampling branch this comment used to describe is GONE.
    // Whether a span is kept now depends on how the request ENDS
    // (shouldRecordTraceSpan: failures always, successes by rate, internal
    // routes never) and `ok` is not known until the finally -- so the decision
    // moved there and the duplicated sampled/unsampled try/catch collapsed
    // into the single path below. #9440's guarantee is strengthened rather
    // than weakened by that: the uncaught-fault capture is no longer merely
    // outside the sampled block, it is on the only block there is.
    const startedAt = Date.now();
    // #9001: masked, like the $exception route above. A span NAME is the
    // primary grouping key in any tracing backend, so a raw pathname makes
    // per-route latency unaggregatable -- `/api/v1/subnets/123/conviction`
    // and `/api/v1/subnets/124/conviction` would never be compared.
    // workers/api.ts has always used the low-cardinality route id here.
    const route = maskedDataApiRoute(request);
    let ok = true;
    try {
      const response = await dispatchDataApiRequest(request, env, ctx);
      ok = response.status < 500;
      return response;
    } catch (error) {
      ok = false;
      await captureUncaughtDataApiError(error, route, env, ctx);
      throw error;
    } finally {
      if (shouldRecordTraceSpan(env, { name: route, ok })) {
        const span = {
          traceId: newTraceId(),
          spanId: newSpanId(),
          name: route,
          startTimeMs: startedAt,
          endTimeMs: Date.now(),
          ok,
          serviceName: "metagraphed-data-api",
          attributes: { route },
        };
        // No Promise.resolve wrapper: workers/api.ts's scheduleTraceSpan needs
        // one because its recorder is an injectable dep that a test may stub
        // with a non-promise. This calls the real `async` recordTraceSpan,
        // which by declaration always returns a promise and never throws
        // synchronously, so .catch alone is the whole guarantee.
        const pending = recordTraceSpan(env, span).catch(() => false);
        if (typeof ctx?.waitUntil === "function") {
          ctx.waitUntil(pending);
        }
      }
    }
  },

  /**
   * The bulk sync path's consumer (metagraphed-infra#347).
   *
   * IT WRITES. The first cut deliberately did not -- it validated, classified
   * and reported, so the queue's real behaviour (batch sizes, retry timing,
   * dead-letter routing, what `max_concurrency` does to throughput) could be
   * observed against production traffic shape before any lane depended on it.
   * Those are the properties the hand-rolled retry and pacing substituted for,
   * and measuring them first is what made deleting the pacing defensible.
   *
   * A lane only reaches here once SYNC_QUEUE_LANES names it, so wiring a lane
   * and cutting it over stay separate deploys.
   *
   * A MALFORMED MESSAGE IS ACKED, NOT RETRIED. Retrying something that can
   * never parse burns five attempts and dead-letters anyway; acking it keeps
   * the DLQ holding things that might yet succeed rather than things that never
   * could.
   */
  async queue(
    batch: MessageBatch<unknown>,
    env: DataApiEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // THE DEAD-LETTER BRANCH COMES FIRST (metagraphed-infra#354/#363). The DLQ
    // is bound to this same handler, so without it a message that already
    // failed five attempts would be handed to the writer again -- a sixth
    // attempt wearing a different hat, writing rows whose write is what killed
    // them. `handleDeadLetterBatch` acks and records; it never retries.
    if (isDeadLetterQueue(batch.queue)) {
      // The dead-letter record is a lane verdict, so it goes where the other
      // 27 do (#10158). recordLaneVerdict swallows failures, so a dead letter
      // written to a store nobody reads is a message lost twice over.
      await handleDeadLetterBatch(batch, laneHealthStore(env));
      return;
    }
    // DECOMPRESS BEFORE ANYTHING READS THE BODY (metagraphed#9759). A
    // compressed message arrives as bytes, and `validSyncBatchMessage` would
    // call those unparseable -- which the consumer ACKS. That is silent data
    // loss for the largest lane on the platform, so it happens first, and a
    // body that fails to decompress simply stays what it was and takes the
    // existing unparseable path.
    const decoded = await Promise.all(
      batch.messages.map(async (message) =>
        isCompressedSyncBatchBody(message.body)
          ? {
              message,
              body: await decompressSyncBatchMessage(message.body),
            }
          : { message, body: message.body },
      ),
    );
    const { valid, invalid } = classifySyncBatch(decoded);
    // syncBatchRowCount, not `m.rows.length`: a multi-family message carries
    // `families` and no `rows` at all, so the direct read threw a TypeError HERE
    // -- above the per-message try/catch below -- and failed the whole batch,
    // every co-batched lane with it, five times over, into the dead-letter
    // queue. A log line is the last thing that should be able to do that.
    const rows = valid.reduce((n: number, m) => n + syncBatchRowCount(m), 0);
    const lanes = [...new Set(valid.map((m) => m.lane))].sort().join(",");
    console.log(
      `sync-batches: ${batch.messages.length} message(s), ${valid.length} valid ` +
        `(${rows} row(s), lanes=${lanes || "none"}), ${invalid} unparseable`,
    );
    // WRITES NOW, per message (metagraphed-infra#348). Per message rather than
    // per batch so one bad chunk is retried alone instead of dragging its nine
    // neighbours through the retry budget with it.
    // ONE CALL per message, so the four families land together.
    //
    // UNCONDITIONAL (#10179). These two maps used to be built only when the D1
    // binding was present, and an absent binding made them `{}` -- which is not
    // "no writer available", it is a consumer that acks every message for every
    // lane and drops the rows. The Neon writers below need no store binding and
    // never did.
    const familyWriters: SyncBatchFamilyWriters = {
      "chain-detail": async (families) => {
        const rows = {
          blockRows: families.blockRows ?? [],
          extrinsicRows: families.extrinsicRows ?? [],
          chainEventRows: families.chainEventRows ?? [],
          accountEventRows: families.accountEventRows ?? [],
        };
        const result = { statements: 0 };
        // THE LANE'S OTHER WRITER, mirrored here as well as on the HTTP
        // path.
        await mirrorChainDetailToNeon(env, ctx, rows);
        return result;
      },
    };
    const writers: SyncBatchWriters = {
      "hotkey-alpha": async (rows, pass) => {
        const result = { statements: 0 };
        const neon = await mirrorLedgerToNeon(
          env,
          ctx,
          "hotkey-alpha",
          rows,
          {},
          pass,
        );
        // UNCONDITIONAL, and the `neonOwns &&` that used to guard it was a
        // silent data-loss path (#10179).
        //
        // neonOwnsLedger requires HYPERDRIVE to be bound. So on the one
        // deployment where the write CANNOT happen -- no binding -- the guard
        // read false, the throw was skipped, and the consumer acked a message
        // whose rows reached no store at all. The condition disabled the check
        // exactly when the check was needed.
        //
        // There is one store now, so "did the write succeed" is the whole
        // question. writeSyncBatch turns a throw into a retry, which is the
        // only thing that can still save the rows.
        if (!neon.result?.ok) {
          throw new Error(
            `hotkey-alpha neon write failed: ${
              neon.result?.reason ?? "not attempted"
            }`,
          );
        }
        return result;
      }, // Recomputes the prune map from THIS message's rows, which is sound
      // only because the message asserted `key_complete` -- the
      // validator rejects it otherwise, so this writer never sees a chunk
      // that could prune rows it did not carry.
      "nominator-positions": async (rows, pass) => {
        const cutoffs = coldkeyMaxCapturedAt(rows);
        // D1 IS NOT WRITTEN -- nominator_positions and its pass ledger
        // are Neon's outright (#10111). The "mirror" is now the write, and
        // that changes what a failure MEANS here: while D1 held the rows a
        // Neon failure cost a lane verdict, and this writer could return
        // normally. Now returning normally ACKS the message and the rows
        // are gone, so the failure has to throw -- writeSyncBatch turns a
        // throw into a retry, which is the only thing that can still save
        // them.
        //
        // The declared pass rides the transport (metagraphed-infra#346): a
        // queue knows a message was DELIVERED, not whether the producer's
        // whole scan arrived, and only the second fact catches a load that
        // stopped halfway.
        const neon = await mirrorNominatorPositionsToNeon(env, ctx, {
          rows,
          coldkeyMaxCapturedAt: cutoffs,
          pass,
        });
        const failed = [
          neon.write,
          neon.prune,
          neon.coverage,
          neon.pass,
        ].filter((r) => r && !r.ok);
        if (!neon.attempted || failed.length > 0) {
          throw new Error(
            `nominator-positions neon write failed: ${
              failed
                .map((r) => r?.reason)
                .filter(Boolean)
                .join("; ") || "not attempted"
            }`,
          );
        }
        return { statements: 0 };
      },
      "account-balances": async (rows, pass) => {
        // The ONLY writer for this lane -- the HTTP route enqueues and
        // never writes inline, so there is no second path to keep in step.
        const result = { statements: 0 };
        // THE PASS WAS NEVER PASSED. writeAccountBalancesToStore took it and the
        // mirror did not, so D1 got a completeness tally and Neon got none --
        // account_balances_passes was empty there, and this lane was about to
        // become the only writer of it.
        const neon = await mirrorLedgerToNeon(
          env,
          ctx,
          "account-balances",
          rows,
          {},
          pass,
        );
        // AND THE RESULT WAS NEVER READ (#10179). This awaited the write and
        // returned regardless, so a failure was acked and the rows were gone --
        // on the lane whose own comment says it is the only writer. Every
        // sibling in this map throws; this one computed `neonOwns` and did
        // nothing with it.
        if (!neon.result?.ok) {
          throw new Error(
            `account-balances neon write failed: ${
              neon.result?.reason ?? "not attempted"
            }`,
          );
        }
        return result;
      }, // Redoes both derivations from THIS message's rows, which is sound
      // only because the message asserted `key_complete` -- the validator
      // rejects a neurons message without it, so this writer never sees a
      // chunk whose prune map would delete rows it did not carry.
      neurons: async (rows, pass) => {
        // THE ONE WRITER IN THIS BLOCK THAT NEVER ASKED (#10162). Every
        // other lane here gated on neonOwns* and mirrored; this wrote D1
        // outright and mirrored nothing. It is unreachable today --
        // SYNC_QUEUE_LANES does not list `neurons` -- which is precisely
        // why it survived: adding the lane to that flag would have started
        // writing the only copy of a metagraph snapshot to a store nothing
        // reads.
        const write = neuronSnapshotWrite(rows, Date.now());
        const result = { statements: 0 };
        const neon = await mirrorNeuronSnapshotToNeon(env, ctx, {
          ...write,
          pass,
        });
        // THROW, never return, on a failed write: a normal return acks the
        // queue message and the rows are gone. writeSyncBatch turns a throw
        // into a retry.
        //
        // UNCONDITIONAL, and the `neonOwns` that used to guard it was a silent
        // data-loss path (#10179): neonOwnsNeuronsSnapshot requires HYPERDRIVE,
        // so on the one deployment where the write cannot happen the guard read
        // false and the throw was skipped.
        //
        // Named tables rather than a fold over neon.results, because the mirror
        // answers `{ attempted: true, results: {} }` when Hyperdrive is unbound
        // and a "nothing said not-ok" test reads that as success.
        const reason = ["neurons", "neuron_daily", "account_position_daily"]
          .map((table) => {
            const r = neon.results?.[table];
            if (!r) return `${table}: no Neon write recorded`;
            return r.ok ? null : `${table}: ${r.reason ?? "failed"}`;
          })
          .filter(Boolean)
          .join("; ");
        if (reason) throw new Error(`neurons queue write failed: ${reason}`);
        return result;
      },
      "validator-nominator-counts": async (rows, pass) => {
        // D1 is not written -- this lane is Neon's outright (#10116) --
        // so the Neon write below is the ONLY one, and its failure must
        // throw rather than return: a normal return acks the message and
        // the rows are gone. writeSyncBatch turns a throw into a retry.
        const neon = await mirrorLedgerToNeon(
          env,
          ctx,
          "validator-nominator-counts",
          rows,
          {},
          pass,
        );
        if (!neon.result?.ok) {
          throw new Error(
            `validator-nominator-counts neon write failed: ${
              neon.result?.reason ?? "not attempted"
            }`,
          );
        }
        return { statements: 0 };
      },
    };
    for (const { message, body } of decoded) {
      if (!validSyncBatchMessage(body)) {
        // Acked, not retried: a message that cannot parse will not parse on the
        // fifth attempt either, and burning the budget only delays the DLQ.
        message.ack();
        continue;
      }
      try {
        await writeSyncBatch(body, writers, Date.now(), familyWriters);
        if (body.lane === "neurons" && body.pass_total !== undefined) {
          scheduleExplorerDirectoryRefresh(env, ctx, body.captured_at);
        }
        message.ack();
      } catch (err) {
        console.error("sync-batches: write failed:", err);
        await captureDataApiError(err, `sync-batches/${body.lane}`, env);
        // Retried: a store write that failed under load is exactly what the queue's
        // backoff exists for, and this is the failure the one-second producer
        // sleep was standing in for.
        message.retry();
      }
    }
    if (invalid > 0) {
      ctx.waitUntil(
        recordLaneVerdict(laneHealthStore(env), {
          lane: "sync-batches",
          verdict: "stale",
          age_ms: null,
          detail: `${invalid} unparseable message(s) in a batch of ${batch.messages.length}`,
          checked_at: Date.now(),
        }).then(() => undefined),
      );
    }
  },
};
