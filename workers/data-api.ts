// metagraphed data Worker — D1-backed serving, kept SEPARATE from the main
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
// What is left is the D1 surface: the neurons / subnet-hyperparams /
// account-identity read families (migrations/d1/0007 + 0009), the user-state
// routes (accounts, API keys, usage accounting, alert triggers, push
// subscriptions), the internal sync WRITE routes that land in D1, and the
// TAO/USD index cron. Routes whose store is gone still answer exactly what
// they answered before the deletion -- see dispatchDataApiRequest's own note
// for why that matters to the forward gate.
import { recordExceptionEvent } from "../src/usage-telemetry.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";
import { maskRouteParams } from "../src/route-label.ts";
import {
  newSpanId,
  newTraceId,
  recordTraceSpan,
  shouldSampleTrace,
} from "../src/tracing.ts";
import { decodeCursor, encodeCursor } from "../src/cursor.ts";
import { buildAccountSubnets } from "../src/account-events.ts";
import {
  buildObservationBatch,
  rowFromBatch,
  type TaoUsdIndexRow,
} from "../src/tao-usd-ingest.ts";
import { TAO_USD_INDEX_CRON } from "./config.ts";
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
import { buildAccountPortfolio } from "../src/account-portfolio.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  HISTORY_WINDOWS,
  DEFAULT_HISTORY_WINDOW,
  MAX_HISTORY_POINTS,
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
import { resolveClientIp, ROLLUP_TOKEN_HEADER } from "./config.ts";
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
  ACCOUNT_IDENTITY_INSERT_COLUMNS,
  IDENTITY_FIELDS,
  buildAccountIdentity,
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
  env: Env,
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
// the D1 loaders' `new Date(Date.now() - days*DAY_MS).toISOString().slice(0,10)`
// exactly. A `null` day value (e.g. HISTORY_WINDOWS.all) means no lower bound.
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
import {
  writeNeuronDailyBackfillToD1,
  writeNeuronSnapshotToD1,
} from "../src/neurons-d1-write.ts";
import {
  writeAccountIdentityToD1,
  writeSubnetHyperparamsToD1,
} from "../src/hyperparams-identity-d1-write.ts";
import {
  coldkeyMaxCapturedAt,
  writeNominatorPositionsToD1,
} from "../src/nominator-positions-d1-write.ts";
import { writeValidatorNominatorCountsToD1 } from "../src/validator-nominator-counts-d1-write.ts";
import { VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS } from "../src/validator-nominator-counts-staleness-watchdog.ts";
import { writeChainDetailToD1 } from "../src/chain-detail-d1-write.ts";
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
import { MCP_TIERED_RATE_LIMIT } from "../src/mcp-server.ts";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

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
// ~33k rows today (129 netuids x <=256 UIDs); generous headroom over that
// (matches the D1 staging path's MAX_STAGED_NEURON_ROWS/MAX_STAGED_NEURONS_BYTES,
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
function validNeuronSyncRow(row: Row) {
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
function neuronSyncSnapshotDate(capturedAtMs: number) {
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

// Coerce one validated row into the exact JS types each Postgres column
// expects: 0/1 -> boolean for the BOOLEAN columns (the fetch script emits
// 0/1 integers, same convention D1's INTEGER columns use), everything else
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

// --- Neurons-family READS on D1 (box decommission; migrations/d1/0007) ------
//
// The WRITE path lives on D1 (#9157's port in handleNeuronsSync below, whose
// Postgres half #9193 deleted). Reads switch separately, on
// METAGRAPH_NEURONS_SOURCE -- the SAME flag the main Worker's tryPostgresTier
// callers already gate on. Any value but "postgres" serves the neurons family
// (neurons / neuron_daily / account_position_daily) from the bounded D1
// database; "postgres" still means "not from D1", and now falls through to the
// dispatcher's 503, which is what it already did in production once the box
// was wiped. The flag's behaviour is unchanged by the deletion -- deliberately,
// so a stale deployed var can't change what a route answers.
function neuronsServedFromD1(env: Env) {
  return env.METAGRAPH_NEURONS_SOURCE !== "postgres";
}

async function handleNeuronsSync(request: Request, env: Env) {
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

  // Shaped ONCE, outside the transaction, so the D1 and Postgres writers put
  // the same rows in the same shape into both stores -- two shapings would be
  // two chances to diverge.
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

  // D1 is the binding this path REQUIRES -- it is the only store left (#9146,
  // #9193), so the sync has to keep working with nothing else bound or the
  // only live-refreshed family in the product stops advancing.
  //
  // Checked HERE, after parsing and validation, not at the top: a malformed
  // body is a 400 whether or not a store happens to be bound, and answering
  // 503 to it would blame the infrastructure for the caller's payload.
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }

  // It must succeed: this is where the data lives, so a D1 failure is a lost
  // snapshot. db.batch() runs its statements in one implicit transaction --
  // a mid-batch failure must never leave `neurons` upserted with stale UIDs
  // left un-pruned.
  let d1Statements: number;
  try {
    ({ statements: d1Statements } = await writeNeuronSnapshotToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeNeuronSnapshotToD1
      >[0],
      { rows, dailyRows, positionRows, netuidMaxCapturedAt },
    ));
  } catch (err) {
    console.error("data-api neurons-sync D1 write failed:", err);
    await captureDataApiError(err, "neurons-sync-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  // #9193: the Postgres half of #9157's dual write is gone with the box, so the
  // D1 write above IS the sync. Body unchanged from the D1-only branch this
  // replaces -- `stores` stays reported rather than inferred, so a reader can
  // still see which stores this snapshot actually reached.
  return writeJson({
    ok: true,
    neurons_written: rows.length,
    neuron_daily_written: dailyRows.length,
    account_position_daily_written: positionRows.length,
    netuids_covered: netuids.length,
    stores: ["d1"],
    d1_statements: d1Statements,
  });
}

// --- POST /api/v1/internal/chain-detail-sync (#9208) ------------------------
//
// The write path into the chain-detail HOT TIER: the rolling window of
// extrinsics / chain_events / account_events that makes block drill-down
// current instead of up to an hour stale. Same delivery pattern as every other
// lane in this file -- the producer decodes, POSTs a token-authed batch, and
// this lands it in D1 -- so there is no new topology, only a new destination.
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
function chainDetailSyncAuth(request: Request, env: Env): Response | null {
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

async function handleChainDetailSync(request: Request, env: Env) {
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

  // D1 is the binding this path REQUIRES -- it is the only store (data-api's
  // Postgres tier was deleted in #9202), so the lane has nowhere else to land.
  //
  // Checked HERE, after parsing and validation, not at the top: a malformed
  // body is a 400 whether or not a store happens to be bound, and answering 503
  // to it would blame the infrastructure for the caller's payload. Same
  // ordering, and the same reason, as handleNeuronsSync above.
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }

  let statements: number;
  try {
    ({ statements } = await writeChainDetailToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeChainDetailToD1
      >[0],
      batch.rows,
    ));
  } catch (err) {
    console.error("data-api chain-detail-sync D1 write failed:", err);
    await captureDataApiError(err, "chain-detail-sync-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  return writeJson({
    ok: true,
    blocks_written: batch.rows.blockRows.length,
    extrinsics_written: batch.rows.extrinsicRows.length,
    chain_events_written: batch.rows.chainEventRows.length,
    account_events_written: batch.rows.accountEventRows.length,
    head: batch.rows.head,
    stores: ["d1"],
    d1_statements: statements,
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
async function handleChainDetailSyncHead(request: Request, env: Env) {
  const denied = chainDetailSyncAuth(request, env);
  if (denied) return denied;
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
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

async function handleNeuronDailyBackfill(request: Request, env: Env) {
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
  if (
    !validatedIncoming.length ||
    !validatedIncoming.every(validNeuronSyncRow)
  ) {
    return writeJson({ error: "rows must match the neuron row shape" }, 400);
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
  // above -- that invariant is store-independent). D1 is the binding this
  // path REQUIRES; it is also how the operator replays the box's
  // neuron_daily/account_position_daily history into D1. Checked after
  // validation for the same 400-before-503 reasoning as the sync handler.
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }
  let d1Statements: number;
  try {
    ({ statements: d1Statements } = await writeNeuronDailyBackfillToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeNeuronDailyBackfillToD1
      >[0],
      { dailyRows, positionRows },
    ));
  } catch (err) {
    console.error("data-api neuron-daily-backfill D1 write failed:", err);
    await captureDataApiError(err, "neuron-daily-backfill-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  // #9193: same deletion as handleNeuronsSync above -- the D1 write IS the sync.
  return writeJson({
    ok: true,
    neuron_daily_written: dailyRows.length,
    account_position_daily_written: positionRows.length,
    stores: ["d1"],
    d1_statements: d1Statements,
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
// internally instead. Mirrors D1's rollupAccountEventsDaily
// (src/account-events.ts) exactly: re-roll the two active UTC days each
// run (past days are already finalized), upsert idempotently. No request
// body -- this is a trigger-only POST, not a data-carrying sync.

async function handleRollupAccountEventsDaily(request: Request, env: Env) {
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
  // #9193: the Postgres tier this route wrote into was destroyed with the box,
  // and HYPERDRIVE has been unbound since #9186 -- everything past this gate has
  // been unreachable ever since (account_events, the source it
  // rolled up, only ever lived on the box). Status and body are deliberately
  // unchanged: the caller already reads this as "the mirror is gone".
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/subnet-hyperparams-sync (#4832 gap-closure) -----
//
// The write path into subnet_hyperparams + subnet_hyperparams_history,
// reached only via workers/api.ts's handleSubnetHyperparamsSyncProxy (the
// same proxyToDataApi shape as neurons-sync/rollup-account-events-daily
// above) -- now this workflow's SOLE write path, D1's own R2-stage-to-D1
// loader (loadStagedSubnetHyperparams) having been retired alongside D1's
// copy of these two tables. .github/workflows/refresh-subnet-hyperparams.yml's
// sign-and-stage job POSTs the signed envelope produced by
// scripts/sign-staged-neurons.ts (its {schema_version, hmac_sha256, rows}
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
function validSubnetHyperparamsSyncRow(row: Row) {
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

async function handleSubnetHyperparamsSync(request: Request, env: Env) {
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
  if (!incoming.length || !incoming.every(validSubnetHyperparamsSyncRow)) {
    return writeJson(
      { error: "rows must match the subnet-hyperparams row shape" },
      400,
    );
  }

  const rows = incoming.map(coerceSubnetHyperparamsSyncRow);
  const netuids = incoming.map((row: Row) => row.netuid);

  // Hashed ONCE, before either store writes, on the RAW incoming rows
  // (pre-coercion) -- formatSubnetHyperparams' toD1Flag(value) tolerates
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

  // D1 is the binding this path REQUIRES -- the only store this family has
  // since the box went away (#9157's contract, applied to this lane). Checked
  // HERE, after parsing and validation, not at the top: a malformed body is a
  // 400 whether or not a store happens to be bound.
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }

  // D1 first, and it must succeed: it is where this family lives now.
  let d1Statements: number;
  let d1HistoryAppended: number;
  try {
    const d1Sql = createD1Sql(env.METAGRAPH_HEALTH_DB);
    // Latest hash per netuid -- group-wise MAX(id) join, the SQLite spelling
    // of the Postgres side's `DISTINCT ON (netuid) ... ORDER BY netuid, id
    // DESC` below.
    const latest = await d1Sql`
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
    d1HistoryAppended = historyRows.length;
    ({ statements: d1Statements } = await writeSubnetHyperparamsToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeSubnetHyperparamsToD1
      >[0],
      { rows, netuids, historyRows },
    ));
  } catch (err) {
    console.error("data-api subnet-hyperparams-sync D1 write failed:", err);
    await captureDataApiError(err, "subnet-hyperparams-sync-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  // #9193: same deletion as handleNeuronsSync above -- the D1 write IS the sync.
  return writeJson({
    ok: true,
    subnet_hyperparams_written: rows.length,
    history_appended: d1HistoryAppended,
    stores: ["d1"],
    d1_statements: d1Statements,
  });
}

// --- POST /api/v1/internal/subnet-locks-sync (#6638, conviction/ownership-
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
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

async function handleSubnetLocksSync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
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
function validAccountIdentitySyncRow(row: Row) {
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

async function handleAccountIdentitySync(request: Request, env: Env) {
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

  // D1 is the binding this path REQUIRES -- the only store this family has
  // since the box went away (#9157's contract, applied to this lane). Checked
  // after parsing and validation for the same reason as the hyperparams sync.
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }

  let d1Statements: number;
  let d1HistoryAppended: number;
  try {
    const d1Sql = createD1Sql(env.METAGRAPH_HEALTH_DB);
    // Latest hash per account -- group-wise MAX(id) join, the SQLite
    // spelling of the Postgres `DISTINCT ON (account)` below.
    const latest = await d1Sql`
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
    d1HistoryAppended = historyRows.length;
    ({ statements: d1Statements } = await writeAccountIdentityToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeAccountIdentityToD1
      >[0],
      { rows, historyRows },
    ));
  } catch (err) {
    console.error("data-api account-identity-sync D1 write failed:", err);
    await captureDataApiError(err, "account-identity-sync-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  // #9193: same deletion as handleNeuronsSync above -- the D1 write IS the sync.
  return writeJson({
    ok: true,
    account_identity_written: rows.length,
    history_appended: d1HistoryAppended,
    stores: ["d1"],
    d1_statements: d1Statements,
  });
}

// --- POST /api/v1/internal/validator-nominator-counts-sync (#2549) --------
//
// RESTORED ON D1 (#9146). Retired by #9193 when the Postgres table it wrote
// was destroyed with the box; this is the same route against
// migrations/d1/0011_validator_nominator_counts.sql instead.
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
function validNominatorCountSyncRow(row: Row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  for (const key of Object.keys(row)) {
    if (!VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS.includes(key)) return false;
  }
  if (typeof row.hotkey !== "string" || row.hotkey.length === 0) return false;
  if (
    utf8Bytes(row.hotkey).length > VALIDATOR_NOMINATOR_COUNTS_SYNC_MAX_KEY_BYTES
  )
    return false;
  if (!Number.isInteger(row.nominator_count) || row.nominator_count < 0)
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  return true;
}

/** Project a validated row onto the writer's exact column list and order. */
function coerceNominatorCountSyncRow(row: Row) {
  const out: Row = {};
  for (const col of VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS)
    out[col] = row[col];
  return out;
}

async function handleValidatorNominatorCountsSync(request: Request, env: Env) {
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
  if (!incoming.length || !incoming.every(validNominatorCountSyncRow)) {
    return writeJson(
      { error: "rows must match the nominator count row shape" },
      400,
    );
  }

  const rows = incoming.map(coerceNominatorCountSyncRow);

  // D1 is the binding this path REQUIRES -- the only store this family has.
  // Checked HERE, after validation, not at the top: a malformed body is a 400
  // whether or not a store happens to be bound (handleNominatorPositionsSync's
  // own 400-before-503 reasoning).
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }

  let d1Statements: number;
  try {
    ({ statements: d1Statements } = await writeValidatorNominatorCountsToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeValidatorNominatorCountsToD1
      >[0],
      rows,
    ));
  } catch (err) {
    console.error(
      "data-api validator-nominator-counts-sync D1 write failed:",
      err,
    );
    await captureDataApiError(err, "validator-nominator-counts-sync-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  return writeJson({
    ok: true,
    nominator_counts_written: rows.length,
    stores: ["d1"],
    d1_statements: d1Statements,
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
function validNominatorPositionSyncRow(row: Row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  for (const key of Object.keys(row)) {
    if (!NOMINATOR_POSITION_INSERT_COLUMNS.includes(key)) return false;
  }
  for (const key of ["coldkey", "hotkey"]) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) return false;
    if (utf8Bytes(value).length > NOMINATOR_POSITIONS_SYNC_MAX_KEY_BYTES)
      return false;
  }
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > NOMINATOR_POSITIONS_SYNC_MAX_NETUID
  )
    return false;
  if (
    typeof row.share_fraction !== "number" ||
    !Number.isFinite(row.share_fraction) ||
    row.share_fraction < 0 ||
    row.share_fraction > 1
  )
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  return true;
}

/** Project a validated row onto the writer's exact column list and order. */
function coerceNominatorPositionSyncRow(row: Row) {
  const out: Row = {};
  for (const col of NOMINATOR_POSITION_INSERT_COLUMNS) out[col] = row[col];
  return out;
}

async function handleNominatorPositionsSync(request: Request, env: Env) {
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
  if (!incoming.length || !incoming.every(validNominatorPositionSyncRow)) {
    return writeJson(
      { error: "rows must match the nominator-position row shape" },
      400,
    );
  }

  const rows = incoming.map(coerceNominatorPositionSyncRow);
  const cutoffs = coldkeyMaxCapturedAt(rows);

  // D1 is the binding this path REQUIRES -- the only store this family has.
  // Checked HERE, after validation, not at the top: a malformed body is a 400
  // whether or not a store happens to be bound (handleSubnetHyperparamsSync's
  // own 400-before-503 reasoning).
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }

  let d1Statements: number;
  try {
    ({ statements: d1Statements } = await writeNominatorPositionsToD1(
      env.METAGRAPH_HEALTH_DB as unknown as Parameters<
        typeof writeNominatorPositionsToD1
      >[0],
      { rows, coldkeyMaxCapturedAt: cutoffs },
    ));
  } catch (err) {
    console.error("data-api nominator-positions-sync D1 write failed:", err);
    await captureDataApiError(err, "nominator-positions-sync-d1", env);
    return writeJson({ error: "d1 write failed" }, 502);
  }

  return writeJson({
    ok: true,
    nominator_positions_written: rows.length,
    coldkeys_pruned: cutoffs.size,
    stores: ["d1"],
    d1_statements: d1Statements,
  });
}

// --- POST /api/v1/internal/account-balances-sync (#6742) -------------------
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// Chain-wide free/reserved balance snapshot, one row per account with a
// nonzero balance --
// apps/indexer-rs/src/bin/poller/jobs/account_balances.rs's own header comment
// on why this reads System::Account directly rather than reconstructing
// balance from transfer/fee/stake events (a direct state read can't drift;
// event-replay can, one missed mutation path at a time). Same "latest-only,
// captured_at freshness guard" upsert shape as nominator-positions-sync.
const ACCOUNT_BALANCES_SYNC_TOKEN_HEADER = "x-account-balances-sync-token";

async function handleAccountBalancesSync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/subnet-identity-sync (#4832 gap-closure) -------
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// The write path into subnet_identity_history -- architecturally different
// from the three internal sync routes above: this one is triggered from
// WITHIN the main Worker's own hourly cron (writeSubnetSnapshot,
// src/health-prober.ts), not an external GitHub Actions workflow, so it's
// called via a direct env.DATA_API.fetch() service-binding call rather than
// crossing the public internet through workers/api.ts's proxy layer (see
// that function's own comment). No latest-only sibling table exists here
// (mirrors D1's own shape -- the current identity lives in the profiles.json
// artifact itself): only diff-and-append against the last recorded hash per
// netuid, reusing identitySnapshotFromProfile/identityHash UNCHANGED from
// src/subnet-identity-history.ts so the hash stays domain-identical to the
// D1 path. No dedicated per-field row validator (unlike the other three
// sync routes): profiles.json is the SAME trust boundary D1's own
// recordSubnetIdentityChanges reads from directly with no staging-style
// validation either -- identitySnapshotFromProfile's own null-guard already
// skips a malformed individual profile without erroring the batch.
const SUBNET_IDENTITY_SYNC_TOKEN_HEADER = "x-subnet-identity-sync-token";

async function handleSubnetIdentitySync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/health-checks-sync (#4832 gap-closure) --------
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// Best-effort Postgres mirror of the D1+KV probe write in
// src/health-prober.ts's runHealthProber -- same "own hourly/15-min cron,
// direct env.DATA_API.fetch() service-binding call" shape as
// subnet-identity-sync above, not an external GitHub Actions workflow. D1+KV
// stay the sole authoritative write target (live serving reads them
// unchanged); this route only mirrors the SAME probed batch into
// surface_checks/surface_status so the Postgres tier can eventually take
// over the read side. surface_status uses ON CONFLICT (surface_id) only
// (not D1's dual surface_key/surface_id conflict targets -- Postgres allows
// one conflict target per INSERT), so the handler compensates for the
// surface_key unique index (idx_surface_status_key_unique) itself: it dedupes
// the batch and evicts stale key-holders before the upsert (METAGRAPHED-B).
// The original "a rename can briefly fail this route, acceptable degrade"
// stance was wrong in practice -- one stale key-holder row aborted the WHOLE
// single-transaction mirror write on every 15-min probe run, permanently.
const HEALTH_CHECKS_SYNC_TOKEN_HEADER = "x-health-checks-sync-token";

async function handleHealthChecksSync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/health-uptime-rollup-sync (#4832 gap-closure) --
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// Best-effort Postgres mirror of src/health-prober.ts's rollupDailyUptime,
// same shape/isolation as health-checks-sync above (reuses
// HEALTH_CHECKS_SYNC_SECRET -- see that route's own header comment). Unlike
// health-checks-sync, the request body carries only UTC day *boundaries*,
// not precomputed rows -- this route computes the rollup itself from
// surface_checks (already mirrored here by health-checks-sync), using
// PERCENTILE_CONT for the p50/p95/p99 tail latency instead of replaying
// D1/SQLite's rank-based CTE (src/health-sql.ts's rankedChecksCte/
// latencyStatColumns) column-for-column.
async function handleHealthUptimeRollupSync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/subnet-snapshot-sync (#4832 gap-closure) ------
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// Best-effort Postgres mirror of writeSubnetSnapshot's D1 upsert
// (src/health-prober.ts) -- same "own hourly cron, direct
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

async function handleSubnetSnapshotSync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/rpc-usage-sync (#4832 gap-closure) ------------
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// Best-effort Postgres mirror of recordRpcUsage's D1 insert
// (workers/request-handlers/rpc-proxy.ts's syncRpcUsageEventToPostgres) --
// Pattern C, unlike every sync route above: one fire-and-forget POST per
// live proxied RPC request under the caller's own ctx.waitUntil, not a
// cron/workflow batch. Justified only after confirming live production
// volume is trivial (69 rows / ~25 days, wrangler d1 execute 2026-07-11) --
// batching would be premature for traffic this low. One event per request,
// not an array, matching the caller's one-row-per-call shape.
const RPC_USAGE_SYNC_TOKEN_HEADER = "x-rpc-usage-sync-token";

async function handleRpcUsageEventSync(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

// --- POST /api/v1/internal/rpc-usage-prune (#5497 gap-closure) -----------
//
// RETIRED (#9193): the Postgres tables this wrote were destroyed with the
// box, so the handler now stops at its auth gate and answers exactly what it
// already answered in production. What follows describes what it DID.
//
// The Postgres mirror of rpc_proxy_events written by handleRpcUsageEventSync
// above has no retention of its own (D1's copy is pruned to a 30-day hot
// window on the hourly maintenance cron; Postgres just grew unbounded).
// Called from src/health-prober.ts's pruneHealthHistory
// (syncRpcProxyEventsPruneToPostgres), on the same cron, right after the D1
// prune -- reuses the rpc-usage-sync token/secret (same trust boundary: both
// routes write to the same table, no reason for a second secret).
async function handleRpcUsageEventPrune(request: Request, env: Env) {
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
  // #9193: same deletion as handleRollupAccountEventsDaily above -- unreachable
  // since HYPERDRIVE went away, answered here, status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
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

// Lookback (days) for each realized-return window (#7228), keyed by the
// baseline-object field buildGlobalValidators/buildValidatorDetail read
// (realized_return_1d/1w/1m). Mirrors the neuron_daily HISTORY_WINDOWS map --
// the rollup's snapshot_date is a native DATE, so each cutoff is computed the
// same way windowCutoffDate does.
const REALIZED_RETURN_WINDOWS = { d1: 1, d7: 7, d30: 30 };

// #8837: a permitted snapshot may serve as a window's baseline only when it
// lands within this many days of that window's target date (today − N days).
// neuron_daily writes one snapshot per validator per UTC day, so a tolerance
// of 2 lets a window fall back to the prior day when a single day's snapshot
// is missing or late, while rejecting anything older -- so a "1-day return"
// can never be computed against a week-old baseline (the stale-baseline bug
// this closes). Applied uniformly to all three REALIZED_RETURN_WINDOWS.
export const REALIZED_RETURN_BASELINE_TOLERANCE_DAYS = 2;

// postgres.js returns BIGINT columns as strings; the D1-backed routes return them
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
// database (migrations/d1/0004_user_state.sql), not the chain-data Postgres
// tier -- they are the box's last functional tenants and D1 is exactly their
// lane (small, transactional, user/config state). The runner below is a
// tagged-template shim over D1's prepare/bind/all so the ~40 existing call
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

type D1SqlRows = Record<string, unknown>[];
interface D1Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<D1SqlRows>;
  /** Positional-placeholder escape hatch, mirroring postgres.js's
   * sql.unsafe(text, params) -- used only where the statement text is built
   * dynamically (the matched-write-back's `IN (?, ?, ...)` expansion). */
  unsafe(text: string, values?: unknown[]): Promise<D1SqlRows>;
}

function coerceD1BindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    return JSON.stringify(value);
  }
  return value;
}

// Exported for tests/data-api-user-state-d1.test.ts, which exercises the
// bind-coercion contract directly against a real SQLite database (routes
// cannot produce every input shape -- e.g. an undefined bind -- but the
// runner's contract still covers them).
export function createD1Sql(db: D1Database): D1Sql {
  const run = async (text: string, values: unknown[]): Promise<D1SqlRows> => {
    const result = await db
      .prepare(text)
      .bind(...values.map(coerceD1BindValue))
      .all();
    return (result.results ?? []) as D1SqlRows;
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    run(strings.join("?"), values)) as D1Sql;
  sql.unsafe = (text: string, values: unknown[] = []) => run(text, values);
  return sql;
}

/** A TEXT column holding JSON (the D1 translation of Postgres text[]/jsonb),
 * parsed where the row value is consumed. Null-safe; a non-string value
 * passes through untouched (it is already parsed -- e.g. a PATCH body field
 * merged over the row), and unparseable text degrades to null rather than
 * throwing inside a read path. */
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
function d1Bool(value: unknown): boolean {
  return value === true || value === 1;
}

/** One chain_alert_triggers row, D1 shape -> the shape every consumer
 * (ownerAlertTriggerView, evaluatorAlertTriggerView,
 * mergeAlertTriggerUpdateBody, validateAlertTriggerInput) already expects:
 * table_filter/condition parsed from their TEXT-JSON columns, active a real
 * boolean. */
function normalizeAlertTriggerRow(row: Row): Row;
function normalizeAlertTriggerRow(row: Row | undefined): Row | null;
function normalizeAlertTriggerRow(row: Row | undefined): Row | null {
  if (!row) return null;
  return {
    ...row,
    table_filter: parseJsonColumn(row.table_filter),
    condition: parseJsonColumn(row.condition),
    active: d1Bool(row.active),
  };
}

/** One chain_alert_deliveries row: success is INTEGER 0/1 on D1, and
 * deliveryRecordView's `success === true` check needs the boolean. */
function normalizeDeliveryRow(row: Row): Row {
  return { ...row, success: d1Bool(row.success) };
}

async function withAlertTriggersSql(
  env: Env,
  fn: (sql: D1Sql) => Promise<Response>,
) {
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }
  const sql = createD1Sql(env.METAGRAPH_HEALTH_DB);
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
  env: Env,
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

async function handleAlertTriggerCreate(request: Request, env: Env) {
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

  return withAlertTriggersSql(env, async (sql) => {
    if (ownerSs58) {
      const counted = await sql`
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
    const [row] = await sql`
      INSERT INTO chain_alert_triggers
        (owner_token, name, table_filter, netuid, event_kind, account, min_amount_tao, condition, channel, destination, active, owner_ss58, created_at, updated_at)
      VALUES (
        ${ownerToken}, ${v.name}, ${v.tableFilter}, ${v.netuid}, ${v.eventKind},
        ${v.account}, ${v.minAmountTao}, ${v.condition ?? null},
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

async function handleAlertTriggerGet(request: Request, env: Env, id: string) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  return withAlertTriggersSql(env, async (sql) => {
    const [row] =
      await sql`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!row) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(
      request,
      row.owner_token as string | null,
    );
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

async function runAlertTriggerUpdate(sql: D1Sql, id: string, merged: Row) {
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
      condition = ${v.condition ?? null},
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
  env: Env,
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
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(
      request,
      existing.owner_token as string | null,
    );
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
  env: Env,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT owner_token FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing) return writeJson({ error: "no such trigger" }, 404);
    const authError = requireAlertTriggerOwner(
      request,
      existing.owner_token as string | null,
    );
    if (authError) return authError;
    await sql`DELETE FROM chain_alert_triggers WHERE id = ${id}`;
    return writeJson({ id, deleted: true });
  });
}

// Internal-only: the #4984 Part 2 evaluator's cache-refresh scan. A
// DIFFERENT secret from the create/owner tokens above -- it grants a wholly
// different capability (read every trigger regardless of owner).
async function handleAlertTriggersActiveList(request: Request, env: Env) {
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
async function handleAlertTriggersMatchedWriteback(request: Request, env: Env) {
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
    // Plain scalar positional binds via sql.unsafe -- the statement text is
    // built dynamically (one `?` per already-isValidAlertTriggerId-validated
    // id), which a tagged template can't express. The first bind is the
    // shared `now` timestamp.
    const placeholders = ids.map(() => "?").join(", ");
    const updated = await sql.unsafe(
      `UPDATE chain_alert_triggers
       SET match_count = match_count + 1,
           last_matched_at = ?
       WHERE id IN (${placeholders})
       RETURNING id`,
      [now, ...ids],
    );
    return writeJson({ updated: updated.length });
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
async function handleAlertTriggersDeliveryLogWrite(request: Request, env: Env) {
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
  return withAlertTriggersSql(env, async (sql) => {
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
      await sql`
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
      await sql`
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

// Internal-only: the #6747 evaluator's METRIC cache-refresh scan -- the raw
// rows AlerterHub.refreshTriggers() feeds into src/dereg-risk.ts's
// buildDeregRiskSnapshot to build the in-memory Maps triggerMatchesEvent's
// condition check reads from. Gated the SAME way as the active-list/
// writeback routes above (same ALERT_TRIGGERS_INTERNAL_TOKEN secret, a
// different capability from the create/owner tokens).
//
// The scan itself read the box's Postgres and is gone with it (#9193); the
// route stays where it is, answering the caller exactly as it does today,
// until the evaluator side stops asking.
async function handleDeregRiskSnapshot(request: Request, env: Env) {
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
  // #9193: every table this snapshot scanned (blocks / subnet_hyperparams /
  // subnet_snapshots, plus the neurons read that had already moved to D1) was
  // reached through withDeregRiskSql, whose HYPERDRIVE gate has answered every
  // call since the binding went away. Status and body unchanged.
  return writeJson({ error: "hyperdrive binding unavailable" }, 503);
}

async function handleAlertTriggersRoute(request: Request, env: Env, url: URL) {
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
  env: Env,
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

async function handleWatchTriggersList(request: Request, env: Env) {
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, async (sql) => {
    const rows = await sql`
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
  env: Env,
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
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT * FROM chain_alert_triggers WHERE id = ${id}`;
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
  env: Env,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT owner_ss58 FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing || existing.owner_ss58 !== auth.ss58) {
      return writeJson({ error: "no such trigger" }, 404);
    }
    await sql`DELETE FROM chain_alert_triggers WHERE id = ${id}`;
    return writeJson({ id, deleted: true });
  });
}

async function handleWatchTriggerDeliveries(
  request: Request,
  env: Env,
  id: string,
) {
  if (!isValidAlertTriggerId(id)) {
    return writeJson({ error: "malformed trigger id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, async (sql) => {
    const [existing] =
      await sql`SELECT owner_ss58 FROM chain_alert_triggers WHERE id = ${id}`;
    if (!existing || existing.owner_ss58 !== auth.ss58) {
      return writeJson({ error: "no such trigger" }, 404);
    }
    const rows = await sql`
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

async function handleWatchTriggersRoute(request: Request, env: Env, url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "watch", "triggers", <id?>, <"deliveries"?>]
  const id = segments[4];
  const sub = segments[5];
  if (!id && request.method === "GET") {
    return handleWatchTriggersList(request, env);
  }
  if (id && sub === "deliveries" && request.method === "GET") {
    return handleWatchTriggerDeliveries(request, env, id);
  }
  if (id && !sub && request.method === "PATCH") {
    return handleWatchTriggerUpdate(request, env, id);
  }
  if (id && !sub && request.method === "DELETE") {
    return handleWatchTriggerDelete(request, env, id);
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

async function handleWatchPushSubscriptionsList(request: Request, env: Env) {
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, async (sql) => {
    const rows = await sql`
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

async function handleWatchPushSubscriptionCreate(request: Request, env: Env) {
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }

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

  return withAlertTriggersSql(env, async (sql) => {
    // Read the OWNER, not just existence. An endpoint is globally unique, so
    // without this check a verified address could POST an endpoint already
    // registered to someone else and the upsert below would silently reassign
    // it: the original owner loses their device, the taker skips their own
    // device cap, and the taker's alert triggers start pushing to a browser
    // that never subscribed to them. Ownership is the thing being enforced
    // here -- existence alone is not enough.
    const existing = await sql`
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
      const count = await sql`
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

    const rows = await sql`
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
  env: Env,
  id: string,
) {
  if (!/^[0-9]{1,19}$/.test(id)) {
    return writeJson({ error: "malformed subscription id" }, 400);
  }
  const auth = await requireVerifiedWatchSs58(request, env);
  if (!auth.ok) return auth.response;
  return withAlertTriggersSql(env, async (sql) => {
    // Scoped by address: another address' id returns the same 404 a
    // nonexistent one does (the anti-oracle posture the trigger routes use).
    const rows = await sql`
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
  env: Env,
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
    return withAlertTriggersSql(env, async (sql) => {
      const rows = await sql`
        SELECT endpoint, p256dh, auth FROM watch_push_subscriptions
        WHERE endpoint = ${endpoint}`;
      const row = rows[0];
      if (!row) return writeJson({ subscription: null });
      // Best-effort liveness stamp so the device list can show "last used".
      await sql`
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
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return writeJson({ error: "body must be JSON" }, 400);
    }
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) return writeJson({ error: "endpoint is required" }, 400);
    return withAlertTriggersSql(env, async (sql) => {
      await sql`DELETE FROM watch_push_subscriptions WHERE endpoint = ${endpoint}`;
      // Idempotent: pruning an already-pruned device is a success, not a 404
      // -- the caller is fire-and-forget and must never see a spurious error.
      return writeJson({ pruned: true });
    });
  }

  return writeJson({ error: "Use GET or DELETE." }, 405);
}

async function handleWatchPushSubscriptionsRoute(
  request: Request,
  env: Env,
  url: URL,
) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "watch", "push-subscriptions", <id?>]
  const id = segments[4];
  if (!id && request.method === "GET") {
    return handleWatchPushSubscriptionsList(request, env);
  }
  if (!id && request.method === "POST") {
    return handleWatchPushSubscriptionCreate(request, env);
  }
  if (id && request.method === "DELETE") {
    return handleWatchPushSubscriptionDelete(request, env, id);
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
  env: Env,
  fn: (sql: D1Sql) => Promise<T>,
): Promise<T | Response> {
  if (!env.METAGRAPH_HEALTH_DB) {
    return writeJson({ error: "d1 binding unavailable" }, 503);
  }
  const sql = createD1Sql(env.METAGRAPH_HEALTH_DB);
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

async function walletAuthRateLimited(request: Request, env: Env) {
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

async function handleWalletChallenge(request: Request, env: Env) {
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

async function handleWalletVerify(request: Request, env: Env) {
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
  return withAccountsSql(env, async (sql) => {
    const now = Date.now();
    const [account] = await sql`
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

async function handleWatchChallenge(request: Request, env: Env) {
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

async function handleWatchTokenMint(request: Request, env: Env) {
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
async function handleGithubAccountUpsert(request: Request, env: Env) {
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
async function requireAccountSession(request: Request, env: Env) {
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

async function handleAccountKeyCreate(request: Request, env: Env) {
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

async function handleAccountKeysList(request: Request, env: Env) {
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

async function handleAccountKeyRevoke(
  request: Request,
  env: Env,
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
async function handleApiKeyVerify(request: Request, env: Env) {
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
async function handleApiKeyUsageIncrement(request: Request, env: Env) {
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
  // #8609: a REJECTED request increments rejected_count instead of
  // request_count. Only a literal true counts -- anything else is a success,
  // so a malformed flag can never silently erase real usage.
  const rejected = body?.rejected === true;
  if (!Number.isFinite(accountId) || !route) {
    return writeJson({ error: "provide account_id and route" }, 400);
  }
  try {
    await withAccountsSql(env, async (sql) => {
      const day = new Date().toISOString().slice(0, 10);
      await sql`
        INSERT INTO api_key_usage_daily
          (account_id, day, route, request_count, rejected_count)
        VALUES (
          ${accountId}, ${day}, ${route},
          ${rejected ? 0 : 1}, ${rejected ? 1 : 0}
        )
        ON CONFLICT (account_id, day, route)
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
async function handleApiQuotaSpend(request: Request, env: Env) {
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
  let body: { account_id?: unknown; cost?: unknown; limit?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return writeJson({ error: "invalid body" }, 400);
  }
  const accountId = Number(body?.account_id);
  const cost = Number(body?.cost);
  const limit = Number(body?.limit);
  if (
    !Number.isInteger(accountId) ||
    accountId <= 0 ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return writeJson({ error: "provide account_id, cost and limit" }, 400);
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

  const result = await withAccountsSql(env, async (sql) => {
    // The SPEND is one guarded upsert -- atomic on its own. The WHERE guard
    // is applyQuotaSpend's reject rule expressed as a conflict predicate:
    // when the new total would exceed the limit the DO UPDATE does not fire,
    // so no rows come back AND the counter is left untouched. (The Postgres
    // version wrapped this in a data-modifying CTE to also read the rejected
    // balance in the same snapshot; SQLite has no data-modifying CTEs, so the
    // reject path reads the unchanged balance in a follow-up SELECT --
    // enforcement is still the single guarded statement, only the 429's
    // advisory `spent` readout could in principle race a concurrent spend.)
    const attempt = await sql`
      INSERT INTO api_quota_daily (account_id, day, units_spent, updated_at)
      VALUES (${accountId}, ${day}, ${cost}, ${now})
      ON CONFLICT (account_id, day) DO UPDATE
        SET units_spent = api_quota_daily.units_spent + EXCLUDED.units_spent,
            updated_at = ${now}
        WHERE api_quota_daily.units_spent + EXCLUDED.units_spent <= ${limit}
      RETURNING units_spent`;
    const spent = attempt[0]?.units_spent;
    if (spent != null) {
      return applyQuotaSpend(Number(spent) - cost, cost, limit, now);
    }
    const [current] = await sql`
      SELECT units_spent FROM api_quota_daily
      WHERE account_id = ${accountId} AND day = ${day}`;
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
async function handleUsageRollupIncrement(request: Request, env: Env) {
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
  let body: { buckets?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return writeJson({ error: "invalid body" }, 400);
  }
  const buckets = Array.isArray(body?.buckets) ? body.buckets : [];
  if (buckets.length === 0) return writeJson({ ok: true, applied: 0 });
  try {
    await withAccountsSql(env, async (sql) => {
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
        await sql`
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
async function handleUsageRollupRead(request: Request, env: Env) {
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
  const result = await withAccountsSql(env, async (sql) => {
    const rows =
      groupBy === "shape"
        ? await sql`
            SELECT cost_shape,
                   SUM(request_count) AS request_count,
                   SUM(keyed_count) AS keyed_count
            FROM api_usage_rollup
            WHERE day >= ${since}
            GROUP BY cost_shape
            ORDER BY SUM(request_count) DESC`
        : await sql`
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
async function handleAccountTierPromote(request: Request, env: Env) {
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
        updateUnkeyKeyTier(env, { keyId: String(row.unkey_key_id), tier }),
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
async function refreshBlocklistSnapshot(env: Env, sql: D1Sql) {
  const rows = await sql`
    SELECT account_id, reason_code, blocked_at
    FROM api_key_blocks
    WHERE unblocked_at IS NULL
    ORDER BY account_id`;
  const snapshot = {
    generated_at: new Date().toISOString(),
    blocks: rows.map((row) => ({
      // account_id is BIGINT -- postgres.js returns it as a STRING, and
      // evaluateBlock compares with Number(). Coerced here so the SNAPSHOT is
      // already the right shape rather than relying on every reader to
      // remember (the #8607 trap).
      accountId: Number(row.account_id),
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

function requireBlockToken(request: Request, env: Env) {
  const configured = (
    env as unknown as { API_KEY_BLOCK_INTERNAL_TOKEN?: string }
  ).API_KEY_BLOCK_INTERNAL_TOKEN;
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
async function handleApiKeyBlock(request: Request, env: Env) {
  const denied = requireBlockToken(request, env);
  if (denied) return denied;
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const accountId = Number(body?.account_id);
  const reasonCode = body?.reason_code;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return writeJson({ error: "provide a valid account_id" }, 400);
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
  return withAccountsSql(env, async (sql) => {
    // ON CONFLICT DO NOTHING against the one-active-block-per-account partial
    // unique index: blocking an already-blocked account is a no-op rather than
    // an error, so an ops action that gets retried or double-clicked stays
    // idempotent instead of 500ing.
    const [row] = await sql`
      INSERT INTO api_key_blocks
        (account_id, reason_code, note, blocked_at, blocked_by)
      VALUES (${accountId}, ${reasonCode}, ${note}, ${Date.now()}, ${blockedBy})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    const active = await refreshBlocklistSnapshot(env, sql);
    return writeJson({
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
async function handleApiKeyUnblock(request: Request, env: Env) {
  const denied = requireBlockToken(request, env);
  if (denied) return denied;
  const { body, error } = await readAccountRouteBody(request);
  if (error) return error;
  const accountId = Number(body?.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return writeJson({ error: "provide a valid account_id" }, 400);
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
  return withAccountsSql(env, async (sql) => {
    const [row] = await sql`
      UPDATE api_key_blocks
      SET unblocked_at = ${Date.now()}, unblocked_note = ${note.slice(0, 2000)}
      WHERE account_id = ${accountId} AND unblocked_at IS NULL
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
async function handleApiKeyAnomalies(request: Request, env: Env) {
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
  return withAccountsSql(env, async (sql) => {
    const usage = await sql`
      SELECT account_id, day, route, request_count
      FROM api_key_usage_daily
      WHERE day >= ${since}
      ORDER BY account_id, day`;
    const blocked = await sql`
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
async function handleAccountKeyStatus(request: Request, env: Env) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  return withAccountsSql(env, async (sql) => {
    const [row] = await sql`
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

async function handleAccountKeyUsage(request: Request, env: Env, url: URL) {
  const { session, error: sessionError } = await requireAccountSession(
    request,
    env,
  );
  if (sessionError) return sessionError;
  return withAccountsSql(env, async (sql) => {
    const since = new Date(
      Date.now() - USAGE_DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const rows = await sql`
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
    const [quotaRow] = await sql`
      SELECT units_spent FROM api_quota_daily
      WHERE account_id = ${session.accountId} AND day = ${today}`;
    const unitsSpent = Number(quotaRow?.units_spent ?? 0) || 0;
    // The tier is NOT on the session token -- it is server-side state that can
    // change without re-issuing a key (#8608), so reading it from the session
    // would show a stale ceiling after a promotion. rpc_accounts.tier is the
    // same column the gate's own key lookup resolves against.
    const [accountRow] = await sql`
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

async function handleAccountKeysRoute(request: Request, env: Env, url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "keys", <key_id?>, <"usage"?>]
  const keyId = segments[3];
  if (!keyId && request.method === "POST") {
    return handleAccountKeyCreate(request, env);
  }
  if (!keyId && request.method === "GET") {
    return handleAccountKeysList(request, env);
  }
  if (keyId === "usage" && request.method === "GET") {
    return handleAccountKeyUsage(request, env, url);
  }
  if (keyId === "status" && request.method === "GET") {
    return handleAccountKeyStatus(request, env);
  }
  if (keyId && request.method === "DELETE") {
    return handleAccountKeyRevoke(request, env, keyId);
  }
  return writeJson(
    {
      error:
        "Use POST/GET /api/v1/keys, GET /api/v1/keys/usage, GET /api/v1/keys/status, or DELETE /api/v1/keys/{key_id}.",
    },
    405,
  );
}

// --- Neurons-family D1 read routes (box decommission; migrations/d1/0007) --
//
// The D1 twins of every neurons/neuron_daily/account_position_daily read the
// deleted Postgres dispatcher served, matched whenever METAGRAPH_NEURONS_SOURCE
// is off "postgres" (see neuronsServedFromD1's own header). Each twin mirrors
// the Postgres route it replaced, param handling and column list alike; only
// the dialect moved:
//   - no ::casts (snapshot_date is already TEXT 'YYYY-MM-DD'; SQLite compares
//     it lexicographically, which for ISO dates IS date order)
//   - validator_permit = TRUE            -> = 1 (INTEGER 0/1 schema)
//   - SUM(validator_permit::int)         -> SUM(validator_permit)
//   - DISTINCT ON (k) ... ORDER BY k, d  -> ROW_NUMBER() OVER (PARTITION BY
//     k ORDER BY d DESC) = 1, or a group-wise-MAX join (SQLite has no
//     DISTINCT ON)
//   - MAX(snapshot_date) - N::int        -> date(MAX(snapshot_date),
//     '-N days')
//
// Cross-tier joins: subnet_snapshots has a live D1 home (migrations/d1/
// 0002_observations.sql), so the alpha_price_tao joins/loads port for real.
// The remaining enrichment side tables (featured_validators, account_identity)
// have NO D1 home yet -- their families are frozen or port separately -- so the
// twins pass each builder the degraded value the retired Postgres loader's own
// catch branch produced (empty set/map, null), rather than issuing a query that
// can only ever throw. Wire the real reads in when those tables land on D1.
//
// subnet_hyperparams' TEMPO no longer belongs to that list either (#9342). It
// landed on D1 in migrations/d1/0009 and is populated for every subnet, but both
// validator handlers kept passing `tempoByNetuid: new Map()` -- the placeholder
// this comment told them to pass. An empty map means every lookup misses, and
// accumulateApyRow skips a membership whose tempo is unresolved, so apy_estimate
// was `null` and apy_estimate_eligible_subnet_count was 0 on EVERY served
// response. A degraded placeholder that outlives the gap it stood in for reads
// exactly like a real absence, which is why it survived this long.
//
// validator_nominator_counts NO LONGER BELONGS TO THAT LIST. It landed on D1
// in migrations/d1/0012, so the real read is wired below and this tier answers
// nominator_count itself -- completely, since #9334 reads absence from a fresh
// scan as a confirmed zero. The serving Worker's lakehouse overlay that covered
// the gap in the meantime (#9146) is gone with #9337: it could only ever fire
// on a null count, and there are none left to fill.
type NeuronsD1RouteHandler = (sql: D1Sql, env: Env) => Promise<Response>;

// The D1 twin of loadAlphaPricesByNetuid (#9051): netuid -> latest
// alpha_price_tao. Group-wise-MAX join instead of DISTINCT ON, same
// degrade-to-empty-map failure contract (every non-root row is then excluded
// from the totals rather than counted 1:1).
// netuid -> tempo(blocks) from the subnet_hyperparams D1 tier (#9342), for
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
// a root membership as real: loadAlphaPricesByNetuidD1 gives netuid 0 a price of
// 1, and the leaderboard counts a root-only validator. Dropping root would make
// apy_estimate silently ignore the root position of exactly the large validators
// whose stake is mostly there.
//
// The one wart is the OUTPUT field's name, `apy_estimate_eligible_subnet_count`,
// which counts root among "subnets" when root is not one. That name predates this
// fix and renaming a published field is a contract change, not a bug fix -- so it
// is left alone and called out rather than quietly redefined here.
async function loadSubnetTemposD1(
  sql: D1Sql,
  env: Env,
): Promise<Map<number, number>> {
  try {
    const rows = await sql`SELECT netuid, tempo FROM subnet_hyperparams`;
    return tempoByNetuid(rows as Array<Record<string, unknown>>);
  } catch (err) {
    console.error("subnet_hyperparams tempo query failed:", err);
    await captureDataApiError(err, "subnet-hyperparams-tempo-query", env);
    return new Map();
  }
}

async function loadAlphaPricesByNetuidD1(
  sql: D1Sql,
  env: Env,
): Promise<Map<number, number | null>> {
  try {
    const rows = await sql`
      SELECT s.netuid AS netuid, s.alpha_price_tao AS alpha_price_tao
      FROM subnet_snapshots s
      JOIN (
        SELECT netuid, MAX(snapshot_date) AS snapshot_date
        FROM subnet_snapshots GROUP BY netuid
      ) latest
        ON latest.netuid = s.netuid AND latest.snapshot_date = s.snapshot_date`;
    return new Map(
      rows.map((row) => [
        Number(row.netuid),
        row.alpha_price_tao == null ? null : Number(row.alpha_price_tao),
      ]),
    );
  } catch (err) {
    console.error("subnet_snapshots alpha-price query failed:", err);
    await captureDataApiError(err, "subnet-snapshots-alpha-price-query", env);
    return new Map();
  }
}

// hotkey -> nominator_count for every permitted validator, from the D1 table
// migrations/d1/0012 created (#9146).
//
// CORRELATED SUBQUERY, NOT AN IN LIST, and that is load-bearing rather than
// stylistic: the leaderboard covers ~1,031 hotkeys and the Workers D1 binding
// caps a statement at 100 bound parameters, so an inlined key list would need
// chunking into a dozen round trips (what the lakehouse reader has to do,
// having no join to reach for). Joining against `neurons` inside SQLite costs
// ZERO bound parameters and one query, and keeps the filter exactly in step
// with the leaderboard's own `validator_permit = 1 AND hotkey IS NOT NULL`.
//
// Same degrade-to-empty-map contract as loadAlphaPricesByNetuidD1 above: on
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
async function loadNominatorCountsD1(
  sql: D1Sql,
  env: Env,
): Promise<Map<string, number>> {
  try {
    // LEFT JOIN from the permitted set, not an inner read of the counts table:
    // the rows with no match are precisely the ones the zero-fill is about, so
    // they have to survive the query to be seen at all.
    const rows = await sql`
      SELECT n.hotkey AS hotkey,
             c.nominator_count AS nominator_count,
             (SELECT MAX(captured_at) FROM validator_nominator_counts) AS scan_at
      FROM (
        SELECT DISTINCT hotkey FROM neurons
        WHERE validator_permit = 1 AND hotkey IS NOT NULL
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
async function loadNominatorCountD1(
  sql: D1Sql,
  hotkey: string,
  env: Env,
): Promise<number | null> {
  try {
    const rows = await sql.unsafe(
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

// The D1 twin of loadRealizedStakeBaselines (#7228/#9051): per-hotkey
// baseline TAO-priced stake ~1d/1w/1m back from neuron_daily. The Postgres
// original's `SELECT DISTINCT ON (hotkey) ... ORDER BY hotkey,
// snapshot_date DESC` (newest qualifying day per hotkey) becomes a
// ROW_NUMBER() window over the same daily CTE. Same failure contract: any
// error degrades every realized_return_* to null via an empty map.
async function loadRealizedStakeBaselinesD1(
  sql: D1Sql,
  { hotkey = null }: { hotkey?: string | null },
  env: Env,
) {
  const windows = Object.entries(REALIZED_RETURN_WINDOWS);
  try {
    const perWindow = await Promise.all(
      windows.map(([, days]) => {
        const cutoff = new Date(Date.now() - days * ANALYTICS_DAY_MS)
          .toISOString()
          .slice(0, 10);
        const floor = new Date(
          Date.now() -
            (days + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS) * ANALYTICS_DAY_MS,
        )
          .toISOString()
          .slice(0, 10);
        const text =
          `WITH daily AS (
            SELECT nd.hotkey AS hotkey, nd.snapshot_date AS snapshot_date,
              SUM(nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.alpha_price_tao END) AS stake_tao
            FROM neuron_daily nd
            LEFT JOIN subnet_snapshots s
              ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
            WHERE nd.validator_permit = 1` +
          (hotkey ? " AND nd.hotkey = ?" : "") +
          ` AND nd.snapshot_date <= ? AND nd.snapshot_date >= ?
            GROUP BY nd.hotkey, nd.snapshot_date
          ), ranked AS (
            SELECT hotkey, stake_tao,
              ROW_NUMBER() OVER (PARTITION BY hotkey ORDER BY snapshot_date DESC) AS rn
            FROM daily
          )
          SELECT hotkey, stake_tao AS baseline_stake_tao FROM ranked WHERE rn = 1`;
        return sql.unsafe(
          text,
          hotkey ? [hotkey, cutoff, floor] : [cutoff, floor],
        );
      }),
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
    await captureDataApiError(err, "realized-return-baseline-query", env);
    return new Map();
  }
}

// Pure matcher: resolves a pathname to its D1 route handler (or null for
// every non-neurons-family route, which then flows on to the dispatcher's
// remaining tiers unchanged). Split from execution so the caller can check
// the binding exactly once, after a route has actually matched.
function matchNeuronsD1Route(url: URL): NeuronsD1RouteHandler | null {
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
        ? await sql.unsafe(
            `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY uid`,
            [netuid],
          )
        : await sql.unsafe(
            `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? ORDER BY uid`,
            [netuid],
          );
      return json(buildSubnetMetagraph(rows, netuid, { immunityPeriod: null }));
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
        HISTORY_WINDOWS,
        DEFAULT_HISTORY_WINDOW,
      );
      const rows = cutoff
        ? await sql`
          SELECT snapshot_date, uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
          FROM neuron_daily
          WHERE netuid = ${netuid} AND uid = ${uid} AND snapshot_date >= ${cutoff}
          ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql`
          SELECT snapshot_date, uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
          FROM neuron_daily
          WHERE netuid = ${netuid} AND uid = ${uid}
          ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildNeuronHistory(rows, netuid, uid, {
          window: windowLabelFor(url, HISTORY_WINDOWS, DEFAULT_HISTORY_WINDOW),
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
      const rows = await sql.unsafe(
        `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
        [netuid, uid],
      );
      return json(
        buildNeuronDetail(rows[0] ?? null, netuid, { immunityPeriod: null }),
      );
    };
  }

  // GET /api/v1/subnets/:netuid/validators. featured_validators has no D1
  // home (it stays a maintainer-toggled Postgres side table until its own
  // port): the empty set is loadFeaturedHotkeys's own degraded value.
  const subnetValidators = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/validators$/,
  );
  if (subnetValidators) {
    return async (sql) => {
      const netuid = Number(subnetValidators[1]);
      const rows = await sql.unsafe(
        `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY stake_tao DESC, uid ASC`,
        [netuid],
      );
      return json(
        buildSubnetValidators(rows, netuid, { featuredHotkeys: new Set() }),
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
        HISTORY_WINDOWS,
        DEFAULT_HISTORY_WINDOW,
      );
      const rows = cutoff
        ? await sql`
          SELECT nd.snapshot_date AS snapshot_date, COUNT(DISTINCT nd.netuid) AS subnet_count,
            SUM(nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.alpha_price_tao END) AS total_stake_tao,
            SUM(nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.alpha_price_tao END) AS total_emission_tao
          FROM neuron_daily nd
          LEFT JOIN subnet_snapshots s
            ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
          WHERE nd.hotkey = ${hotkey} AND nd.validator_permit = 1 AND nd.snapshot_date >= ${cutoff}
          GROUP BY nd.snapshot_date ORDER BY nd.snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql`
          SELECT nd.snapshot_date AS snapshot_date, COUNT(DISTINCT nd.netuid) AS subnet_count,
            SUM(nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.alpha_price_tao END) AS total_stake_tao,
            SUM(nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.alpha_price_tao END) AS total_emission_tao
          FROM neuron_daily nd
          LEFT JOIN subnet_snapshots s
            ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
          WHERE nd.hotkey = ${hotkey} AND nd.validator_permit = 1
          GROUP BY nd.snapshot_date ORDER BY nd.snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildValidatorHistory(rows, hotkey, {
          window: windowLabelFor(url, HISTORY_WINDOWS, DEFAULT_HISTORY_WINDOW),
        }),
      );
    };
  }

  // GET /api/v1/validators?sort=&limit=. The nominator-count, tempo and
  // identity joins keep their Postgres loaders' degraded values (no D1
  // homes); prices and realized-return baselines port for real. The serving
  // Worker fills nominator_count over this response from the lakehouse (#9146)
  // -- see this dispatcher's header.
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
      const [
        rows,
        realizedStakeByHotkey,
        priceByNetuid,
        nominatorCounts,
        tempos,
      ] = await Promise.all([
        sql`
          SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, stake_tao, block_number, captured_at, take
          FROM neurons WHERE validator_permit = 1 AND hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
        loadRealizedStakeBaselinesD1(sql, {}, env),
        loadAlphaPricesByNetuidD1(sql, env),
        loadNominatorCountsD1(sql, env),
        loadSubnetTemposD1(sql, env),
      ]);
      return json(
        buildGlobalValidators(rows, {
          sort,
          limit,
          priceByNetuid,
          featuredHotkeys: new Set(),
          identityByColdkey: new Map(),
          nominatorCounts,
          tempoByNetuid: tempos,
          realizedStakeByHotkey,
        }),
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
      const [rows, realizedByHotkey, priceByNetuid, nominatorCount, tempos] =
        await Promise.all([
          sql.unsafe(
            `SELECT ${NEURON_COLUMNS}, netuid FROM neurons WHERE hotkey = ? AND validator_permit = 1 ORDER BY netuid ASC, uid ASC`,
            [hotkey],
          ),
          loadRealizedStakeBaselinesD1(sql, { hotkey }, env),
          loadAlphaPricesByNetuidD1(sql, env),
          loadNominatorCountD1(sql, hotkey, env),
          loadSubnetTemposD1(sql, env),
        ]);
      return json(
        buildValidatorDetail(rows, hotkey, {
          identityByColdkey: new Map(),
          priceByNetuid,
          nominatorCount,
          tempoByNetuid: tempos,
          realizedStake: realizedByHotkey.get(hotkey) ?? null,
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
      const rows = await sql`
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
      const rows = await sql`
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
      const rows = await sql`
        SELECT snapshot_date, incentive, dividends, trust, consensus, validator_permit, active
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
    };
  }

  // GET /api/v1/subnets/:netuid/performance
  const subnetPerformance = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/performance$/,
  );
  if (subnetPerformance) {
    return async (sql) => {
      const netuid = Number(subnetPerformance[1]);
      const rows = await sql`
        SELECT incentive, dividends, trust, consensus, validator_trust, active, validator_permit, captured_at
        FROM neurons WHERE netuid = ${netuid}`;
      return json(buildSubnetPerformance(rows, netuid));
    };
  }

  // GET /api/v1/chain/concentration
  if (url.pathname === "/api/v1/chain/concentration") {
    return async (sql) => {
      const rows = await sql`
        SELECT stake_tao, emission_tao, coldkey, validator_permit, netuid, captured_at
        FROM neurons`;
      return json(buildChainConcentration(rows));
    };
  }

  // GET /api/v1/chain/performance
  if (url.pathname === "/api/v1/chain/performance") {
    return async (sql) => {
      const rows = await sql`
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
      const rows = await sql`
        SELECT stake_tao, dividends, captured_at FROM neurons WHERE netuid = ${netuid}`;
      return json(buildSubnetIdleStake(rows, netuid));
    };
  }

  // GET /api/v1/chain/idle-stake
  if (url.pathname === "/api/v1/chain/idle-stake") {
    return async (sql) => {
      const rows = await sql`
        SELECT stake_tao, dividends, netuid, captured_at FROM neurons`;
      return json(buildChainIdleStake(rows));
    };
  }

  // GET /api/v1/chain/yield
  if (url.pathname === "/api/v1/chain/yield") {
    return async (sql) => {
      const rows = await sql`
        SELECT validator_permit, stake_tao, emission_tao, netuid, captured_at
        FROM neurons WHERE netuid != 0`;
      return json(buildChainYield(rows));
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
      const rows = await sql`
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
      const rows = await sql`
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
      const rows = await sql`
        SELECT netuid, uid, stake_tao, emission_tao, rank, trust, incentive, dividends, validator_permit, active, captured_at
        FROM neurons WHERE hotkey = ${ss58} ORDER BY netuid`;
      const priceByNetuid = await loadAlphaPricesByNetuidD1(sql, env);
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
      const rows = await sql`
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
        HISTORY_WINDOWS,
        DEFAULT_HISTORY_WINDOW,
      );
      const rows = cutoff
        ? await sql`
          SELECT snapshot_date, captured_at, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao
          FROM account_position_daily
          WHERE account = ${ss58} AND netuid = ${netuid} AND snapshot_date >= ${cutoff}
          ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql`
          SELECT snapshot_date, captured_at, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao
          FROM account_position_daily
          WHERE account = ${ss58} AND netuid = ${netuid}
          ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildAccountPositionHistory(rows, ss58, netuid, {
          window: windowLabelFor(url, HISTORY_WINDOWS, DEFAULT_HISTORY_WINDOW),
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
        sql`
          SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, stake_tao, block_number, captured_at
          FROM neurons WHERE hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`,
        loadAlphaPricesByNetuidD1(sql, env),
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

  // GET /api/v1/subnets/:netuid/history
  const subnetHistoryMatch = url.pathname.match(
    /^\/api\/v1\/subnets\/(\d+)\/history$/,
  );
  if (subnetHistoryMatch) {
    return async (sql) => {
      const netuid = Number(subnetHistoryMatch[1]);
      const cutoff = windowCutoffDate(
        url,
        HISTORY_WINDOWS,
        DEFAULT_HISTORY_WINDOW,
      );
      // validator_permit is already INTEGER 0/1 here, so the Postgres
      // branch's ::int cast simply disappears.
      const rows = cutoff
        ? await sql`
          SELECT snapshot_date, COUNT(*) AS neuron_count,
            SUM(validator_permit) AS validator_count,
            SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
          FROM neuron_daily
          WHERE netuid = ${netuid} AND snapshot_date >= ${cutoff}
          GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`
        : await sql`
          SELECT snapshot_date, COUNT(*) AS neuron_count,
            SUM(validator_permit) AS validator_count,
            SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao
          FROM neuron_daily
          WHERE netuid = ${netuid}
          GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${MAX_HISTORY_POINTS}`;
      return json(
        buildSubnetHistory(rows, netuid, {
          window: windowLabelFor(url, HISTORY_WINDOWS, DEFAULT_HISTORY_WINDOW),
        }),
      );
    };
  }

  // GET /api/v1/chain/turnover?window=&limit=. The Postgres branch anchors
  // the window with `MAX(snapshot_date) - ${days}::int`; SQLite's native
  // equivalent is date(MAX(snapshot_date), '-N days') -- the exact idiom the
  // pre-#4772 D1 route used. An empty table leaves the subquery NULL, the
  // >= comparison matches nothing, and the same schema-stable empty shape
  // falls out.
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
      const bounds = await sql`
        SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date
        FROM neuron_daily
        WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ${`-${days} days`}) FROM neuron_daily)`;
      const startDate = (bounds[0]?.start_date ?? null) as string | null;
      const endDate = (bounds[0]?.end_date ?? null) as string | null;
      let rows: Row[] = [];
      if (startDate != null && endDate != null && startDate !== endDate) {
        rows = await sql`
          SELECT snapshot_date, netuid, hotkey, validator_permit
          FROM neuron_daily
          WHERE validator_permit = 1 AND snapshot_date IN (${startDate}, ${endDate})`;
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
      const windowLabel = Object.hasOwn(HISTORY_WINDOWS, windowParam)
        ? windowParam
        : DEFAULT_HISTORY_WINDOW;
      const windowDays = HISTORY_WINDOWS[windowLabel];
      const includeChanges = url.searchParams.get("changes") === "true";
      const bounds =
        windowDays == null
          ? await sql`
            SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date
            FROM neuron_daily WHERE netuid = ${netuid}`
          : await sql`
            SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date
            FROM neuron_daily
            WHERE netuid = ${netuid}
              AND snapshot_date >= (SELECT date(MAX(snapshot_date), ${`-${windowDays} days`}) FROM neuron_daily WHERE netuid = ${netuid})`;
      const startDate = (bounds[0]?.start_date ?? null) as string | null;
      const endDate = (bounds[0]?.end_date ?? null) as string | null;
      const rows =
        startDate == null || endDate == null
          ? []
          : await sql`
            SELECT snapshot_date, uid, hotkey, validator_permit
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
      const bounds = await sql`
        SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date
        FROM neuron_daily
        WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ${`-${days} days`}) FROM neuron_daily)`;
      const startDate = (bounds[0]?.start_date ?? null) as string | null;
      const endDate = (bounds[0]?.end_date ?? null) as string | null;
      let startRows: Row[] = [];
      let endRows: Row[] = [];
      if (startDate != null && endDate != null && startDate !== endDate) {
        const rows = await sql`
          SELECT netuid, snapshot_date, COUNT(*) AS neuron_count,
            SUM(validator_permit) AS validator_count,
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

// --- Hyperparams + account-identity D1 read routes (box decommission;
// migrations/d1/0009_hyperparams_identity.sql) ------------------------------
//
// The D1 twins of the four family reads the deleted Postgres dispatcher
// served -- the same contract as matchNeuronsD1Route above, switched
// per-family on
// METAGRAPH_SUBNET_HYPERPARAMS_SOURCE / METAGRAPH_ACCOUNT_IDENTITY_SOURCE
// (the flags the main Worker's tryPostgresTier callers gate on; unset here
// means D1, exactly like neuronsServedFromD1).
//
// With ONE deliberate addition over the neurons twins: a COLD tier -- the
// route's D1 table has NO rows at all because no sync has landed since the
// migration -- answers 503 instead of a schema-stable empty. tryPostgresTier
// treats any non-2xx as "degrade to null", which sends the serving handler to
// its next fallback: the lakehouse cold-tier reader
// (src/subnet-hyperparams-cold-tier.ts / src/account-identity-cold-tier.ts),
// the frozen pre-wipe snapshot. A schema-stable empty here would MASK that
// snapshot with nulls for however long the first sync takes. Once one sync
// lands the table is never empty again and this branch never fires; a row
// merely absent from a POPULATED table serves the same schema-stable shape
// the retired Postgres route served (deregistered netuid -> null card,
// account with no identity -> has_identity:false).
function subnetHyperparamsServedFromD1(env: Env) {
  return env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE !== "postgres";
}

function accountIdentityServedFromD1(env: Env) {
  return env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE !== "postgres";
}

function d1TierCold() {
  return json({ error: "d1 tier cold: no sync has landed yet" }, 503);
}

async function d1TableHasRows(
  sql: D1Sql,
  table:
    | "subnet_hyperparams"
    | "subnet_hyperparams_history"
    | "account_identity"
    | "account_identity_history",
): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT 1 AS one FROM ${table} LIMIT 1`);
  return rows.length > 0;
}

// Every INSERT column except netuid (already known from the WHERE clause) --
// the same list the Postgres route below selects.
const SUBNET_HYPERPARAMS_D1_READ_COLUMNS =
  SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1).join(", ");
const SUBNET_HYPERPARAMS_HISTORY_D1_READ_COLUMNS = `id, block_number, observed_at, ${SUBNET_HYPERPARAMS_HISTORY_FIELDS.join(", ")}, hyperparams_hash`;
const ACCOUNT_IDENTITY_D1_READ_COLUMNS =
  ACCOUNT_IDENTITY_INSERT_COLUMNS.join(", ");
const ACCOUNT_IDENTITY_HISTORY_D1_READ_COLUMNS = `id, observed_at, ${IDENTITY_FIELDS.join(", ")}, identity_hash`;

function matchHyperparamsIdentityD1Route(
  url: URL,
  env: Env,
): NeuronsD1RouteHandler | null {
  if (subnetHyperparamsServedFromD1(env)) {
    // GET /api/v1/subnets/:netuid/hyperparameters -- twin of the Postgres
    // route of the same name below, latest-only single-row lookup.
    const subnetHyperparams = url.pathname.match(
      /^\/api\/v1\/subnets\/(\d+)\/hyperparameters$/,
    );
    if (subnetHyperparams) {
      return async (sql) => {
        const netuid = Number(subnetHyperparams[1]);
        const rows = await sql.unsafe(
          `SELECT ${SUBNET_HYPERPARAMS_D1_READ_COLUMNS} FROM subnet_hyperparams WHERE netuid = ? LIMIT 1`,
          [netuid],
        );
        if (!rows.length && !(await d1TableHasRows(sql, "subnet_hyperparams")))
          return d1TierCold();
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
          ? await sql.unsafe(
              `SELECT ${SUBNET_HYPERPARAMS_HISTORY_D1_READ_COLUMNS}
               FROM subnet_hyperparams_history
               WHERE netuid = ? AND (observed_at, id) < (?, ?)
               ORDER BY observed_at DESC, id DESC LIMIT ?`,
              [netuid, cursor[0], cursor[1], limit],
            )
          : await sql.unsafe(
              `SELECT ${SUBNET_HYPERPARAMS_HISTORY_D1_READ_COLUMNS}
               FROM subnet_hyperparams_history
               WHERE netuid = ?
               ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?`,
              [netuid, limit, offset],
            );
        if (
          !rows.length &&
          !(await d1TableHasRows(sql, "subnet_hyperparams_history"))
        )
          return d1TierCold();
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
      };
    }
  }

  if (accountIdentityServedFromD1(env)) {
    // GET /api/v1/accounts/:ss58/identity -- latest-only single-row lookup;
    // an absent row in a populated table is has_identity:false, the common
    // case, exactly as the Postgres route serves it.
    const acctIdentity = url.pathname.match(
      /^\/api\/v1\/accounts\/([^/]+)\/identity$/,
    );
    if (acctIdentity) {
      return async (sql) => {
        const ss58 = decodeURIComponent(acctIdentity[1]);
        const rows = await sql.unsafe(
          `SELECT ${ACCOUNT_IDENTITY_D1_READ_COLUMNS} FROM account_identity WHERE account = ?`,
          [ss58],
        );
        if (!rows.length && !(await d1TableHasRows(sql, "account_identity")))
          return d1TierCold();
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
          ? await sql.unsafe(
              `SELECT ${ACCOUNT_IDENTITY_HISTORY_D1_READ_COLUMNS}
               FROM account_identity_history
               WHERE account = ? AND (observed_at, id) < (?, ?)
               ORDER BY observed_at DESC, id DESC LIMIT ?`,
              [ss58, cursor[0], cursor[1], limit],
            )
          : await sql.unsafe(
              `SELECT ${ACCOUNT_IDENTITY_HISTORY_D1_READ_COLUMNS}
               FROM account_identity_history
               WHERE account = ?
               ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?`,
              [ss58, limit, offset],
            );
        if (
          !rows.length &&
          !(await d1TableHasRows(sql, "account_identity_history"))
        )
          return d1TierCold();
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
      };
    }
  }

  return null;
}

// The actual route dispatcher, extracted from the default export's fetch so
// the top-level export (below) can wrap it with a PostHog trace span
// (metagraphed#7768) without indenting this whole function. Tests import
// this raw handler directly (unaffected by the wrapper).
async function dispatchDataApiRequest(
  request: Request,
  env: Env,
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
      return handleNeuronsSync(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/backfill-neuron-daily"
    ) {
      return handleNeuronDailyBackfill(request, env);
    }
    // #9208's live-follow lane. The head read is a GET and therefore has to be
    // matched HERE too rather than left to the read dispatcher: the gate below
    // admits GETs, but only for paths it knows, and this one is internal.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/chain-detail-sync"
    ) {
      return handleChainDetailSync(request, env);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/chain-detail-sync/head"
    ) {
      return handleChainDetailSyncHead(request, env);
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
    // KV-cache-fronted validator (src/api-key-validation.ts). See
    // handleApiKeyVerify's own header comment for why this is POST-with-body
    // rather than the old GET-with-path-param shape.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/verify"
    ) {
      return handleApiKeyVerify(request, env);
    }
    // Internal-only usage-counter increment for the self-serve usage
    // dashboard (#8386) -- see handleApiKeyUsageIncrement's own header
    // comment for why it reuses the verify route's shared secret.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/usage"
    ) {
      return handleApiKeyUsageIncrement(request, env);
    }
    // Internal-only all-traffic usage rollup (#8597) -- the measurement ADR
    // 0022's pricing decision is blocked on. Write is batched+fire-and-forget;
    // read is the maintainer's queryable readout.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/usage-rollup"
    ) {
      return handleUsageRollupIncrement(request, env);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/usage-rollup"
    ) {
      return handleUsageRollupRead(request, env);
    }
    // Internal-only daily-quota spend (#8608) -- see handleApiQuotaSpend's own
    // header comment for why it shares the verify route's secret and why,
    // unlike the usage counter above, its response body is load-bearing.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/quota"
    ) {
      return handleApiQuotaSpend(request, env);
    }
    // Internal-only key-level abuse controls (#8611). Own shared secret --
    // blocking a paying customer is a higher-privilege act than recording a
    // request, so it does not share the verify route's token.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/block"
    ) {
      return handleApiKeyBlock(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/keys/unblock"
    ) {
      return handleApiKeyUnblock(request, env);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/internal/keys/anomalies"
    ) {
      return handleApiKeyAnomalies(request, env);
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
    // does its own method dispatch, same shape as workers/api.ts's
    // handleWebhookRequest.
    if (url.pathname.startsWith("/api/v1/alerts/triggers")) {
      return handleAlertTriggersRoute(request, env, url);
    }
    // #8375: the Alert Center's address-scoped counterpart -- GET (list),
    // PATCH/DELETE (single trigger), GET .../deliveries (history), all
    // watch-token authorized. Same "multi-method, can't join the exact-match
    // checks" shape as handleAlertTriggersRoute just above.
    if (url.pathname.startsWith("/api/v1/watch/triggers")) {
      return handleWatchTriggersRoute(request, env, url);
    }
    // #8385: the same address-scoped shape for web-push device
    // subscriptions (GET list, POST subscribe, DELETE one device).
    if (url.pathname.startsWith("/api/v1/watch/push-subscriptions")) {
      return handleWatchPushSubscriptionsRoute(request, env, url);
    }
    // #8385: internal-only push-subscription resolve/prune for AlerterHub.
    if (url.pathname === "/api/v1/internal/push-subscription") {
      return handleInternalPushSubscription(request, env, url);
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
    // #8375: the evaluator's own delivery-history write-back -- see
    // handleAlertTriggersDeliveryLogWrite's own header comment.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/alert-triggers/deliveries"
    ) {
      return handleAlertTriggersDeliveryLogWrite(request, env);
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

    // Neurons-family reads on D1 (box decommission) -- these serve with no
    // Postgres tier at all, which is the whole point of the port. Every other
    // route falls through to the gone-tier 503 below. Log + masked-route
    // capture + an opaque 502 that never leaks DB detail.
    if (neuronsServedFromD1(env)) {
      const neuronsD1Handler = matchNeuronsD1Route(url);
      if (neuronsD1Handler) {
        if (!env.METAGRAPH_HEALTH_DB) {
          return json({ error: "d1 binding unavailable" }, 503);
        }
        try {
          return await neuronsD1Handler(
            createD1Sql(env.METAGRAPH_HEALTH_DB),
            env,
          );
        } catch (err) {
          console.error("data-api neurons D1 query failed:", err);
          await captureDataApiError(err, maskRouteParams(url.pathname), env);
          return json({ error: "data query failed" }, 502);
        }
      }
    }

    // Hyperparams + account-identity reads on D1 (box decommission,
    // migrations/d1/0009) -- the same shape as the neurons block above, with
    // the per-family flag check folded into the matcher (each family switches
    // independently). Same catch envelope: log + masked-route capture + an
    // opaque 502 that never leaks DB detail.
    {
      const hyperparamsIdentityD1Handler = matchHyperparamsIdentityD1Route(
        url,
        env,
      );
      if (hyperparamsIdentityD1Handler) {
        if (!env.METAGRAPH_HEALTH_DB) {
          return json({ error: "d1 binding unavailable" }, 503);
        }
        try {
          return await hyperparamsIdentityD1Handler(
            createD1Sql(env.METAGRAPH_HEALTH_DB),
            env,
          );
        } catch (err) {
          console.error("data-api hyperparams/identity D1 query failed:", err);
          await captureDataApiError(err, maskRouteParams(url.pathname), env);
          return json({ error: "data query failed" }, 502);
        }
      }
    }

    // #9193: the Postgres read tier is gone. HYPERDRIVE was unbound with the
    // box (#9186) and no wrangler config declares it any more, so every read
    // route that used to live below this point was already unreachable -- this
    // gate answered all of them. The status and body are deliberately
    // UNCHANGED, because the forward gate depends on them: tryPostgresTier's
    // callers in the main Worker read a non-2xx here as "this tier declines"
    // and fall through to the lakehouse/D1 tiers exactly as they do today.
    return json({ error: "hyperdrive binding unavailable" }, 503);
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

export async function writeTaoUsdIndexRow(
  env: Env,
  row: TaoUsdIndexRow,
): Promise<{ inserted: boolean }> {
  // User-state D1, same runner the account/alert routes use. A missing
  // binding throws here and surfaces as ingestTaoUsdIndex's caught
  // "tick_failed" -- the same degrade the old code had when HYPERDRIVE was
  // unbound. The provenance array is stringified into the TEXT-holding-JSON
  // `pools` column (the D1 translation of the old jsonb cast).
  //
  // RETURNING plus a length check, rather than trusting a rowcount: ON CONFLICT
  // DO NOTHING returns zero rows on a re-run, which is precisely the signal
  // wanted -- "this height was already recorded" is a success, not a failure.
  const sql = createD1Sql(env.METAGRAPH_HEALTH_DB);
  const written = await sql`
    INSERT INTO tao_usd_index
      (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
    VALUES (
      ${row.block_number},
      ${row.observed_at},
      ${row.usd_per_tao},
      ${row.price_basis},
      ${row.eth_usd},
      ${row.pool_count},
      ${JSON.stringify(row.pools)}
    )
    ON CONFLICT (block_number, observed_at) DO NOTHING
    RETURNING block_number`;
  return { inserted: written.length > 0 };
}

export async function ingestTaoUsdIndex(env: Env): Promise<Row> {
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

    const { inserted } = await writeTaoUsdIndexRow(env, row);
    return {
      ok: true,
      inserted,
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

export default {
  // #8600: the data-api Worker's first cron. It lives here rather than on the
  // api Worker for the same locality reason it always has -- this Worker owns
  // the tick end to end (RPC reads + the tao_usd_index write, now on the
  // shared user-state D1) -- routing a write through a service binding to
  // reach another Worker is the hop #4832 removed, not one to add back.
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    if (controller?.cron !== TAO_USD_INDEX_CRON) {
      return { ok: false, skipped: true, reason: "unknown cron" };
    }
    return ingestTaoUsdIndex(env);
  },
  async fetch(
    request: Request,
    env: Env,
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
    if (!shouldSampleTrace(env)) {
      return dispatchDataApiRequest(request, env);
    }
    const startedAt = Date.now();
    // #9001: masked, like the $exception route above. A span NAME is the
    // primary grouping key in any tracing backend, so a raw pathname makes
    // per-route latency unaggregatable -- `/api/v1/subnets/123/conviction`
    // and `/api/v1/subnets/124/conviction` would never be compared.
    // workers/api.ts has always used the low-cardinality route id here.
    const route = maskRouteParams(new URL(request.url).pathname);
    let ok = true;
    try {
      const response = await dispatchDataApiRequest(request, env);
      ok = response.status < 500;
      return response;
    } catch (error) {
      ok = false;
      throw error;
    } finally {
      const endedAt = Date.now();
      const pending = Promise.resolve(
        recordTraceSpan(env, {
          traceId: newTraceId(),
          spanId: newSpanId(),
          name: route,
          startTimeMs: startedAt,
          endTimeMs: endedAt,
          ok,
          serviceName: "metagraphed-data-api",
          attributes: { route },
        }),
      ).catch(() => false);
      if (typeof ctx?.waitUntil === "function") {
        ctx.waitUntil(pending);
      }
    }
  },
};
