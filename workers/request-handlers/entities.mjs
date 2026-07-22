// Single-entity chain-data handlers: the cheap per-key D1 lookups behind the
// metagraph, account, block, and extrinsic routes (extracted from workers/api.mjs
// per #1763).
//
// These are the "fetch one entity by its key" reads — a subnet's metagraph, one
// UID's neuron + history, a per-subnet history rollup, an account summary/events/
// subnets, the block + extrinsic feeds and their detail rows. Every handler is
// null-safe by design: an unbound or cold D1 returns a schema-stable empty/zero
// payload (never a 404 or a throw), matching the live tiers the analytics module
// already owns.
//
// Dependency wiring (the analytics.mjs pattern): the query-param guards
// (`validateQueryParams` / `analyticsQueryError`) live in
// request-handlers/analytics.mjs, which this module imports directly.
// analytics.mjs imports nothing from here, so the two are a clean leaf chain
// with no cycle — no injected deps are needed. Everything else is imported
// straight from the src/* leaf modules + config. api.mjs imports the
// handlers back and dispatches them from the router.

import { SS58_ADDRESS_PATTERN, resolveClientIp } from "../config.ts";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  parseDateRange,
  parseLimitParam,
  parseNonNegativeIntParam,
  parsePagination,
} from "../request-params.ts";

import { errorResponse, X_METAGRAPH_ARTIFACT_SOURCE_HEADER } from "../http.ts";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.ts";
import { tryPostgresTier } from "../postgres-tier.ts";
import { csvRequested, csvResponse } from "../csv.ts";
import {
  analyticsQueryError,
  markD1FallbackResponse,
  validateQueryParams,
} from "./analytics.ts";
import {
  buildGlobalValidators,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildNeuronDetail,
  buildValidatorDetail,
  overlayFeaturedValidators,
  GLOBAL_VALIDATOR_SORTS,
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
} from "../../src/metagraph-neurons.ts";
import {
  buildAccountsList,
  ACCOUNTS_LIST_SORTS,
  DEFAULT_ACCOUNTS_LIST_SORT,
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
} from "../../src/accounts-list.ts";
import {
  buildTopHoldersList,
  TOP_HOLDERS_SORTS,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
} from "../../src/top-holders.mjs";
import { buildSubnetHyperparams } from "../../src/subnet-hyperparams.mjs";
import { buildSubnetHyperparamsHistory } from "../../src/subnet-hyperparams-history.mjs";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
  parseSubnetYieldHistoryWindow,
} from "../../src/subnet-yield.mjs";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  parseHistoryWindow,
  unsupportedWindowMessage,
} from "../../src/neuron-history.ts";
import {
  INGESTED_EVENT_KINDS,
  DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  SUBNET_EVENT_SUMMARY_WINDOWS,
  buildAccountHistory,
  buildAccountSummary,
  buildAccountEvents,
  buildSubnetEvents,
  buildSubnetEventSummary,
  buildAccountTransfers,
  buildAccountSubnets,
  buildBlockEvents,
} from "../../src/account-events.ts";
import { buildAccountPortfolio } from "../../src/account-portfolio.ts";
import { buildAccountPositions } from "../../src/account-nominator-positions.ts";
import { buildAccountPositionHistory } from "../../src/account-position-history.ts";
import { buildAccountIdentity } from "../../src/account-identity.ts";
import { buildAccountIdentityHistory } from "../../src/account-identity-history.ts";
import {
  isFinneySs58Address,
  loadAccountBalance,
} from "../../src/account-balance.ts";
import { loadAccountRootClaim } from "../../src/account-root-claim.ts";
import {
  loadAccountChildren,
  loadAccountParents,
} from "../../src/child-hotkey-delegation.ts";
import { loadSudoKey } from "../../src/sudo-key.mjs";
import { H160_PATTERN, loadAddressMapping } from "../../src/address-mapping.ts";
import { loadNetworkParameters } from "../../src/network-parameters.ts";
import { loadRandomnessStatus } from "../../src/randomness.ts";
import {
  ENTITY_LABELS_ARTIFACT,
  buildAccountEntities,
  entityLabelsIndex,
  labelsForSs58,
} from "../../src/entity-labels.ts";
import { isU16Netuid, loadSubnetRecycled } from "../../src/subnet-recycled.mjs";
import { loadSubnetBurn } from "../../src/subnet-burn.ts";
import { loadSubnetLease } from "../../src/subnet-lease.mjs";
import { computeStakeQuote } from "../../src/stake-quote.ts";
import { buildRuntimeVersionHistory } from "../../src/runtime-versions.ts";
import { buildBlock, buildBlockFeed } from "../../src/blocks.ts";
import { buildBlocksSummary } from "../../src/blocks-summary.ts";
import {
  EXTRINSICS_CSV_COLUMNS,
  extrinsicsToCsvRows,
  buildExtrinsic,
  buildExtrinsicFeed,
  buildAccountExtrinsics,
  buildBlockExtrinsics,
} from "../../src/extrinsics.ts";
import {
  buildConcentration,
  buildChainConcentration,
  buildConcentrationHistory,
  parseConcentrationHistoryWindow,
} from "../../src/concentration.ts";
import { buildChainPerformance } from "../../src/chain-performance.ts";
import { buildChainYield } from "../../src/chain-yield.ts";
import {
  buildChainIdleStake,
  buildSubnetIdleStake,
} from "../../src/subnet-idle-stake.mjs";
import {
  buildChainIdentityHistory,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "../../src/chain-identity-history.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
  parseSubnetPerformanceHistoryWindow,
} from "../../src/subnet-performance.mjs";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
} from "../../src/counterparties.ts";
import {
  buildTurnover,
  buildTurnoverChanges,
  turnoverChangeDetail,
} from "../../src/turnover.mjs";
import {
  buildSubnetWeights,
  SUBNET_WEIGHTS_WINDOWS,
  DEFAULT_SUBNET_WEIGHTS_WINDOW,
} from "../../src/subnet-weights.mjs";
import {
  buildSubnetWeightSetters,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
} from "../../src/subnet-weight-setters.mjs";
import {
  buildSubnetServing,
  SUBNET_SERVING_WINDOWS,
  DEFAULT_SUBNET_SERVING_WINDOW,
} from "../../src/subnet-serving.mjs";
import {
  buildSubnetPrometheus,
  SUBNET_PROMETHEUS_WINDOWS,
  DEFAULT_SUBNET_PROMETHEUS_WINDOW,
} from "../../src/subnet-prometheus.mjs";
import {
  buildSubnetStakeMoves,
  SUBNET_STAKE_MOVES_WINDOWS,
  DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
} from "../../src/subnet-stake-moves.mjs";
import {
  buildSubnetStakeTransfers,
  SUBNET_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
} from "../../src/subnet-stake-transfers.mjs";
import {
  buildSubnetRegistrations,
  SUBNET_REGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
} from "../../src/subnet-registrations.mjs";
import {
  buildSubnetAxonRemovals,
  SUBNET_AXON_REMOVALS_WINDOWS,
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
} from "../../src/subnet-axon-removals.ts";
import {
  buildSubnetDeregistrations,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "../../src/subnet-deregistrations.mjs";
import {
  buildStakeFlow,
  STAKE_FLOW_WINDOWS,
  DEFAULT_STAKE_FLOW_WINDOW,
  STAKE_FLOW_DIRECTIONS,
} from "../../src/stake-flow.ts";
import { buildAlphaVolume } from "../../src/alpha-volume.ts";
import {
  buildSubnetOhlc,
  OHLC_INTERVALS,
  OHLC_INTERVAL_DEFAULT,
  DEFAULT_OHLC_WINDOW_DAYS,
  MAX_OHLC_WINDOW_DAYS,
} from "../../src/subnet-ohlc.mjs";
import { resolveLiveEconomics } from "../../src/health-serving.ts";
import { KV_ECONOMICS_CURRENT } from "../../src/kv-keys.ts";
import { readArtifact, readHealthKv } from "../storage.ts";
import { buildAccountStakeFlow } from "../../src/account-stake-flow.ts";
import {
  buildValidatorNominators,
  NOMINATOR_WINDOWS,
  DEFAULT_NOMINATOR_WINDOW,
  NOMINATOR_SORTS,
} from "../../src/validator-nominators.mjs";
import { buildValidatorHistory } from "../../src/validator-history.mjs";
import {
  buildAccountStakeMoves,
  ACCOUNT_STAKE_MOVES_WINDOWS,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
} from "../../src/account-stake-moves.ts";
import {
  buildAccountWeightSetters,
  ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "../../src/account-weight-setters.ts";
import {
  buildAccountRegistrations,
  REGISTRATION_WINDOWS,
  DEFAULT_REGISTRATION_WINDOW,
} from "../../src/account-registrations.ts";
import {
  buildAccountServing,
  SERVING_WINDOWS,
  DEFAULT_SERVING_WINDOW,
} from "../../src/account-serving.ts";
import {
  buildAccountAxonRemovals,
  AXON_REMOVAL_WINDOWS,
  DEFAULT_AXON_REMOVAL_WINDOW,
} from "../../src/account-axon-removals.ts";
import {
  buildAccountPrometheus,
  PROMETHEUS_WINDOWS,
  DEFAULT_PROMETHEUS_WINDOW,
} from "../../src/account-prometheus.ts";
import {
  buildAccountDeregistrations,
  DEREGISTRATION_WINDOWS,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "../../src/account-deregistrations.ts";
import {
  buildMovers,
  MOVERS_WINDOWS,
  DEFAULT_MOVERS_WINDOW,
  MOVERS_SORTS,
  DEFAULT_MOVERS_SORT,
  MOVERS_LIMIT_DEFAULT,
  MOVERS_LIMIT_MAX,
} from "../../src/movers.ts";
import {
  buildChainTurnover,
  CHAIN_TURNOVER_WINDOWS,
  DEFAULT_CHAIN_TURNOVER_WINDOW,
  CHAIN_TURNOVER_LIMIT_DEFAULT,
  CHAIN_TURNOVER_LIMIT_MAX,
} from "../../src/chain-turnover.ts";
import { buildSubnetIdentityHistory } from "../../src/subnet-identity-history.mjs";

const RESPONSE_FORMATS = ["json", "csv"];
const NEURON_CSV_COLUMNS = [
  "uid",
  "hotkey",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
];
const MOVERS_CSV_COLUMNS = [
  "netuid",
  "stake_start_tao",
  "stake_end_tao",
  "stake_delta_tao",
  "stake_pct_change",
  "emission_start_tao",
  "emission_end_tao",
  "emission_delta_tao",
  "emission_pct_change",
  "validators_start",
  "validators_end",
  "validators_delta",
  "neurons_start",
  "neurons_end",
  "neurons_delta",
];
const GLOBAL_VALIDATOR_CSV_COLUMNS = [
  "hotkey",
  "coldkey",
  "coldkey_count",
  "subnet_count",
  "uid_count",
  "total_stake_tao",
  "root_stake_tao",
  "alpha_stake_tao",
  "total_emission_tao",
  "nominator_count",
  "apy_estimate",
  "apy_estimate_eligible_subnet_count",
  "realized_return_1d",
  "realized_return_1w",
  "realized_return_1m",
  "stake_dominance",
  "avg_validator_trust",
  "max_validator_trust",
  "latest_captured_at",
  "latest_block_number",
  "subnets",
];
const ACCOUNTS_LIST_CSV_COLUMNS = [
  "hotkey",
  "coldkey",
  "coldkey_count",
  "subnet_count",
  "uid_count",
  "validator_count",
  "miner_count",
  "total_stake_tao",
  "total_emission_tao",
  "stake_dominance",
  "latest_captured_at",
  "latest_block_number",
  "subnets",
];
const TOP_HOLDERS_CSV_COLUMNS = [
  "ss58",
  "free_tao",
  "delegated_tao",
  "total_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
  "last_updated",
];
// Public per-nominator row shape from buildValidatorNominators (#5745); the
// internal `last_observed_ms` sort key is dropped before the response, so it is
// intentionally not a column here.
const VALIDATOR_NOMINATOR_CSV_COLUMNS = [
  "coldkey",
  "staked_tao",
  "unstaked_tao",
  "net_staked_tao",
  "gross_staked_tao",
  "event_count",
  "last_observed_at",
];
// CSV column order for the /api/v1/chain/turnover per-subnet churn leaderboard
// rows (the `subnets` array). The network rollup + stability distribution stay
// JSON-only, mirroring the chain-analytics leaderboard CSV exports.
const CHAIN_TURNOVER_CSV_COLUMNS = [
  "netuid",
  "validators_start",
  "validators_end",
  "validators_entered",
  "validators_exited",
  "validator_retention",
  "stability_score",
];
const SUBNET_YIELD_CSV_COLUMNS = [
  "uid",
  "hotkey",
  "role",
  "stake_tao",
  "emission_tao",
  "yield",
  "vs_median",
];
const SUBNET_CONCENTRATION_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "stake_gini",
  "stake_nakamoto_coefficient",
  "stake_top_10pct_share",
  "emission_gini",
  "emission_nakamoto_coefficient",
  "emission_top_10pct_share",
];

// CSV projection for the recent-block feed (#2528). The block rows are already
// flat (formatBlock), so the feed's own fields are the columns in read order.
const BLOCK_CSV_COLUMNS = [
  "block_number",
  "block_hash",
  "parent_hash",
  "author",
  "extrinsic_count",
  "event_count",
  "spec_version",
  "observed_at",
];
const SUBNET_YIELD_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "validator_count",
  "yield_count",
  "subnet_yield",
  "mean_yield",
  "median_yield",
  "p25_yield",
  "p75_yield",
  "p90_yield",
];
// performanceHistoryPoint's flat row shape (src/subnet-performance.mjs) — the
// reward-flow twin of SUBNET_CONCENTRATION_HISTORY_CSV_COLUMNS.
const SUBNET_PERFORMANCE_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "validator_count",
  "active_count",
  "incentive_gini",
  "incentive_nakamoto_coefficient",
  "incentive_top_10pct_share",
  "dividends_gini",
  "dividends_nakamoto_coefficient",
  "dividends_top_10pct_share",
  "trust_mean",
  "trust_median",
  "consensus_mean",
  "consensus_median",
  "validator_trust_mean",
  "validator_trust_median",
];
// formatHyperparamsHistoryEntry's row shape (src/subnet-hyperparams-history.mjs);
// `hyperparameters` is the nested 33-field object, serialized as one JSON cell
// like the `axon` column on NEURON_CSV_COLUMNS.
const SUBNET_HYPERPARAMS_HISTORY_CSV_COLUMNS = [
  "block_number",
  "observed_at",
  "hyperparameters",
  "hyperparams_hash",
];
const ACCOUNT_EXTRINSICS_CSV_COLUMNS = [
  "extrinsic_id",
  "block_number",
  "extrinsic_index",
  "extrinsic_hash",
  "signer",
  "call_module",
  "call_function",
  "success",
  "fee_tao",
  "tip_tao",
  "observed_at",
];
// formatAccountDay row shape (#5741); event_kinds is a string[] that
// csvResponse serializes as a single cell, like the nested `subnets` column on
// the leaderboard exports.
const ACCOUNT_HISTORY_CSV_COLUMNS = [
  "day",
  "netuid",
  "event_count",
  "event_kinds",
  "first_block",
  "last_block",
];
const ACCOUNT_TRANSFERS_CSV_COLUMNS = [
  "block_number",
  "event_index",
  "from",
  "to",
  "amount_tao",
  "direction",
  "observed_at",
];
// The buildCounterparties row shape (list mode only -- the relationship
// drilldown's single-object shape doesn't map onto CSV rows, see
// handleAccountCounterparties).
const ACCOUNT_COUNTERPARTIES_CSV_COLUMNS = [
  "address",
  "sent_tao",
  "received_tao",
  "net_tao",
  "transfer_count",
  "last_block",
];
// Shared column order for the subnet + account event-stream feeds — the
// formatAccountEvent row shape, stable so a CSV consumer's columns never shift.
const EVENTS_CSV_COLUMNS = [
  "block_number",
  "event_index",
  "event_kind",
  "hotkey",
  "coldkey",
  "netuid",
  "uid",
  "amount_tao",
  "alpha_amount",
  "observed_at",
  "extrinsic_index",
];
// The formatIdentityHistoryEntry row shape (src/subnet-identity-history.mjs):
// one SubnetIdentitiesV3 snapshot per row, stable so a CSV consumer's columns
// never shift.
const SUBNET_IDENTITY_HISTORY_CSV_COLUMNS = [
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
];
// The formatAccountIdentityHistoryEntry row shape
// (src/account-identity-history.mjs): keyed by account, so it carries no
// block_number (account_identity has no chain block height, only captured_at)
// and uses the account_identity field names rather than the subnet identity
// fields.
const ACCOUNT_IDENTITY_HISTORY_CSV_COLUMNS = [
  "observed_at",
  "name",
  "url",
  "github",
  "image",
  "discord",
  "description",
  "additional",
  "identity_hash",
];

function validateResponseFormat(url) {
  const raw = url.searchParams.get("format");
  if (raw === null && !url.searchParams.has("format")) return null;
  const normalized = String(raw || "").toLowerCase();
  if (RESPONSE_FORMATS.includes(normalized)) return null;
  return {
    parameter: "format",
    message: `format must be one of: ${RESPONSE_FORMATS.join(", ")}.`,
  };
}

function validateEntityQuery(url, allowedParams) {
  const validationError = validateQueryParams(url, allowedParams);
  if (validationError) return validationError;
  return validateResponseFormat(url);
}

function csvCacheVariant(url, request, canonicalPath) {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv = format === "csv" || (request && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  const separator = canonicalPath.includes("?") ? "&" : "?";
  return `${canonicalPath}${separator}format=csv`;
}

function parseBoundedIntParam(url, parameter, { def, min, max }) {
  const raw = url.searchParams.get(parameter);
  if (raw == null || raw === "") return { value: def };
  if (!/^\d+$/.test(raw)) {
    return {
      error: {
        parameter,
        message: `${parameter} must be an integer from ${min} to ${max}.`,
      },
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      error: {
        parameter,
        message: `${parameter} must be an integer from ${min} to ${max}.`,
      },
    };
  }
  return { value };
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

export async function handleSubnetMetagraph(request, env, netuid, url) {
  const validationError = validateEntityQuery(url, [
    "validator_permit",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  // #4909 D1 retirement: neurons' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  // Mirrors handleSubnetHyperparams's pattern below (a schema-stable literal,
  // not a live D1 query) rather than querying a table that no longer exists.
  // validator_permit is still validated above and forwarded to Postgres via
  // the proxied request (tryPostgresTier passes the request through unchanged).
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetMetagraph([], netuid);
  if (csvRequested(url, request)) {
    return csvResponse(
      data.neurons,
      "subnet-metagraph",
      "short",
      request,
      NEURON_CSV_COLUMNS,
    );
  }
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

// GET /api/v1/subnets/{netuid}/yield: per-UID emission yield (emission/stake) over the
// current neurons snapshot, ranked, with a distribution summary (subnet aggregate yield,
// mean, p25/median/p75/p90), a validator/miner split, and a per-UID vs-median label.
// neurons-tier (source "metagraph-snapshot"). Cold/absent store → schema-stable empties.
export async function handleSubnetYield(request, env, netuid, url) {
  const validationError = validateEntityQuery(url, ["format"]);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetYield([], netuid);
  if (csvRequested(url, request)) {
    return csvResponse(
      data.neurons,
      `subnet-${netuid}-yield`,
      "short",
      request,
      SUBNET_YIELD_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/yield.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

export async function handleNeuron(request, env, netuid, uid) {
  // Cold/absent snapshot → 200 with neuron:null, consistent with the other live
  // tiers (health/economics never 404 on a cold store).
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildNeuronDetail(null, netuid);
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

// GET /api/v1/subnets/{netuid}/hyperparameters (#4307/1.4): one netuid's live
// consensus/economic/governance settings, served from Postgres
// (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE, refreshed daily by
// refresh-subnet-hyperparams.yml, #4306/1.3) — no static file, no query
// params (a single-row lookup, nothing to filter or paginate).
//
// D1 retirement: subnet_hyperparams's D1 write path (loadStagedSubnetHyperparams
// in workers/request-handlers/staging.mjs) is retired, so D1's copy is frozen,
// not actively wrong — but falling back to it here would silently serve an
// ever-staler snapshot instead of the same schema-stable-null cold shape every
// other cold/absent tier already returns. buildSubnetHyperparams(null, netuid)
// reproduces that cold shape directly, without querying D1 at all.
export async function handleSubnetHyperparams(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(
      env,
      request,
      "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    )) ?? buildSubnetHyperparams(null, netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/hyperparameters.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/hyperparameters/history (#4309/1.6): append-only
// hyperparameter-change timeline for one subnet, newest first, served from
// Postgres (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE). Forward-only — rows only
// exist from when the diff-on-change write started running (see
// handleSubnetHyperparamsSync's diff-and-append in workers/data-api.mjs).
// Cold/absent store -> schema-stable zero, never 404.
//
// D1 retirement: see handleSubnetHyperparams above — the D1 fallback
// (loadSubnetHyperparamsHistory) is retired alongside subnet_hyperparams's D1
// write path; buildSubnetHyperparamsHistory([], ...) reproduces the same
// schema-stable empty-page shape a cold store returned, without querying D1.
export async function handleSubnetHyperparamsHistory(
  request,
  env,
  netuid,
  url,
) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const data =
    (await tryPostgresTier(
      env,
      request,
      "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    )) ??
    buildSubnetHyperparamsHistory([], netuid, {
      limit,
      offset,
      nextCursor: null,
    });
  // CSV mirrors handleAccountHistory: the page is already limit/offset-bounded,
  // so the CSV path carries the identical page the JSON path would. Cold store
  // -> empty entries -> header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries,
      `subnet-${netuid}-hyperparameters-history`,
      "short",
      request,
      SUBNET_HYPERPARAMS_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/hyperparameters/history.json`,
        data.entries[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

export async function handleSubnetValidators(request, env, netuid, url) {
  const validationError = validateEntityQuery(url, ["format"]);
  if (validationError) return analyticsQueryError(validationError);
  // Featured-validator pin (#5166): applied once, right where the Postgres/D1
  // tiers converge, so it never needs duplicating per tier. This route has no
  // `sort` param at all -- its ranking is always the stake-DESC default -- so
  // the overlay always applies here (see overlayFeaturedValidators).
  const data = overlayFeaturedValidators(
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
      buildSubnetValidators([], netuid),
  );
  if (csvRequested(url, request)) {
    return csvResponse(
      data.validators,
      "subnet-validators",
      "short",
      request,
      NEURON_CSV_COLUMNS,
    );
  }
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

// GET /api/v1/validators?sort=subnet_count|uid_count|avg_validator_trust|max_validator_trust&limit=20:
// network-wide validator/operator leaderboard from the current neurons snapshot. This
// groups validator-permit UID rows by public identity, so consumers can see cross-subnet
// operator footprint rather than only one subnet at a time. Stake/emission values stay
// scoped to each membership row because those source units are not globally aggregated.
// Cold/absent D1 returns a schema-stable empty list.
function parseGlobalValidatorsQuery(url) {
  const validationError = validateEntityQuery(url, ["sort", "limit", "format"]);
  if (validationError) return { error: validationError };

  const sort = url.searchParams.get("sort") || DEFAULT_GLOBAL_VALIDATOR_SORT;
  if (!GLOBAL_VALIDATOR_SORTS.includes(sort)) {
    return {
      error: {
        parameter: "sort",
        message: `"${sort}" is not a supported sort. Supported: ${GLOBAL_VALIDATOR_SORTS.join(
          ", ",
        )}.`,
      },
    };
  }

  const limit = parseBoundedIntParam(url, "limit", {
    def: GLOBAL_VALIDATOR_LIMIT_DEFAULT,
    min: 1,
    max: GLOBAL_VALIDATOR_LIMIT_MAX,
  });
  if (limit.error) return { error: limit.error };

  return { sort, limit: limit.value };
}

export function canonicalGlobalValidatorsCachePath(url, request = null) {
  const parsed = parseGlobalValidatorsQuery(url);
  if (parsed.error) {
    return { response: analyticsQueryError(parsed.error) };
  }
  const search = `sort=${encodeURIComponent(parsed.sort)}&limit=${parsed.limit}`;
  return {
    cachePathAndSearch: csvCacheVariant(
      url,
      request,
      `${url.pathname}?${search}`,
    ),
  };
}

export async function handleGlobalValidators(request, env, url) {
  const parsed = parseGlobalValidatorsQuery(url);
  if (parsed.error) return analyticsQueryError(parsed.error);
  // Featured-validator pin (#5166), applied once at tier convergence -- see
  // handleSubnetValidators above. Unlike that route this one has a `sort`
  // param, so overlayFeaturedValidators only reorders the default (unsorted)
  // view; an explicit non-default ?sort= keeps the caller's exact order while
  // `featured` stays present on every row either way.
  const data = overlayFeaturedValidators(
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
      buildGlobalValidators([], {
        sort: parsed.sort,
        limit: parsed.limit,
      }),
  );
  if (csvRequested(url, request)) {
    return csvResponse(
      data.validators,
      "global-validators",
      "short",
      request,
      GLOBAL_VALIDATOR_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/validators.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts?sort=total_stake|total_emission|subnet_count|uid_count|
// validator_count|stake_dominance|last_active&limit=20 (#4324/5.3): site-wide
// accounts leaderboard — every currently-registered hotkey, miners included,
// from the current neurons snapshot. The collection-level counterpart to
// /api/v1/validators (which this route follows as its precedent), generalized
// to every account rather than just validator_permit=1 rows. See
// src/accounts-list.mjs's header for the "Free"/"Total" balance columns this
// deliberately does NOT carry (no balance-tracking tier exists to derive them
// from). Cold/absent D1 returns a schema-stable empty list.
function parseAccountsListQuery(url) {
  const validationError = validateEntityQuery(url, ["sort", "limit", "format"]);
  if (validationError) return { error: validationError };

  const sort = url.searchParams.get("sort") || DEFAULT_ACCOUNTS_LIST_SORT;
  if (!ACCOUNTS_LIST_SORTS.includes(sort)) {
    return {
      error: {
        parameter: "sort",
        message: `"${sort}" is not a supported sort. Supported: ${ACCOUNTS_LIST_SORTS.join(
          ", ",
        )}.`,
      },
    };
  }

  const limit = parseBoundedIntParam(url, "limit", {
    def: ACCOUNTS_LIST_LIMIT_DEFAULT,
    min: 1,
    max: ACCOUNTS_LIST_LIMIT_MAX,
  });
  if (limit.error) return { error: limit.error };

  return { sort, limit: limit.value };
}

export function canonicalAccountsListCachePath(url, request = null) {
  const parsed = parseAccountsListQuery(url);
  if (parsed.error) {
    return { response: analyticsQueryError(parsed.error) };
  }
  const search = `sort=${encodeURIComponent(parsed.sort)}&limit=${parsed.limit}`;
  return {
    cachePathAndSearch: csvCacheVariant(
      url,
      request,
      `${url.pathname}?${search}`,
    ),
  };
}

export async function handleAccountsList(request, env, url) {
  const parsed = parseAccountsListQuery(url);
  if (parsed.error) return analyticsQueryError(parsed.error);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildAccountsList([], {
      sort: parsed.sort,
      limit: parsed.limit,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.accounts,
      "accounts-list",
      "short",
      request,
      ACCOUNTS_LIST_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/accounts.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/top-holders?sort=total_tao|free_tao|delegated_tao&
// limit=20 (#6741/#6743): the balance-based top-holder leaderboard -- the
// coldkey/balance-centric counterpart to /api/v1/accounts above (hotkey/
// neuron-centric, explicitly missing the Free/Total columns this route
// exists to add -- see that route's own header). Cold/absent Postgres tier
// returns a schema-stable empty leaderboard, same posture as accounts-list.
function parseTopHoldersQuery(url) {
  const validationError = validateEntityQuery(url, ["sort", "limit", "format"]);
  if (validationError) return { error: validationError };

  const sort = url.searchParams.get("sort") || DEFAULT_TOP_HOLDERS_SORT;
  if (!TOP_HOLDERS_SORTS.includes(sort)) {
    return {
      error: {
        parameter: "sort",
        message: `"${sort}" is not a supported sort. Supported: ${TOP_HOLDERS_SORTS.join(
          ", ",
        )}.`,
      },
    };
  }

  const limit = parseBoundedIntParam(url, "limit", {
    def: TOP_HOLDERS_LIMIT_DEFAULT,
    min: 1,
    max: TOP_HOLDERS_LIMIT_MAX,
  });
  if (limit.error) return { error: limit.error };

  return { sort, limit: limit.value };
}

export function canonicalTopHoldersCachePath(url, request = null) {
  const parsed = parseTopHoldersQuery(url);
  if (parsed.error) {
    return { response: analyticsQueryError(parsed.error) };
  }
  const search = `sort=${encodeURIComponent(parsed.sort)}&limit=${parsed.limit}`;
  return {
    cachePathAndSearch: csvCacheVariant(
      url,
      request,
      `${url.pathname}?${search}`,
    ),
  };
}

export async function handleTopHoldersList(request, env, url) {
  const parsed = parseTopHoldersQuery(url);
  if (parsed.error) return analyticsQueryError(parsed.error);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_TOP_HOLDERS_SOURCE")) ??
    buildTopHoldersList([], {
      sort: parsed.sort,
      limit: parsed.limit,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.accounts,
      "top-holders",
      "short",
      request,
      TOP_HOLDERS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/top-holders.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/{hotkey}: a single validator's validator_permit=1
// rows aggregated across every subnet it operates in — the single-entity
// drill-in of the /api/v1/validators leaderboard above. Cold/absent hotkey
// (no permit=1 rows anywhere) returns 200 with a zeroed aggregate and an
// empty subnets array, consistent with handleNeuron's absent-uid contract
// (never 404 on a cold/absent live D1 tier).
export async function handleValidatorDetail(request, env, hotkey) {
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildValidatorDetail([], hotkey);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/validators/${hotkey}.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/{hotkey}/nominators?window=7d|30d|90d&sort=net_staked|
// gross_staked|last_activity&limit=&offset=&coldkey=: who has staked to this
// validator (across every subnet it operates in) over the window, ranked by
// net/gross flow or recency. account_events-derived (source "chain-events"),
// no new capture — StakeAdded/StakeRemoved already carry the hotkey/coldkey
// pair on every row. coldkey= narrows to one nominator's own flow (an
// exact-match lookup, not fuzzy search). Cold/absent → 200 with an empty
// list, never 404.
export async function handleValidatorNominators(request, env, hotkey, url) {
  const validationError = validateEntityQuery(url, [
    "window",
    "sort",
    "limit",
    "offset",
    "coldkey",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_NOMINATOR_WINDOW;
  if (!Object.hasOwn(NOMINATOR_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, NOMINATOR_WINDOWS),
    });
  }
  const sort = url.searchParams.get("sort");
  if (sort !== null && !NOMINATOR_SORTS.includes(sort)) {
    return analyticsQueryError({
      parameter: "sort",
      message: `"${sort}" is not a supported sort. Supported: ${NOMINATOR_SORTS.join(", ")}.`,
    });
  }
  const limit = parseBoundedIntParam(url, "limit", {
    def: GLOBAL_VALIDATOR_LIMIT_DEFAULT,
    min: 1,
    max: GLOBAL_VALIDATOR_LIMIT_MAX,
  });
  if (limit.error) return analyticsQueryError(limit.error);
  const offset = parseBoundedIntParam(url, "offset", {
    def: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (offset.error) return analyticsQueryError(offset.error);
  const coldkeyParam = url.searchParams.get("coldkey");
  if (coldkeyParam !== null && !SS58_ADDRESS_PATTERN.test(coldkeyParam)) {
    return analyticsQueryError({
      parameter: "coldkey",
      message: `"coldkey" must be a valid SS58 address.`,
    });
  }
  const { data, generatedAt } = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
  )) ?? {
    data: buildValidatorNominators([], hotkey, {
      window: windowParam,
      sort: sort ?? undefined,
      limit: limit.value,
      offset: offset.value,
    }),
    generatedAt: null,
  };
  // CSV export mirrors handleAccountsList / handleGlobalValidators: the rows are
  // already sorted/paginated/coldkey-filtered by buildValidatorNominators, so
  // the CSV path carries the identical set the JSON path would (#5745). A cold
  // result yields an empty array → a header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.nominators,
      "validator-nominators",
      "short",
      request,
      VALIDATOR_NOMINATOR_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/validators/${hotkey}/nominators.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/{hotkey}/history?window=7d|30d|90d|1y|all: cross-
// subnet staked-over-time + a rewards-per-1000-TAO rate for one validator,
// one point per snapshot_date summed across every subnet it validates in
// that day. Rolled up from the neuron_daily tier (idx_neuron_daily_hotkey_date),
// the same tier the per-UID/per-subnet history routes below already use.
export async function handleValidatorHistory(request, env, hotkey, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return analyticsQueryError(error);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildValidatorHistory([], hotkey, {
      window: label,
    });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/validators/${hotkey}/history.json`,
        null,
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
export async function handleNeuronHistory(request, env, netuid, uid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return analyticsQueryError(error);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildNeuronHistory([], netuid, uid, {
      window: label,
    });
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
export async function handleSubnetHistory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return analyticsQueryError(error);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetHistory([], netuid, {
      window: label,
    });
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

// GET /api/v1/subnets/{netuid}/identity-history (#1647): append-only on-chain
// identity timeline, newest first. Cold/absent store → schema-stable zero.
export async function handleSubnetIdentityHistory(request, env, netuid, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_SUBNET_IDENTITY_SOURCE")) ??
    buildSubnetIdentityHistory([], netuid, { limit, offset, nextCursor: null });
  // CSV mirrors handleSubnetHyperparamsHistory: the page is already
  // limit/offset/cursor-bounded, so the CSV path carries the identical page the
  // JSON path would. Cold store -> empty entries -> header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries,
      `subnet-${netuid}-identity-history`,
      "short",
      request,
      SUBNET_IDENTITY_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/identity-history.json`,
        data.entries[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/concentration: stake & emission decentralization
// metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) over
// the subnet's live distribution (#2106), across three lenses — per-UID, per-entity
// (coldkeys collapsed, the true control distribution) and validator-only consensus
// power. Computed from the neurons D1 tier; a cold/absent store or empty
// subnet → 200 with null blocks (schema-stable, never 404), mirroring the sibling
// metagraph/history routes.
export async function handleSubnetConcentration(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildConcentration([], netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/concentration.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/performance: reward-distribution + score-spread
// metrics for one subnet — how concentrated the actual REWARDS are (Gini/HHI/
// Nakamoto/top-share of incentive across neurons and dividends across validators)
// and how the 0..1 trust/consensus/validator_trust scores are spread (p10..p90).
// The reward-flow companion to /concentration (which measures stake/emission).
// Computed from the neurons D1 tier; a cold/absent store or empty subnet → 200
// with null blocks (schema-stable, never 404), mirroring the sibling routes.
export async function handleSubnetPerformance(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetPerformance([], netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/performance.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/concentration: network-wide stake & emission concentration
// across EVERY subnet's neurons — the same five lenses as the per-subnet route,
// but the entity lenses collapse an operator's hotkeys ACROSS subnets, so this is
// the true network-level control distribution. neurons-tier (source
// "metagraph-snapshot"), no params. Cold/absent store → schema-stable empties.
export async function handleChainConcentration(request, env, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildChainConcentration([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/concentration.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/performance: network-wide reward-distribution & score-spread
// across EVERY subnet's neurons — reward concentration (Gini/HHI/Nakamoto/
// top-share/entropy) for incentive across all neurons and dividends across
// validators, plus the p10–p90 spread of the 0–1 trust/consensus/validator_trust
// scores, computed live from the neurons D1 tier. The reward-flow companion to
// /chain/concentration. No params; a cold/absent store → 200 with null blocks.
export async function handleChainPerformance(request, env, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildChainPerformance([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/performance.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/idle-stake (#6789): stake delegated to a
// hotkey currently earning zero dividends -- the only stream delegated
// stake ever receives in dTAO (incentive goes to the hotkey owner alone),
// so a hotkey with no permit or a zero weight-setting output pays every
// delegator nothing right now. Computed from the neurons D1 tier; a
// cold/absent store or empty subnet -> 200 with a zeroed scorecard
// (schema-stable, never 404), mirroring /concentration and /performance.
export async function handleSubnetIdleStake(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetIdleStake([], netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/idle-stake.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/idle-stake (#6789): the network-wide rollup of the
// route above -- every subnet's own idle-stake scorecard ranked by
// idle_stake_tao descending, plus the network total. No params; a
// cold/absent store -> 200 with an empty ranking.
export async function handleChainIdleStake(request, env, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildChainIdleStake([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/idle-stake.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/identity-history: the most-recent SubnetIdentitiesV3 changes
// aggregated across EVERY subnet (newest first), each entry shaped like the
// per-subnet /identity-history route plus its `netuid`. The network analog of
// handleSubnetIdentityHistory — a capped feed (`?limit` default 50, max 200), not a
// per-subnet timeline. A cold/absent store → 200 with an empty feed (schema-stable,
// never 404).
export async function handleChainIdentityHistory(request, env, url) {
  const validationError = validateQueryParams(url, ["limit"]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, error: limitError } = parseLimitParam(url, {
    defaultLimit: CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
    maxLimit: CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  });
  if (limitError) return analyticsQueryError(limitError);
  // D1 retirement: subnet_identity_history's D1 write path is retired
  // (2026-07-16, syncSubnetIdentityToPostgres is the sole writer now), so a
  // Postgres miss/outage degrades to a schema-stable empty feed, never a
  // live D1 read.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_SUBNET_IDENTITY_SOURCE")) ??
    buildChainIdentityHistory([], { limit });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/identity-history.json",
        // Freshness = the newest change's observed_at (feed is newest-first), else
        // null when the store is cold.
        data.changes[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/yield: network-wide emission-yield (return rate) across EVERY
// subnet's neurons — the aggregate network return (total emission / total stake),
// the same split by validator vs miner role, and the p10–p90 spread of the
// per-neuron emission/stake return, computed live from the neurons D1 tier. The
// return-rate companion to /chain/performance. No params; a cold/absent store →
// 200 with null blocks.
export async function handleChainYield(request, env, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildChainYield([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/yield.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the network identity-history feed: normalize `?limit`
// (its only response-changing param) to the default when omitted so a bare request
// and an explicit-default request share one cache slot; an invalid limit falls
// through to the raw search so the handler surfaces the 400.
export function canonicalChainIdentityHistoryCachePath(url) {
  const validationError = validateQueryParams(url, ["limit"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { limit, error } = parseLimitParam(url, {
    defaultLimit: CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
    maxLimit: CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  });
  if (error) return `${url.pathname}${url.search}`;
  return `${url.pathname}?limit=${limit}`;
}

// Shared helper: build a canonical edge-cache key for any windowed route by
// normalising the ?window= query parameter through the route-specific parse
// function, so that an omitted window and an explicit default-value window map
// to the same cache slot.
function canonicalWindowedCachePath(url, parseWindow) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { label, error } = parseWindow(url.searchParams.get("window"));
  if (error) return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

export function canonicalSubnetHistoryCachePath(url) {
  return canonicalWindowedCachePath(url, parseHistoryWindow);
}

export function canonicalValidatorHistoryCachePath(url) {
  return canonicalWindowedCachePath(url, parseHistoryWindow);
}

export function canonicalSubnetConcentrationHistoryCachePath(
  url,
  request = null,
) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateResponseFormat(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label, error } = parseConcentrationHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return `${url.pathname}${url.search}`;
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

export function canonicalSubnetPerformanceHistoryCachePath(
  url,
  request = null,
) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateResponseFormat(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label, error } = parseSubnetPerformanceHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return `${url.pathname}${url.search}`;
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

export function canonicalSubnetYieldHistoryCachePath(url, request = null) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateResponseFormat(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label, error } = parseSubnetYieldHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return `${url.pathname}${url.search}`;
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

// Canonical edge-cache key for the subnet-turnover route (?window= via
// parseHistoryWindow). Distinct from canonicalSubnetConcentrationHistoryCachePath
// which uses a different parse function (parseConcentrationHistoryWindow).
export function canonicalSubnetTurnoverCachePath(url) {
  const validationError = validateQueryParams(url, ["window", "changes"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return `${url.pathname}${url.search}`;
  const changes = url.searchParams.get("changes");
  if (changes != null && changes !== "true") {
    return `${url.pathname}${url.search}`;
  }
  const suffix = changes === "true" ? "&changes=true" : "";
  return `${url.pathname}?window=${encodeURIComponent(label)}${suffix}`;
}

// Canonical edge-cache key for the subnet-stake-flow route. ?window= (one of
// STAKE_FLOW_WINDOWS) and ?direction= (all|in|out) change the response; omitted
// window/direction and their explicit defaults must share one cache slot.
export function canonicalSubnetStakeFlowCachePath(url) {
  const validationError = validateQueryParams(url, ["window", "direction"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_STAKE_FLOW_WINDOW;
  if (!Object.hasOwn(STAKE_FLOW_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  const direction = url.searchParams.get("direction");
  if (direction !== null && !STAKE_FLOW_DIRECTIONS.includes(direction)) {
    return `${url.pathname}${url.search}`;
  }
  let path = `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
  if (direction === "in" || direction === "out") {
    path += `&direction=${encodeURIComponent(direction)}`;
  }
  return path;
}

// Canonical edge-cache key for the cross-subnet movers route: window/sort/limit, each
// canonicalized to its default when omitted, so equivalent requests share one slot.
export function canonicalSubnetMoversCachePath(url, request = null) {
  const validationError = validateEntityQuery(url, [
    "window",
    "sort",
    "limit",
    "format",
  ]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam = url.searchParams.get("window") || DEFAULT_MOVERS_WINDOW;
  if (!Object.hasOwn(MOVERS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  const sortParam = url.searchParams.get("sort") || DEFAULT_MOVERS_SORT;
  if (!MOVERS_SORTS.includes(sortParam)) {
    return `${url.pathname}${url.search}`;
  }
  const limit = parseBoundedIntParam(url, "limit", {
    def: MOVERS_LIMIT_DEFAULT,
    min: 1,
    max: MOVERS_LIMIT_MAX,
  });
  if (limit.error) return `${url.pathname}${url.search}`;
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${windowParam}&sort=${sortParam}&limit=${limit.value}`,
  );
}

// Canonical edge-cache key for the network turnover route: window + limit collapsed to
// their resolved defaults so ?window=30d and the bare path share one cached entry. Falls
// back to the raw path+search when validation fails (the handler will 400 it anyway).
export function canonicalChainTurnoverCachePath(url, request = null) {
  const validationError = validateEntityQuery(url, [
    "window",
    "limit",
    "format",
  ]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_CHAIN_TURNOVER_WINDOW;
  if (!Object.hasOwn(CHAIN_TURNOVER_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  const limit = parseBoundedIntParam(url, "limit", {
    def: CHAIN_TURNOVER_LIMIT_DEFAULT,
    min: 1,
    max: CHAIN_TURNOVER_LIMIT_MAX,
  });
  if (limit.error) return `${url.pathname}${url.search}`;
  // CSV and JSON responses must not share one edge-cache entry.
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${windowParam}&limit=${limit.value}`,
  );
}

// GET /api/v1/chain/turnover?window=7d|30d|90d&limit=20: network-wide validator-set churn
// across all subnets between the window's boundary neuron_daily snapshots — a per-subnet
// turnover leaderboard plus a network rollup over the union validator set.
export async function handleChainTurnover(request, env, url) {
  const validationError = validateEntityQuery(url, [
    "window",
    "limit",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_CHAIN_TURNOVER_WINDOW;
  if (!Object.hasOwn(CHAIN_TURNOVER_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, CHAIN_TURNOVER_WINDOWS),
    });
  }
  const limit = parseBoundedIntParam(url, "limit", {
    def: CHAIN_TURNOVER_LIMIT_DEFAULT,
    min: 1,
    max: CHAIN_TURNOVER_LIMIT_MAX,
  });
  if (limit.error) return analyticsQueryError(limit.error);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildChainTurnover([], {
      window: windowParam,
      startDate: null,
      endDate: null,
      limit: limit.value,
    });
  // CSV exports the row-shaped per-subnet churn leaderboard; the network rollup +
  // stability distribution stay JSON-only (mirrors the chain-analytics exports).
  if (csvRequested(url, request)) {
    return csvResponse(
      data.subnets,
      "chain-turnover",
      "short",
      request,
      CHAIN_TURNOVER_CSV_COLUMNS,
    );
  }
  // neuron_daily-derived, so the meta reports the metagraph-snapshot source; generated_at
  // is the end snapshot date (string), matching the movers/turnover routes.
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/turnover.json",
        data.end_date,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-metagraph route. Only
// ?validator_permit=true changes the response; omission and =false both serve
// the full metagraph and must share one cache slot.
export function canonicalSubnetMetagraphCachePath(url, request = null) {
  const validationError = validateEntityQuery(url, [
    "validator_permit",
    "format",
  ]);
  if (validationError) return `${url.pathname}${url.search}`;
  const validatorsOnly = url.searchParams.get("validator_permit") === "true";
  const canonicalPath = validatorsOnly
    ? `${url.pathname}?validator_permit=true`
    : url.pathname;
  return csvCacheVariant(url, request, canonicalPath);
}

// Canonical edge-cache key for the subnet validators route. The default JSON
// envelope and explicit ?format=json share one cache slot; CSV receives its own.
export function canonicalSubnetValidatorsCachePath(url, request = null) {
  const validationError = validateEntityQuery(url, ["format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  return csvCacheVariant(url, request, url.pathname);
}

export function canonicalSubnetYieldCachePath(url, request = null) {
  const validationError = validateEntityQuery(url, ["format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  return csvCacheVariant(url, request, url.pathname);
}

// GET /api/v1/subnets/{netuid}/concentration/history?window=7d|30d|90d: the per-day
// stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share)
// from the dated neuron_daily rollup — "is this subnet centralizing over time?".
// Each day needs its full per-UID distribution, so the read is the raw rows (not a
// GROUP BY) bounded by a row cap; a cold/absent store → 200 with points:[]
// (schema-stable, never 404).
export async function handleSubnetConcentrationHistory(
  request,
  env,
  netuid,
  url,
) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label, error } = parseConcentrationHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildConcentrationHistory([], netuid, {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [...data.points].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-concentration-history`,
      "short",
      request,
      SUBNET_CONCENTRATION_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/concentration/history.json`,
        data.points[0]?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/performance/history?window=7d|30d|90d: the per-day
// reward-flow & trust trend (incentive/dividends Gini, Nakamoto, top-10% share +
// trust/consensus/validator_trust mean & median) from the dated neuron_daily rollup
// — "are this subnet's rewards consolidating over time?". The reward-flow twin of
// concentration/history: each day needs its full per-UID distribution, so the read
// is the raw rows (not a GROUP BY) bounded by a row cap; a cold/absent store → 200
// with points:[] (schema-stable, never 404).
export async function handleSubnetPerformanceHistory(
  request,
  env,
  netuid,
  url,
) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label, error } = parseSubnetPerformanceHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetPerformanceHistory([], netuid, {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [...data.points].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-performance-history`,
      "short",
      request,
      SUBNET_PERFORMANCE_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/performance/history.json`,
        data.points[0]?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/yield/history?window=7d|30d|90d: the per-day
// emission-yield distribution trend (subnet-wide return + the mean/median/p25/p75/p90
// of the per-UID emission-per-stake yields) from the dated neuron_daily rollup — "is
// this subnet's return spread widening or its median falling?". The return-rate twin
// of concentration/history: each day needs its full per-UID distribution, so the read
// is the raw rows (not a GROUP BY) bounded by a row cap; a cold/absent store → 200
// with points:[] (schema-stable, never 404).
export async function handleSubnetYieldHistory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label, error } = parseSubnetYieldHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildSubnetYieldHistory([], netuid, {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [...data.points].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-yield-history`,
      "short",
      request,
      SUBNET_YIELD_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/yield/history.json`,
        data.points[0]?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/turnover?window=7d|30d|90d|1y|all: validator-set &
// registration churn between the window's start and end neuron_daily snapshots.
// Add ?changes=true for validator hotkeys entered/exited and UID slots reassigned
// between the same boundary snapshots. Cold/absent store or a single snapshot →
// 200 with comparable:false + zeroed metrics (schema-stable, never 404).
export async function handleSubnetTurnover(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window", "changes"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return analyticsQueryError(error);
  const changes = url.searchParams.get("changes");
  if (changes != null && changes !== "true") {
    return analyticsQueryError({
      parameter: "changes",
      message: `"${changes}" is not a valid changes flag. Supported: true.`,
    });
  }
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const turnoverOptions = { window: label, startDate: null, endDate: null };
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    (changes === "true"
      ? {
          ...buildTurnover([], netuid, turnoverOptions),
          changes: turnoverChangeDetail(
            buildTurnoverChanges([], netuid, turnoverOptions),
          ),
        }
      : buildTurnover([], netuid, turnoverOptions));
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/turnover.json`,
        data.end_date,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-weights route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetWeightsCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_WEIGHTS_WINDOW;
  if (!Object.hasOwn(SUBNET_WEIGHTS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/weights?window=7d|30d: validator weight-setting activity for
// one subnet over the window — distinct weight-setting validators, WeightsSet event count, and
// updates per validator — read live from the account_events WeightsSet stream. The per-subnet
// drill-in of /api/v1/chain/weights. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetWeights(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_WEIGHTS_WINDOW;
  if (!Object.hasOwn(SUBNET_WEIGHTS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, SUBNET_WEIGHTS_WINDOWS),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetWeights(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed WeightsSet event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/weights.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-weight-setters route: only ?window= (7d/30d) changes
// the response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetWeightSettersCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW;
  if (!Object.hasOwn(SUBNET_WEIGHT_SETTERS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/weights/setters?window=7d|30d: the per-subnet weight-setter
// leaderboard — the individual validators behind /weights, each with its WeightsSet count,
// share of the subnet's total, and first/last set time, ranked by activity. Read live from the
// account_events WeightsSet stream. Cold/absent store → 200 with an empty leaderboard (never 404).
export async function handleSubnetWeightSetters(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW;
  if (!Object.hasOwn(SUBNET_WEIGHT_SETTERS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(
        windowParam,
        SUBNET_WEIGHT_SETTERS_WINDOWS,
      ),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetWeightSetters([], null, netuid, { window: windowParam });
  // account_events-derived: the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed WeightsSet event, mirroring the sibling /weights route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/weights/setters.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-serving route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetServingCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_SERVING_WINDOW;
  if (!Object.hasOwn(SUBNET_SERVING_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/serving?window=7d|30d: axon-serving announcement activity for one
// subnet over the window — distinct servers (hotkeys), AxonServed event count, and announcements
// per server — read live from the account_events AxonServed stream. The per-subnet drill-in of
// /api/v1/chain/serving. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetServing(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_SERVING_WINDOW;
  if (!Object.hasOwn(SUBNET_SERVING_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, SUBNET_SERVING_WINDOWS),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetServing(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed AxonServed event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/serving.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-prometheus route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetPrometheusCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_PROMETHEUS_WINDOW;
  if (!Object.hasOwn(SUBNET_PROMETHEUS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/prometheus?window=7d|30d: Prometheus-endpoint serving activity for
// one subnet over the window — distinct exporters (hotkeys), PrometheusServed event count, and
// announcements per exporter — read live from the account_events PrometheusServed stream. The
// per-subnet drill-in of /api/v1/chain/prometheus and the telemetry-endpoint sibling of
// /api/v1/subnets/{netuid}/serving. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetPrometheus(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_PROMETHEUS_WINDOW;
  if (!Object.hasOwn(SUBNET_PROMETHEUS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, SUBNET_PROMETHEUS_WINDOWS),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetPrometheus(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed PrometheusServed event, mirroring the sibling serving route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/prometheus.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-stake-moves route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetStakeMovesCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_STAKE_MOVES_WINDOW;
  if (!Object.hasOwn(SUBNET_STAKE_MOVES_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/stake-moves?window=7d|30d: stake-movement (re-delegation) activity
// for one subnet over the window — distinct movers (accounts), StakeMoved event count, and
// movements per mover — read live from the account_events StakeMoved stream. The per-subnet drill-in
// of /api/v1/chain/stake-moves and the re-delegation-churn sibling of
// /api/v1/subnets/{netuid}/stake-flow. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetStakeMoves(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_STAKE_MOVES_WINDOW;
  if (!Object.hasOwn(SUBNET_STAKE_MOVES_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(
        windowParam,
        SUBNET_STAKE_MOVES_WINDOWS,
      ),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetStakeMoves(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed StakeMoved event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-moves.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-stake-transfers route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetStakeTransfersCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW;
  if (!Object.hasOwn(SUBNET_STAKE_TRANSFERS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/stake-transfers?window=7d|30d: stake-transfer activity for one subnet
// over the window — distinct senders (accounts), StakeTransferred event count, and transfers per
// sender — read live from the account_events StakeTransferred stream. The per-subnet drill-in of
// /api/v1/chain/stake-transfers and the between-coldkeys sibling of
// /api/v1/subnets/{netuid}/stake-moves. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetStakeTransfers(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW;
  if (!Object.hasOwn(SUBNET_STAKE_TRANSFERS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(
        windowParam,
        SUBNET_STAKE_TRANSFERS_WINDOWS,
      ),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetStakeTransfers(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed StakeTransferred event, mirroring the sibling stake-moves route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-transfers.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-registrations route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetRegistrationsCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_REGISTRATIONS_WINDOW;
  if (!Object.hasOwn(SUBNET_REGISTRATIONS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/registrations?window=7d|30d: neuron-registration activity for one
// subnet over the window — distinct registrants (hotkeys), NeuronRegistered event count, and
// registrations per registrant — read live from the account_events NeuronRegistered stream. The
// account_events companion to /turnover. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetRegistrations(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_REGISTRATIONS_WINDOW;
  if (!Object.hasOwn(SUBNET_REGISTRATIONS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(
        windowParam,
        SUBNET_REGISTRATIONS_WINDOWS,
      ),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetRegistrations(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed NeuronRegistered event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/registrations.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-axon-removals route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetAxonRemovalsCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_AXON_REMOVALS_WINDOW;
  if (!Object.hasOwn(SUBNET_AXON_REMOVALS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/axon-removals?window=7d|30d: axon-removal activity for one subnet
// over the window — distinct removers (hotkeys), AxonInfoRemoved event count, and removals per
// remover — read live from the account_events AxonInfoRemoved stream. The removal-side companion
// to /serving. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetAxonRemovals(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_AXON_REMOVALS_WINDOW;
  if (!Object.hasOwn(SUBNET_AXON_REMOVALS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(
        windowParam,
        SUBNET_AXON_REMOVALS_WINDOWS,
      ),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetAxonRemovals(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed AxonInfoRemoved event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/axon-removals.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-deregistrations route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetDeregistrationsCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW;
  if (!Object.hasOwn(SUBNET_DEREGISTRATIONS_WINDOWS, windowParam)) {
    return `${url.pathname}${url.search}`;
  }
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/deregistrations?window=7d|30d: neuron-deregistration activity for one
// subnet over the window — distinct deregistered hotkeys, NeuronDeregistered event count, and
// deregistrations per hotkey — read live from the account_events NeuronDeregistered stream. The
// exit-side companion to /registrations. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetDeregistrations(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW;
  if (!Object.hasOwn(SUBNET_DEREGISTRATIONS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(
        windowParam,
        SUBNET_DEREGISTRATIONS_WINDOWS,
      ),
    });
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetDeregistrations(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed NeuronDeregistered event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/deregistrations.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/stake-flow?window=7d|30d|90d&direction=all|in|out:
// net stake flow for one subnet over the window — TAO staked (StakeAdded) vs
// unstaked (StakeRemoved) and the net, summed live from the account_events stream
// (idx_account_events_netuid_kind). ?direction=in|out narrows to one side;
// omitted or all sums both. Windows (7d/30d/90d) match the concentration/history
// route. Cold/absent store → 200 with zeroed totals (schema-stable, never 404),
// mirroring the sibling routes.
export async function handleSubnetStakeFlow(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window", "direction"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_STAKE_FLOW_WINDOW;
  if (!Object.hasOwn(STAKE_FLOW_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, STAKE_FLOW_WINDOWS),
    });
  }
  const direction = url.searchParams.get("direction");
  if (direction !== null && !STAKE_FLOW_DIRECTIONS.includes(direction)) {
    return analyticsQueryError({
      parameter: "direction",
      message: `"${direction}" is not a valid direction. Supported: ${STAKE_FLOW_DIRECTIONS.join(", ")}.`,
    });
  }
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss
  // (#6016/#6017). Postgres → schema-stable empty stub.
  const pgPayload = await tryPostgresTier(
    env,
    request,
    "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
  );
  const { data, generatedAt } = pgPayload ?? {
    data: buildStakeFlow([], netuid, { window: windowParam }),
    generatedAt: null,
  };
  // account_events-derived, so the meta reports source "chain-events" (via
  // accountMeta), not the metagraph snapshot; generated_at is the newest event in
  // the window.
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-flow.json`,
        generatedAt,
      ),
    },
    "short",
  );
  return pgPayload ? response : markD1FallbackResponse(response);
}

// One subnet's alpha_market_cap_tao (#4342/8.3), preferring the live economics
// KV tier and falling back to the committed R2 economics.json when the live
// tier is cold/stale — same fallback shape resolveEconomicsRows uses in
// request-handlers/analytics-routes.mjs. Unmemoized (unlike api.mjs's
// readEconomicsCurrentKv): this route's traffic doesn't warrant the isolate
// cache analytics-routes.mjs's higher-traffic /economics + /subnets/{netuid}
// pair share, and entities.mjs deliberately imports leaf modules directly
// rather than taking injected deps from api.mjs (see this file's header).
// Null when neither tier has a row for this subnet.
async function resolveSubnetMarketCapTao(env, netuid) {
  const live = await resolveLiveEconomics({
    readHealthKv: (e) => readHealthKv(e, KV_ECONOMICS_CURRENT),
    env,
    contractVersion: contractVersion(env),
  });
  let rows = Array.isArray(live?.data?.subnets) ? live.data.subnets : null;
  if (!rows) {
    const artifact = await readArtifact(env, "/metagraph/economics.json");
    rows =
      artifact.ok && Array.isArray(artifact.data?.subnets)
        ? artifact.data.subnets
        : [];
  }
  const row = rows.find((entry) => entry?.netuid === netuid);
  const marketCap = row?.alpha_market_cap_tao;
  return typeof marketCap === "number" && Number.isFinite(marketCap)
    ? marketCap
    : null;
}

// One subnet's live AMM pool reserves (#5235) — the constant-product inputs the
// stake-quote math needs — resolved from the same live-KV-then-committed-R2
// economics tiers as resolveSubnetMarketCapTao, plus the blob's freshness stamp
// for the response meta. Returns { row: null } when neither tier has a row.
async function resolveSubnetEconomicsRow(env, netuid) {
  const live = await resolveLiveEconomics({
    readHealthKv: (e) => readHealthKv(e, KV_ECONOMICS_CURRENT),
    env,
    contractVersion: contractVersion(env),
  });
  let blob = Array.isArray(live?.data?.subnets) ? live.data : null;
  if (!blob) {
    const artifact = await readArtifact(env, "/metagraph/economics.json");
    blob =
      artifact.ok && Array.isArray(artifact.data?.subnets)
        ? artifact.data
        : null;
  }
  const rows = Array.isArray(blob?.subnets) ? blob.subnets : [];
  return {
    row: rows.find((entry) => entry?.netuid === netuid) ?? null,
    generatedAt: blob?.generated_at ?? blob?.captured_at ?? null,
  };
}

// GET /api/v1/subnets/{netuid}/stake-quote?amount=&direction=stake|unstake
// (#5235): a read-only constant-product slippage/price-impact estimate against
// the subnet's live AMM pool reserves — no chain write, no custody. Pure math in
// src/stake-quote.ts; this handler just resolves the reserves and maps its
// typed result onto the API envelope (400 for a bad request, 422 when the pool
// can't fill the requested swap).
export async function handleSubnetStakeQuote(request, env, netuid, url) {
  const validationError = validateEntityQuery(url, ["amount", "direction"]);
  if (validationError) return analyticsQueryError(validationError);
  // A missing/empty `amount` coerces to 0, which computeStakeQuote rejects as
  // invalid_amount just like a non-numeric value — no separate null check.
  const amount = Number(url.searchParams.get("amount"));
  const direction = url.searchParams.get("direction") ?? "stake";
  const { row, generatedAt } = await resolveSubnetEconomicsRow(env, netuid);
  const result = computeStakeQuote({
    netuid,
    taoInPool: row?.tao_in_pool_tao,
    alphaInPool: row?.alpha_in_pool,
    amount,
    direction,
  });
  if (!result.ok) {
    return errorResponse(result.code, result.error, result.status);
  }
  return envelopeResponse(
    request,
    {
      data: { schema_version: 1, ...result.quote },
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-quote.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/volume (#4339/8.1): rolling 24h buy (StakeAdded)
// vs sell (StakeRemoved) alpha volume for one subnet, summed live from the same
// account_events stream as stake-flow — unsigned (buy + sell), never netted, and
// a fixed 24h window (no ?window= param), matching the issue's framing as a
// canonical market-depth figure rather than a windowed analytics view. Cold/
// absent store → 200 with zeroed totals (schema-stable, never 404).
export async function handleSubnetAlphaVolume(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const marketCapTao = await resolveSubnetMarketCapTao(env, netuid);
  const { data, generatedAt } = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
  )) ?? {
    data: buildAlphaVolume([], netuid, { marketCapTao }),
    generatedAt: null,
  };
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/volume.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/ohlc?interval=1h|1d&days=1-365 (#5655, Phase 1 of
// the OHLC epic #5304): open/high/low/close/volume candles for one subnet's
// alpha price, bucketed by ?interval= (default 1h) from the same account_events
// StakeAdded/StakeRemoved stream as /volume and /stake-flow -- each row is one
// executed trade, price = amount_tao / alpha_amount. ?days= bounds the
// Postgres-tier lookback window (default DEFAULT_OHLC_WINDOW_DAYS, max
// MAX_OHLC_WINDOW_DAYS); a wider opt-in beyond that is out of scope for this v1
// (#5304's scoping comment). Both params are validated here (a clear 400 for a
// bad value) even though buildSubnetOhlc also normalizes defensively -- mirrors
// handleSubnetStakeFlow's own window/direction validation. Root (netuid 0) has
// no AMM -- buildSubnetOhlc returns its root_excluded degenerate shape (no
// candles) rather than a meaningless flat-line series. Cold/absent store -> 200
// with an empty candle array (schema-stable, never 404), mirroring the sibling
// account_events routes.
export async function handleSubnetOhlc(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["interval", "days"]);
  if (validationError) return analyticsQueryError(validationError);
  const intervalParam = url.searchParams.get("interval");
  if (intervalParam !== null && !Object.hasOwn(OHLC_INTERVALS, intervalParam)) {
    return analyticsQueryError({
      parameter: "interval",
      message: `"${intervalParam}" is not a valid interval. Supported: ${Object.keys(OHLC_INTERVALS).join(", ")}.`,
    });
  }
  const interval = intervalParam || OHLC_INTERVAL_DEFAULT;
  const { error: daysError } = parseBoundedIntParam(url, "days", {
    def: DEFAULT_OHLC_WINDOW_DAYS,
    min: 1,
    max: MAX_OHLC_WINDOW_DAYS,
  });
  if (daysError) return analyticsQueryError(daysError);
  const { data, generatedAt } = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
  )) ?? {
    data: buildSubnetOhlc([], netuid, { interval }),
    generatedAt: null,
  };
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/ohlc.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/movers?window=7d|30d|90d&sort=stake|emission|validators&limit=20:
// cross-subnet momentum leaderboard — every subnet ranked by its stake/emission/validator
// change between the window's start and end neuron_daily snapshots. Computed live from the
// neuron_daily rollup (idx_neuron_daily_netuid_date_agg covers the GROUP BY netuid,
// snapshot_date read). Cold/absent or single-snapshot store → 200 with movers:[]
// (schema-stable, never 404), mirroring the sibling history/turnover routes.
export async function handleSubnetMovers(request, env, url) {
  const validationError = validateEntityQuery(url, [
    "window",
    "sort",
    "limit",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam = url.searchParams.get("window") || DEFAULT_MOVERS_WINDOW;
  if (!Object.hasOwn(MOVERS_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, MOVERS_WINDOWS),
    });
  }
  const sortParam = url.searchParams.get("sort") || DEFAULT_MOVERS_SORT;
  if (!MOVERS_SORTS.includes(sortParam)) {
    return analyticsQueryError({
      parameter: "sort",
      message: `"${sortParam}" is not a supported sort. Supported: ${MOVERS_SORTS.join(
        ", ",
      )}.`,
    });
  }
  const limit = parseBoundedIntParam(url, "limit", {
    def: MOVERS_LIMIT_DEFAULT,
    min: 1,
    max: MOVERS_LIMIT_MAX,
  });
  if (limit.error) return analyticsQueryError(limit.error);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildMovers([], [], {
      window: windowParam,
      startDate: null,
      endDate: null,
      sort: sortParam,
      limit: limit.value,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.movers,
      "subnet-movers",
      "short",
      request,
      MOVERS_CSV_COLUMNS,
    );
  }
  // neuron_daily-derived, so the meta reports the metagraph-snapshot source; generated_at
  // is the end snapshot date (string), matching the turnover/history routes.
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/subnets/movers.json",
        data.end_date,
      ),
    },
    "short",
  );
}

// ---- Account entity handlers (#1347) ---------------------------------------
// SQL + pagination live in src/account-events.mjs (loadAccount*), shared with the
// MCP account tools; these handlers add only the REST envelope + meta.
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

// Account routes stamp meta.source but browsers need the CORS-exposed header too.
async function accountEnvelopeResponse(
  request,
  payload,
  cacheProfile = "short",
  extraHeaders = {},
) {
  return envelopeResponse(request, payload, cacheProfile, {
    [X_METAGRAPH_ARTIFACT_SOURCE_HEADER]: payload.meta.source,
    ...extraHeaders,
  });
}

// GET /api/v1/accounts/{ss58}/stake-flow: the account's StakeAdded/StakeRemoved flow
// per subnet over a 7d/30d/90d window — net + gross flow, an HHI concentration of where
// its flow is focused, and a direction label. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export async function handleAccountStakeFlow(request, env, ss58, url) {
  const validationError = validateQueryParams(url, ["window", "direction"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam =
    url.searchParams.get("window") || DEFAULT_STAKE_FLOW_WINDOW;
  if (!Object.hasOwn(STAKE_FLOW_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, STAKE_FLOW_WINDOWS),
    });
  }
  // ?direction=all|in|out narrows to inflow/outflow only; omitted sums both.
  // Mirrors the subnet stake-flow route (#2694).
  const direction = url.searchParams.get("direction");
  if (direction !== null && !STAKE_FLOW_DIRECTIONS.includes(direction)) {
    return analyticsQueryError({
      parameter: "direction",
      message: `"${direction}" is not a valid direction. Supported: ${STAKE_FLOW_DIRECTIONS.join(", ")}.`,
    });
  }
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss
  // (#6016/#6017). Postgres → schema-stable empty stub.
  const { data, generatedAt } = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
  )) ?? {
    data: buildAccountStakeFlow([], ss58, { window: windowParam }),
    generatedAt: null,
  };
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/stake-flow.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// Factory for the account-events handlers below (#5296): each GET /api/v1/accounts/{ss58}/<kind>
// endpoint validates ?window=, resolves via the Postgres tier with a schema-stable-zeros fallback,
// and wraps the result in the standard account envelope — identical control flow across all 7,
// differing only in the window enum, the shaping builder, and the response artifact's URL suffix.
function makeAccountEventHandler({ windows, defaultWindow, build, urlSuffix }) {
  return async function handleAccountEvent(request, env, ss58, url) {
    const validationError = validateQueryParams(url, ["window"]);
    if (validationError) return analyticsQueryError(validationError);
    const windowParam = url.searchParams.get("window") || defaultWindow;
    if (!Object.hasOwn(windows, windowParam)) {
      return analyticsQueryError({
        parameter: "window",
        message: unsupportedWindowMessage(windowParam, windows),
      });
    }
    const { data, generatedAt } = (await tryPostgresTier(
      env,
      request,
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    )) ?? {
      data: build([], ss58, { window: windowParam }),
      generatedAt: null,
    };
    return accountEnvelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/${urlSuffix}.json`,
          generatedAt,
        ),
      },
      "short",
    );
  };
}

// GET /api/v1/accounts/{ss58}/stake-moves: the account's per-subnet StakeMoved footprint
// over a 7d/30d/90d window — movement count + first/last timestamps per subnet, an HHI
// concentration of where its re-delegation churn is focused, and the dominant subnet.
// account_events-derived (source "chain-events"). Cold/absent store → schema-stable zeros.
export const handleAccountStakeMoves = makeAccountEventHandler({
  windows: ACCOUNT_STAKE_MOVES_WINDOWS,
  defaultWindow: DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
  build: buildAccountStakeMoves,
  urlSuffix: "stake-moves",
});

// GET /api/v1/accounts/{ss58}/weight-setters: the account's (validator's) per-subnet WeightsSet
// footprint over a 7d/30d window — weight-set count + first/last timestamps per subnet, an HHI
// concentration of where its weight-setting activity is focused, and the dominant subnet.
// account_events-derived (source "chain-events"). Cold/absent store → schema-stable zeros.
export const handleAccountWeightSetters = makeAccountEventHandler({
  windows: ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  defaultWindow: DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
  build: buildAccountWeightSetters,
  urlSuffix: "weight-setters",
});

// GET /api/v1/accounts/{ss58}/registrations: the account's per-subnet NeuronRegistered footprint
// over a 7d/30d/90d window — registration count + first/last timestamps per subnet, an HHI
// concentration of where its registration activity is focused, and the dominant subnet.
// account_events-derived (source "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountRegistrations = makeAccountEventHandler({
  windows: REGISTRATION_WINDOWS,
  defaultWindow: DEFAULT_REGISTRATION_WINDOW,
  build: buildAccountRegistrations,
  urlSuffix: "registrations",
});

// GET /api/v1/accounts/{ss58}/serving: the account's per-subnet AxonServed footprint over a
// 7d/30d/90d window — announcement count + first/last timestamps per subnet, an HHI concentration
// of where its serving activity is focused, and the dominant subnet. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountServing = makeAccountEventHandler({
  windows: SERVING_WINDOWS,
  defaultWindow: DEFAULT_SERVING_WINDOW,
  build: buildAccountServing,
  urlSuffix: "serving",
});

// GET /api/v1/accounts/{ss58}/axon-removals: the account's per-subnet AxonInfoRemoved footprint over
// a 7d/30d/90d window — removal count + first/last timestamps per subnet, an HHI concentration of
// where its teardown activity is focused, and the dominant subnet. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountAxonRemovals = makeAccountEventHandler({
  windows: AXON_REMOVAL_WINDOWS,
  defaultWindow: DEFAULT_AXON_REMOVAL_WINDOW,
  build: buildAccountAxonRemovals,
  urlSuffix: "axon-removals",
});

// GET /api/v1/accounts/{ss58}/prometheus: the account's per-subnet PrometheusServed footprint over a
// 7d/30d/90d window — announcement count + first/last timestamps per subnet, an HHI concentration of
// where its telemetry activity is focused, and the dominant subnet. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountPrometheus = makeAccountEventHandler({
  windows: PROMETHEUS_WINDOWS,
  defaultWindow: DEFAULT_PROMETHEUS_WINDOW,
  build: buildAccountPrometheus,
  urlSuffix: "prometheus",
});

// GET /api/v1/accounts/{ss58}/deregistrations: the account's per-subnet NeuronDeregistered footprint
// over a 7d/30d/90d window — eviction count + first/last timestamps per subnet, an HHI concentration
// of where its deregistration activity is focused, and the dominant subnet. account_events-derived
// (source "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountDeregistrations = makeAccountEventHandler({
  windows: DEREGISTRATION_WINDOWS,
  defaultWindow: DEFAULT_DEREGISTRATION_WINDOW,
  build: buildAccountDeregistrations,
  urlSuffix: "deregistrations",
});

// GET /api/v1/accounts/{ss58}: cross-subnet summary — event-history aggregates
// (account_events, matched by hotkey OR coldkey) joined to current registrations
// (neurons, by hotkey). Cold/absent store → schema-stable zero (never 404).
export async function handleAccount(request, env, ss58) {
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildAccountSummary(ss58, {});
  // Community-contributable entity labels (#6739): additive field over the
  // baked entities.json artifact, joined by ss58 here rather than in either
  // upstream builder above (one join site instead of two). A missing/cold
  // artifact degrades to an empty label list, matching this route's own
  // never-404 contract.
  const entitiesArtifact = await readArtifact(env, ENTITY_LABELS_ARTIFACT);
  data.labels = labelsForSs58(
    entityLabelsIndex(
      entitiesArtifact.ok ? entitiesArtifact.data?.entities : [],
    ),
    ss58,
  );
  return accountEnvelopeResponse(
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

// GET /api/v1/accounts/{coldkey}/entities (#6740): one address's own entity
// labels plus every subnet-ownership tie it has via the SubnetOwnerChanged
// chain_events stream (either side of the transfer) -- see
// src/entity-labels.ts's own header for the scope/limitation note (this
// only tracks AUTOMATIC ownership transfers, not genesis ownership).
//
// The DATA_API service binding (workers/data-api.mjs) only carries the
// Postgres/Hyperdrive connection -- no R2/KV bindings of its own -- so it
// builds ownership_ties alone (entities: [] on its side); this handler then
// joins the entities.json artifact's `labels` on top, same join site as
// handleAccount above.
export async function handleAccountEntities(request, env, coldkey) {
  const [entitiesArtifact, ownershipData] = await Promise.all([
    readArtifact(env, ENTITY_LABELS_ARTIFACT),
    tryPostgresTier(env, request, "METAGRAPH_SUBNET_OWNERSHIP_SOURCE"),
  ]);
  const data = ownershipData ?? buildAccountEntities(coldkey, { entities: [] });
  data.labels = labelsForSs58(
    entityLabelsIndex(
      entitiesArtifact.ok ? entitiesArtifact.data?.entities : [],
    ),
    coldkey,
  );
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/events: paginated event history (newest first),
// optional ?kind= filter, ?limit (<=1000) / ?offset.
export async function handleAccountEvents(request, env, ss58, url) {
  const validationError = validateEntityQuery(url, [
    "kind",
    "netuid",
    "block_start",
    "block_end",
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  // Optional block-height range filter, parity with the extrinsics and
  // chain-events feeds. Index-satisfiable via idx_account_events_hotkey and
  // idx_account_events_coldkey (each leads block_number), so a bounded range
  // seeks rather than scans this public, ~60s-cached route.
  const blockStart = parseNonNegativeIntParam(
    url.searchParams.get("block_start"),
    "block_start",
  );
  if (blockStart.error) return analyticsQueryError(blockStart.error);
  const blockEnd = parseNonNegativeIntParam(
    url.searchParams.get("block_end"),
    "block_end",
  );
  if (blockEnd.error) return analyticsQueryError(blockEnd.error);
  const netuid = parseNonNegativeIntParam(
    url.searchParams.get("netuid"),
    "netuid",
  );
  if (netuid.error) return analyticsQueryError(netuid.error);
  const kind = url.searchParams.get("kind");
  // Reject an unknown ?kind= up front, validated against the FULL ingested set
  // (not just INDEXED_EVENT_KINDS, which would wrongly reject Transfer/NetworkAdded
  // etc.). A typo/nonexistent kind otherwise matches nothing and forces a full
  // index walk on this public, ~60s-cached route — parity with handleSubnetEvents
  // (#2081).
  if (kind != null && !INGESTED_EVENT_KINDS.includes(kind)) {
    return analyticsQueryError({
      parameter: "kind",
      message: `"${kind}" is not a supported event kind. Supported: ${INGESTED_EVENT_KINDS.join(", ")}.`,
    });
  }
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const { limit: parsedLimit, offset: parsedOffset } = parsePagination(
    url,
    FEED_PAGINATION,
  );
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildAccountEvents([], ss58, {
      limit: parsedLimit,
      offset: parsedOffset,
      nextCursor: null,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.events,
      "account-events",
      "short",
      request,
      EVENTS_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
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

// GET /api/v1/accounts/{ss58}/history (#1854): the durable per-day activity
// series for an account, from the account_events_daily rollup. ?netuid filters
// to one subnet; ?from / ?to are YYYY-MM-DD bounds; ?limit (<=1000) / ?offset.
// Newest day first. D1 fully eliminated (2026-07-17): account_events_daily is
// Postgres-only now, so a tier miss (incl. inverted from>to bounds, which
// short-circuit before the tier call) always returns the schema-stable empty
// shape, never a live D1 query.
//
// SCOPE: the rollup writes only hotkey-attributed rows, so an ss58 with no
// hotkey activity returns zero days even when /events shows activity — a
// documented limitation of the hotkey-keyed rollup, not a bug (the contract
// description spells out the contrast with /events in full).

export async function handleAccountHistory(request, env, ss58, url) {
  const validationError = validateEntityQuery(url, [
    "netuid",
    "from",
    "to",
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const range = parseDateRange(url);
  if (range.error) return analyticsQueryError(range.error);
  const { from, to } = range;
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const netuid = url.searchParams.get("netuid");
  if (
    netuid != null &&
    (!/^\d+$/.test(netuid) || !Number.isSafeInteger(Number(netuid)))
  ) {
    return analyticsQueryError({
      parameter: "netuid",
      message: "netuid must be a non-negative integer.",
    });
  }
  // Inverted YYYY-MM-DD bounds are a deterministic no-match. Short-circuit before
  // D1 so callers cannot force a scan to prove an impossible empty page.
  if (from && to && from > to) {
    const data = buildAccountHistory([], ss58, {
      limit,
      offset,
      nextCursor: null,
    });
    // Honour ?format=csv on the short-circuit too, so an inverted range yields
    // a header-only CSV rather than a JSON body for a CSV request (#5741).
    if (csvRequested(url, request)) {
      return csvResponse(
        data.days,
        "account-history",
        "short",
        request,
        ACCOUNT_HISTORY_CSV_COLUMNS,
      );
    }
    // Use the account envelope so this short-circuit exposes the
    // x-metagraph-artifact-source header too — the normal path below does (#2618),
    // and the payload stamps the same meta.source, so a browser must not lose the
    // CORS-exposed header just because the range was inverted.
    return accountEnvelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/history.json`,
          null,
        ),
      },
      "short",
    );
  }
  // Keyset (cursor) pagination over (day, netuid). day sorts as TEXT (YYYY-MM-DD
  // is chronological); the cursor encodes it as its natural sortable integer
  // (2026-06-25 -> 20260625) to fit the integer-only cursor codec, with netuid as
  // the within-day tiebreaker. netuid is NOT NULL (a primary-key column of
  // account_events_daily), so the cursor's netuid leg is always a real integer and
  // the seek never degrades to a NULL comparison. ORDER BY adds `netuid DESC` to
  // make same-day ordering deterministic — it was `day DESC` only before, where
  // same-day order was unspecified, so existing offset callers get a stable (not a
  // changed) page order. offset stays as a deprecated fallback; cursor wins. A
  // cursor that does not decode to a valid YYYYMMDD day is ignored (falls back to
  // the first page), preserving the never-throw contract.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildAccountHistory([], ss58, { limit, offset, nextCursor: null });
  // CSV export mirrors handleAccountEvents/Extrinsics/Transfers: the rows are
  // already range/netuid-filtered and paginated, so the CSV path carries the
  // identical set the JSON path would (#5741). Cold → empty array → header-only.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.days,
      "account-history",
      "short",
      request,
      ACCOUNT_HISTORY_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/extrinsics: the extrinsics this account SIGNED
// (newest first), from the extrinsics D1 tier (#1844). Matched by the extrinsic
// signer only — NOT the hotkey or coldkey union the account_events routes use,
// since `extrinsics` carries a single `signer` column. ?block_start/?block_end
// constrain block height; ?limit (<=1000) / ?offset, or ?cursor=. Cold/absent store →
// schema-stable zero (never 404).
export async function handleAccountExtrinsics(request, env, ss58, url) {
  const validationError = validateEntityQuery(url, [
    "block_start",
    "block_end",
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const blockStart = parseNonNegativeIntParam(
    url.searchParams.get("block_start"),
    "block_start",
  );
  if (blockStart.error) return analyticsQueryError(blockStart.error);
  const blockEnd = parseNonNegativeIntParam(
    url.searchParams.get("block_end"),
    "block_end",
  );
  if (blockEnd.error) return analyticsQueryError(blockEnd.error);
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const { limit: parsedLimit, offset: parsedOffset } = parsePagination(
    url,
    FEED_PAGINATION,
  );
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_EXTRINSICS_SOURCE")) ??
    buildAccountExtrinsics([], ss58, {
      limit: parsedLimit,
      offset: parsedOffset,
      nextCursor: null,
    });
  if (csvRequested(url, request)) {
    const csvRows = data.extrinsics.map((extrinsic) => ({
      ...extrinsic,
      extrinsic_id: `${extrinsic.block_number}-${extrinsic.extrinsic_index}`,
    }));
    return csvResponse(
      csvRows,
      "account-extrinsics",
      "short",
      request,
      ACCOUNT_EXTRINSICS_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/extrinsics.json`,
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
    { vary: "Accept, Accept-Encoding" },
  );
}

// GET /api/v1/accounts/{ss58}/transfers: the native-TAO Balances.Transfer feed for
// this account (#1850), newest first, from the account_events tier (event_kind=
// 'Transfer', where the poller stores hotkey=from / coldkey=to). ?direction=
// all|sent|received narrows by side; ?block_start/?block_end constrain block
// height; ?limit (<=1000) / ?offset, or ?cursor=. This is the native-TAO
// transfer feed only, NOT a full balance ledger. Cold/absent store →
// schema-stable zero (never 404).
export async function handleAccountTransfers(request, env, ss58, url) {
  const validationError = validateEntityQuery(url, [
    "direction",
    "block_start",
    "block_end",
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const direction = url.searchParams.get("direction");
  if (
    direction !== null &&
    direction !== "all" &&
    direction !== "sent" &&
    direction !== "received"
  ) {
    return analyticsQueryError({
      parameter: "direction",
      message: `"${direction}" is not a valid direction. Supported: all, sent, received.`,
    });
  }
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const blockStart = parseNonNegativeIntParam(
    url.searchParams.get("block_start"),
    "block_start",
  );
  if (blockStart.error) return analyticsQueryError(blockStart.error);
  const blockEnd = parseNonNegativeIntParam(
    url.searchParams.get("block_end"),
    "block_end",
  );
  if (blockEnd.error) return analyticsQueryError(blockEnd.error);
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildAccountTransfers([], ss58, {
      limit,
      offset,
      nextCursor: null,
      direction: undefined,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.transfers,
      "account-transfers",
      "short",
      request,
      ACCOUNT_TRANSFERS_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/transfers.json`,
        data.transfers[0]?.observed_at ?? null,
      ),
    },
    "short",
    { vary: "Accept, Accept-Encoding" },
  );
}

// GET /api/v1/accounts/{ss58}/counterparties?limit=N: who this account transacts
// with. Add ?counterparty=<ss58> to return a focused relationship drilldown on
// the same route without expanding the public path surface. ?format=csv exports
// the list-mode leaderboard (mirrors handleAccountsList); it's rejected alongside
// ?counterparty since the drilldown's single composite object has no CSV rows.
export async function handleAccountCounterparties(request, env, ss58, url) {
  const validationError = validateEntityQuery(url, [
    "counterparty",
    "limit",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const counterparty = url.searchParams.get("counterparty");
  const parsedLimit = parseBoundedIntParam(url, "limit", {
    def: counterparty == null ? 20 : 50,
    min: 1,
    max: 100,
  });
  if (parsedLimit.error) return analyticsQueryError(parsedLimit.error);
  const limit = parsedLimit.value;
  if (counterparty != null) {
    // CSV export only covers the list-mode leaderboard below -- the
    // relationship drilldown returns a single composite object, not rows.
    if (csvRequested(url, request)) {
      return analyticsQueryError({
        parameter: "format",
        message:
          "format=csv is not supported with counterparty; remove counterparty to export the list-mode counterparties CSV.",
      });
    }
    if (!SS58_ADDRESS_PATTERN.test(counterparty)) {
      return analyticsQueryError({
        parameter: "counterparty",
        message: "counterparty must be a valid SS58 account address.",
      });
    }
    if (ss58 === counterparty) {
      return analyticsQueryError({
        parameter: "counterparty",
        message: "counterparty must differ from ss58.",
      });
    }
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
    // and the table is dropped in production, so a D1 query here would
    // always miss. An empty rows input always yields transfer_count: 0, so
    // this mirrors loadCounterpartyRelationship's composite shape with an
    // always-empty counterparties list, without querying D1 at all.
    const emptyRelationship = buildCounterpartyRelationship(
      [],
      ss58,
      counterparty,
      { limit },
    );
    const data = (await tryPostgresTier(
      env,
      request,
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    )) ?? {
      schema_version: 1,
      ss58,
      counterparty_count: 0,
      transfers_scanned: emptyRelationship.transfers_scanned,
      scan_capped: emptyRelationship.scan_capped,
      total_sent_tao: emptyRelationship.total_sent_tao,
      total_received_tao: emptyRelationship.total_received_tao,
      counterparties: [],
      relationship: emptyRelationship,
    };
    return accountEnvelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/counterparties.json`,
          data.relationship.last_seen_at,
        ),
      },
      "short",
    );
  }
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildCounterparties([], ss58, { limit });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.counterparties,
      "account-counterparties",
      "short",
      request,
      ACCOUNT_COUNTERPARTIES_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/counterparties.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/subnets: the subnets where this hotkey is currently
// registered (the cross-subnet footprint), from the neurons tier.
export async function handleAccountSubnets(request, env, ss58) {
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildAccountSubnets([], ss58);
  return accountEnvelopeResponse(
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

// GET /api/v1/accounts/{ss58}/portfolio: the wallet's cross-subnet neuron
// positions with per-position economics + yield and wallet-level aggregates
// (totals, counts, overall return, stake concentration), from the neurons D1
// tier. Richer than /subnets (registration footprint only). Cold/absent → empty.
export async function handleAccountPortfolio(request, env, ss58) {
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildAccountPortfolio([], ss58);
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/portfolio.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/positions (#5233): this account's reconstructed
// nominator-side positions -- what it holds delegated across every
// hotkey/subnet, distinct from /portfolio above (hotkey-scoped). Postgres-
// only, same shape as handleAccountPositionHistory's own no-D1-fallback note:
// nominator_positions never had a D1-era predecessor, so there is nothing to
// fall back to besides a schema-stable empty card. Reuses
// METAGRAPH_NEURONS_SOURCE (not a dedicated flag) since this route's stake_tao
// join reads the same neurons tier that flag already gates in production.
export async function handleAccountPositions(request, env, ss58) {
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildAccountPositions([], new Map(), ss58);
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/positions.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/subnets/{netuid}/history?window=7d|30d|90d|1y|all
// (block-explorer Tier-1, #4329/6.2): one wallet's position on one subnet over
// time — the "Alpha Holdings chart" — read from the account_position_daily
// rollup tier (#4330/6.1). Source is metagraph-snapshot (rolled from
// `neurons`), not chain-events, so this uses envelopeResponse + metagraphMeta
// like the neuron/subnet history routes, not accountEnvelopeResponse.
// Postgres-only (#4839 shipped its write path + this read route; #4910's "no
// Postgres read route" premise was stale). No D1 fallback: D1's own
// account_position_daily rollup (rollupAccountPositionDaily,
// src/account-position-history.mjs) has been permanently broken since #4908
// dropped D1's `neurons` table out from under it, so a D1 branch here could
// only ever serve data frozen at 2026-07-11 — worse than the schema-stable
// empty response below. Cold/absent store → 200 with empty points (never
// 404), matching every sibling history route.
export async function handleAccountPositionHistory(
  request,
  env,
  ss58,
  netuid,
  url,
) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return analyticsQueryError(error);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    buildAccountPositionHistory([], ss58, netuid, { window: label });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/accounts/${ss58}/subnets/${netuid}/history.json`,
        data.points[0]?.captured_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/identity (epic #4301/5.4): the latest-only
// personal chain identity for one account, from the same
// MetagraphInfo.identities capture account-identity.mjs's header documents
// (metagraph-snapshot sourced, like account position history above — not
// account_events, so metagraphMeta not accountMeta). has_identity is false
// for the common case (most accounts never call set_identity) — schema-stable,
// never 404.
//
// D1 retirement: account_identity's D1 write path (loadStagedAccountIdentity,
// formerly workers/request-handlers/staging.mjs, now deleted) is retired --
// refresh-account-identity writes Postgres only now (indexer-box cron
// pipeline). D1 fully eliminated (2026-07-16): a Postgres miss/outage now
// degrades to the schema-stable "no identity" shape, never a live D1 read of
// D1's frozen copy.
export async function handleAccountIdentity(request, env, ss58, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    (await tryPostgresTier(
      env,
      request,
      "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
    )) ?? buildAccountIdentity(null, ss58);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/accounts/${ss58}/identity.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/identity-history (epic #4301/5.4): append-only
// diff-tracking timeline for one account's identity (src/account-identity-
// history.mjs), newest first. Mirrors handleSubnetIdentityHistory's shape
// exactly, keyed by ss58 instead of netuid. Cold/absent store → schema-stable
// zero entries, never 404.
export async function handleAccountIdentityHistory(request, env, ss58, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const data =
    (await tryPostgresTier(
      env,
      request,
      "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
    )) ??
    buildAccountIdentityHistory([], ss58, { limit, offset, nextCursor: null });
  // CSV mirrors handleSubnetHyperparamsHistory: the page is already
  // limit/offset/cursor-bounded, so the CSV path carries the identical page the
  // JSON path would. Cold store -> empty entries -> header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries,
      "account-identity-history",
      "short",
      request,
      ACCOUNT_IDENTITY_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/accounts/${ss58}/identity-history.json`,
        data.entries[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/events (#1345 block explorer): the first-party
// chain-event stream for one subnet — account_events filtered by netuid, newest
// first (the idx_account_events_netuid index this tier was built for). Optional
// ?kind= filter; ?limit (<=1000)/?offset. Cold/absent store → schema-stable zero
// (never 404), mirroring handleAccountEvents.
export async function handleSubnetEvents(request, env, netuid, url) {
  const validationError = validateEntityQuery(url, [
    "kind",
    "block_start",
    "block_end",
    "limit",
    "offset",
    "cursor",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const kind = url.searchParams.get("kind");
  // Reject an unknown ?kind= up front, validated against the FULL ingested set
  // (not just INDEXED_EVENT_KINDS, which would wrongly reject Transfer/NetworkAdded
  // etc.). A typo/nonexistent kind otherwise matches nothing and forces a full
  // index walk on this public, ~60s-cached route (#2081).
  if (kind != null && !INGESTED_EVENT_KINDS.includes(kind)) {
    return analyticsQueryError({
      parameter: "kind",
      message: `"${kind}" is not a supported event kind. Supported: ${INGESTED_EVENT_KINDS.join(", ")}.`,
    });
  }
  // Optional block-height range filter, parity with the extrinsics, chain-events
  // and account-events feeds. A bounded range stays index-satisfiable, so it
  // seeks rather than scans this public, ~60s-cached route.
  const blockStart = parseNonNegativeIntParam(
    url.searchParams.get("block_start"),
    "block_start",
  );
  if (blockStart.error) return analyticsQueryError(blockStart.error);
  const blockEnd = parseNonNegativeIntParam(
    url.searchParams.get("block_end"),
    "block_end",
  );
  if (blockEnd.error) return analyticsQueryError(blockEnd.error);
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const { limit: parsedLimit, offset: parsedOffset } = parsePagination(
    url,
    FEED_PAGINATION,
  );
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetEvents([], netuid, {
      limit: parsedLimit,
      offset: parsedOffset,
      nextCursor: null,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.events,
      "subnet-events",
      "short",
      request,
      EVENTS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/events.json`,
        data.events[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/event-summary: compact windowed account_events
// aggregates by kind/category plus a small newest-first evidence slice. This is
// the dashboard-friendly companion to the raw /events feed.
export async function handleSubnetEventSummary(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window", "limit"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowLabel =
    url.searchParams.get("window") ?? DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW;
  if (
    !Object.prototype.hasOwnProperty.call(
      SUBNET_EVENT_SUMMARY_WINDOWS,
      windowLabel,
    )
  ) {
    return analyticsQueryError({
      parameter: "window",
      message: `window must be one of ${Object.keys(SUBNET_EVENT_SUMMARY_WINDOWS).join(", ")}.`,
    });
  }
  const parsedLimit = parseLimitParam(url, {
    defaultLimit: SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
    maxLimit: SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  });
  if (parsedLimit.error) return analyticsQueryError(parsedLimit.error);
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_ACCOUNT_EVENTS_SOURCE")) ??
    buildSubnetEventSummary([], [], netuid, {
      window: windowLabel,
      limit: parsedLimit.limit,
    });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/event-summary.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

export const BALANCE_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// GET /api/v1/accounts/{ss58}/balance (#1818): live TAO balance (free+reserved)
// for one account, queried from the finney RPC at request time. 60s KV cache via
// METAGRAPH_CONTROL. Returns 400 on invalid ss58; 200 with balance_tao:null on
// RPC failure (schema-stable, consistent with blocks/extrinsics null-on-miss).
// Served through the shared envelopeResponse so it carries the same ok/data
// envelope, weak ETag, contract-version header, and 304/HEAD handling as every
// other route — the body matches the AccountBalanceArtifact data schema.
export async function handleAccountBalance(request, env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `balance:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "balance_rate_limited",
        "Too many live balance requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountBalance(env, ss58);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/root-claim (#7229): live root-claim current
// state for one Finney ss58 account — claim type, per-hotkey claimable rates,
// cumulative claimed watermarks, and per-netuid thresholds. Read-only; never
// submits claim_root. Live RPC + KV-cache, same shape as handleAccountBalance.
export async function handleAccountRootClaim(request, env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `root-claim:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "root_claim_rate_limited",
        "Too many live root-claim requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountRootClaim(env, ss58);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/children (#6723, part of the child-hotkey
// delegation graph epic #6721): every child hotkey this account currently
// delegates stake-weight to, per subnet, with the proportion charged. Live
// RPC + KV-cache route, same shape as handleAccountBalance just above —
// see src/child-hotkey-delegation.ts's header for the on-chain storage
// details.
export async function handleAccountChildren(request, env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `children:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "children_rate_limited",
        "Too many live delegation-graph requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountChildren(env, ss58);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/parents (#6723): every hotkey currently
// delegating stake-weight to this account, per subnet. Same shape as
// handleAccountChildren just above, reading ParentKeys instead.
export async function handleAccountParents(request, env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `parents:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "parents_rate_limited",
        "Too many live delegation-graph requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountParents(env, ss58);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/recycled (#4339/8.4): the live cumulative TAO
// recycled for registration on one subnet, queried from the chain's own
// RAORecycledForRegistration storage map at request time (600s KV cache via
// METAGRAPH_CONTROL) — see src/subnet-recycled.mjs's header for why this
// isn't a log-layer/account_events aggregation. netuid is a per-request-
// controllable cache-busting parameter (like /accounts/{ss58}/balance's
// ss58), so it shares that route's rate limiter rather than sudo-key's
// no-limiter reasoning. recycled_tao is null on RPC failure (schema-stable).
export async function handleSubnetRecycled(request, env, netuid) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `recycled:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "recycled_rate_limited",
        "Too many live recycled-TAO requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadSubnetRecycled(env, netuid);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/burn (#6321): the live current registration/
// burn cost — the dynamic price between min_burn_tao/max_burn_tao's static
// bounds (subnet-hyperparams.mjs). Same live-RPC + KV-cache + rate-limit
// shape as handleSubnetRecycled just above (a sibling storage-map read, not
// the same underlying value).
export async function handleSubnetBurn(request, env, netuid) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `burn:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "burn_rate_limited",
        "Too many live burn-cost requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadSubnetBurn(env, netuid);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/lease (#6719, part of the subnet-leasing/
// crowdloan-tracking epic #6717): whether a subnet is currently under a
// lease and, if so, its terms + accumulated-but-undistributed alpha
// dividends. Same live-RPC + KV-cache + rate-limit shape as handleSubnetBurn
// just above (a different set of storage items, same pattern). See
// src/subnet-lease.mjs's header for the on-chain storage-key/struct-layout
// details. The companion /lease/history route (event log) is a Postgres-
// tier route in workers/data-api.mjs, not here.
export async function handleSubnetLease(request, env, netuid) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `lease:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "lease_rate_limited",
        "Too many live lease-state requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadSubnetLease(env, netuid);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/blocks: the recent-block feed (newest first), served live from the
// `blocks` D1 tier (#1345 block explorer). ?limit clamp <=100, ?offset. Cold/
// absent store → schema-stable zero (never throws). Reuses the chain-events meta
// (source:"chain-events") since the same first-party poller fills this tier.
export async function handleBlocks(request, env, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "author",
    "spec_version",
    "from",
    "to",
    "block_start",
    "block_end",
    "min_extrinsics",
    "min_events",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, BLOCK_PAGINATION);
  const sp = url.searchParams;
  // Reject non-integer numeric filters with 400 (mirrors handleExtrinsics / #2274).
  for (const param of [
    "block_start",
    "block_end",
    "from",
    "to",
    "min_extrinsics",
    "min_events",
    "spec_version",
  ]) {
    const raw = sp.get(param);
    if (raw === null) continue;
    const parsed = parseNonNegativeIntParam(raw, param);
    if (parsed.error) return analyticsQueryError(parsed.error);
  }
  // #4909 D1 retirement: blocks' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_BLOCKS_SOURCE")) ??
    buildBlockFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.blocks,
      "blocks",
      "short",
      request,
      BLOCK_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/blocks.json",
        data.blocks[0]?.observed_at ?? null,
      ),
    },
    "short",
    { vary: "Accept, Accept-Encoding" },
  );
}

// GET /api/v1/blocks/summary: block-production analytics over the most recent
// blocks — inter-block time distribution, extrinsic/event throughput, block-author
// decentralization (concentration over each author's block count), and the runtime
// spec-version spread, computed live from the `blocks` D1 tier. No params; a
// cold/absent store → 200 with a schema-stable zeroed card.
export async function handleBlocksSummary(request, env, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const pgData = await tryPostgresTier(env, request, "METAGRAPH_BLOCKS_SOURCE");
  const data = pgData ?? buildBlocksSummary([]);
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/blocks/summary.json",
        data.last_observed_at,
      ),
    },
    "short",
  );
  return pgData ? response : markD1FallbackResponse(response);
}

// GET /api/v1/blocks/{ref}: per-block detail (#1345). ref is a numeric
// block_number OR a 0x block_hash. Served live from the `blocks` D1 tier; an
// unknown ref / cold store → 200 with block:null (schema-stable, mirrors the
// neuron detail route — NEVER 404/throw).
export async function handleBlock(request, env, ref) {
  // #4909 D1 retirement: blocks' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_BLOCKS_SOURCE")) ??
    buildBlock(undefined, ref);
  // Finalized block detail is immutable once resolved; a cold/unknown ref stays
  // on the short profile so clients re-check when the block lands.
  const cacheProfile = data.block ? "static" : "short";
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}.json`,
        data.block?.observed_at ?? null,
      ),
    },
    cacheProfile,
  );
}

// GET /api/v1/blocks/{ref}/extrinsics: the extrinsics in one block (#1845), in
// natural read order (extrinsic_index ASC). ref is a numeric block_number OR a 0x
// block_hash — a hash ref is resolved to its block_number first (idx_blocks_hash),
// then extrinsics are read by the (block_number, extrinsic_index) PK prefix. ?limit
// (<=100) / ?offset. Unknown ref / cold store → 200 with block_number:null +
// extrinsics:[] (schema-stable, never 404).
export async function handleBlockExtrinsics(request, env, ref, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, BLOCK_PAGINATION);
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const { data } = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_EXTRINSICS_SOURCE",
  )) ?? { data: buildBlockExtrinsics([], ref, null, { limit, offset }) };
  // CSV reuses handleExtrinsics's transform + columns — buildBlockExtrinsics maps
  // the same formatExtrinsic row shape (#5746). Cold block → empty → header-only.
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(data.extrinsics),
      `block-${ref}-extrinsics`,
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}/extrinsics.json`,
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/blocks/{ref}/events: the decoded chain events in one block (#1852),
// in natural read order (event_index ASC). ref is a numeric block_number OR a 0x
// block_hash — a hash ref is resolved to its block_number first (idx_blocks_hash),
// then events are read by the (block_number, event_index) PK prefix. ?limit
// (<=1000) / ?offset. Unknown ref / cold store → 200 with block_number:null +
// events:[] (schema-stable, never 404). Mirrors handleBlockExtrinsics.
export async function handleBlockEvents(request, env, ref, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a D1 query here would always miss.
  const { data } = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
  )) ?? { data: buildBlockEvents([], ref, null, { limit, offset }) };
  // CSV reuses the account-events EVENTS_CSV_COLUMNS — buildBlockEvents maps the
  // same formatAccountEvent row shape (#5746). Cold block → empty → header-only.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.events,
      `block-${ref}-events`,
      "short",
      request,
      EVENTS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}/events.json`,
        data.events[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/extrinsics: the recent-extrinsic feed (newest first), served live
// from the `extrinsics` D1 tier (#1345 block explorer). ?limit clamp <=100,
// ?offset, and a conjunctive (AND-ed) filter set (#1846): ?block=<n>, ?signer=,
// ?call_module=, ?call_function=, ?success=true|false, ?block_start/?block_end
// (block range), ?from/?to (observed_at epoch-ms range). All optional; an inverted
// range simply matches nothing (never throws). Cold/absent store → schema-stable
// zero. Reuses the chain-events meta since the same first-party poller fills this
// tier. The per-row shape is bound, never interpolated.
// A 0x-prefixed 64-hex-char hash — the same shape as extrinsic_hash (#2063),
// reused here for call_hash (#4322). No `%`/`_` can appear in a valid match,
// so it's also safe to interpolate into a LIKE pattern below.
const CALL_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export async function handleExtrinsics(request, env, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "block",
    "signer",
    "call_module",
    "call_function",
    "call_hash",
    "success",
    "block_start",
    "block_end",
    "from",
    "to",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, BLOCK_PAGINATION);
  const sp = url.searchParams;
  for (const param of ["block", "block_start", "block_end", "from", "to"]) {
    const raw = sp.get(param);
    if (raw === null) continue;
    const parsed = parseNonNegativeIntParam(raw, param);
    if (parsed.error) return analyticsQueryError(parsed.error);
  }
  const successRaw = sp.get("success");
  if (successRaw !== null && successRaw !== "true" && successRaw !== "false") {
    return analyticsQueryError({
      parameter: "success",
      message: "success must be one of: true, false.",
    });
  }
  const callHashRaw = sp.get("call_hash");
  if (callHashRaw !== null && !CALL_HASH_RE.test(callHashRaw)) {
    return analyticsQueryError({
      parameter: "call_hash",
      message: "call_hash must be a 0x-prefixed 64-character hex string.",
    });
  }
  const callModule = sp.get("call_module") || undefined;
  if (callHashRaw !== null && !callModule) {
    return analyticsQueryError({
      parameter: "call_module",
      message: "call_module is required when call_hash is provided.",
    });
  }
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_EXTRINSICS_SOURCE")) ??
    buildExtrinsicFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(data.extrinsics),
      "extrinsics",
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/extrinsics.json",
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/sudo (#4310/2.2): the root-origin call table. subtensor has no
// Council/Senate (confirmed live against finney, bittensor 10.5.0, 2026-07-08 —
// only the Sudo pallet exists from the generic-Substrate governance family), so
// this is the extrinsics feed hardcoded to call_module='Sudo' rather than a
// proposal-lifecycle route — same D1 tier + loader as handleExtrinsics, no
// signer/call_module query params (signer is always the current sudo key, see
// GET /api/v1/sudo/key; call_module is fixed).
export async function handleSudo(request, env, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "block",
    "call_function",
    "success",
    "block_start",
    "block_end",
    "from",
    "to",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, BLOCK_PAGINATION);
  const sp = url.searchParams;
  for (const param of ["block", "block_start", "block_end", "from", "to"]) {
    const raw = sp.get(param);
    if (raw === null) continue;
    const parsed = parseNonNegativeIntParam(raw, param);
    if (parsed.error) return analyticsQueryError(parsed.error);
  }
  const successRaw = sp.get("success");
  if (successRaw !== null && successRaw !== "true" && successRaw !== "false") {
    return analyticsQueryError({
      parameter: "success",
      message: "success must be one of: true, false.",
    });
  }
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_EXTRINSICS_SOURCE")) ??
    buildExtrinsicFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(data.extrinsics),
      "sudo-calls",
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/sudo.json",
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/governance/config-changes (#4310/2.3, re-scoped from the
// original Council/Senate framing — see #4310's audit): subtensor's own
// root-origin hyperparameter/network-config change pathway. Same shape as
// handleSudo, just call_module='AdminUtils' — most AdminUtils calls (77 of
// ~83) don't emit their own dedicated event, so the extrinsic + its decoded
// call_args is the reliable source, not chain_events.
export async function handleGovernanceConfigChanges(request, env, url) {
  const validationError = validateEntityQuery(url, [
    "limit",
    "offset",
    "cursor",
    "block",
    "call_function",
    "success",
    "block_start",
    "block_end",
    "from",
    "to",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, BLOCK_PAGINATION);
  const sp = url.searchParams;
  for (const param of ["block", "block_start", "block_end", "from", "to"]) {
    const raw = sp.get(param);
    if (raw === null) continue;
    const parsed = parseNonNegativeIntParam(raw, param);
    if (parsed.error) return analyticsQueryError(parsed.error);
  }
  const successRaw = sp.get("success");
  if (successRaw !== null && successRaw !== "true" && successRaw !== "false") {
    return analyticsQueryError({
      parameter: "success",
      message: "success must be one of: true, false.",
    });
  }
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_EXTRINSICS_SOURCE")) ??
    buildExtrinsicFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(data.extrinsics),
      "governance-config-changes",
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/governance/config-changes.json",
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// The three columns the /runtime page's table renders (Spec Version | Block |
// Observed), in that order, so the download matches what the reader sees.
const RUNTIME_VERSIONS_CSV_COLUMNS = [
  "spec_version",
  "block_number",
  "observed_at",
];

// GET /api/v1/runtime (#4316/3.1): the spec-version transition timeline — the
// earliest known block at each distinct spec_version the blocks D1 tier has
// observed, ascending by block_number. A single-row aggregate over the whole
// retained window, nothing to filter or paginate (?format=csv is the one
// accepted param, #6392). See src/runtime-versions.ts for the coverage caveat
// (spec_version wasn't tracked before 2026-06-25 and can't be back-filled for
// rows written before then).
export async function handleRuntime(request, env, url) {
  const validationError = validateEntityQuery(url, ["format"]);
  if (validationError) return analyticsQueryError(validationError);
  // #4909 D1 retirement: blocks' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_BLOCKS_SOURCE")) ??
    buildRuntimeVersionHistory([]);
  // CSV exports the row-shaped transition timeline -- the same three columns
  // the /runtime page's table renders (#6392). The rollup fields
  // (current_spec_version, coverage_from_block/at) describe the series rather
  // than belonging to any row, so they stay JSON-only, mirroring how
  // chain-signers/chain-fees export their leaderboard and keep their totals out
  // of the CSV. A cold store yields transitions: [] -> a header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.transitions,
      "runtime-versions",
      "short",
      request,
      RUNTIME_VERSIONS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/runtime.json",
        data.transitions[data.transitions.length - 1]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/sudo/key (#4310/2.4, re-scoped from the original Senate/Council
// membership framing — see #4310's audit): the current Sudo::Key holder,
// queried live from finney RPC at request time. Sudo::Key changes extremely
// rarely, so a single fixed-key KV cache (1h TTL, same METAGRAPH_CONTROL
// binding as loadAccountBalance) means only the first request per hour ever
// reaches the live RPC — no per-request-controllable cache-busting parameter
// exists for this route (unlike /accounts/{ss58}/balance), so it doesn't need
// that route's rate limiter. hotkey is null on RPC failure or an unset sudo
// key (schema-stable, never throws).
export async function handleSudoKey(request, env) {
  const data = await loadSudoKey(env);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

export const EVM_ADDRESS_MAPPING_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// GET /api/v1/evm/address/{h160} (#6725/#6728): live H160 -> SS58 address
// mapping via the AddressMapping EVM precompile, queried from the finney RPC
// at request time. 1h KV cache via METAGRAPH_CONTROL (deterministic given
// h160, never changes). Returns 400 on invalid h160; 200 with ss58:null on
// RPC failure (schema-stable, consistent with handleAccountBalance below).
export async function handleEvmAddressMapping(request, env, h160) {
  if (!H160_PATTERN.test(h160)) {
    return errorResponse(
      "invalid_h160",
      "h160 must be a 20-byte 0x-prefixed hex address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `evm-address-mapping:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "evm_address_mapping_rate_limited",
        "Too many live address-mapping requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(EVM_ADDRESS_MAPPING_RATE_LIMIT.windowSeconds),
        },
      );
    }
  }

  const data = await loadAddressMapping(env, h160);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/network/parameters (#6343): live global Subtensor protocol/
// governance parameters (TaoWeight, StakeThreshold,
// PendingChildKeyCooldown) -- three parallel finney RPC reads, batched into
// one KV-cached response. Same shape as handleSudoKey just above (no path
// params, no dedicated rate limiter -- neither is a per-caller-scoped
// resource). Every field is independently null on RPC failure
// (schema-stable, never throws).
export async function handleNetworkParameters(request, env) {
  const data = await loadNetworkParameters(env);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/network/randomness (#6731): live drand randomness-beacon
// status -- LastStoredRound/OldestStoredRound -- a finney RPC read, KV-
// cached snapshot (not a history feed, pulses land ~3s apart). Same shape
// as handleNetworkParameters just above (no path params, no dedicated rate
// limiter). Every field is independently null on RPC failure
// (schema-stable, never throws).
export async function handleRandomnessStatus(request, env) {
  const data = await loadRandomnessStatus(env);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/extrinsics/{ref}: per-extrinsic detail (#1345/#1848). ref is EITHER
// a 0x extrinsic_hash OR the canonical composite id "<block_number>-<extrinsic_index>".
// The hash is best-effort/nullable in the decoder, so the composite id is the
// guaranteed-present identifier; the composite path does a direct (block_number,
// extrinsic_index) PK hit. Served live from the `extrinsics` D1 tier; an unknown
// ref / cold store / malformed composite → 200 with extrinsic:null (schema-stable,
// mirrors handleBlock's numeric-OR-hash branch — NEVER 404/throw).
//
// When the extrinsic resolves, the indexed account_events it emitted (#1849) are
// embedded via a second lookup on (block_number, extrinsic_index) — bounded to 50.
// Empty for pre-migration rows, non-ApplyExtrinsic events, or a cold store.
export async function handleExtrinsic(request, env, ref) {
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a D1 query here would always miss.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_EXTRINSICS_SOURCE")) ??
    buildExtrinsic(undefined, ref);
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/extrinsics/${ref}.json`,
        data.extrinsic?.observed_at ?? null,
      ),
    },
    "short",
  );
}
