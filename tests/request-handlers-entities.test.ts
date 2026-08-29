// Direct unit tests for workers/request-handlers/entities.ts (#1900).
// Imports every exported handler and exercises the null-safe D1 read path,
// query-param guards, and schema-stable cold-store contracts without routing
// through workers/api.ts.

import assert from "node:assert/strict";
import { visibleInWindow } from "./helpers/scan-window.ts";
import {
  forbiddenDataApi,
  lakehouse,
  LAKEHOUSE_ENV,
} from "./helpers/cold-tier-env.ts";
import { handleRequest } from "../workers/api.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

// Every hot-tier read in these handlers goes through readStore -> `new
// Client({ connectionString })` (#10179), and a handler is entered as
// `handler(request, env, ...)` -- there is no store parameter to inject. So the
// `pg` module is the seam; see tests/helpers/pg-mock.ts for why it is a module
// mock rather than a production export, and why the controller has to be built
// inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { CHAIN_CALL_MODULE_MAX_LENGTH } from "../src/route-limits.ts";
import { ALL_TABLES, pgMockEnv, toQuestionMarks } from "./helpers/pg-mock.ts";
import {
  buildSubnetMetagraph,
  buildSubnetValidators,
} from "../src/metagraph-neurons.ts";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import { type Row, type AnyFn, jsonBody } from "./row-type.ts";
import {
  CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY,
  CHAIN_DEREGISTRATIONS_PROJECTION_KEY,
} from "../src/chain-deregistrations-artifact.ts";
import { DEREGISTRATIONS_DEGRADED_NOT_DERIVED } from "../src/uncurated-event-streams.ts";
import {
  handleSubnetMetagraph,
  handleSubnetYield,
  handleNeuron,
  handleSubnetValidators,
  handleGlobalValidators,
  handleValidatorOperatorDirectory,
  handleValidatorDetail,
  handleValidatorNominators,
  handleAccountWeightSetters,
  handleSubnetWeightSetters,
  handleAccountRegistrations,
  handleAccountServing,
  handleAccountAxonRemovals,
  handleAccountPrometheus,
  handleAccountDeregistrations,
  handleValidatorHistory,
  handleNeuronHistory,
  handleSubnetHistory,
  handleSubnetIdentityHistory,
  handleSubnetHyperparams,
  handleSubnetHyperparamsHistory,
  handleSubnetConcentration,
  handleSubnetPerformance,
  handleChainConcentration,
  handleChainConcentrationSubnets,
  handleChainPerformance,
  handleChainYield,
  handleSelfHealth,
  handleAccountPortfolio,
  handleAccountPositions,
  handleAccountsList,
  handleAccountHolderDirectory,
  handleSubnetConcentrationHistory,
  handleSubnetPerformanceHistory,
  handleSubnetYieldHistory,
  handleChainTurnover,
  handleSubnetTurnover,
  handleSubnetStakeFlow,
  handleSubnetWeights,
  handleSubnetAlphaVolume,
  handleSubnetServing,
  handleSubnetPrometheus,
  handleSubnetStakeMoves,
  handleSubnetStakeTransfers,
  handleSubnetRegistrations,
  handleSubnetAxonRemovals,
  handleSubnetDeregistrations,
  handleSubnetMovers,
  handleAccount,
  handleAccountEvents,
  handleAccountHistory,
  handleAccountExtrinsics,
  handleAccountTransfers,
  handleAccountCounterparties,
  handleAccountStakeFlow,
  handleAccountStakeMoves,
  handleAccountSubnets,
  handleAccountPositionHistory,
  handleSubnetEventSummary,
  handleSubnetEvents,
  handleAccountBalance,
  handleAccountIdentity,
  handleAccountIdentityHistory,
  handleBlocks,
  handleBlock,
  handleBlockExtrinsics,
  handleBlockEvents,
  handleBlocksSummary,
  handleSudo,
  handleGovernanceConfigChanges,
  handleRuntime,
  handleExtrinsics,
  handleExtrinsic,
  canonicalSubnetHistoryCachePath,
  canonicalChainRevenueCoverageCachePath,
  canonicalSubnetTurnoverCachePath,
  canonicalSubnetStakeFlowCachePath,
  canonicalSubnetWeightsCachePath,
  canonicalSubnetServingCachePath,
  canonicalSubnetPrometheusCachePath,
  canonicalSubnetStakeMovesCachePath,
  canonicalSubnetStakeTransfersCachePath,
  canonicalSubnetRegistrationsCachePath,
  canonicalSubnetAxonRemovalsCachePath,
  canonicalSubnetDeregistrationsCachePath,
  canonicalSubnetMoversCachePath,
  canonicalSubnetMetagraphCachePath,
  canonicalSubnetValidatorsCachePath,
  canonicalGlobalValidatorsCachePath,
} from "../workers/request-handlers/entities.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const COUNTERPARTY = "5D7FVSM1fJM56zHJuMBuQ5LH32mkLni52JonoeppFrezvyHy";
const HASH = `0x${"a".repeat(64)}`;
const NETUID = 7;
const UID = 3;
const BLOCK_NUM = 1234;
const OBSERVED_AT = 1_750_009_000_000;

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

/**
 * Drive a path the way a request arrives.
 *
 * Query-parameter validation is the ROUTER's, once, against the route's own
 * Zod schema (#10218) -- so a handler called directly no longer refuses a bad
 * value, and asserting that it does would assert a property the surface does
 * not have. These tests want to know what a CALLER gets, which is unchanged.
 */
function viaRouter(path: string) {
  return handleRequest(
    new Request(`https://api.metagraph.sh${path}`),
    {} as never,
    {} as never,
  );
}

async function json(res: Response): Promise<Row> {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await jsonBody(res);
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res: Response): Promise<Row> {
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = await jsonBody(res);
  assert.equal(body.ok, false);
  return body;
}

function emptyEnv(): Row {
  return {};
}

/**
 * An env whose archive carries a chain-deregistrations projection (#9307):
 * one derived row for NETUID in the rollup object, and one displaced-hotkey
 * entry for SS58 in the split-out per-hotkey object.
 */
function deregistrationProjectionEnv(): Row {
  const derivation = {
    method: "uid-reuse",
    lookback_days: 30,
    window_registrations: 8064,
    unattributed_registrations: 1726,
    // #9708: the payload now says out loud what the docs always said.
    is_lower_bound: true,
  };
  const bodies: Record<string, unknown> = {
    [CHAIN_DEREGISTRATIONS_PROJECTION_KEY]: {
      schema_version: 1,
      lookback_days: 30,
      windows: {
        "7d": {
          days: 7,
          network: {
            distinct_deregistered_hotkeys: 4989,
            newest_observed: 1_785_784_392_000,
          },
          rows: [
            {
              netuid: NETUID,
              deregistrations: 441,
              distinct_deregistered_hotkeys: 432,
              newest_observed: 1_785_784_392_000,
            },
          ],
          derivation,
        },
      },
    },
    [CHAIN_DEREGISTRATIONS_HOTKEY_PROJECTION_KEY]: {
      schema_version: 1,
      lookback_days: 30,
      windows: {
        "30d": {
          days: 30,
          hotkeys: {
            [SS58]: [[NETUID, 2, 1_785_700_000_000, 1_785_784_392_000]],
          },
          derivation,
        },
      },
    },
  };
  return {
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (!Object.hasOwn(bodies, key)) return null;
        return { json: async () => bodies[key] };
      },
    },
  };
}

// ---- Fixture rows (stable shapes matching D1 column contracts) ----------------

function neuronRow(overrides = {}) {
  return {
    uid: UID,
    hotkey: SS58,
    coldkey: "5ColdkeyExample123456789012345678901234567890",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    validator_trust: 0.8,
    consensus: 0.7,
    incentive: 0.6,
    dividends: 0.4,
    emission_tao: 1.23,
    stake_tao: 456.7,
    registered_at_block: 100,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: OBSERVED_AT,
    ...overrides,
  };
}

function accountEventRow(overrides = {}) {
  return {
    block_number: BLOCK_NUM,
    event_index: 1,
    event_kind: "StakeAdded",
    hotkey: SS58,
    coldkey: null,
    netuid: NETUID,
    uid: UID,
    amount_tao: 1.5,
    alpha_amount: null,
    observed_at: OBSERVED_AT,
    extrinsic_index: 2,
    ...overrides,
  };
}

function transferEventRow(overrides = {}) {
  return accountEventRow({
    event_kind: "Transfer",
    hotkey: SS58,
    coldkey: "5RecipientExample123456789012345678901234567890",
    netuid: null,
    uid: null,
    amount_tao: 4.2,
    ...overrides,
  });
}

function extrinsicRow(overrides = {}) {
  return {
    block_number: BLOCK_NUM,
    extrinsic_index: 2,
    extrinsic_hash: HASH,
    signer: SS58,
    call_module: "SubtensorModule",
    call_function: "add_stake",
    call_args: null,
    fee_tao: 0.0125,
    success: 1,
    observed_at: OBSERVED_AT,
    ...overrides,
  };
}

function blockRow(overrides = {}) {
  return {
    block_number: BLOCK_NUM,
    block_hash: HASH,
    parent_hash: `0x${"b".repeat(64)}`,
    author: "5AuthorExample12345678901234567890123456789012",
    extrinsic_count: 5,
    event_count: 20,
    spec_version: 201,
    observed_at: OBSERVED_AT,
    ...overrides,
  };
}

function accountDayRow(overrides = {}) {
  return {
    day: "2026-06-24",
    netuid: NETUID,
    event_count: 12,
    event_kinds: "StakeAdded,WeightsSet",
    first_block: 4_000_100,
    last_block: 4_000_900,
    ...overrides,
  };
}

// `identityHistoryRow` went with the tests that used it (#10190).

function hyperparamsRow(overrides = {}) {
  return {
    block_number: 100,
    captured_at: OBSERVED_AT,
    kappa_ratio: 0.5,
    immunity_period: 7200,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 1,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 1,
    min_burn_tao: 0.001,
    max_burn_tao: 100,
    burn_half_life: 100_000,
    burn_increase_mult: 1,
    bonds_moving_avg_raw: 900_000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.1,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 3,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 1,
    min_childkey_take_ratio: 0,
    ...overrides,
  };
}

function hyperparamsHistoryRow(overrides = {}) {
  return {
    id: 10,
    block_number: 100,
    observed_at: OBSERVED_AT,
    kappa_ratio: 0.5,
    immunity_period: 7200,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 1,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 1,
    min_burn_tao: 0.001,
    max_burn_tao: 100,
    burn_half_life: 100_000,
    burn_increase_mult: 1,
    bonds_moving_avg_raw: 900_000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.1,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 3,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 1,
    min_childkey_take_ratio: 0,
    hyperparams_hash: "abc",
    ...overrides,
  };
}

/**
 * Every table these handlers may read, so readStore hands one of them a store.
 *
 * readStore is ALL-OR-NOTHING per reader: a reader whose tables are not every
 * one of them declared Neon's gets `undefined` and serves its schema-stable
 * empty, silently. The four names appended here are in both wrangler configs'
 * NEON_SOLE_STORE_TABLES and not (yet) in the helper's ALL_TABLES, and a
 * handler reading one of them would otherwise test nothing at all.
 */
const HANDLER_TABLES = [
  ...ALL_TABLES,
  "subnets",
  "surfaces",
  "providers",
  "surface_history",
];

beforeEach(() => {
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = null;
  pg.control.db = null;
});

// A store mock that routes SQL by regex patterns (order-sensitive: specific
// first). Named buckets let each handler test supply only the rows it needs.
function dbWith({
  neurons,
  neuronDailyUid,
  neuronDailySubnet,
  neuronDailyHistory,
  turnoverBounds,
  turnoverRows,
  stakeFlow,
  stakeMoves,
  stakeMovesPrices,
  agg,
  kinds,
  registrations,
  accountEvents,
  accountEventsDaily,
  subnetIdentityHistory,
  subnetHyperparams,
  subnetHyperparamsHistory,
  accountIdentity,
  accountIdentityHistory,
  transfers,
  relationshipTransfers,
  subnetEvents,
  subnetEventSummaryKinds,
  subnetEventSummaryRecent,
  blockEvents,
  extrinsicEvents,
  extrinsics,
  activity,
  modules,
  blocksFeed,
  blockDetail,
  blockNeighbors,
  blockNumberByHash,
  extrinsicDetail,
  captures,
}: Row = {}) {
  const cap = captures || { sql: [], params: [] };
  // The router is still written against the `?` placeholders every handler
  // emits; the store rewrites them to `$n` on the way out
  // (toPositionalPlaceholders), and toQuestionMarks below undoes exactly that
  // so ~40 patterns keep matching the statements they were written for.
  //
  // Respelling each pattern as `\$\d` instead would have been the same
  // conversion done forty times with forty chances to stop matching silently:
  // a pattern that misses falls through to `[]`, and a schema-stable empty is
  // what most of the assertions in this file are guarding against being
  // served -- so the miss would look like a pass.
  const answer = (sql: string): { results: unknown[] } => {
    // Block prev/next neighbor lookup (#1853).
    if (
      /SELECT MAX\(block_number\) FROM blocks WHERE block_number < \?/.test(sql)
    ) {
      return {
        results: [blockNeighbors || { prev: null, next: null }],
      };
    }
    // Subnet history: GROUP BY snapshot_date over neuron_daily.
    if (/GROUP BY snapshot_date/.test(sql)) {
      return { results: neuronDailySubnet || [] };
    }
    // Per-UID neuron_daily history.
    if (/FROM neuron_daily WHERE netuid = \? AND uid = \?/.test(sql)) {
      return { results: neuronDailyUid || [] };
    }
    // Turnover: MIN/MAX boundary-date probe (checked before the
    // generic `snapshot_date >=` history match below).
    if (/MIN\(snapshot_date\) AS start_date/.test(sql)) {
      return { results: turnoverBounds || [] };
    }
    // Turnover: the two boundary snapshots' rows.
    if (/FROM neuron_daily WHERE netuid = \? AND snapshot_date IN/.test(sql)) {
      return { results: turnoverRows || [] };
    }
    // Raw per-day neuron_daily rows (concentration history).
    if (
      /FROM neuron_daily WHERE netuid = \? AND snapshot_date >= \?/.test(sql)
    ) {
      return { results: neuronDailyHistory || [] };
    }
    // Net stake flow: SUM(amount_tao) over stake kinds
    // (checked before the generic event_kind aggregate below).
    if (/SUM\(amount_tao\)/.test(sql) && /event_kind IN \(/.test(sql)) {
      return { results: stakeFlow || [] };
    }
    // Account stake-movement footprint: GROUP BY netuid over StakeMoved.
    if (
      /COUNT\(\*\) AS movements/.test(sql) &&
      /event_kind = \?/.test(sql) &&
      /GROUP BY netuid/.test(sql)
    ) {
      return { results: stakeMoves || [] };
    }
    // Price-at-tx enrichment follow-up: subnet_snapshots.alpha_price_tao
    // lookup for the stake-moves rows' (netuid, last-moved-date) pairs.
    if (/FROM subnet_snapshots/.test(sql)) {
      return { results: stakeMovesPrices || [] };
    }
    // Account summary aggregates (order matters).
    if (
      /GROUP BY event_kind ORDER BY event_count DESC/.test(sql) &&
      /observed_at >= \?/.test(sql)
    ) {
      return { results: subnetEventSummaryKinds || [] };
    }
    if (
      /FROM account_events WHERE netuid = \? AND observed_at >= \?/.test(sql) &&
      /ORDER BY block_number DESC, event_index DESC LIMIT \?/.test(sql)
    ) {
      return { results: subnetEventSummaryRecent || [] };
    }
    if (/GROUP BY event_kind/.test(sql)) {
      return { results: kinds || [] };
    }
    if (/GROUP BY call_module/.test(sql)) {
      return { results: modules || [] };
    }
    if (/AS tx_count/.test(sql)) {
      return { results: activity ? [activity] : [] };
    }
    if (/COUNT\(\*\) AS c\b/.test(sql)) {
      return { results: agg ? [agg] : [] };
    }
    // Account per-day rollup (#1854).
    if (/FROM account_events_daily/.test(sql)) {
      return { results: accountEventsDaily || [] };
    }
    // Subnet on-chain identity history (#1647).
    if (/FROM subnet_identity_history/.test(sql)) {
      return { results: subnetIdentityHistory || [] };
    }
    // Historical hyperparameter change tracking (#4309).
    if (/FROM subnet_hyperparams_history/.test(sql)) {
      return { results: subnetHyperparamsHistory || [] };
    }
    // Subnet hyperparameters, latest-only (#4307/1.4).
    if (/FROM subnet_hyperparams WHERE netuid = \?/.test(sql)) {
      return { results: subnetHyperparams || [] };
    }
    // Personal chain identity, latest-only (epic #4301/5.4) —
    // checked before the history branch below (both match
    // "account_identity" but this one is NOT the _history table).
    if (/FROM account_identity WHERE account = \?/.test(sql)) {
      return { results: accountIdentity || [] };
    }
    // Personal chain identity diff-tracking history (epic #4301/5.2).
    if (/FROM account_identity_history/.test(sql)) {
      return { results: accountIdentityHistory || [] };
    }
    // Extrinsic-emitted events embed (#1849) — before generic events.
    if (
      /FROM account_events WHERE block_number = \? AND extrinsic_index = \?/.test(
        sql,
      )
    ) {
      return { results: extrinsicEvents || [] };
    }
    // Block-scoped events (natural event_index ASC order).
    if (
      /FROM account_events WHERE block_number = \? ORDER BY event_index ASC/.test(
        sql,
      )
    ) {
      return { results: blockEvents || [] };
    }
    // Account/counterparty pair detail: two indexed pair seeks
    // (forward + reverse), then one bounded newest-first merge.
    if (
      /UNION ALL/.test(sql) &&
      /event_kind = 'Transfer' AND hotkey = \? AND coldkey = \?/.test(sql)
    ) {
      return { results: relationshipTransfers || [] };
    }
    // Native transfer feed.
    if (/event_kind = 'Transfer'/.test(sql)) {
      return { results: transfers || [] };
    }
    // Per-subnet event stream (netuid filter; SELECT lists hotkey
    // as a column so match the WHERE clause, not the column name).
    if (
      /FROM account_events WHERE netuid = \?/.test(sql) &&
      !/\(hotkey = \?/.test(sql)
    ) {
      return { results: subnetEvents || [] };
    }
    // Account events (hotkey OR coldkey union).
    if (/FROM account_events/.test(sql)) {
      return { results: accountEvents || [] };
    }
    // Ref → block_number resolution for block extrinsics/events.
    if (/SELECT block_number FROM blocks WHERE block_hash = \?/.test(sql)) {
      if (blockNumberByHash != null) {
        return { results: [{ block_number: blockNumberByHash }] };
      }
      if (blockDetail?.block_number != null) {
        return {
          results: [{ block_number: blockDetail.block_number }],
        };
      }
      return { results: [] };
    }
    if (/SELECT block_number FROM blocks WHERE block_number = \?/.test(sql)) {
      if (blockDetail?.block_number != null) {
        return {
          results: [{ block_number: blockDetail.block_number }],
        };
      }
      return { results: [] };
    }
    // Blocks keyset cursor feed.
    if (/WHERE block_number < \?/.test(sql)) {
      return { results: blocksFeed || [] };
    }
    // Block detail by hash or number.
    if (
      /FROM blocks WHERE block_hash = \?|FROM blocks WHERE block_number = \?/.test(
        sql,
      ) &&
      /BLOCK_READ|block_number, block_hash/.test(sql)
    ) {
      return { results: blockDetail ? [blockDetail] : [] };
    }
    // Extrinsic detail by hash.
    if (/WHERE extrinsic_hash = \?/.test(sql)) {
      return {
        results: extrinsicDetail ? [extrinsicDetail] : [],
      };
    }
    // Extrinsic detail by composite PK.
    if (/WHERE block_number = \? AND extrinsic_index = \?/.test(sql)) {
      return {
        results: extrinsicDetail ? [extrinsicDetail] : [],
      };
    }
    // Block extrinsics (extrinsic_index ASC).
    if (
      /FROM extrinsics WHERE block_number = \? ORDER BY extrinsic_index ASC/.test(
        sql,
      )
    ) {
      return { results: extrinsics || [] };
    }
    // Account-signed extrinsics or generic extrinsic feed.
    if (/FROM extrinsics/.test(sql)) {
      return { results: extrinsics || [] };
    }
    // Neurons: single UID lookup.
    if (/FROM neurons WHERE netuid = \? AND uid = \?/.test(sql)) {
      if (Array.isArray(neurons) && neurons.length === 1) {
        return { results: neurons };
      }
      return { results: neurons?.length ? [neurons[0]] : [] };
    }
    // Validators ranking (stake_tao DESC).
    if (/validator_permit = TRUE ORDER BY stake_tao DESC/.test(sql)) {
      const rows = neurons || [];
      return { results: rows };
    }
    // Metagraph / validator_permit filter / hotkey registrations.
    if (/FROM neurons/.test(sql)) {
      return { results: registrations ?? neurons ?? [] };
    }
    // Blocks OFFSET feed (after more-specific block queries).
    if (/FROM blocks/.test(sql)) {
      return { results: blocksFeed || [] };
    }
    return { results: [] };
  };
  pg.control.onQuery = (query) => {
    const sql = toQuestionMarks(query.text);
    cap.sql.push(sql);
    cap.params.push(query.values);
    // Assigned from inside the subscription, which fires BEFORE the double
    // consults `rows` -- that ordering is what lets one env answer each
    // statement differently, the way the per-SQL D1 fake did.
    pg.control.rows = answer(sql).results;
  };
  return {
    env: { ...pgMockEnv(HANDLER_TABLES) } as unknown as Row,
    captures: cap,
  };
}

async function assertColdSchema(handlerFn: AnyFn, ...args: unknown[]) {
  const res = await handlerFn(...args);
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.ok, true);
  return body;
}

async function assertValidComponent(componentName: string, data: unknown) {
  const generatedAt = "2026-06-24T12:00:00.000Z";
  const openapi = buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile({
    $id: `https://metagraph.sh/test/${componentName}.json`,
    components: openapi.components,
    $ref: `#/components/schemas/${componentName}`,
  });
  assert.equal(validate(data), true, ajv.errorsText(validate.errors));
}

// An env whose D1 read REJECTS (schema drift / "no such column" / connection
// failure). storeAll catches this and degrades to [] — the handler must stay 200 +
// schema-stable, never propagate the throw or 404. Bound (a real prepared
// statement chain) so .prepare().bind().all() exists and only .all() rejects.
function dbThrows(message = "no such column") {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error(message);
              },
            };
          },
        };
      },
    },
  };
}

describe("handleSubnetMetagraph", () => {
  test("rejects a validator_permit that is not `true`", async () => {
    // #10096: the published enum is ["true"] -- a presence flag -- and it was
    // not enforced. `?validator_permit=false` returned ALL 256 rows, which a
    // caller asking for non-permitted neurons reads as "none hold a permit".
    // Measured on SN1 before the fix: no filter 256, =true 10, =false 256,
    // =bogus 256.
    for (const value of ["false", "bogus", "1"]) {
      const path = `/api/v1/subnets/${NETUID}/metagraph?validator_permit=${value}`;
      const body = await errorJson(await viaRouter(path));
      assert.equal(body.error.code, "invalid_query", value);
      assert.equal(body.meta.parameter, "validator_permit", value);
    }
  });

  test("accepts validator_permit=true, the one value it publishes", async () => {
    // The other side: the published enum must name a value that works, or the
    // rejection above would just be a parameter nobody can use.
    const path = `/api/v1/subnets/${NETUID}/metagraph?validator_permit=true`;
    const res = await handleSubnetMetagraph(
      req(path),
      emptyEnv() as unknown as Env,
      NETUID,
      url(path),
    );
    assert.equal(res.status, 200);
  });

  test("returns schema-stable empty payload on a cold or unbound store", async () => {
    const body = await assertColdSchema(
      handleSubnetMetagraph,
      req(`/api/v1/subnets/${NETUID}/metagraph`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/metagraph`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.neuron_count, 0);
    assert.deepEqual(body.data.neurons, []);
    assert.equal(body.data.captured_at, null);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  // #9082: `fields=` narrows each neuron row. Exercised through the Postgres
  // tier because that is the only path that produces real rows to narrow.
  test("fields= narrows each row and echoes the projection in meta", async () => {
    const { env } = dbWith({ neurons: [] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json(buildSubnetMetagraph([neuronRow()], NETUID)),
    };
    const path = `/api/v1/subnets/${NETUID}/metagraph?fields=uid,hotkey`;
    const body = await json(
      await handleSubnetMetagraph(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.deepEqual(body.data.neurons, [{ uid: UID, hotkey: SS58 }]);
    // The envelope is untouched -- only the rows narrow.
    assert.equal(body.data.neuron_count, 1);
    assert.deepEqual(body.meta.projection, { fields: ["uid", "hotkey"] });
  });

  test("omitting fields= leaves the response and its meta exactly as before", async () => {
    const { env } = dbWith({ neurons: [] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json(buildSubnetMetagraph([neuronRow()], NETUID)),
    };
    const path = `/api/v1/subnets/${NETUID}/metagraph`;
    const body = await json(
      await handleSubnetMetagraph(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(Object.keys(body.data.neurons[0]).length > 2, true);
    assert.equal("projection" in body.meta, false);
  });

  test("an unsupported field is a 400 that names it, before any tier read", async () => {
    let fetched = false;
    const { env } = dbWith({ neurons: [] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      async fetch() {
        fetched = true;
        return Response.json({});
      },
    };
    const path = `/api/v1/subnets/${NETUID}/metagraph?fields=uid,stake`;
    const body = await errorJson(
      await handleSubnetMetagraph(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.error.code, "invalid_query");
    assert.match(body.error.message, /unsupported field for neurons: stake/);
    assert.equal(fetched, false);
  });

  // The reason the neuron routes resolve `fields` against NeuronSchema rather
  // than against the rows in hand: immunity_expires_at_block is emitted only
  // while a neuron is inside its immunity window, and it is still a legitimate
  // field to ask for when none of them is.
  test("a declared field absent from every row is accepted, not rejected", async () => {
    const { env } = dbWith({ neurons: [] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json(
          buildSubnetMetagraph([neuronRow({ is_immunity_period: 0 })], NETUID),
        ),
    };
    const path = `/api/v1/subnets/${NETUID}/metagraph?fields=uid,immunity_expires_at_block`;
    const res = await handleSubnetMetagraph(
      req(path),
      env as unknown as Env,
      NETUID,
      url(path),
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    // Present in the contract, absent on this row -- so it is simply not
    // emitted, rather than emitted as null.
    assert.deepEqual(body.data.neurons, [{ uid: UID }]);
  });
});

describe("handleSubnetYield", () => {
  test("returns schema-stable empty payload on a cold or unbound store", async () => {
    const body = await assertColdSchema(
      handleSubnetYield,
      req(`/api/v1/subnets/${NETUID}/yield`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.neuron_count, 0);
    assert.equal(body.data.subnet_yield, null);
    assert.deepEqual(body.data.neurons, []);
    assert.equal(body.data.captured_at, null);
    await assertValidComponent("SubnetYieldArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/yield.json`,
    );
    assert.equal(body.meta.source, "metagraph-snapshot");
  });
});

describe("handleNeuron", () => {
  test("rejects an unsupported fields= name with 400 (#9082)", async () => {
    const body = await errorJson(
      await handleNeuron(
        req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        emptyEnv() as unknown as Env,
        NETUID,
        UID,
        url(`/api/v1/subnets/${NETUID}/neurons/${UID}?fields=stake`),
      ),
    );
    assert.equal(body.error.code, "invalid_query");
    assert.match(body.error.message, /unsupported field for neuron: stake/);
  });

  test("returns schema-stable neuron:null on a cold or unbound store", async () => {
    const body = await assertColdSchema(
      handleNeuron,
      req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
      emptyEnv(),
      NETUID,
      UID,
      url(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.neuron, null);
    assert.equal(body.data.captured_at, null);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("missing UID row yields neuron:null (not 404)", async () => {
    const { env } = dbWith({ neurons: [] });
    const body = await json(
      await handleNeuron(
        req(`/api/v1/subnets/${NETUID}/neurons/999`),
        env as unknown as Env,
        NETUID,
        999,
        url(`/api/v1/subnets/${NETUID}/neurons/999`),
      ),
    );
    assert.equal(body.data.neuron, null);
  });
});

describe("handleSubnetValidators", () => {
  test("rejects an unsupported fields= name with 400 (#9082)", async () => {
    const path = `/api/v1/subnets/${NETUID}/validators?fields=stake`;
    const body = await errorJson(
      await handleSubnetValidators(
        req(path),
        emptyEnv() as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.error.code, "invalid_query");
    assert.match(body.error.message, /unsupported field for validators: stake/);
  });

  test("fields= narrows each validator row and echoes the projection (#9082)", async () => {
    const { env } = dbWith({ neurons: [] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json(buildSubnetValidators([neuronRow()], NETUID)),
    };
    const path = `/api/v1/subnets/${NETUID}/validators?fields=hotkey`;
    const body = await json(
      await handleSubnetValidators(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.deepEqual(body.data.validators, [{ hotkey: SS58 }]);
    assert.deepEqual(body.meta.projection, { fields: ["hotkey"] });
  });

  test("returns schema-stable empty validators on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetValidators,
      req(`/api/v1/subnets/${NETUID}/validators`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/validators`),
    );
    assert.equal(body.data.validator_count, 0);
    assert.deepEqual(body.data.validators, []);
  });

  test("moves a featured validator to the front (#5166, Postgres tier)", async () => {
    // This route has no `sort` param at all -- the overlay always applies to
    // its default stake-ranked view (see overlayFeaturedValidators).
    const env = {
      ...emptyEnv(),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            netuid: NETUID,
            validator_count: 2,
            captured_at: null,
            block_number: null,
            validators: [
              {
                uid: 0,
                hotkey: "hk-a",
                coldkey: null,
                active: true,
                validator_permit: true,
                rank: null,
                trust: null,
                validator_trust: null,
                consensus: null,
                incentive: null,
                dividends: null,
                emission_tao: null,
                stake_tao: 10,
                registered_at_block: null,
                is_immunity_period: false,
                axon: null,
                featured: false,
              },
              {
                uid: 1,
                hotkey: "hk-b",
                coldkey: null,
                active: true,
                validator_permit: true,
                rank: null,
                trust: null,
                validator_trust: null,
                consensus: null,
                incentive: null,
                dividends: null,
                emission_tao: null,
                stake_tao: 5,
                registered_at_block: null,
                is_immunity_period: false,
                axon: null,
                featured: true,
              },
            ],
          }),
      },
    };
    const res = await handleSubnetValidators(
      req(`/api/v1/subnets/${NETUID}/validators`),
      env as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/validators`),
    );
    const body = await json(res);
    assert.equal(body.data.validators[0].hotkey, "hk-b");
    assert.equal(body.data.validators[0].featured, true);
    assert.equal(body.data.validators[1].hotkey, "hk-a");
    await assertValidComponent("SubnetValidatorsArtifact", body.data);
  });
});

describe("handleGlobalValidators", () => {
  // workers/api.ts always resolves canonicalGlobalValidatorsCachePath(url)
  // first and short-circuits on its { response } before handleGlobalValidators
  // ever runs, so the router never reaches this guard with an invalid query.
  // It stays as defense in depth for any direct/non-cached caller, so cover it
  // directly here rather than only through the edge-cache route.

  test("returns schema-stable empty leaderboard on a cold store", async () => {
    const body = await assertColdSchema(
      handleGlobalValidators,
      req("/api/v1/validators"),
      emptyEnv(),
      url("/api/v1/validators"),
    );
    assert.deepEqual(body.data.validators, []);
  });

  function globalValidatorEntry(overrides = {}) {
    return {
      hotkey: "hk-a",
      featured: false,
      coldkey: null,
      coldkey_identity: null,
      coldkey_count: 0,
      subnet_count: 1,
      uid_count: 1,
      take: null,
      total_stake_tao: 0,
      root_stake_tao: 0,
      alpha_stake_tao: 0,
      total_emission_tao: 0,
      nominator_count: null,
      apy_estimate: null,
      apy_estimate_eligible_subnet_count: 0,
      realized_return_1d: null,
      realized_return_1d_as_of: null,
      realized_return_1w: null,
      realized_return_1w_as_of: null,
      realized_return_1m: null,
      realized_return_1m_as_of: null,
      stake_dominance: null,
      avg_validator_trust: null,
      max_validator_trust: null,
      latest_captured_at: null,
      latest_block_number: null,
      subnets: [],
      ...overrides,
    };
  }

  test("moves a featured validator to the front on the default (unsorted) view (#5166, Postgres tier)", async () => {
    const env = {
      ...emptyEnv(),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            sort: "subnet_count",
            limit: 20,
            captured_at: null,
            block_number: null,
            validator_count: 2,
            validators: [
              globalValidatorEntry({ hotkey: "hk-a", featured: false }),
              globalValidatorEntry({ hotkey: "hk-b", featured: true }),
            ],
          }),
      },
    };
    const res = await handleGlobalValidators(
      req("/api/v1/validators"),
      env as unknown as Env,
      url("/api/v1/validators"),
    );
    const body = await json(res);
    assert.equal(body.data.validators[0].hotkey, "hk-b");
    assert.equal(body.data.validators[0].featured, true);
    assert.equal(body.data.validators[1].hotkey, "hk-a");
    await assertValidComponent("GlobalValidatorsArtifact", body.data);
  });

  test("does NOT reorder an explicit, non-default ?sort= -- `featured` stays present (#5166)", async () => {
    const env = {
      ...emptyEnv(),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            sort: "total_stake",
            limit: 20,
            captured_at: null,
            block_number: null,
            validator_count: 2,
            validators: [
              globalValidatorEntry({ hotkey: "hk-a", featured: false }),
              globalValidatorEntry({ hotkey: "hk-b", featured: true }),
            ],
          }),
      },
    };
    const res = await handleGlobalValidators(
      req("/api/v1/validators?sort=total_stake"),
      env as unknown as Env,
      url("/api/v1/validators?sort=total_stake"),
    );
    const body = await json(res);
    // The caller's explicit ranking is untouched...
    assert.equal(body.data.validators[0].hotkey, "hk-a");
    assert.equal(body.data.validators[1].hotkey, "hk-b");
    // ...but the badge-driving flag is still on every row.
    assert.equal(body.data.validators[0].featured, false);
    assert.equal(body.data.validators[1].featured, true);
  });
});

describe("handleValidatorOperatorDirectory", () => {
  test("returns a schema-stable empty directory on a cold store", async () => {
    const body = await assertColdSchema(
      handleValidatorOperatorDirectory,
      req("/api/v1/validators/operators"),
      emptyEnv(),
    );
    assert.equal(body.data.validator_count, 0);
    assert.equal(body.data.operator_count, 0);
    assert.deepEqual(body.data.operators, []);
    await assertValidComponent("ValidatorOperatorDirectoryArtifact", body.data);
  });

  test("forwards the grouped data-tier response without rebuilding it", async () => {
    const directory = {
      schema_version: 1,
      captured_at: "2026-08-29T00:00:00.000Z",
      block_number: 8_950_000,
      validator_count: 1,
      operator_count: 1,
      operators: [
        {
          identity_name: null,
          hotkeys: [],
          hotkey_count: 1,
          primary_hotkey: "hk-a",
          coldkey: "ck-a",
          total_stake_tao: 42,
          total_emission_tao: 1,
          nominator_count: null,
          membership_count: 2,
          uid_count: 2,
          take_min: null,
          take_max: null,
          apy_estimate: null,
          stake_dominance: 1,
        },
      ],
    };
    let forwardedPath = "";
    const env = {
      ...emptyEnv(),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        fetch: async (request: Request) => {
          forwardedPath = new URL(request.url).pathname;
          return Response.json(directory);
        },
      },
    };
    const body = await json(
      await handleValidatorOperatorDirectory(
        req("/api/v1/validators/operators"),
        env as unknown as Env,
      ),
    );
    assert.equal(forwardedPath, "/api/v1/validators/operators");
    assert.deepEqual(body.data, directory);
    await assertValidComponent("ValidatorOperatorDirectoryArtifact", body.data);
  });
});

describe("handleAccountHolderDirectory", () => {
  test("returns a schema-stable empty directory on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountHolderDirectory,
      req("/api/v1/accounts/directory"),
      emptyEnv(),
    );
    assert.equal(body.data.account_count, 0);
    assert.equal(body.data.priced_registered_stake_tao, 0);
    assert.deepEqual(body.data.rankings, {
      stake: [],
      emission: [],
      reach: [],
    });
    await assertValidComponent("AccountHolderDirectoryArtifact", body.data);
  });

  test("forwards the one-pass data-tier projection without rebuilding it", async () => {
    const directory = {
      schema_version: 1,
      captured_at: "2026-08-29T00:00:00.000Z",
      block_number: 8_950_000,
      account_count: 1,
      limit: 20,
      priced_registered_stake_tao: 42,
      rankings: { stake: [], emission: [], reach: [] },
    };
    let forwardedPath = "";
    const env = {
      ...emptyEnv(),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        fetch: async (request: Request) => {
          forwardedPath = new URL(request.url).pathname;
          return Response.json(directory);
        },
      },
    };
    const body = await json(
      await handleAccountHolderDirectory(
        req("/api/v1/accounts/directory"),
        env as unknown as Env,
      ),
    );
    assert.equal(forwardedPath, "/api/v1/accounts/directory");
    assert.deepEqual(body.data, directory);
    await assertValidComponent("AccountHolderDirectoryArtifact", body.data);
  });
});

describe("canonicalGlobalValidatorsCachePath", () => {
  test("an unsupported sort is the router's 400, not a cache key", async () => {
    // The helper used to re-check the enum and hand back its own 400. The
    // router parses the same request against the same schema first (#10060),
    // so the caller-visible answer is unchanged and the second check is gone.
    const res = await viaRouter("/api/v1/validators?sort=bogus");
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "sort");
  });

  test("omitted sort/limit and their explicit defaults produce the same cache key", () => {
    const omitted = canonicalGlobalValidatorsCachePath(
      url("/api/v1/validators"),
    );
    const explicit = canonicalGlobalValidatorsCachePath(
      url("/api/v1/validators?sort=subnet_count&limit=20"),
    );
    assert.equal(omitted.response, undefined);
    assert.equal(omitted.cachePathAndSearch, explicit.cachePathAndSearch);
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalGlobalValidatorsCachePath(
      url("/api/v1/validators?format=csv"),
    );
    assert.equal(
      csv.cachePathAndSearch,
      "/api/v1/validators?sort=subnet_count&limit=20&format=csv",
    );

    const csvAccept = new Request(
      "https://api.metagraph.sh/api/v1/validators",
      {
        headers: { accept: "text/csv" },
      },
    );
    const json = canonicalGlobalValidatorsCachePath(
      url("/api/v1/validators?format=json"),
      csvAccept as unknown as Parameters<
        typeof canonicalGlobalValidatorsCachePath
      >[1],
    );
    assert.equal(
      json.cachePathAndSearch,
      "/api/v1/validators?sort=subnet_count&limit=20",
    );
  });
});

describe("handleNeuronHistory", () => {
  test("rejects an invalid window param with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/neurons/${UID}/history?window=400d`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty points on a cold store", async () => {
    const body = await assertColdSchema(
      handleNeuronHistory,
      req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
      emptyEnv(),
      NETUID,
      UID,
      url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.uid, UID);
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.window, "30d");
  });
});

describe("handleSubnetHistory", () => {
  test("returns schema-stable empty series on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetHistory,
      req(`/api/v1/subnets/${NETUID}/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });

  test("uses the covering index for the aggregate history query plan", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE neuron_daily (
        netuid INTEGER NOT NULL,
        uid INTEGER NOT NULL,
        snapshot_date TEXT NOT NULL,
        hotkey TEXT,
        coldkey TEXT,
        active INTEGER,
        validator_permit INTEGER,
        rank REAL,
        trust REAL,
        validator_trust REAL,
        consensus REAL,
        incentive REAL,
        dividends REAL,
        emission_tao REAL,
        stake_tao REAL,
        registered_at_block INTEGER,
        is_immunity_period INTEGER,
        axon TEXT,
        block_number INTEGER,
        captured_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (netuid, uid, snapshot_date)
      );
      CREATE INDEX idx_neuron_daily_netuid_date_agg
        ON neuron_daily (netuid, snapshot_date, validator_permit, stake_tao, emission_tao);
    `);

    const sql =
      "SELECT snapshot_date, COUNT(*) AS neuron_count, " +
      "SUM(validator_permit) AS validator_count, " +
      "SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao " +
      "FROM neuron_daily WHERE netuid = ? GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ?";
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(NETUID, 400);

    assert.equal(plan.length, 1);
    assert.equal(
      plan[0].detail,
      "SEARCH neuron_daily USING COVERING INDEX idx_neuron_daily_netuid_date_agg (netuid=?)",
    );
    assert.equal(
      plan.some(({ detail }) => /TEMP B-TREE/.test(detail as string)),
      false,
    );
  });

  test("invalid window returns 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/history?window=bogus`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });
});

describe("handleSubnetIdentityHistory", () => {
  test("returns schema-stable empty entries on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetIdentityHistory,
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  // REMOVED (#10190): "happy path returns identity timeline rows". The rows came
  // from a DATA_API stub behind the retired METAGRAPH_SUBNET_IDENTITY_SOURCE, so
  // the "happy path" it described is one production never takes -- nothing writes
  // subnet_identity_history at all (#10710). The cold/empty shape this route really
  // serves is asserted by its siblings; restore a populated timeline with #10710.
});

describe("handleSubnetHyperparams", () => {
  // D1 retirement: subnet_hyperparams's D1 write/read path is retired
  // (workers/request-handlers/entities.ts's handleSubnetHyperparams no
  // longer queries the store at all), so this is now "Postgres unconfigured" rather
  // than "D1 queried but cold" -- same schema-stable null contract either way.
  test("returns schema-stable hyperparameters:null when Postgres is unconfigured", async () => {
    const body = await assertColdSchema(
      handleSubnetHyperparams,
      req(`/api/v1/subnets/${NETUID}/hyperparameters`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.hyperparameters, null);
    assert.equal(body.data.captured_at, null);
  });
});

describe("handleSubnetHyperparamsHistory", () => {
  // D1 retirement: same as handleSubnetHyperparams above -- no store fallback
  // left to query, so this is "Postgres unconfigured" rather than "the store is cold".
  test("returns schema-stable empty entries when Postgres is unconfigured", async () => {
    const body = await assertColdSchema(
      handleSubnetHyperparamsHistory,
      req(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });
});

describe("handleSubnetPerformance", () => {
  test("returns schema-stable null blocks on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetPerformance,
      req(`/api/v1/subnets/${NETUID}/performance`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.neuron_count, 0);
    assert.equal(body.data.incentive, null);
    assert.equal(body.data.trust, null);
  });
});

describe("handleSubnetConcentration", () => {
  test("returns schema-stable null blocks on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetConcentration,
      req(`/api/v1/subnets/${NETUID}/concentration`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.neuron_count, 0);
    assert.equal(body.data.stake, null);
    assert.equal(body.data.emission, null);
  });

  test("degrades to schema-stable null blocks when the store read throws", async () => {
    // A bound DB whose .all() rejects (schema drift) — storeAll swallows it to [],
    // so the handler still answers 200 with null metric blocks, never 5xx/404.
    const res = await handleSubnetConcentration(
      req(`/api/v1/subnets/${NETUID}/concentration`),
      dbThrows("no such column: validator_permit") as unknown as Env,
      NETUID,
    );
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.neuron_count, 0);
    assert.equal(body.data.stake, null);
    assert.equal(body.data.emission, null);
    assert.equal(body.data.validator_stake, null);
    assert.equal(body.data.captured_at, null);
  });
});

describe("handleSubnetConcentrationHistory", () => {
  test("rejects an out-of-range window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/concentration/history?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty series on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetConcentrationHistory,
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });

  test("degrades to an empty series when the store read throws", async () => {
    // storeAll swallows the rejecting read to []; the trend stays 200 + points:[].
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      dbThrows("store timeout") as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history?window=7d`),
    );
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });
});

describe("handleSubnetPerformanceHistory", () => {
  test("rejects an out-of-range window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/performance/history?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty series on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetPerformanceHistory,
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });

  test("degrades to an empty series when the store read throws", async () => {
    // storeAll swallows the rejecting read to []; the trend stays 200 + points:[].
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      dbThrows("store timeout") as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history?window=7d`),
    );
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });
});

describe("handleSubnetYieldHistory", () => {
  test("rejects an out-of-range window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/yield/history?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty series on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetYieldHistory,
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });

  test("degrades to an empty series when the store read throws", async () => {
    // storeAll swallows the rejecting read to []; the trend stays 200 + points:[].
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      dbThrows("store timeout") as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=7d`),
    );
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });
});

describe("handleSubnetTurnover", () => {
  test("returns schema-stable empty turnover on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetTurnover,
      req(`/api/v1/subnets/${NETUID}/turnover`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/turnover`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.comparable, false);
    assert.equal(body.data.validator_retention, null);
  });

  test("rejects an invalid changes flag with 400", async () => {
    const res = await handleSubnetTurnover(
      req(`/api/v1/subnets/${NETUID}/turnover`),
      emptyEnv() as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/turnover?changes=false`),
    );
    await errorJson(res);
  });

  test("changes=true returns schema-stable empty detail on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetTurnover,
      req(`/api/v1/subnets/${NETUID}/turnover`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/turnover?changes=true`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.comparable, false);
    assert.deepEqual(body.data.changes.validators_entered, []);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/turnover.json`,
    );
  });

  describe("canonicalChainRevenueCoverageCachePath", () => {
    const PATH = "/api/v1/chain/revenue-coverage";
    const at = (search = "") =>
      canonicalChainRevenueCoverageCachePath(
        new URL(`https://api.metagraph.sh${PATH}${search}`),
      );

    test("omitted window canonicalises to the default, so both share one entry", () => {
      // This route folds all 129 subnets together. Two keys for one answer
      // means folding them twice.
      assert.equal(at(), `${PATH}?window=1d`);
      assert.equal(at("?window=1d"), `${PATH}?window=1d`);
      assert.equal(at("?window=30d"), `${PATH}?window=30d`);
    });

    test("a REJECTED query passes through verbatim, never onto a valid key", () => {
      // Canonicalising an invalid query onto the default key would file the
      // 400 under the slot the good answer lives in -- and, worse, let the
      // rejected request be answered from a warm entry.
      assert.equal(at("?window=nonsense"), `${PATH}?window=nonsense`);
    });
  });

  describe("canonicalSubnetTurnoverCachePath", () => {
    test("omitted window and explicit ?window=30d produce the same cache key", () => {
      const noWindow = canonicalSubnetTurnoverCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/1/turnover"),
      );
      const explicit30d = canonicalSubnetTurnoverCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/turnover?window=30d",
        ),
      );
      assert.equal(noWindow, explicit30d);
      assert.equal(noWindow, "/api/v1/subnets/1/turnover?window=30d");
      const withChanges = canonicalSubnetTurnoverCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/turnover?changes=true",
        ),
      );
      assert.equal(
        withChanges,
        "/api/v1/subnets/1/turnover?window=30d&changes=true",
      );
    });

    test("preserves a non-default valid window label", () => {
      const key = canonicalSubnetTurnoverCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/1/turnover?window=7d"),
      );
      assert.equal(key, "/api/v1/subnets/1/turnover?window=7d");
    });

    test("accepts 1y window (parseHistoryWindow-only value, rejected by concentration parser)", () => {
      const key = canonicalSubnetTurnoverCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/1/turnover?window=1y"),
      );
      assert.equal(key, "/api/v1/subnets/1/turnover?window=1y");
    });

    test("returns raw search on an invalid window value", () => {
      const raw = "/api/v1/subnets/1/turnover?window=bogus";
      const key = canonicalSubnetTurnoverCachePath(
        new URL(`https://api.metagraph.sh${raw}`),
      );
      assert.equal(key, raw);
    });

    test("returns raw search on an unsupported query parameter", () => {
      const raw = "/api/v1/subnets/1/turnover?unknown=1";
      const key = canonicalSubnetTurnoverCachePath(
        new URL(`https://api.metagraph.sh${raw}`),
      );
      assert.equal(key, raw);
    });
  });

  describe("canonicalSubnetMetagraphCachePath", () => {
    test("a rejected validator_permit gets no cache slot of its own", () => {
      // `=false` used to share the bare path's slot, on the reading that it
      // meant "unfiltered". The route refuses it (#10060 aligned the published
      // enum with what #10096 made the server do), so it is a 400 rather than
      // a second spelling of the same answer -- and the helper falls through
      // to the raw path+search, which is what it does for every request the
      // router will refuse.
      const bare = canonicalSubnetMetagraphCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/1/metagraph"),
      );
      assert.equal(bare, "/api/v1/subnets/1/metagraph");
      const rejected = canonicalSubnetMetagraphCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/metagraph?validator_permit=false",
        ),
      );
      assert.equal(
        rejected,
        "/api/v1/subnets/1/metagraph?validator_permit=false",
      );
    });

    test("preserves validator_permit=true filter in the cache key", () => {
      const key = canonicalSubnetMetagraphCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/metagraph?validator_permit=true",
        ),
      );
      assert.equal(key, "/api/v1/subnets/1/metagraph?validator_permit=true");
    });

    test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
      const csv = canonicalSubnetMetagraphCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/metagraph?format=csv",
        ),
      );
      assert.equal(csv, "/api/v1/subnets/1/metagraph?format=csv");

      const filteredCsv = canonicalSubnetMetagraphCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/metagraph?validator_permit=true&format=csv",
        ),
      );
      assert.equal(
        filteredCsv,
        "/api/v1/subnets/1/metagraph?validator_permit=true&format=csv",
      );

      const csvAccept = new Request(
        "https://api.metagraph.sh/api/v1/subnets/1/metagraph",
        { headers: { accept: "text/csv" } },
      );
      const json = canonicalSubnetMetagraphCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/metagraph?format=json",
        ),
        csvAccept as unknown as Parameters<
          typeof canonicalSubnetMetagraphCachePath
        >[1],
      );
      assert.equal(json, "/api/v1/subnets/1/metagraph");
    });

    test("returns raw search on an unsupported query parameter", () => {
      const raw = "/api/v1/subnets/1/metagraph?unknown=1";
      const key = canonicalSubnetMetagraphCachePath(
        new URL(`https://api.metagraph.sh${raw}`),
      );
      assert.equal(key, raw);
    });
  });

  describe("canonicalSubnetValidatorsCachePath", () => {
    test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
      const csv = canonicalSubnetValidatorsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/validators?format=csv",
        ),
      );
      assert.equal(csv, "/api/v1/subnets/1/validators?format=csv");

      const csvAccept = new Request(
        "https://api.metagraph.sh/api/v1/subnets/1/validators",
        { headers: { accept: "text/csv" } },
      );
      const json = canonicalSubnetValidatorsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/validators?format=json",
        ),
        csvAccept as unknown as Parameters<
          typeof canonicalSubnetValidatorsCachePath
        >[1],
      );
      assert.equal(json, "/api/v1/subnets/1/validators");
    });
  });
});

describe("handleSubnetWeights", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(`/api/v1/subnets/${NETUID}/weights?window=1y`);
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetWeights,
      req(`/api/v1/subnets/${NETUID}/weights`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/weights?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_setters, 0);
    assert.equal(body.data.weight_sets, 0);
    assert.equal(body.data.sets_per_setter, null);
    await assertValidComponent("SubnetWeightsArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/weights.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetWeightsCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetWeightsCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/weights"),
      );
      const explicit = canonicalSubnetWeightsCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/weights?window=7d"),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/weights?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetWeightsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/weights?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/weights?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetWeightsCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/weights?bogus=1"),
      );
      assert.equal(path, "/api/v1/subnets/7/weights?bogus=1");
    });
  });
});

describe("handleSubnetServing", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(`/api/v1/subnets/${NETUID}/serving?window=1y`);
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetServing,
      req(`/api/v1/subnets/${NETUID}/serving`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/serving?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_servers, 0);
    assert.equal(body.data.announcements, 0);
    assert.equal(body.data.announcements_per_server, null);
    await assertValidComponent("SubnetServingArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/serving.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetServingCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetServingCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/serving"),
      );
      const explicit = canonicalSubnetServingCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/serving?window=7d"),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/serving?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetServingCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/serving?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/serving?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetServingCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/serving?bogus=1"),
      );
      assert.equal(path, "/api/v1/subnets/7/serving?bogus=1");
    });
  });
});

describe("handleSubnetPrometheus", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/prometheus?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetPrometheus,
      req(`/api/v1/subnets/${NETUID}/prometheus`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/prometheus?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_exporters, 0);
    assert.equal(body.data.announcements, 0);
    assert.equal(body.data.announcements_per_exporter, null);
    await assertValidComponent("SubnetPrometheusArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/prometheus.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetPrometheusCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetPrometheusCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/prometheus"),
      );
      const explicit = canonicalSubnetPrometheusCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/prometheus?window=7d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/prometheus?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetPrometheusCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/prometheus?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/prometheus?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetPrometheusCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/prometheus?bogus=1"),
      );
      assert.equal(path, "/api/v1/subnets/7/prometheus?bogus=1");
    });
  });
});

describe("handleSubnetStakeMoves", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/stake-moves?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetStakeMoves,
      req(`/api/v1/subnets/${NETUID}/stake-moves`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-moves?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_movers, 0);
    assert.equal(body.data.movements, 0);
    assert.equal(body.data.movements_per_mover, null);
    await assertValidComponent("SubnetStakeMovesArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/stake-moves.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetStakeMovesCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetStakeMovesCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/stake-moves"),
      );
      const explicit = canonicalSubnetStakeMovesCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-moves?window=7d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/stake-moves?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetStakeMovesCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-moves?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-moves?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetStakeMovesCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-moves?bogus=1",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-moves?bogus=1");
    });
  });
});

describe("handleSubnetStakeTransfers", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/stake-transfers?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetStakeTransfers,
      req(`/api/v1/subnets/${NETUID}/stake-transfers`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-transfers?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_senders, 0);
    assert.equal(body.data.transfers, 0);
    assert.equal(body.data.transfers_per_sender, null);
    await assertValidComponent("SubnetStakeTransfersArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/stake-transfers.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetStakeTransfersCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetStakeTransfersCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/stake-transfers"),
      );
      const explicit = canonicalSubnetStakeTransfersCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-transfers?window=7d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/stake-transfers?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetStakeTransfersCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-transfers?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-transfers?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetStakeTransfersCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-transfers?bogus=1",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-transfers?bogus=1");
    });
  });
});

describe("handleSubnetRegistrations", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/registrations?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetRegistrations,
      req(`/api/v1/subnets/${NETUID}/registrations`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/registrations?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_registrants, 0);
    assert.equal(body.data.registrations, 0);
    assert.equal(body.data.registrations_per_registrant, null);
    await assertValidComponent("SubnetRegistrationsArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/registrations.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetRegistrationsCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetRegistrationsCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/registrations"),
      );
      const explicit = canonicalSubnetRegistrationsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/registrations?window=7d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/registrations?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetRegistrationsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/registrations?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/registrations?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetRegistrationsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/registrations?bogus=1",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/registrations?bogus=1");
    });
  });
});

describe("handleSubnetAxonRemovals", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/axon-removals?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetAxonRemovals,
      req(`/api/v1/subnets/${NETUID}/axon-removals`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/axon-removals?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_removers, 0);
    assert.equal(body.data.removals, 0);
    assert.equal(body.data.removals_per_remover, null);
    await assertValidComponent("SubnetAxonRemovalsArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/axon-removals.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetAxonRemovalsCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetAxonRemovalsCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/axon-removals"),
      );
      const explicit = canonicalSubnetAxonRemovalsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/axon-removals?window=7d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/axon-removals?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetAxonRemovalsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/axon-removals?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/axon-removals?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetAxonRemovalsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/axon-removals?bogus=1",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/axon-removals?bogus=1");
    });
  });
});

describe("handleSubnetDeregistrations", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/deregistrations?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetDeregistrations,
      req(`/api/v1/subnets/${NETUID}/deregistrations`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/deregistrations?window=30d`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.distinct_deregistered_hotkeys, 0);
    assert.equal(body.data.deregistrations, 0);
    assert.equal(body.data.deregistrations_per_hotkey, null);
    await assertValidComponent("SubnetDeregistrationsArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/deregistrations.json`,
    );
    // account_events provenance (not the metagraph snapshot); null on a cold store.
    assert.equal(body.meta.generated_at, null);
    // #9307: that zero is not a measurement -- NeuronDeregistered has never
    // been emitted -- and nothing derived this window here, so it says so.
    assert.deepEqual(body.data.degraded, {
      reason: DEREGISTRATIONS_DEGRADED_NOT_DERIVED,
    });
  });

  test("serves the UID-reuse derivation when the projection carries it (#9307)", async () => {
    const res = await handleSubnetDeregistrations(
      req(`/api/v1/subnets/${NETUID}/deregistrations`),
      deregistrationProjectionEnv() as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/deregistrations?window=7d`),
    );
    const body = await json(res);
    assert.equal(body.data.deregistrations, 441);
    assert.equal(body.data.distinct_deregistered_hotkeys, 432);
    assert.equal(body.data.derivation.unattributed_registrations, 1726);
    // The floor is flagged in the payload, not only in the documentation
    // (#9708). Two mainnet subnets published a literal 0 against two dozen
    // registrations each, and a reader took that to mean "no churn".
    assert.equal(body.data.derivation.is_lower_bound, true);
    assert.equal(body.data.degraded, undefined);
    await assertValidComponent("SubnetDeregistrationsArtifact", body.data);
  });

  describe("canonicalSubnetDeregistrationsCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetDeregistrationsCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/deregistrations"),
      );
      const explicit = canonicalSubnetDeregistrationsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/deregistrations?window=7d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/deregistrations?window=7d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetDeregistrationsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/deregistrations?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/deregistrations?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetDeregistrationsCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/deregistrations?bogus=1",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/deregistrations?bogus=1");
    });
  });
});

describe("handleSubnetStakeFlow", () => {
  test("rejects an out-of-retention window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/stake-flow?window=1y`,
    );
    await errorJson(res);
  });

  test("rejects an unsupported direction enum value with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/stake-flow?direction=invalid`,
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "direction");
  });

  test("returns schema-stable zeros on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetStakeFlow,
      req(`/api/v1/subnets/${NETUID}/stake-flow`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-flow`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.total_staked_tao, 0);
    assert.equal(body.data.total_unstaked_tao, 0);
    assert.equal(body.data.net_flow_tao, 0);
    await assertValidComponent("SubnetStakeFlowArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/stake-flow.json`,
    );
    // account_events provenance, not the metagraph snapshot; null on a cold store.
    assert.equal(body.meta.source, "chain-events");
    assert.equal(body.meta.generated_at, null);
  });

  describe("canonicalSubnetStakeFlowCachePath", () => {
    test("canonicalizes omitted and explicit default window to one cache key", () => {
      const omitted = canonicalSubnetStakeFlowCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/stake-flow"),
      );
      const explicit = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=30d",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/stake-flow?window=30d");
    });

    test("passes an invalid window through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-flow?window=bogus");
    });

    test("passes an unsupported query param through unchanged (validation error)", () => {
      const path = canonicalSubnetStakeFlowCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/7/stake-flow?bogus=1"),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-flow?bogus=1");
    });

    test("passes an invalid direction through unchanged (the handler rejects it)", () => {
      const path = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?direction=bogus",
        ),
      );
      assert.equal(path, "/api/v1/subnets/7/stake-flow?direction=bogus");
    });

    test("canonicalizes omitted and explicit default direction to one cache key", () => {
      const omitted = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=30d",
        ),
      );
      const explicit = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=30d&direction=all",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(omitted, "/api/v1/subnets/7/stake-flow?window=30d");
    });

    test("includes direction=in|out in the cache key", () => {
      const inPath = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=7d&direction=in",
        ),
      );
      assert.equal(
        inPath,
        "/api/v1/subnets/7/stake-flow?window=7d&direction=in",
      );
      const outPath = canonicalSubnetStakeFlowCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/7/stake-flow?window=7d&direction=out",
        ),
      );
      assert.equal(
        outPath,
        "/api/v1/subnets/7/stake-flow?window=7d&direction=out",
      );
    });
  });
});

describe("handleSubnetMovers", () => {
  test("rejects an unsupported window with 400", async () => {
    const body = await errorJson(
      await viaRouter("/api/v1/subnets/movers?window=1y"),
    );
    assert.equal(body.meta.parameter, "window");
    assert.equal(
      body.error.message,
      'window must be one of: 7d, 30d, 90d. Received: "1y".',
    );
  });

  test("rejects an unsupported sort with 400", async () => {
    await errorJson(await viaRouter("/api/v1/subnets/movers?sort=bogus"));
  });

  test("rejects an out-of-range limit with 400", async () => {
    await errorJson(await viaRouter("/api/v1/subnets/movers?limit=0"));
  });

  test("returns a schema-stable empty leaderboard on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetMovers,
      req("/api/v1/subnets/movers"),
      emptyEnv(),
      url("/api/v1/subnets/movers"),
    );
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.sort, "stake");
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.movers, []);
    await assertValidComponent("SubnetMoversArtifact", body.data);
    assert.equal(body.meta.artifact_path, "/metagraph/subnets/movers.json");
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  describe("canonicalSubnetMoversCachePath", () => {
    test("canonicalizes omitted params to the full default cache key", () => {
      const omitted = canonicalSubnetMoversCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/movers"),
      );
      const explicit = canonicalSubnetMoversCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/movers?window=30d&sort=stake&limit=20",
        ),
      );
      assert.equal(omitted, explicit);
      assert.equal(
        omitted,
        "/api/v1/subnets/movers?window=30d&sort=stake&limit=20",
      );
    });

    test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
      const csv = canonicalSubnetMoversCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/movers?format=csv"),
      );
      assert.equal(
        csv,
        "/api/v1/subnets/movers?window=30d&sort=stake&limit=20&format=csv",
      );

      const csvAccept = new Request(
        "https://api.metagraph.sh/api/v1/subnets/movers",
        { headers: { accept: "text/csv" } },
      );
      const json = canonicalSubnetMoversCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/movers?format=json"),
        csvAccept as unknown as Parameters<
          typeof canonicalSubnetMoversCachePath
        >[1],
      );
      assert.equal(
        json,
        "/api/v1/subnets/movers?window=30d&sort=stake&limit=20",
      );
    });

    test("passes invalid params through unchanged (the handler rejects them)", () => {
      for (const q of ["?bogus=1", "?window=1y", "?sort=bogus", "?limit=0"]) {
        const path = canonicalSubnetMoversCachePath(
          new URL(`https://api.metagraph.sh/api/v1/subnets/movers${q}`),
        );
        assert.equal(path, `/api/v1/subnets/movers${q}`);
      }
    });
  });
});

describe("handleAccount", () => {
  test("returns schema-stable zero summary on a cold or unbound store", async () => {
    const body = await assertColdSchema(
      handleAccount,
      req(`/api/v1/accounts/${SS58}`),
      emptyEnv(),
      SS58,
    );
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.event_count, 0);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.registrations, []);
    assert.equal(body.data.activity.tx_count, 0);
    assert.deepEqual(body.data.labels, []);
    assert.equal(body.meta.source, "chain-events");
  });

  test("exposes x-metagraph-artifact-source matching meta.source", async () => {
    const res = await handleAccount(
      req(`/api/v1/accounts/${SS58}`),
      emptyEnv() as unknown as Env,
      SS58,
    );
    const body = await json(res);
    assert.equal(body.meta.source, "chain-events");
    assert.equal(
      res.headers.get("x-metagraph-artifact-source"),
      body.meta.source,
    );
  });

  test("304 still carries x-metagraph-artifact-source", async () => {
    const first = await handleAccount(
      req(`/api/v1/accounts/${SS58}`),
      emptyEnv() as unknown as Env,
      SS58,
    );
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const second = await handleAccount(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}`, {
        headers: { "if-none-match": etag },
      }),
      emptyEnv() as unknown as Env,
      SS58,
    );
    assert.equal(second.status, 304);
    assert.equal(
      second.headers.get("x-metagraph-artifact-source"),
      "chain-events",
    );
    assert.equal(second.headers.get("etag"), etag);
  });
});

describe("cold tier answers when Postgres misses (lakehouse-backed handlers)", () => {
  // One test per newly wired handler, all proving the same thing: with no
  // Postgres flag set and R2 SQL configured, the lakehouse answer flows
  // through the shared formatters into the response instead of the
  // schema-stable empty. globalThis.fetch is the R2 SQL transport, restored
  // after each test.
  const LAKE_ENV = { R2_SQL_TOKEN: "cfut_test" } as unknown as Env;
  const realFetch = globalThis.fetch;
  const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

  function lakeFetch(...responses: unknown[][]) {
    const queries: string[] = [];
    let call = 0;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const sql = String(JSON.parse(String(init.body)).query);
      queries.push(sql);
      const rows = visibleInWindow(
        sql,
        responses[Math.min(call, responses.length - 1)] ?? [],
      );
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return queries;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const SUDO_ROW = {
    block_number: 4200,
    extrinsic_index: 1,
    extrinsic_hash: "0x" + "e".repeat(64),
    signer: ADDR,
    call_module: "Sudo",
    call_function: "sudo",
    call_args: null,
    success: true,
    fee_tao: null,
    tip_tao: null,
    observed_at: 1_700_000_004_200,
  };
  const EVENT_ROW = {
    block_number: 4200,
    event_index: 0,
    extrinsic_index: 1,
    event_kind: "StakeAdded",
    hotkey: ADDR,
    coldkey: null,
    netuid: 7,
    uid: 3,
    amount_tao: 5000,
    alpha_amount: null,
    observed_at: 1_700_000_004_200,
  };

  test("handleSudo serves the Sudo-module feed from the lakehouse", async () => {
    const q = lakeFetch([SUDO_ROW]);
    const body = await json(
      await handleSudo(req("/api/v1/sudo"), LAKE_ENV, url("/api/v1/sudo")),
    );
    assert.equal(body.data.extrinsics.length, 1);
    assert.match(q[0]!, /call_module = 'Sudo'/);
  });

  test("handleGovernanceConfigChanges serves the AdminUtils feed", async () => {
    const q = lakeFetch([{ ...SUDO_ROW, call_module: "AdminUtils" }]);
    const body = await json(
      await handleGovernanceConfigChanges(
        req("/api/v1/governance/config-changes"),
        LAKE_ENV,
        url("/api/v1/governance/config-changes?success=true"),
      ),
    );
    assert.equal(body.data.extrinsics.length, 1);
    assert.match(q[0]!, /call_module = 'AdminUtils'/);
    assert.match(q[0]!, /success = TRUE/);
  });

  test("handleBlockEvents serves one block's events from the lakehouse", async () => {
    const q = lakeFetch([EVENT_ROW]);
    const body = await json(
      await handleBlockEvents(
        req("/api/v1/blocks/4200/events"),
        LAKE_ENV,
        "4200",
        url("/api/v1/blocks/4200/events"),
      ),
    );
    assert.equal(body.data.events.length, 1);
    assert.equal(body.data.block_number, 4200);
    assert.match(q[0]!, /ORDER BY event_index ASC/);
  });

  test("handleAccountEvents serves the account feed from the lakehouse", async () => {
    // DISTINCT WINDOWS, not one response replayed. The reader steps down the
    // block range until the page fills, and lakeFetch now honours that bound
    // (tests/helpers/scan-window.ts) -- so this row is visible in exactly the
    // window that contains block 4200 and nowhere else, which is what a real
    // lakehouse does. Before the stub understood the bound, the same fixture
    // came back once per window and the test had to pad with an empty response.
    const q = lakeFetch([EVENT_ROW]);
    const body = await json(
      await handleAccountEvents(
        req(`/api/v1/accounts/${ADDR}/events`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/events?kind=StakeAdded`),
      ),
    );
    assert.equal(body.data.events.length, 1);
    // BY CONTENT, NOT POSITION: the head read now precedes the account read.
    const read = q.find((sql) => sql.includes("account_events"));
    assert.ok(read, `no account_events read among ${q.length} queries`);
    assert.match(read, /event_kind = 'StakeAdded'/);
    assert.match(read, new RegExp(`hotkey = '${ADDR}' OR coldkey = '${ADDR}'`));
  });

  const COUNTERPARTY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const TRANSFER_ROW = {
    ...EVENT_ROW,
    event_kind: "Transfer",
    coldkey: COUNTERPARTY,
    amount_tao: 2.5,
  };

  test("handleAccountTransfers serves the Transfer feed from the lakehouse", async () => {
    const q = lakeFetch([TRANSFER_ROW]);
    const body = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${ADDR}/transfers`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/transfers?direction=sent`),
      ),
    );
    assert.equal(body.data.transfer_count, 1);
    assert.equal(body.data.transfers[0].direction, "sent");
    assert.match(q[0]!, /event_kind = 'Transfer'/);
    assert.match(q[0]!, new RegExp(`hotkey = '${ADDR}'`));
  });

  test("handleAccountStakeFlow serves the windowed flow card from the lakehouse", async () => {
    const q = lakeFetch([
      {
        netuid: 7,
        event_kind: "StakeAdded",
        total_tao: "100",
        event_count: 2,
        last_observed: 1_700_000_004_200,
      },
    ]);
    const body = await json(
      await handleAccountStakeFlow(
        req(`/api/v1/accounts/${ADDR}/stake-flow`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/stake-flow?window=7d`),
      ),
    );
    assert.equal(body.data.total_staked_tao, 100);
    assert.equal(body.data.window, "7d");
    assert.match(q[0]!, /GROUP BY netuid, event_kind/);
  });

  test("handleAccountStakeMoves serves the movement card from the lakehouse", async () => {
    const q = lakeFetch([
      {
        netuid: 3,
        movements: "4",
        first_observed: 1_700_000_000_100,
        last_observed: 1_700_000_004_200,
      },
    ]);
    const body = await json(
      await handleAccountStakeMoves(
        req(`/api/v1/accounts/${ADDR}/stake-moves`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/stake-moves`),
      ),
    );
    assert.equal(body.data.total_movements, 4);
    assert.match(q[0]!, /event_kind = 'StakeMoved'/);
  });

  test("handleAccountRegistrations serves the registration card from the lakehouse", async () => {
    const q = lakeFetch([
      {
        netuid: 104,
        registrations: "3",
        first_observed: 1_783_319_088_000,
        last_observed: 1_783_386_048_000,
      },
    ]);
    const body = await json(
      await handleAccountRegistrations(
        req(`/api/v1/accounts/${ADDR}/registrations`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/registrations`),
      ),
    );
    assert.equal(body.data.total_registrations, 3);
    assert.match(q[0]!, /event_kind = 'NeuronRegistered'/);
    // Hotkey-only attribution: widening to the coldkey would credit an
    // operator with registrations made by every hotkey it funds.
    assert.doesNotMatch(q[0]!, /coldkey/);
  });

  test("handleAccountServing serves the serving card from the lakehouse", async () => {
    const q = lakeFetch([
      {
        netuid: 55,
        announcements: "3",
        first_observed: 1_784_016_000_001,
        last_observed: 1_785_342_888_001,
      },
    ]);
    const body = await json(
      await handleAccountServing(
        req(`/api/v1/accounts/${ADDR}/serving`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/serving`),
      ),
    );
    assert.equal(body.data.total_announcements, 3);
    assert.match(q[0]!, /event_kind = 'AxonServed'/);
    assert.doesNotMatch(q[0]!, /coldkey/);
  });

  test("handleAccountWeightSetters joins the D1 neuron slots into the lakehouse read", async () => {
    const q = lakeFetch([
      {
        netuid: 11,
        weight_sets: "6",
        first_observed: 1_700_000_000_100,
        last_observed: 1_700_000_004_200,
      },
    ]);
    // The slots leg reads `neurons` from the store; the counts leg reads the
    // lakehouse. Two sources, one card -- which is what the tuple IN list below
    // is the join between.
    pg.control.rows = [{ netuid: 11, uid: 4 }];
    const envWithD1 = {
      ...LAKE_ENV,
      ...pgMockEnv(["neurons"]),
    } as unknown as Env;
    const body = await json(
      await handleAccountWeightSetters(
        req(`/api/v1/accounts/${ADDR}/weight-setters`),
        envWithD1,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/weight-setters`),
      ),
    );
    assert.equal(body.data.total_weight_sets, 6);
    assert.match(q[0]!, /event_kind = 'WeightsSet'/);
    // A tuple IN list, not an OR chain -- one OR clause per slot exceeded R2
    // SQL's expression nesting limit (40018) for accounts on many subnets.
    assert.match(q[0]!, /\(netuid, uid\) IN \(\(11, 4\)\)/);
  });

  test("handleAccountCounterparties serves both modes from the lakehouse", async () => {
    lakeFetch([TRANSFER_ROW]);
    const list = await json(
      await handleAccountCounterparties(
        req(`/api/v1/accounts/${ADDR}/counterparties`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/accounts/${ADDR}/counterparties`),
      ),
    );
    assert.equal(list.data.counterparty_count, 1);
    assert.equal(list.data.counterparties[0].address, COUNTERPARTY);

    const q = lakeFetch([TRANSFER_ROW]);
    const drill = await json(
      await handleAccountCounterparties(
        req(`/api/v1/accounts/${ADDR}/counterparties`),
        LAKE_ENV,
        ADDR,
        url(
          `/api/v1/accounts/${ADDR}/counterparties?counterparty=${COUNTERPARTY}`,
        ),
      ),
    );
    assert.equal(drill.data.relationship.transfer_count, 1);
    assert.equal(drill.data.counterparties[0].sent_tao, 2.5);
    assert.match(
      q[0]!,
      new RegExp(`hotkey = '${ADDR}' AND coldkey = '${COUNTERPARTY}'`),
    );
  });

  test("handleValidatorNominators serves the nominator list from the lakehouse", async () => {
    const q = lakeFetch(
      [
        {
          coldkey: COUNTERPARTY,
          staked_tao: 40,
          unstaked_tao: 5,
          event_count: 4,
          last_observed: 1_785_544_524_000,
          net_staked_tao: 35,
          gross_staked_tao: 45,
        },
      ],
      // #9393: the loader also reads the TRUE distinct-coldkey count now -- the
      // leaderboard scan is bounded by LIMIT, so its length is the page size, not
      // the total, which is what used to ship as nominator_count.
      [{ c: 1 }],
    );
    const body = await json(
      await handleValidatorNominators(
        req(`/api/v1/validators/${ADDR}/nominators`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/validators/${ADDR}/nominators?sort=gross_staked`),
      ),
    );
    assert.equal(body.data.nominator_count, 1);
    assert.equal(body.data.nominators[0].coldkey, COUNTERPARTY);
    assert.equal(body.data.nominators[0].net_staked_tao, 35);
    assert.equal(body.data.sort, "gross_staked");
    assert.match(q[0]!, new RegExp(`hotkey = '${ADDR}'`));
    assert.match(q[0]!, /GROUP BY coldkey/);
    assert.equal(
      body.meta.generated_at,
      new Date(1_785_544_524_000).toISOString(),
    );
  });

  test("handleValidatorNominators forwards ?coldkey to the lakehouse predicate", async () => {
    const q = lakeFetch([]);
    await json(
      await handleValidatorNominators(
        req(`/api/v1/validators/${ADDR}/nominators`),
        LAKE_ENV,
        ADDR,
        url(`/api/v1/validators/${ADDR}/nominators?coldkey=${COUNTERPARTY}`),
      ),
    );
    assert.match(q[0]!, new RegExp(`coldkey = '${COUNTERPARTY}'`));
  });

  test("handleValidatorNominators keeps its empty envelope when the lakehouse declines too", async () => {
    // No Postgres flag and no R2 SQL token -- the local/CI and self-hosted
    // case. Both echoes of the requested sort still have to survive: the
    // supplied label, and the default when none was asked for.
    const coldEnv = {} as unknown as Env;
    const asked = await json(
      await handleValidatorNominators(
        req(`/api/v1/validators/${ADDR}/nominators`),
        coldEnv,
        ADDR,
        url(`/api/v1/validators/${ADDR}/nominators?sort=gross_staked`),
      ),
    );
    assert.equal(asked.data.nominator_count, 0);
    assert.deepEqual(asked.data.nominators, []);
    assert.equal(asked.data.sort, "gross_staked");
    assert.equal(asked.meta.generated_at, null);

    const defaulted = await json(
      await handleValidatorNominators(
        req(`/api/v1/validators/${ADDR}/nominators`),
        coldEnv,
        ADDR,
        url(`/api/v1/validators/${ADDR}/nominators`),
      ),
    );
    assert.equal(defaulted.data.sort, "net_staked");
    assert.equal(defaulted.data.window, "30d");
  });

  test("handleAccountPositions prices the lakehouse ledger off the neurons store", async () => {
    const q = lakeFetch([
      {
        hotkey: COUNTERPARTY,
        netuid: 18,
        share_fraction: 0.5,
        captured_at: 1_785_634_702_670,
      },
    ]);
    // Per statement, because the two legs must answer differently: the HOT
    // ledger is empty (this test is about the COLD one being served) and the
    // stake read is what prices it. One shared row set would let the hot leg
    // answer and the cold tier would never run.
    pg.control.answers = [
      { match: /FROM nominator_positions/i, rows: [] },
      {
        match: /FROM neurons/i,
        rows: [{ hotkey: COUNTERPARTY, netuid: 18, stake_tao: 100 }],
      },
    ];
    const envWithD1 = {
      ...LAKE_ENV,
      ...pgMockEnv(["neurons", "nominator_positions"]),
    } as unknown as Env;
    const body = await json(
      await handleAccountPositions(
        req(`/api/v1/accounts/${ADDR}/positions`),
        envWithD1,
        ADDR,
      ),
    );
    assert.equal(body.data.position_count, 1);
    assert.equal(body.data.positions[0].stake_tao, 50);
    assert.equal(body.data.total_stake_alpha, 50);
    assert.match(q[0]!, /FROM chain\.nominator_positions/);
    assert.match(q[0]!, new RegExp(`coldkey = '${ADDR}'`));
  });

  test("handleAccountPositions keeps the empty card when the stake leg is unreadable", async () => {
    // No D1 binding: the reader declines rather than pricing a partial set,
    // and the route serves the schema-stable empty it already had.
    lakeFetch([
      {
        hotkey: COUNTERPARTY,
        netuid: 18,
        share_fraction: 0.5,
        captured_at: 1_785_634_702_670,
      },
    ]);
    const body = await json(
      await handleAccountPositions(
        req(`/api/v1/accounts/${ADDR}/positions`),
        LAKE_ENV,
        ADDR,
      ),
    );
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_stake_alpha, 0);
  });
});

describe("handleAccountEvents", () => {
  test("rejects a non-integer block_start with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/events?block_start=abc`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/events?block_end=oops`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });

  test("rejects a malformed netuid with 400", async () => {
    const res = await viaRouter(`/api/v1/accounts/${SS58}/events?netuid=abc`);
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "netuid");
  });

  test("netuid absent leaves the feed unfiltered", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow()],
    });
    await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      env as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/events`),
    );
    assert.ok(
      captures.sql.every((s: string) => !/AND netuid = \?/.test(s)),
      "expected no netuid filter when param is absent",
    );
  });

  test("short-circuits an inverted block_start>block_end window before the store", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow()],
    });
    const body = await json(
      await handleAccountEvents(
        req(`/api/v1/accounts/${SS58}/events`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/events?block_start=500&block_end=100`),
      ),
    );
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
    assert.equal(captures.sql.length, 0);
  });

  test("returns schema-stable empty events on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountEvents,
      req(`/api/v1/accounts/${SS58}/events`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/events`),
    );
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
    assert.equal(body.data.next_cursor, null);
  });

  test("rejects an unknown event kind with 400", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow()],
    });
    const res = await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      env as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/events?kind=Nonexistent`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "kind");
    assert.match(body.error.message, /not a supported event kind/);
    assert.equal(captures.sql.length, 0);
  });
});

describe("handleAccountHistory", () => {
  test("rejects malformed from/to dates with 400", async () => {
    const res = await viaRouter(`/api/v1/accounts/${SS58}/history?from=June`);
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "from");
  });

  test("rejects malformed netuid filters with 400", async () => {
    // 9007199254740993 = Number.MAX_SAFE_INTEGER + 2: passes /^\d+$/ but loses
    // precision under Number(), so the safe-integer guard rejects it.
    // 70000 is past the u16 ceiling (#10075): a value no subnet can carry used
    // to come back 200 with an empty result, which reads as "no activity".
    for (const netuid of ["abc", "-1", "7.5", "9007199254740993", "70000"]) {
      const res = await viaRouter(
        `/api/v1/accounts/${SS58}/history?netuid=${netuid}`,
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "netuid");
    }
  });

  // A BLANK `?netuid=` is unscoped, not malformed (#10075). This route used to
  // be the only one of the four netuid-filtered feeds that rejected it: its
  // siblings all run parseNonNegativeIntParam, whose documented contract is
  // "absent/blank -> no filter". One mistake answered two different ways across
  // four routes is the defect, so they agree now.
  test("a blank netuid filters nothing rather than 400ing", async () => {
    const res = await handleAccountHistory(
      req(`/api/v1/accounts/${SS58}/history`),
      emptyEnv() as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/history?netuid=`),
    );
    assert.equal(res.status, 200);
  });

  test("returns schema-stable empty days on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountHistory,
      req(`/api/v1/accounts/${SS58}/history`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/history`),
    );
    assert.equal(body.data.day_count, 0);
    assert.deepEqual(body.data.days, []);
  });

  // D1 fully eliminated (2026-07-17): account_events_daily is Postgres-only
  // now, so ?netuid/?from/?to/?limit no longer drive a live D1 query -- a
  // Postgres-tier miss (the only path this handler has without
  // METAGRAPH_ACCOUNT_EVENTS_SOURCE=postgres) always returns the
  // schema-stable empty shape regardless of those filters. See "returns
  // schema-stable empty days on a cold store" above for that coverage.

  test("short-circuits an inverted from>to date window before the store", async () => {
    const { env, captures } = dbWith({ accountEventsDaily: [accountDayRow()] });
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/history?from=2026-06-30&to=2026-06-01`),
      ),
    );
    assert.equal(body.data.day_count, 0);
    assert.deepEqual(body.data.days, []);
    assert.equal(captures.sql.length, 0);
  });
});

describe("handleAccountExtrinsics", () => {
  test("returns schema-stable empty extrinsics on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountExtrinsics,
      req(`/api/v1/accounts/${SS58}/extrinsics`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/extrinsics`),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
  });

  test("rejects a non-integer block_start with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/extrinsics?block_start=abc`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/extrinsics?block_end=oops`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });

  test("short-circuits an inverted block_start>block_end window before the store", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    const body = await json(
      await handleAccountExtrinsics(
        req(`/api/v1/accounts/${SS58}/extrinsics`),
        env as unknown as Env,
        SS58,
        url(
          `/api/v1/accounts/${SS58}/extrinsics?block_start=500&block_end=100`,
        ),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
    assert.equal(body.data.next_cursor, null);
    assert.equal(captures.sql.length, 0);
  });
});

describe("handleAccountTransfers", () => {
  test("rejects an unsupported direction enum value with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/transfers?direction=invalid`,
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "direction");
  });

  test("rejects a non-integer block_start with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/transfers?block_start=abc`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/transfers?block_end=oops`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });

  test("short-circuits an inverted block_start>block_end window before the store", async () => {
    const { env, captures } = dbWith({ transfers: [transferEventRow()] });
    const body = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers?block_start=500&block_end=100`),
      ),
    );
    assert.equal(body.data.transfer_count, 0);
    assert.deepEqual(body.data.transfers, []);
    assert.equal(body.data.next_cursor, null);
    assert.equal(captures.sql.length, 0);
  });

  test("returns schema-stable empty transfers on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountTransfers,
      req(`/api/v1/accounts/${SS58}/transfers`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers`),
    );
    assert.equal(body.data.transfer_count, 0);
    assert.deepEqual(body.data.transfers, []);
  });
});

describe("handleAccountCounterparties", () => {
  test("rejects malformed and out-of-range limits before D1 work", async () => {
    // The message is the router's now, derived from the published bound rather
    // than typed beside it (#10060) -- same 400, same `parameter`, and still
    // before any read, because the router answers before dispatch.
    for (const limit of ["random_nonce", "Infinity", "0", "101", "10.5"]) {
      const res = await viaRouter(
        `/api/v1/accounts/${SS58}/counterparties?limit=${limit}`,
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "limit");
      assert.equal(
        body.error.message,
        `limit must be an integer between 1 and 100. Received: "${limit}".`,
      );
    }
  });

  test("returns schema-stable empty rollup on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountCounterparties,
      req(`/api/v1/accounts/${SS58}/counterparties`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/counterparties`),
    );
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.counterparty_count, 0);
    assert.deepEqual(body.data.counterparties, []);
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/counterparties?format=xml`,
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "format");
  });

  test("?format=csv exports the list-mode leaderboard as CSV", async () => {
    const { env } = dbWith({ accountEvents: [accountEventRow()] });
    // #10190: the tier this doubled is retired; the list mode reads the
    // lakehouse (loadAccountCounterpartiesColdTier). Doubled at that transport
    // and given raw TRANSFER rows, because the leaderboard below is what
    // buildCounterparties aggregates FROM them -- the retired tier handed the
    // finished leaderboard over, so the aggregation never ran in this test.
    const lake = lakehouse([
      {
        hotkey: SS58,
        coldkey: COUNTERPARTY,
        amount_tao: 4.2,
        block_number: BLOCK_NUM,
        event_index: 0,
        observed_at: 1_750_009_000_000,
      },
    ]);
    Object.assign(env, LAKEHOUSE_ENV);
    const res = await handleAccountCounterparties(
      req(`/api/v1/accounts/${SS58}/counterparties?format=csv`),
      env as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/counterparties?format=csv`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/csv/);
    assert.equal(
      await res.text(),
      [
        "address,sent_tao,received_tao,net_tao,transfer_count,last_block",
        `${COUNTERPARTY},4.2,0,'-4.2,1,${BLOCK_NUM}`,
      ].join("\r\n"),
    );
    lake.restore();
  });

  test("empty CSV export still emits the header row", async () => {
    const res = await handleAccountCounterparties(
      req(`/api/v1/accounts/${SS58}/counterparties?format=csv`),
      emptyEnv() as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/counterparties?format=csv`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/csv/);
    assert.equal(
      await res.text(),
      "address,sent_tao,received_tao,net_tao,transfer_count,last_block",
    );
  });

  test("?format=csv combined with counterparty is rejected, not silently ignored", async () => {
    const res = await handleAccountCounterparties(
      req(
        `/api/v1/accounts/${SS58}/counterparties?format=csv&counterparty=${COUNTERPARTY}`,
      ),
      emptyEnv() as unknown as Env,
      SS58,
      url(
        `/api/v1/accounts/${SS58}/counterparties?format=csv&counterparty=${COUNTERPARTY}`,
      ),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "format");
  });

  test("Accept: text/csv combined with counterparty is rejected the same as ?format=csv", async () => {
    const res = await handleAccountCounterparties(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/counterparties?counterparty=${COUNTERPARTY}`,
        { headers: { accept: "text/csv" } },
      ),
      emptyEnv() as unknown as Env,
      SS58,
      url(
        `/api/v1/accounts/${SS58}/counterparties?counterparty=${COUNTERPARTY}`,
      ),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "format");
  });
});

describe("handleAccountCounterparties relationship drilldown", () => {
  test("rejects malformed counterparty and limits before D1 work", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/counterparties?counterparty=not-ss58`,
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "counterparty");

    for (const limit of ["random_nonce", "Infinity", "0", "101", "10.5"]) {
      const rejected = await viaRouter(
        `/api/v1/accounts/${SS58}/counterparties?counterparty=${COUNTERPARTY}&limit=${limit}`,
      );
      const rejectedBody = await errorJson(rejected);
      assert.equal(rejectedBody.error.code, "invalid_query");
      assert.equal(rejectedBody.meta.parameter, "limit");
      assert.equal(
        rejectedBody.error.message,
        `limit must be an integer between 1 and 100. Received: "${limit}".`,
      );
    }
  });

  test("returns schema-stable empty pair detail on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountCounterparties,
      req(`/api/v1/accounts/${SS58}/counterparties`),
      emptyEnv(),
      SS58,
      url(
        `/api/v1/accounts/${SS58}/counterparties?counterparty=${COUNTERPARTY}`,
      ),
    );
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.counterparty_count, 0);
    assert.deepEqual(body.data.counterparties, []);
    assert.equal(body.data.relationship.counterparty, COUNTERPARTY);
    assert.equal(body.data.relationship.transfer_count, 0);
    assert.deepEqual(body.data.relationship.transfers, []);
  });
});

describe("handleAccountStakeFlow", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/stake-flow?window=1y`,
    );
    await errorJson(res);
  });

  test("rejects an unsupported direction enum value with 400 (#2694 parity)", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/stake-flow?direction=invalid`,
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "direction");
  });

  test("returns schema-stable zeros on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountStakeFlow,
      req(`/api/v1/accounts/${SS58}/stake-flow`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-flow`),
    );
    assert.equal(body.data.address, SS58);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.net_flow_tao, 0);
    assert.equal(body.data.subnet_count, 0);
    assert.equal(body.data.concentration, null);
    assert.equal(body.data.dominant_netuid, null);
    await assertValidComponent("AccountStakeFlowArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/accounts/${SS58}/stake-flow.json`,
    );
    assert.equal(body.meta.source, "chain-events");
    assert.equal(body.meta.generated_at, null);
  });
});

describe("handleAccountStakeMoves", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/accounts/${SS58}/stake-moves?window=1y`,
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable zeros on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountStakeMoves,
      req(`/api/v1/accounts/${SS58}/stake-moves`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-moves`),
    );
    assert.equal(body.data.address, SS58);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.total_movements, 0);
    assert.equal(body.data.subnet_count, 0);
    assert.equal(body.data.concentration, null);
    assert.equal(body.data.dominant_netuid, null);
    await assertValidComponent("AccountStakeMovesArtifact", body.data);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/accounts/${SS58}/stake-moves.json`,
    );
    assert.equal(body.meta.source, "chain-events");
    assert.equal(body.meta.generated_at, null);
  });
});

describe("handleAccountSubnets", () => {
  test("returns schema-stable empty subnets on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountSubnets,
      req(`/api/v1/accounts/${SS58}/subnets`),
      emptyEnv(),
      SS58,
    );
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
  });
});

describe("handleSubnetEvents", () => {
  test("returns schema-stable empty events on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetEvents,
      req(`/api/v1/subnets/${NETUID}/events`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
  });

  test("rejects an unknown event kind with 400", async () => {
    const res = await handleSubnetEvents(
      req(`/api/v1/subnets/${NETUID}/events`),
      emptyEnv() as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events?kind=Nonexistent`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "kind");
  });

  test("short-circuits an inverted block_start>block_end window before the store", async () => {
    const { env, captures } = dbWith({
      subnetEvents: [accountEventRow({ block_number: 500 })],
    });
    const body = await json(
      await handleSubnetEvents(
        req(`/api/v1/subnets/${NETUID}/events`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/events?block_start=500&block_end=100`),
      ),
    );
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
    assert.equal(body.data.next_cursor, null);
    assert.equal(captures.sql.length, 0);
  });

  test("rejects a non-integer block_start with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/events?block_start=abc`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/events?block_end=oops`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });
});

describe("handleSubnetEventSummary", () => {
  test("rejects an unsupported window with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/event-summary?window=365d`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("rejects an invalid recent-event limit with 400", async () => {
    const res = await viaRouter(
      `/api/v1/subnets/${NETUID}/event-summary?limit=0`,
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "limit");
  });

  test("returns schema-stable empty summary on a cold store", async () => {
    const body = await assertColdSchema(
      handleSubnetEventSummary,
      req(`/api/v1/subnets/${NETUID}/event-summary`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/event-summary`),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.total_events, 0);
    assert.deepEqual(body.data.categories, []);
    assert.deepEqual(body.data.event_kinds, []);
    assert.deepEqual(body.data.recent_events, []);
  });
});

describe("handleAccountBalance", () => {
  test("returns 400 for invalid ss58", async () => {
    const res = await handleAccountBalance(
      req("/api/v1/accounts/notanss58address/balance"),
      emptyEnv() as unknown as Env,
      "notanss58address",
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_ss58");
  });

  test("returns 400 for a too-short ss58", async () => {
    const short = "5" + "a".repeat(45);
    const res = await handleAccountBalance(
      req(`/api/v1/accounts/${short}/balance`),
      emptyEnv() as unknown as Env,
      short,
    );
    await errorJson(res);
  });

  test("cold env returns balance_tao:null without calling RPC", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error(
        "RPC must not be called when testing cold schema via KV miss",
      );
    };
    try {
      const body = await assertColdSchema(
        handleAccountBalance,
        req(`/api/v1/accounts/${SS58}/balance`),
        emptyEnv(),
        SS58,
      );
      assert.equal(body.data.ss58, SS58);
      assert.equal(body.data.balance_tao, null);
      assert.ok(body.data.queried_at);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("serves from KV cache hit without RPC", async () => {
    const cached = {
      schema_version: 1,
      ss58: SS58,
      balance_tao: 99.0,
      queried_at: "2026-06-25T00:00:00.000Z",
    };
    const origFetch = globalThis.fetch;
    let rpcCalled = false;
    globalThis.fetch = () => {
      rpcCalled = true;
      throw new Error("RPC should not run on KV hit");
    };
    try {
      const env = {
        METAGRAPH_CONTROL: {
          get: async () => cached,
        },
      };
      const body = await json(
        await handleAccountBalance(
          req(`/api/v1/accounts/${SS58}/balance`),
          env as unknown as Env,
          SS58,
        ),
      );
      assert.equal(body.data.balance_tao, 99.0);
      assert.equal(body.data.queried_at, "2026-06-25T00:00:00.000Z");
      assert.equal(rpcCalled, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("KV read failure falls through to null balance (no throw)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
    })) as unknown as typeof fetch;
    try {
      const env = {
        METAGRAPH_CONTROL: {
          get: async () => {
            throw new Error("kv down");
          },
        },
      };
      const body = await json(
        await handleAccountBalance(
          req(`/api/v1/accounts/${SS58}/balance`),
          env as unknown as Env,
          SS58,
        ),
      );
      assert.equal(body.data.balance_tao, null);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

function accountIdentityRow(overrides = {}) {
  return {
    account: SS58,
    name: "Example Team",
    url: "https://miao.example/",
    github: "https://github.com/miao-team/miao-repo",
    image: "https://miao.example/logo.png",
    discord: "examplehandle",
    description: "An example subnet operator.",
    additional: null,
    captured_at: OBSERVED_AT,
    ...overrides,
  };
}

describe("handleAccountIdentity", () => {
  test("has_identity is false on a cold store (schema-stable, never 404)", async () => {
    const body = await assertColdSchema(
      handleAccountIdentity,
      req(`/api/v1/accounts/${SS58}/identity`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/identity`),
    );
    assert.equal(body.data.account, SS58);
    assert.equal(body.data.has_identity, false);
  });

  test("happy path returns the account's identity", async () => {
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "data-api",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            account: SS58,
            has_identity: true,
            name: "Example Team",
          }),
      },
    };
    const body = await json(
      await handleAccountIdentity(
        req(`/api/v1/accounts/${SS58}/identity`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.has_identity, true);
    assert.equal(body.data.name, "Example Team");
  });
});

describe("handleAccountIdentityHistory", () => {
  test("returns schema-stable empty entries on a cold store", async () => {
    const body = await assertColdSchema(
      handleAccountIdentityHistory,
      req(`/api/v1/accounts/${SS58}/identity-history`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history`),
    );
    assert.equal(body.data.account, SS58);
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  test("happy path returns identity timeline rows", async () => {
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "data-api",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            account: SS58,
            entry_count: 1,
            limit: 20,
            offset: null,
            next_cursor: null,
            entries: [
              {
                observed_at: new Date(OBSERVED_AT).toISOString(),
                name: "Example Team",
                identity_hash: "abc",
              },
            ],
          }),
      },
    };
    const body = await json(
      await handleAccountIdentityHistory(
        req(`/api/v1/accounts/${SS58}/identity-history`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/identity-history?limit=20`),
      ),
    );
    assert.equal(body.data.entry_count, 1);
    assert.equal(body.data.entries[0].name, "Example Team");
    assert.equal(body.data.limit, 20);
  });
});

describe("handleBlocks", () => {
  test("returns schema-stable empty feed on a cold store", async () => {
    const body = await assertColdSchema(
      handleBlocks,
      req("/api/v1/blocks"),
      emptyEnv(),
      url("/api/v1/blocks"),
    );
    assert.equal(body.data.block_count, 0);
    assert.deepEqual(body.data.blocks, []);
    assert.equal(body.data.next_cursor, null);
  });

  test("Accept: text/csv negotiates CSV without an explicit format", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const res = await handleBlocks(
      new Request("https://api.metagraph.sh/api/v1/blocks", {
        headers: { accept: "text/csv" },
      }),
      env as unknown as Env,
      url("/api/v1/blocks"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/csv/);
  });

  test("JSON response varies on Accept for the CSV-negotiated blocks URL", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const res = await handleBlocks(
      new Request("https://api.metagraph.sh/api/v1/blocks", {
        headers: { accept: "application/json" },
      }),
      env as unknown as Env,
      url("/api/v1/blocks"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^application\/json/);
    assert.equal(res.headers.get("vary"), "Accept, Accept-Encoding");
  });

  test("adds one fresh response-level TAO/USD conversion to complete mainnet blocks", async () => {
    const { env } = dbWith({
      blocksFeed: [
        blockRow({
          decode_status: "complete",
          economic_activity_tao: "2.5",
          economics_complete: true,
        }),
      ],
    });
    const observedAt = new Date().toISOString();
    env.METAGRAPH_CONTROL = {
      get: async () => ({
        usd_per_tao: 240,
        observed_at: observedAt,
        block_number: 9_000_000,
        price_basis: "tao-usd-index",
      }),
    };

    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env as unknown as Env,
        url("/api/v1/blocks"),
      ),
    );

    assert.equal(body.data.blocks[0].economic_activity_tao, 2.5);
    assert.equal(body.data.blocks[0].economic_activity_usd, 600);
    assert.equal(body.data.blocks[0].usd_per_tao, 240);
    assert.equal(body.data.blocks[0].tao_usd_observed_at, observedAt);
    assert.equal(body.data.blocks[0].tao_usd_unavailable, undefined);
  });

  test("never applies the mainnet TAO/USD index to testnet blocks", async () => {
    const { env } = dbWith({
      blocksFeed: [
        blockRow({
          decode_status: "complete",
          economic_activity_tao: "2.5",
          economics_complete: true,
        }),
      ],
    });
    Object.assign(env, LAKEHOUSE_ENV);
    const kvKeys: string[] = [];
    env.METAGRAPH_CONTROL = {
      get: async (key: string) => {
        kvKeys.push(key);
        return {
          usd_per_tao: 240,
          observed_at: new Date().toISOString(),
          block_number: 9_000_000,
          price_basis: "tao-usd-index",
        };
      },
    };

    const cold = lakehouse([
      blockRow({
        decode_status: "complete",
        economic_activity_tao: "2.5",
        economics_complete: true,
      }),
    ]);
    try {
      const body = await json(
        await handleBlocks(
          req("/api/v1/testnet/blocks"),
          env as unknown as Env,
          url("/api/v1/testnet/blocks"),
          "testnet",
        ),
      );

      assert.equal(kvKeys.includes("tao-usd:current"), false);
      assert.equal(body.data.blocks[0].economic_activity_tao, 2.5);
      assert.equal(body.data.blocks[0].economic_activity_usd, null);
      assert.equal(body.data.blocks[0].usd_per_tao, null);
      assert.equal(body.data.blocks[0].tao_usd_unavailable, "no_index_reading");
    } finally {
      cold.restore();
    }
  });

  test("empty CSV export still emits the header row", async () => {
    const { env } = dbWith({ blocksFeed: [] });
    const res = await handleBlocks(
      req("/api/v1/blocks?format=csv"),
      env as unknown as Env,
      url("/api/v1/blocks?format=csv"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/csv/);
    assert.equal(
      await res.text(),
      "block_number,block_hash,parent_hash,author,extrinsic_count,event_count,spec_version,decode_status,native_transfer_tao,stake_flow_tao,economic_activity_tao,fee_tao,tip_tao,issuance_tao,subnet_ids,economic_activity_usd,usd_per_tao,tao_usd_block,tao_usd_observed_at,tao_usd_basis,tao_usd_unavailable,observed_at",
    );
  });

  test("?format=json keeps the JSON envelope even under Accept: text/csv", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const res = await handleBlocks(
      new Request("https://api.metagraph.sh/api/v1/blocks?format=json", {
        headers: { accept: "text/csv" },
      }),
      env as unknown as Env,
      url("/api/v1/blocks?format=json"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^application\/json/);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.data.blocks), true);
  });

  test("rejects an unsupported format value with 400", async () => {
    await errorJson(await viaRouter("/api/v1/blocks?format=xml"));
  });

  test("REJECTS a limit above the declared maximum (#9916)", async () => {
    // Was: clamped to 100 and answered 200, so a caller asking for 999 got
    // a short page with no signal that it was short.
    dbWith({ blocksFeed: [] });
    const res = await viaRouter("/api/v1/blocks?limit=999");
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.match(body.error.message, /between 1 and 100\./);
  });

  test("short-circuits impossible count floors before querying D1", async () => {
    const { env, captures } = dbWith({ blocksFeed: [blockRow()] });
    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env as unknown as Env,
        url("/api/v1/blocks?min_events=9007199254740991"),
      ),
    );
    assert.equal(body.data.block_count, 0);
    assert.deepEqual(body.data.blocks, []);
    assert.equal(captures.sql.length, 0);
  });

  test("short-circuits inverted block and time ranges before querying D1", async () => {
    const { env, captures } = dbWith({ blocksFeed: [blockRow()] });
    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env as unknown as Env,
        url("/api/v1/blocks?block_start=20&block_end=10&from=200&to=100"),
      ),
    );
    assert.equal(body.data.block_count, 0);
    assert.deepEqual(body.data.blocks, []);
    assert.equal(captures.sql.length, 0);
  });
});

describe("handleBlock", () => {
  test("returns schema-stable block:null on a cold store", async () => {
    const body = await assertColdSchema(
      handleBlock,
      req(`/api/v1/blocks/${BLOCK_NUM}`),
      emptyEnv(),
      String(BLOCK_NUM),
    );
    assert.equal(body.data.ref, String(BLOCK_NUM));
    assert.equal(body.data.block, null);
    assert.equal(body.data.prev_block_number, null);
    assert.equal(body.data.next_block_number, null);
  });

  test("keeps the short cache profile when the block is unknown", async () => {
    const res = await handleBlock(
      req(`/api/v1/blocks/${BLOCK_NUM}`),
      emptyEnv() as unknown as Env,
      String(BLOCK_NUM),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /max-age=60/);
    assert.equal(res.headers.get("x-metagraph-cache-profile"), "short");
  });

  test("prices a complete mainnet block without changing its chain-native total", async () => {
    const { env } = dbWith({
      blockDetail: blockRow(),
    });
    Object.assign(env, LAKEHOUSE_ENV);
    env.METAGRAPH_CONTROL = {
      get: async () => ({
        usd_per_tao: 200,
        observed_at: new Date().toISOString(),
        block_number: 9_000_000,
        price_basis: "tao-usd-index",
      }),
    };

    const cold = lakehouse([
      blockRow({
        decode_status: "complete",
        economic_activity_tao: "1.25",
        economics_complete: true,
      }),
    ]);
    try {
      const response = await handleBlock(
        req(`/api/v1/blocks/${BLOCK_NUM}`),
        env as unknown as Env,
        String(BLOCK_NUM),
      );
      const body = await json(response);

      assert.equal(body.data.block.economic_activity_tao, 1.25);
      assert.equal(body.data.block.economic_activity_usd, 250);
      assert.equal(body.data.block.usd_per_tao, 200);
      assert.equal(response.headers.get("x-metagraph-cache-profile"), "short");
    } finally {
      cold.restore();
    }
  });

  test("caches a settled unpriced historical block without live price metadata", async () => {
    const { env } = dbWith({ blockDetail: blockRow() });
    Object.assign(env, LAKEHOUSE_ENV);
    env.METAGRAPH_CONTROL = {
      get: async () => ({
        usd_per_tao: 200,
        observed_at: new Date().toISOString(),
        block_number: 9_000_000,
        price_basis: "tao-usd-index",
      }),
    };

    const cold = lakehouse([
      blockRow({
        decode_status: "unavailable",
        economic_activity_tao: null,
        economics_complete: false,
      }),
    ]);
    try {
      const response = await handleBlock(
        req(`/api/v1/blocks/${BLOCK_NUM}`),
        env as unknown as Env,
        String(BLOCK_NUM),
      );
      const body = await json(response);

      assert.equal(body.data.block.decode_status, "unavailable");
      assert.equal(body.data.block.economic_activity_tao, null);
      assert.equal(body.data.block.economic_activity_usd, null);
      assert.equal(body.data.block.usd_per_tao, null);
      assert.equal(body.data.block.tao_usd_observed_at, null);
      assert.equal(response.headers.get("x-metagraph-cache-profile"), "static");
      assert.match(response.headers.get("cache-control") || "", /max-age=600/);
    } finally {
      cold.restore();
    }
  });
});

describe("handleBlockExtrinsics", () => {
  test("returns schema-stable empty extrinsics on a cold store", async () => {
    const body = await assertColdSchema(
      handleBlockExtrinsics,
      req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
      emptyEnv(),
      String(BLOCK_NUM),
      url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
  });

  test("unknown numeric ref yields block_number:null + empty extrinsics", async () => {
    const { env } = dbWith({ blocksFeed: [], extrinsics: [] });
    const body = await json(
      await handleBlockExtrinsics(
        req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
        env as unknown as Env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
      ),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
  });

  test("unknown hash ref yields block_number:null + empty extrinsics", async () => {
    const unknown = `0x${"d".repeat(64)}`;
    const body = await assertColdSchema(
      handleBlockExtrinsics,
      req(`/api/v1/blocks/${unknown}/extrinsics`),
      emptyEnv(),
      unknown,
      url(`/api/v1/blocks/${unknown}/extrinsics`),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.extrinsic_count, 0);
  });
});

describe("handleBlockEvents", () => {
  test("returns schema-stable empty events on a cold store", async () => {
    const body = await assertColdSchema(
      handleBlockEvents,
      req(`/api/v1/blocks/${BLOCK_NUM}/events`),
      emptyEnv(),
      String(BLOCK_NUM),
      url(`/api/v1/blocks/${BLOCK_NUM}/events`),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
  });

  test("unknown numeric ref yields block_number:null + empty events", async () => {
    const { env } = dbWith({ blocksFeed: [], blockEvents: [] });
    const body = await json(
      await handleBlockEvents(
        req(`/api/v1/blocks/${BLOCK_NUM}/events`),
        env as unknown as Env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/events`),
      ),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
  });

  test("orphaned account_events rows do not bypass blocks existence check", async () => {
    const { env } = dbWith({ blockEvents: [accountEventRow()] });
    const body = await json(
      await handleBlockEvents(
        req(`/api/v1/blocks/${BLOCK_NUM}/events`),
        env as unknown as Env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/events`),
      ),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
  });

  test("unknown hash ref yields block_number:null + empty events", async () => {
    const unknown = `0x${"d".repeat(64)}`;
    const body = await assertColdSchema(
      handleBlockEvents,
      req(`/api/v1/blocks/${unknown}/events`),
      emptyEnv(),
      unknown,
      url(`/api/v1/blocks/${unknown}/events`),
    );
    assert.equal(body.data.block_number, null);
    assert.equal(body.data.event_count, 0);
  });
});

describe("handleExtrinsics", () => {
  test("rejects an over-length call_module, like its three sibling feeds", async () => {
    // #10096: /chain/calls, /chain/fees and /chain/signers have always
    // rejected a call_module over CHAIN_CALL_MODULE_MAX_LENGTH; this route
    // took the identical filter with no bound, so one value was a 400 on
    // three doors and a 200 on the fourth. Length taken from the constant, so
    // raising the cap moves the test with it rather than leaving it asserting
    // a number nobody enforces any more.
    const long = "A".repeat(CHAIN_CALL_MODULE_MAX_LENGTH + 1);
    const path = `/api/v1/extrinsics?call_module=${long}`;
    const res = await viaRouter(path);
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "call_module");
  });

  test("accepts a call_module at exactly the cap", async () => {
    // The other side: the bound is inclusive, so the published `maxLength` is
    // a value a caller may actually send.
    const atCap = "A".repeat(CHAIN_CALL_MODULE_MAX_LENGTH);
    const path = `/api/v1/extrinsics?call_module=${atCap}`;
    const res = await handleExtrinsics(
      req(path),
      emptyEnv() as unknown as Env,
      url(path),
    );
    assert.equal(res.status, 200);
  });

  test("returns schema-stable empty feed on a cold store", async () => {
    const body = await assertColdSchema(
      handleExtrinsics,
      req("/api/v1/extrinsics"),
      emptyEnv(),
      url("/api/v1/extrinsics"),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
    assert.equal(body.data.next_cursor, null);
  });

  test("rejects a non-boolean success value with 400 (#2575)", async () => {
    const { captures } = dbWith({ extrinsics: [] });
    const res = await viaRouter("/api/v1/extrinsics?success=1");
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "success");
    assert.match(body.error.message, /true, false/);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("rejects a malformed call_hash with 400 (#4322)", async () => {
    const { captures } = dbWith({ extrinsics: [] });
    const res = await viaRouter("/api/v1/extrinsics?call_hash=not-a-hash");
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "call_hash");
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("rejects call_hash without call_module to avoid unscoped JSON scans", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const hash = `0x${"c".repeat(64)}`;
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env as unknown as Env,
      url(`/api/v1/extrinsics?call_hash=${hash}`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "call_module");
    assert.equal(
      captures.sql.filter((sql: string) => /FROM extrinsics/.test(sql)).length,
      0,
    );
  });

  test("uses idx_extrinsics_module_block for module feed query plan", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE extrinsics (
        block_number INTEGER NOT NULL,
        extrinsic_index INTEGER NOT NULL,
        extrinsic_hash TEXT NOT NULL,
        signer TEXT,
        call_module TEXT,
        call_function TEXT,
        call_args TEXT,
        fee_tao REAL,
        success INTEGER,
        observed_at INTEGER,
        PRIMARY KEY (block_number, extrinsic_index)
      );
      CREATE INDEX IF NOT EXISTS idx_extrinsics_module_block
        ON extrinsics (call_module, block_number DESC, extrinsic_index DESC);
    `);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN " +
          "SELECT * FROM extrinsics WHERE call_module = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?",
      )
      .all("Balances", 10);

    assert.equal(plan.length, 1);
    assert.equal(
      plan[0].detail,
      "SEARCH extrinsics USING INDEX idx_extrinsics_module_block (call_module=?)",
    );
  });

  test("rejects malformed time filters with 400 (#2086)", async () => {
    const { captures } = dbWith({ extrinsics: [] });
    const res = await viaRouter("/api/v1/extrinsics?from=abc");
    await errorJson(res);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits impossible future time filters before the store", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env as unknown as Env,
        url("/api/v1/extrinsics?from=9007199254740991"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits an expired to< retention-floor window before the store", async () => {
    // to=2000 (1970 epoch) is below the retained hot window floor; every
    // candidate row would already be pruned, so never touch D1.
    const { env, captures } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env as unknown as Env,
        url("/api/v1/extrinsics?to=2000"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits an inverted from>to window before the store", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const now = Date.now();
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env as unknown as Env,
        url(`/api/v1/extrinsics?from=${now}&to=${now - 60_000}`),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits an inverted block_start>block_end window before the store", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env as unknown as Env,
        url("/api/v1/extrinsics?block_start=500&block_end=100"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
    assert.equal(captures.sql.length, 0);
  });

  test("REJECTS a limit above the declared maximum (#9916)", async () => {
    // Was: clamped to 100 and answered 200, so a caller asking for 500 got
    // a short page with no signal that it was short.
    dbWith({ extrinsics: [] });
    const res = await viaRouter("/api/v1/extrinsics?limit=500");
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.match(body.error.message, /between 1 and 100\./);
  });

  const EXTRINSICS_CSV_HEADER =
    "extrinsic_id,block_number,signer,call_module,call_function,success";

  test("Accept: text/csv negotiates CSV on the extrinsics feed", async () => {
    const { env } = dbWith({ extrinsics: [extrinsicRow()] });
    const res = await handleExtrinsics(
      new Request("https://api.metagraph.sh/api/v1/extrinsics?limit=10", {
        headers: { accept: "text/csv" },
      }),
      env as unknown as Env,
      url("/api/v1/extrinsics?limit=10"),
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type") || "",
      "text/csv; charset=utf-8",
    );
  });

  test("?format=csv emits a header-only export on a cold store", async () => {
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      emptyEnv() as unknown as Env,
      url("/api/v1/extrinsics?format=csv"),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(lines[0], EXTRINSICS_CSV_HEADER);
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const body = await errorJson(
      await viaRouter("/api/v1/extrinsics?format=pdf"),
    );
    assert.equal(body.meta.parameter, "format");
  });
});

describe("handleExtrinsic", () => {
  test("returns schema-stable extrinsic:null on a cold store", async () => {
    const body = await assertColdSchema(
      handleExtrinsic,
      req(`/api/v1/extrinsics/${HASH}`),
      emptyEnv(),
      HASH,
    );
    assert.equal(body.data.ref, HASH);
    assert.equal(body.data.extrinsic, null);
    assert.deepEqual(body.data.events, []);
  });

  test("malformed composite id yields extrinsic:null", async () => {
    const body = await json(
      await handleExtrinsic(
        req("/api/v1/extrinsics/not-a-valid-ref"),
        emptyEnv() as unknown as Env,
        "not-a-valid-ref",
      ),
    );
    assert.equal(body.data.extrinsic, null);
  });
});

describe("D1 -> Postgres serving-cutover flag (#4656 followup)", () => {
  // Shared across handleBlocks/handleBlock/handleExtrinsics/handleExtrinsic: a
  // per-tier env flag tries the DATA_API service binding first and falls back
  // to D1 on ANY failure (absent binding, network error, non-2xx, unparseable
  // body) -- never a client-facing error. dbWith(...) gives each test a D1
  // fixture distinguishable from the Postgres fixture, so passing tests prove
  // WHICH source actually served the response, not just that a 200 came back.
  function dataApi(response: Response) {
    return { fetch: async () => response };
  }

  /** Stub the lakehouse transport; answers each cold-tier query by SQL prefix. */
  function lakehouse(answer: (sql: string) => unknown[]) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const sql = String(JSON.parse(String(init.body)).query);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { rows: visibleInWindow(sql, answer(sql)) },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  const LAKEHOUSE_TOKEN = { R2_SQL_TOKEN: "cfut_test" };

  test("handleBlocks: the retired blocks flag is not consulted even when set", async () => {
    // No head-leg fixture: the lakehouse is then the only leg that can answer,
    // so the marker below identifies the source unambiguously.
    const { env } = dbWith({});
    env.METAGRAPH_BLOCKS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    Object.assign(env, LAKEHOUSE_TOKEN);
    const restore = lakehouse(() => [blockRow({ author: "cold-tier" })]);
    try {
      const body = await json(
        await handleBlocks(
          req("/api/v1/blocks"),
          env as unknown as Env,
          url("/api/v1/blocks"),
        ),
      );
      assert.deepEqual(tier.paths, []); // the dead tier read is gone
      assert.equal(body.data.blocks[0].author, "cold-tier"); // the lakehouse did
    } finally {
      restore();
    }
  });

  test("handleBlock: the retired blocks flag is not consulted even when set", async () => {
    const { env } = dbWith({ blockDetail: blockRow() });
    env.METAGRAPH_BLOCKS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    Object.assign(env, LAKEHOUSE_TOKEN);
    const restore = lakehouse(() => [{ ...blockRow(), author: "lakehouse" }]);
    try {
      const body = await json(
        await handleBlock(
          req(`/api/v1/blocks/${BLOCK_NUM}`),
          env as unknown as Env,
          String(BLOCK_NUM),
        ),
      );
      assert.deepEqual(tier.paths, []);
      assert.equal(body.data.block.author, "lakehouse");
    } finally {
      restore();
    }
  });

  test("handleExtrinsics: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env as unknown as Env,
        url("/api/v1/extrinsics"),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // ANY store read here is the HOT TIER's, never the retired one. This used
    // to assert `captures.sql` empty, which was INCIDENTAL rather than the
    // property under test: the lakehouse leg reads over `fetch`, so nothing
    // reached pg at all. The extrinsic feeds now try `chain_detail_extrinsics`
    // first, which is a legitimate store read that says nothing about the
    // retired flag -- so this asserts what the test is named for.
    for (const sql of captures.sql) {
      assert.match(String(sql), /FROM chain_detail_/, String(sql));
    }
  });

  test("handleExtrinsic: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ extrinsicDetail: extrinsicRow() });
    env.METAGRAPH_EXTRINSICS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleExtrinsic(
        req(`/api/v1/extrinsics/${HASH}`),
        env as unknown as Env,
        HASH,
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // The store read this used to assert AWAY is now the answer: the tier
    // short-circuited it, and with the tier gone the composer reads the store
    // itself. Asserting it happened is the honest inverse of the old claim.
    assert.ok(captures.sql.length > 0);
  });

  test("handleAccountEvents: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const path = `/api/v1/accounts/${SS58}/events`;
    const body = await json(
      await handleAccountEvents(
        req(path),
        env as unknown as Env,
        SS58,
        url(path),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  // #4771: neurons/neuron_daily's new Postgres tier, same shared-fallback
  // wiring as blocks/extrinsics/account_events above (METAGRAPH_NEURONS_SOURCE).
  test("handleSubnetMetagraph: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        netuid: NETUID,
        neuron_count: 99,
        captured_at: null,
        block_number: null,
        neurons: [],
      }),
    );
    const path = `/api/v1/subnets/${NETUID}/metagraph`;
    const body = await json(
      await handleSubnetMetagraph(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.data.neuron_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleNeuron: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        netuid: NETUID,
        captured_at: null,
        block_number: null,
        neuron: { ...neuronRow(), hotkey: "postgres-hotkey" },
      }),
    );
    const body = await json(
      await handleNeuron(
        req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        env as unknown as Env,
        NETUID,
        UID,
        url(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
      ),
    );
    assert.equal(body.data.neuron.hotkey, "postgres-hotkey");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 gap-closure: subnet_hyperparams/subnet_hyperparams_history's own
  // Postgres tier, own dedicated flag (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE)
  // since it has an independent write path from neurons/neuron_daily above.
  // D1 retirement: subnet_hyperparams's D1 write/read path is fully retired
  // now (no code path ever prepares D1 SQL for these two routes), so
  // `dbWith({subnetHyperparams: ...})` below only proves the D1 mock's rows
  // are never touched -- a Postgres failure falls back to the same
  // schema-stable null/empty shape a cold store returns, not to D1 data.
  test("handleSubnetHyperparams: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ subnetHyperparams: [hyperparamsRow()] });
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        netuid: NETUID,
        captured_at: null,
        block_number: null,
        hyperparameters: { tempo: 999 },
      }),
    );
    const path = `/api/v1/subnets/${NETUID}/hyperparameters`;
    const body = await json(
      await handleSubnetHyperparams(req(path), env as unknown as Env, NETUID),
    );
    assert.equal(body.data.hyperparameters.tempo, 999);
    // The hyperparameter DATA still comes entirely from the Postgres tier --
    // the one statement here is #10259's subnet_status lookup, which reads
    // subnet_lifecycle because the card is retained for deregistered subnets
    // rather than pruned. Asserted by SHAPE rather than as an empty list, so
    // this keeps saying "no tier query" instead of "no query at all".
    assert.equal(captures.sql.length, 1);
    assert.match(captures.sql[0], /FROM subnet_lifecycle/);
    assert.doesNotMatch(captures.sql[0], /subnet_hyperparams/);
  });

  test("handleSubnetHyperparams: flag=postgres falls back to schema-stable null on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/subnets/${NETUID}/hyperparameters`;
    const body = await json(
      await handleSubnetHyperparams(req(path), env as unknown as Env, NETUID),
    );
    assert.equal(body.data.hyperparameters, null);
    assert.equal(body.data.captured_at, null);
  });

  test("handleSubnetHyperparamsHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({
      subnetHyperparamsHistory: [hyperparamsHistoryRow()],
    });
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        netuid: NETUID,
        entry_count: 1,
        limit: null,
        offset: null,
        next_cursor: null,
        entries: [{ hyperparams_hash: "pg-hash" }],
      }),
    );
    const path = `/api/v1/subnets/${NETUID}/hyperparameters/history`;
    const body = await json(
      await handleSubnetHyperparamsHistory(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.data.entries[0].hyperparams_hash, "pg-hash");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetHyperparamsHistory: flag=postgres falls back to schema-stable empty on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/subnets/${NETUID}/hyperparameters/history`;
    const body = await json(
      await handleSubnetHyperparamsHistory(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  // #4832 gap-closure: account_identity/account_identity_history's new
  // Postgres tier, own dedicated flag (METAGRAPH_ACCOUNT_IDENTITY_SOURCE).
  test("handleAccountIdentity: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({
      accountIdentity: [accountIdentityRow()],
    });
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        account: SS58,
        has_identity: true,
        name: "Postgres Team",
      }),
    );
    const path = `/api/v1/accounts/${SS58}/identity`;
    const body = await json(
      await handleAccountIdentity(req(path), env as unknown as Env, SS58),
    );
    assert.equal(body.data.name, "Postgres Team");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountIdentity: flag=postgres falls back to schema-stable null on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/accounts/${SS58}/identity`;
    const body = await json(
      await handleAccountIdentity(req(path), env as unknown as Env, SS58),
    );
    assert.equal(body.data.has_identity, false);
    assert.equal(body.data.name, null);
  });

  test("handleAccountIdentityHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({
      accountIdentityHistory: [
        {
          id: 10,
          observed_at: OBSERVED_AT,
          name: "Example Team",
          url: null,
          github: null,
          image: null,
          discord: null,
          description: null,
          additional: null,
          identity_hash: "abc",
        },
      ],
    });
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        account: SS58,
        entry_count: 1,
        limit: null,
        offset: null,
        next_cursor: null,
        entries: [{ identity_hash: "pg-hash" }],
      }),
    );
    const path = `/api/v1/accounts/${SS58}/identity-history`;
    const body = await json(
      await handleAccountIdentityHistory(
        req(path),
        env as unknown as Env,
        SS58,
        url(path),
      ),
    );
    assert.equal(body.data.entries[0].identity_hash, "pg-hash");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountIdentityHistory: flag=postgres falls back to schema-stable empty on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/accounts/${SS58}/identity-history`;
    const body = await json(
      await handleAccountIdentityHistory(
        req(path),
        env as unknown as Env,
        SS58,
        url(path),
      ),
    );
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  // #4832 gap-closure: subnet_identity_history's new Postgres tier, own
  // dedicated flag (METAGRAPH_SUBNET_IDENTITY_SOURCE). Written from the main
  // Worker's own hourly cron (writeSubnetSnapshot), not an external GitHub
  // Actions workflow -- but served the same way as every other tier here.
  // REMOVED (#10190): "handleSubnetIdentityHistory: flag=postgres uses Postgres
  // data, the store never queried". Both halves are moot -- METAGRAPH_SUBNET_IDENTITY_SOURCE
  // forwards nowhere, and there is no D1 left to leave unqueried.

  test("handleSubnetIdentityHistory: flag=postgres falls back to schema-stable empty on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_SUBNET_IDENTITY_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/subnets/${NETUID}/identity-history`;
    const body = await json(
      await handleSubnetIdentityHistory(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  test("handleSubnetValidators: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        netuid: NETUID,
        validator_count: 99,
        captured_at: null,
        block_number: null,
        validators: [],
      }),
    );
    const path = `/api/v1/subnets/${NETUID}/validators`;
    const body = await json(
      await handleSubnetValidators(
        req(path),
        env as unknown as Env,
        NETUID,
        url(path),
      ),
    );
    assert.equal(body.data.validator_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleGlobalValidators: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({
      neurons: [neuronRow({ netuid: NETUID })],
    });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        sort: "subnet_count",
        limit: 20,
        captured_at: null,
        block_number: null,
        validator_count: 99,
        validators: [],
      }),
    );
    const body = await json(
      await handleGlobalValidators(
        req("/api/v1/validators"),
        env as unknown as Env,
        url("/api/v1/validators"),
      ),
    );
    assert.equal(body.data.validator_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleValidatorDetail: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        hotkey: SS58,
        coldkey: null,
        coldkey_count: 0,
        subnet_count: 99,
        total_stake_tao: 0,
        total_emission_tao: 0,
        avg_validator_trust: null,
        max_validator_trust: null,
        captured_at: null,
        block_number: null,
        subnets: [],
      }),
    );
    const body = await json(
      await handleValidatorDetail(
        req(`/api/v1/validators/${SS58}`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.subnet_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleValidatorNominators: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleValidatorNominators(
        req(`/api/v1/validators/${SS58}/nominators`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/validators/${SS58}/nominators`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountWeightSetters: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountWeightSetters(
        req(`/api/v1/accounts/${SS58}/weight-setters`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/weight-setters`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // The store read this used to assert AWAY is now the answer: the tier
    // short-circuited it, and with the tier gone the composer reads the store
    // itself. Asserting it happened is the honest inverse of the old claim.
    assert.ok(captures.sql.length > 0);
  });

  test("handleSubnetWeightSetters: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetWeightSetters(
        req(`/api/v1/subnets/${NETUID}/weights/setters`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/weights/setters`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountStakeFlow: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountStakeFlow(
        req(`/api/v1/accounts/${SS58}/stake-flow`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/stake-flow`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetStakeFlow: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetStakeFlow(
        req(`/api/v1/subnets/${NETUID}/stake-flow`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-flow`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountStakeMoves: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountStakeMoves(
        req(`/api/v1/accounts/${SS58}/stake-moves`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/stake-moves`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetStakeMoves: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetStakeMoves(
        req(`/api/v1/subnets/${NETUID}/stake-moves`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-moves`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetStakeTransfers: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetStakeTransfers(
        req(`/api/v1/subnets/${NETUID}/stake-transfers`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-transfers`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountRegistrations: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountRegistrations(
        req(`/api/v1/accounts/${SS58}/registrations`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/registrations`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetRegistrations: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetRegistrations(
        req(`/api/v1/subnets/${NETUID}/registrations`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/registrations`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountServing: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountServing(
        req(`/api/v1/accounts/${SS58}/serving`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/serving`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetServing: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetServing(
        req(`/api/v1/subnets/${NETUID}/serving`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/serving`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountAxonRemovals: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountAxonRemovals(
        req(`/api/v1/accounts/${SS58}/axon-removals`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/axon-removals`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountDeregistrations: serves the derived footprint from the per-hotkey index (#9307)", async () => {
    const body = await json(
      await handleAccountDeregistrations(
        req(`/api/v1/accounts/${SS58}/deregistrations`),
        deregistrationProjectionEnv() as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/deregistrations`),
      ),
    );
    assert.equal(body.data.total_deregistrations, 2);
    assert.equal(body.data.derivation.unattributed_registrations, 1726);
    // The floor is flagged in the payload, not only in the documentation
    // (#9708). Two mainnet subnets published a literal 0 against two dozen
    // registrations each, and a reader took that to mean "no churn".
    assert.equal(body.data.derivation.is_lower_bound, true);
    assert.equal(body.data.degraded, undefined);
    await assertValidComponent("AccountDeregistrationsArtifact", body.data);
  });

  test("handleSubnetAxonRemovals: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetAxonRemovals(
        req(`/api/v1/subnets/${NETUID}/axon-removals`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/axon-removals`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // #10805: this used to assert NO query at all, which was true only while
    // the route had no source. It now derives removals from `neuron_daily`,
    // so the claim worth pinning is narrower and still the one the test is
    // named for -- the retired TIER is not consulted, and what runs instead is
    // the state diff rather than an account_events read.
    assert.equal(captures.sql.length, 1);
    assert.match(String(captures.sql[0]), /FROM neuron_daily/);
    assert.doesNotMatch(String(captures.sql[0]), /account_events/);
  });

  test("handleAccountPrometheus: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountPrometheus(
        req(`/api/v1/accounts/${SS58}/prometheus`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/prometheus`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetPrometheus: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetPrometheus(
        req(`/api/v1/subnets/${NETUID}/prometheus`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/prometheus`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountDeregistrations: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountDeregistrations(
        req(`/api/v1/accounts/${SS58}/deregistrations`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/deregistrations`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetDeregistrations: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetDeregistrations(
        req(`/api/v1/subnets/${NETUID}/deregistrations`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/deregistrations`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountTransfers: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountCounterparties: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountCounterparties(
        req(`/api/v1/accounts/${SS58}/counterparties`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/counterparties`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountCounterparties: flag=postgres accepts relationship drilldown envelope", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          ss58: SS58,
          counterparty_count: 1,
          transfers_scanned: 1,
          scan_capped: false,
          total_sent_tao: 4.2,
          total_received_tao: 0,
          counterparties: [
            {
              address: COUNTERPARTY,
              sent_tao: 4.2,
              received_tao: 0,
              net_tao: -4.2,
              transfer_count: 1,
              last_block: BLOCK_NUM,
            },
          ],
          relationship: {
            schema_version: 1,
            ss58: SS58,
            counterparty: COUNTERPARTY,
            transfer_count: 1,
            transfers_scanned: 1,
            scan_capped: false,
            total_sent_tao: 4.2,
            total_received_tao: 0,
            net_tao: -4.2,
            first_seen_at: new Date(OBSERVED_AT).toISOString(),
            last_seen_at: new Date(OBSERVED_AT).toISOString(),
            first_block: BLOCK_NUM,
            last_block: BLOCK_NUM,
            transfers: [],
          },
        }),
    };
    const body = await json(
      await handleAccountCounterparties(
        req(`/api/v1/accounts/${SS58}/counterparties`),
        env as unknown as Env,
        SS58,
        url(
          `/api/v1/accounts/${SS58}/counterparties?counterparty=${COUNTERPARTY}`,
        ),
      ),
    );
    assert.equal(body.data.relationship.counterparty, COUNTERPARTY);
    assert.deepEqual(captures.sql, []);
  });

  // #4832 Tier 1a: blocks/extrinsics-derived handlers that were reading D1
  // directly with no Postgres tier at all -- silently serving data frozen
  // since the streamer stopped. Same pattern as the blocks above.

  test("handleBlockExtrinsics: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleBlockExtrinsics(
        req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
        env as unknown as Env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleBlockEvents: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ blockEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleBlockEvents(
        req(`/api/v1/blocks/${BLOCK_NUM}/events`),
        env as unknown as Env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/events`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleBlocksSummary: the retired flag is not consulted; the projection answers", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    env.METAGRAPH_BLOCKS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    // #9146: the blocks-summary projection is what serves this card now.
    // A COMPLETE card, not a sentinel. This used to plant
    // `{ marker: "projection" }` -- a body no lane could write -- and the
    // reader's cast served it back. The projection tier is now proved by the
    // DATA_API binding staying untouched plus this card's own distinctive
    // block_count, both asserted below.
    env.METAGRAPH_ARCHIVE = {
      get: async () => ({
        json: async () => ({
          schema_version: 1,
          summary: {
            schema_version: 1,
            block_count: 7,
            first_block: 100,
            last_block: 106,
            first_observed_at: "2026-07-01T00:00:00.000Z",
            last_observed_at: "2026-07-01T00:01:12.000Z",
            block_time: null,
            throughput: null,
            distinct_authors: 1,
            author_concentration: null,
            distinct_spec_versions: 1,
            latest_spec_version: 199,
          },
        }),
      }),
    };
    const body = await json(
      await handleBlocksSummary(
        req("/api/v1/blocks/summary"),
        env as unknown as Env,
        url("/api/v1/blocks/summary"),
      ),
    );
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.block_count, 7);
  });

  test("handleAccountExtrinsics: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountExtrinsics(
        req(`/api/v1/accounts/${SS58}/extrinsics`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/extrinsics`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // ANY store read here is the HOT TIER's, never the retired one. This used
    // to assert `captures.sql` empty, which was INCIDENTAL rather than the
    // property under test: the lakehouse leg reads over `fetch`, so nothing
    // reached pg at all. The extrinsic feeds now try `chain_detail_extrinsics`
    // first, which is a legitimate store read that says nothing about the
    // retired flag -- so this asserts what the test is named for.
    for (const sql of captures.sql) {
      assert.match(String(sql), /FROM chain_detail_/, String(sql));
    }
  });

  test("handleSudo: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({
      extrinsics: [extrinsicRow({ call_module: "Sudo" })],
    });
    env.METAGRAPH_EXTRINSICS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSudo(
        req("/api/v1/sudo"),
        env as unknown as Env,
        url("/api/v1/sudo"),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // ANY store read here is the HOT TIER's, never the retired one. This used
    // to assert `captures.sql` empty, which was INCIDENTAL rather than the
    // property under test: the lakehouse leg reads over `fetch`, so nothing
    // reached pg at all. The extrinsic feeds now try `chain_detail_extrinsics`
    // first, which is a legitimate store read that says nothing about the
    // retired flag -- so this asserts what the test is named for.
    for (const sql of captures.sql) {
      assert.match(String(sql), /FROM chain_detail_/, String(sql));
    }
  });

  test("handleGovernanceConfigChanges: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({
      extrinsics: [extrinsicRow({ call_module: "AdminUtils" })],
    });
    env.METAGRAPH_EXTRINSICS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleGovernanceConfigChanges(
        req("/api/v1/governance/config-changes"),
        env as unknown as Env,
        url("/api/v1/governance/config-changes"),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // ANY store read here is the HOT TIER's, never the retired one. This used
    // to assert `captures.sql` empty, which was INCIDENTAL rather than the
    // property under test: the lakehouse leg reads over `fetch`, so nothing
    // reached pg at all. The extrinsic feeds now try `chain_detail_extrinsics`
    // first, which is a legitimate store read that says nothing about the
    // retired flag -- so this asserts what the test is named for.
    for (const sql of captures.sql) {
      assert.match(String(sql), /FROM chain_detail_/, String(sql));
    }
  });

  test("handleRuntime: the retired flag is not consulted; the lakehouse answers", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    env.METAGRAPH_BLOCKS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    Object.assign(env, LAKEHOUSE_TOKEN);
    // #9265: `chain.blocks` carries spec_version, so the timeline is real.
    const restore = lakehouse(() => [
      { spec_version: 423, block_number: 8_000_000, observed_at: 1 },
    ]);
    try {
      const body = await json(
        await handleRuntime(
          req("/api/v1/runtime"),
          env as unknown as Env,
          url("/api/v1/runtime"),
        ),
      );
      assert.deepEqual(tier.paths, []);
      assert.equal(body.data.current_spec_version, 423);
    } finally {
      restore();
    }
  });

  // #6392: /runtime was the one Explorer list page with no CSV export, because
  // the route rejected every query param -- ?format=csv 400'd before it could
  // reach the handler.
  describe("handleRuntime CSV export (#6392)", () => {
    // The transitions arrive from the lakehouse now, not the retired tier
    // (#10190), so the fixture is injected as ROWS and the builder derives the
    // envelope -- which is closer to what the route actually does than handing
    // it a pre-built envelope ever was.
    function coldTierEnv(transitions: Row[]) {
      const { env } = dbWith({ blocksFeed: [blockRow()] });
      Object.assign(env, LAKEHOUSE_TOKEN);
      restoreFetch = lakehouse((sql) =>
        // LATEST_SQL asks for the head block; TRANSITIONS_SQL for the timeline.
        sql.includes("ORDER BY block_number DESC")
          ? transitions.slice(-1)
          : transitions,
      );
      return env;
    }

    let restoreFetch: (() => void) | undefined;
    afterEach(() => {
      restoreFetch?.();
      restoreFetch = undefined;
    });

    const ROWS = [
      // observed_at is epoch ms here because that is the lakehouse column's own
      // type -- the ISO string in the CSV assertion below is the builder's
      // formatting, which the pre-built tier envelope used to bypass.
      {
        spec_version: 423,
        block_number: 8000000,
        observed_at: Date.parse("2026-06-25T00:00:00.000Z"),
      },
      {
        spec_version: 424,
        block_number: 8100000,
        observed_at: Date.parse("2026-07-01T00:00:00.000Z"),
      },
    ];

    test("?format=csv exports the transition timeline with the on-screen columns", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?format=csv"),
        coldTierEnv(ROWS) as unknown as Env,
        url("/api/v1/runtime?format=csv"),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/csv/);
      assert.equal(
        res.headers.get("content-disposition"),
        'attachment; filename="runtime-versions.csv"',
      );
      const lines = (await res.text()).trim().split("\r\n");
      // The three columns the /runtime table renders: Spec Version | Block | Observed.
      assert.equal(lines[0], "spec_version,block_number,observed_at");
      assert.equal(lines[1], "423,8000000,2026-06-25T00:00:00.000Z");
      assert.equal(lines.length, ROWS.length + 1);
    });

    test("the default response is still the JSON envelope", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime"),
        coldTierEnv(ROWS) as unknown as Env,
        url("/api/v1/runtime"),
      );
      assert.match(res.headers.get("content-type") || "", /application\/json/);
      const body = await jsonBody(res);
      // The rollup fields stay JSON-only -- they describe the series, not a row.
      assert.equal(body.data.current_spec_version, 424);
      assert.equal(body.data.coverage_from_block, 8000000);
    });

    test("?format=json is accepted and keeps the envelope", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?format=json"),
        coldTierEnv(ROWS) as unknown as Env,
        url("/api/v1/runtime?format=json"),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /application\/json/);
    });

    test("a cold store yields a header-only CSV, never an error", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?format=csv"),
        coldTierEnv([]) as unknown as Env,
        url("/api/v1/runtime?format=csv"),
      );
      assert.equal(res.status, 200);
      assert.equal(
        (await res.text()).trim(),
        "spec_version,block_number,observed_at",
      );
    });

    test("an unsupported format is still rejected", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?format=bogus"),
        coldTierEnv(ROWS) as unknown as Env,
        url("/api/v1/runtime?format=bogus"),
      );
      assert.equal(res.status, 400);
    });
  });

  // #4832 Tier 1b: the remaining account_events-derived handlers with no
  // Postgres tier at all -- same pattern as Tier 1a above.

  test("handleSubnetWeights: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetWeights(
        req(`/api/v1/subnets/${NETUID}/weights`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/weights`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetAlphaVolume: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetAlphaVolume(
        req(`/api/v1/subnets/${NETUID}/volume`),
        env as unknown as Env,
        NETUID,
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetEvents: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ subnetEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetEvents(
        req(`/api/v1/subnets/${NETUID}/events`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/events`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetEventSummary: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({
      subnetEventSummaryKinds: [],
      subnetEventSummaryRecent: [],
    });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleSubnetEventSummary(
        req(`/api/v1/subnets/${NETUID}/event-summary`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/event-summary`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  // #4832 Tier 1c: handleAccount (multi-table: account_events + neurons +
  // extrinsics) and handleAccountSubnets (neurons-derived).

  test("handleAccount: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccount(
        req(`/api/v1/accounts/${SS58}`),
        env as unknown as Env,
        SS58,
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    // The store read this used to assert AWAY is now the answer: the tier
    // short-circuited it, and with the tier gone the composer reads the store
    // itself. Asserting it happened is the honest inverse of the old claim.
    assert.ok(captures.sql.length > 0);
  });

  test("handleAccountSubnets: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", subnets: [] }),
    };
    const body = await json(
      await handleAccountSubnets(
        req(`/api/v1/accounts/${SS58}/subnets`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 Tier 2a: the 8 flat-`neurons` handlers (concentration, performance,
  // yield, portfolio, accounts list) across the subnet/chain/account scopes.

  test("handleSubnetConcentration: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", netuid: NETUID }),
    };
    const body = await json(
      await handleSubnetConcentration(
        req(`/api/v1/subnets/${NETUID}/concentration`),
        env as unknown as Env,
        NETUID,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetPerformance: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", netuid: NETUID }),
    };
    const body = await json(
      await handleSubnetPerformance(
        req(`/api/v1/subnets/${NETUID}/performance`),
        env as unknown as Env,
        NETUID,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetYield: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", neurons: [] }),
    };
    const body = await json(
      await handleSubnetYield(
        req(`/api/v1/subnets/${NETUID}/yield`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/yield`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainConcentration: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainConcentration(
        req("/api/v1/chain/concentration"),
        env as unknown as Env,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainConcentrationSubnets: forwards to the tier and envelopes it", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainConcentrationSubnets(
        req("/api/v1/chain/concentration/subnets"),
        env as unknown as Env,
        url("/api/v1/chain/concentration/subnets"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainConcentrationSubnets: a cold tier echoes the CALLER's query back", async () => {
    // An empty ranking that reports lens=stake to someone who asked for
    // lens=stake is a different statement from one that reports the default.
    const { env } = dbWith({ neurons: [] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = { fetch: async () => new Response(null, { status: 503 }) };
    const query = "?lens=stake&sort=gini&order=desc&limit=5";
    const body = await json(
      await handleChainConcentrationSubnets(
        req(`/api/v1/chain/concentration/subnets${query}`),
        env as unknown as Env,
        url(`/api/v1/chain/concentration/subnets${query}`),
      ),
    );
    assert.equal(body.data.lens, "stake");
    assert.equal(body.data.sort, "gini");
    assert.equal(body.data.order, "desc");
    assert.equal(body.data.limit, 5);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
  });

  test("handleChainPerformance: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainPerformance(
        req("/api/v1/chain/performance"),
        env as unknown as Env,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainYield: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainYield(req("/api/v1/chain/yield"), env as unknown as Env),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // REMOVED (#10190): "handleSelfHealth: flag=postgres uses Postgres data, D1
  // never queried". METAGRAPH_SELF_HEALTH_SOURCE reads "retired" in every
  // deployed config and is absent from FORWARDABLE_TIER_FLAGS, so the forward it
  // asserted never happened outside this test -- the `marker: "pg"` it checked
  // for could only come from its own DATA_API stub. What the route actually
  // serves from is Neon, then the lakehouse cold tier, both covered below.

  test("handleSelfHealth: lane verdicts ride on whichever tier answered", async () => {
    // #9330/#9340. The lanes come from lane_health, not from the tier that produced
    // the card, because the point of the change is that a lane's health stays readable
    // when the serving tier does not -- so the live-tier card above must carry them too.
    const { env } = dbWith({ neurons: [] });
    // NO SERVING TIER STUBBED (#10190). This used to force the card through
    // METAGRAPH_SELF_HEALTH_SOURCE="postgres" and assert its stub's marker came
    // back; that flag is retired and forwards nowhere, so the tier is whatever
    // the route really reaches. The CLAIM under test is unchanged and is the
    // point of #9330/#9340: the lanes come from lane_health regardless of which
    // tier produced the card, so they must survive a tier that answered nothing.
    // A canned answer rather than a router bucket: `answers` is consulted
    // before the row set dbWith assigns, so this one statement can differ from
    // everything else the handler asks without touching the router.
    pg.control.answers = [
      {
        match: /FROM lane_health/i,
        rows: [
          {
            // `neon:neurons`, not the bare spelling: that one is RETIRED
            // (#10851's key change froze it, see RETIRED_LANES), so the
            // serving read drops it -- and the prefixed key is what
            // production actually carries.
            lane: "neon:neurons",
            verdict: "ok",
            age_ms: 30_000,
            detail: null,
            checked_at: 1_785_800_000_000,
          },
          {
            lane: "chain-detail",
            verdict: "stale",
            age_ms: 14_400_000,
            detail: "hot_window.to frozen",
            checked_at: 1_785_800_000_000,
          },
        ],
      },
    ];
    const body = await json(
      await handleSelfHealth(req("/api/v1/self-health"), env as unknown as Env),
    );
    // Stale first: the row an operator acts on leads.
    assert.deepEqual(
      body.data.lanes.map((l: { lane: string }) => l.lane),
      ["chain-detail", "neon:neurons"],
    );
    assert.equal(body.data.stale_lane_count, 1);
  });

  test("handleSelfHealth: no lane table yields an empty list, never a stale claim", async () => {
    // migrations here are applied by hand, so "the table does not exist yet" is a
    // real production state and must not read as "every lane is fine" OR as an error.
    const { env } = dbWith({ neurons: [] });
    const body = await json(
      await handleSelfHealth(req("/api/v1/self-health"), env as unknown as Env),
    );
    assert.deepEqual(body.data.lanes, []);
    assert.equal(body.data.stale_lane_count, 0);
  });

  test("handleSelfHealth: a cold tier serves the empty shape, never a 404", async () => {
    // "We have no readings" is a real state, not a missing resource -- and a
    // status page that 404s is the worst possible status report.
    const { env } = dbWith({ neurons: [] });
    const res = await handleSelfHealth(
      req("/api/v1/self-health"),
      env as unknown as Env,
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.data.verdict, "degraded");
    assert.equal(body.data.components.length, 3);
    // Null, not false: unmeasured is not down.
    assert.equal(
      body.data.components.every(
        (c: { current_ok: unknown }) => c.current_ok === null,
      ),
      true,
    );
  });

  test("handleAccountPortfolio: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", positions: [] }),
    };
    const body = await json(
      await handleAccountPortfolio(
        req(`/api/v1/accounts/${SS58}/portfolio`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountPositions never forwards to DATA_API -- that Worker has no branch for this path", async () => {
    // The regression pin for the dead forward. DATA_API is a LIVE
    // Hyperdrive->Neon tier and answers the sibling routes (portfolio, subnets,
    // identity, position HISTORY), which is exactly why re-adding a leg here
    // looks reasonable -- but it has never had a branch for
    // /accounts/:ss58/positions, so the forward could only ever fall through to
    // that Worker's terminal 503. In production that cost two subrequests (503
    // is at or above the retry floor, so the attempt was made twice) plus an
    // AWAITED PostHog $exception on the response path, before the hot leg
    // answered anyway: 55 of 55 captured neurons-tier declines in the fourteen
    // days to 2026-08-15 were this single path.
    //
    // A `fetch` that THROWS is the assertion. Were the leg restored, this stub
    // would be called and the throw would surface as a tier fallback rather
    // than the clean hot-leg answer below -- and the capture it would have
    // fired is the thing this test exists to keep out of production.
    let dataApiCalls = 0;
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        dataApiCalls += 1;
        throw new Error("DATA_API must not be consulted for this route");
      },
    };
    const body = await json(
      await handleAccountPositions(
        req(`/api/v1/accounts/${SS58}/positions`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(dataApiCalls, 0, "the DATA_API leg is gone, not merely quiet");
    assert.equal(body.data.ss58, SS58);
    assert.ok(
      captures.sql.some((sql: string) => /FROM nominator_positions/.test(sql)),
      "the hot leg is consulted first and directly, with no doomed hop before it",
    );
  });

  test("handleAccountPositions: every tier declines and the empty card is LABELLED (#9273)", async () => {
    // The chain is D1 hot -> lakehouse cold -> labelled empty. This stub's D1
    // had no nominator_positions ledger and there is no R2 SQL token, so every
    // tier declines -- and the card that comes back now SAYS so rather than
    // publishing a confident `total_stake_alpha: 0`, which is the #9260/#9263
    // defect class this route shared.
    //
    // `tier_unavailable` still being the reason is the point worth keeping:
    // dropping the DATA_API leg removed a hop that could never answer, not the
    // route's ability to admit that it cannot answer.
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    const body = await json(
      await handleAccountPositions(
        req(`/api/v1/accounts/${SS58}/positions`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, undefined);
    assert.equal(body.data.ss58, SS58);
    assert.deepEqual(body.data.positions, []);
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_stake_alpha, 0);
    assert.equal(body.data.degraded.reason, "tier_unavailable");
    assert.ok(
      captures.sql.some((sql: string) => /FROM nominator_positions/.test(sql)),
      "the D1 hot leg is consulted before the lakehouse -- it is the only tier that can be current",
    );
  });

  test("handleAccountsList: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", accounts: [] }),
    };
    const body = await json(
      await handleAccountsList(
        req("/api/v1/accounts"),
        env as unknown as Env,
        url("/api/v1/accounts"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // Called directly (bypassing workers/api.ts's canonicalTopHoldersCachePath,
  // which already validates and short-circuits on a bad query before ever
  // reaching this handler) so handleTopHoldersList's own defensive
  // parsed.error guard -- the same defense-in-depth shape as every other
  // handler in this file -- is exercised too.

  // REMOVED (#10190): "handleTopHoldersList: flag=postgres uses Postgres data,
  // the store never queried". Same reason as the self-health one above --
  // METAGRAPH_TOP_HOLDERS_SOURCE is retired and absent from
  // FORWARDABLE_TIER_FLAGS. The live tier is the flow projection
  // (src/top-holders-flow-tier.ts), covered by tests/top-holders-flow-tier.test.ts
  // and by the CSV export test in tests/top-holders.test.ts.

  // #4832 Tier 2b: the 9 neuron_daily-history handlers (structural history,
  // concentration/performance/yield history, chain/subnet turnover, movers).

  test("handleValidatorHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleValidatorHistory(
        req(`/api/v1/validators/${SS58}/history`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/validators/${SS58}/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleNeuronHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleNeuronHistory(
        req(`/api/v1/subnets/${NETUID}/neurons/1/history`),
        env as unknown as Env,
        NETUID,
        1,
        url(`/api/v1/subnets/${NETUID}/neurons/1/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetHistory(
        req(`/api/v1/subnets/${NETUID}/history`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetConcentrationHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetConcentrationHistory(
        req(`/api/v1/subnets/${NETUID}/concentration/history`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/concentration/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetPerformanceHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetPerformanceHistory(
        req(`/api/v1/subnets/${NETUID}/performance/history`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/performance/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetYieldHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetYieldHistory(
        req(`/api/v1/subnets/${NETUID}/yield/history`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/yield/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainTurnover: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", subnets: [] }),
    };
    const body = await json(
      await handleChainTurnover(
        req("/api/v1/chain/turnover"),
        env as unknown as Env,
        url("/api/v1/chain/turnover"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetTurnover: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", subnets: [] }),
    };
    const body = await json(
      await handleSubnetTurnover(
        req(`/api/v1/subnets/${NETUID}/turnover`),
        env as unknown as Env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/turnover`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetMovers: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", movers: [] }),
    };
    const body = await json(
      await handleSubnetMovers(
        req("/api/v1/subnets/movers"),
        env as unknown as Env,
        url("/api/v1/subnets/movers"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 gap-closure: handleAccountPositionHistory (account_position_daily,
  // rolled from the same neurons snapshot as neuron_daily).

  test("handleAccountPositionHistory: flag=postgres uses Postgres data, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleAccountPositionHistory(
        req(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
        env as unknown as Env,
        SS58,
        NETUID,
        url(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountPositionHistory: HEAD uses the Postgres GET representation", async () => {
    const { env, captures } = dbWith({});
    let forwardedMethod;
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async (request: Request) => {
        forwardedMethod = request.method;
        return Response.json({
          schema_version: 1,
          marker: "pg",
          points: [{ captured_at: "2026-07-13T00:00:00.000Z" }],
        });
      },
    };
    const res = await handleAccountPositionHistory(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/${NETUID}/history`,
        { method: "HEAD" },
      ),
      env as unknown as Env,
      SS58,
      NETUID,
      url(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
    assert.equal(forwardedMethod, "GET");
    assert.notEqual(res.headers.get("etag"), null);
    assert.deepEqual(captures.sql, []);
  });

  // No store fallback here (unlike the ~40 branches #4909 tracks separately):
  // D1's own account_position_daily rollup has been permanently broken since
  // #4908 dropped D1's `neurons` table, so a Postgres failure degrades to the
  // same schema-stable empty series a cold store returns, never a store read.
  test("handleAccountPositionHistory: flag=postgres degrades to an empty schema-stable series on failure, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const body = await json(
      await handleAccountPositionHistory(
        req(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
        env as unknown as Env,
        SS58,
        NETUID,
        url(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
      ),
    );
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(captures.sql, []);
  });

  // #4832 gap-closure: handleAccountHistory (account_events_daily, now
  // populated by a dedicated hourly Postgres-side rollup route).

  test("handleAccountHistory: the retired tier flag is not consulted even when set (#10190)", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    const tier = forbiddenDataApi();
    env.DATA_API = tier.DATA_API;
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/history`),
      ),
    );
    // Nothing asks the binding, and the answer carries none of its marker.
    assert.deepEqual(tier.paths, []);
    assert.equal(body.data.marker, undefined);
    assert.deepEqual(captures.sql, []);
  });

  // D1 fully eliminated (2026-07-17): a Postgres-tier failure now falls
  // through to the schema-stable empty shape, never a live store read.
  test("handleAccountHistory: flag=postgres falls back to schema-stable empty on failure, the store never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "data-api";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env as unknown as Env,
        SS58,
        url(`/api/v1/accounts/${SS58}/history`),
      ),
    );
    assert.equal(body.data.marker, undefined);
    assert.equal(body.data.day_count, 0);
    assert.deepEqual(body.data.days, []);
    assert.deepEqual(captures.sql, []);
  });
});

// ---- Cross-handler contract smoke tests -------------------------------------

describe("entities handler exports (#1900)", () => {
  const handlers = [
    handleSubnetMetagraph,
    handleNeuron,
    handleSubnetValidators,
    handleNeuronHistory,
    handleSubnetHistory,
    handleAccount,
    handleAccountEvents,
    handleAccountHistory,
    handleAccountExtrinsics,
    handleAccountTransfers,
    handleAccountSubnets,
    handleSubnetEvents,
    handleAccountBalance,
    handleBlocks,
    handleBlock,
    handleBlockExtrinsics,
    handleBlockEvents,
    handleExtrinsics,
    handleExtrinsic,
  ];

  test("exports exactly 19 handler functions", () => {
    assert.equal(handlers.length, 19);
    for (const fn of handlers) {
      assert.equal(typeof fn, "function");
    }
  });

  test("every handler returns an envelope with ok:true on a cold store (sample)", async () => {
    const samples = [
      () =>
        handleSubnetMetagraph(
          req(`/api/v1/subnets/${NETUID}/metagraph`),
          emptyEnv() as unknown as Env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/metagraph`),
        ),
      () =>
        handleNeuron(
          req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
          emptyEnv() as unknown as Env,
          NETUID,
          UID,
          url(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        ),
      () =>
        handleAccount(
          req(`/api/v1/accounts/${SS58}`),
          emptyEnv() as unknown as Env,
          SS58,
        ),
      () =>
        handleBlocks(
          req("/api/v1/blocks"),
          emptyEnv() as unknown as Env,
          url("/api/v1/blocks"),
        ),
      () =>
        handleExtrinsic(
          req(`/api/v1/extrinsics/${HASH}`),
          emptyEnv() as unknown as Env,
          HASH,
        ),
    ];
    for (const call of samples) {
      const res = await call();
      assert.equal(res.status, 200);
      const body = await jsonBody(res);
      assert.equal(body.ok, true);
      assert.ok(body.data);
    }
  });
});

// Additional exhaustive schema-stability checks per handler family to pad coverage
// and document the null-safe contract across every exported entry point.

describe("schema-stable cold-store matrix (#1900)", () => {
  const coldCases = [
    {
      name: "handleSubnetValidators",
      run: () =>
        handleSubnetValidators(
          req(`/api/v1/subnets/${NETUID}/validators`),
          emptyEnv() as unknown as Env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/validators`),
        ),
      assertData: (d: Row) => assert.equal(d.validator_count, 0),
    },
    {
      name: "handleNeuronHistory",
      run: () =>
        handleNeuronHistory(
          req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
          emptyEnv() as unknown as Env,
          NETUID,
          UID,
          url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
        ),
      assertData: (d: Row) => assert.equal(d.point_count, 0),
    },
    {
      name: "handleSubnetHistory",
      run: () =>
        handleSubnetHistory(
          req(`/api/v1/subnets/${NETUID}/history`),
          emptyEnv() as unknown as Env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/history`),
        ),
      assertData: (d: Row) => assert.equal(d.point_count, 0),
    },
    {
      name: "handleAccountEvents",
      run: () =>
        handleAccountEvents(
          req(`/api/v1/accounts/${SS58}/events`),
          emptyEnv() as unknown as Env,
          SS58,
          url(`/api/v1/accounts/${SS58}/events`),
        ),
      assertData: (d: Row) => assert.equal(d.event_count, 0),
    },
    {
      name: "handleAccountHistory",
      run: () =>
        handleAccountHistory(
          req(`/api/v1/accounts/${SS58}/history`),
          emptyEnv() as unknown as Env,
          SS58,
          url(`/api/v1/accounts/${SS58}/history`),
        ),
      assertData: (d: Row) => assert.equal(d.day_count, 0),
    },
    {
      name: "handleAccountExtrinsics",
      run: () =>
        handleAccountExtrinsics(
          req(`/api/v1/accounts/${SS58}/extrinsics`),
          emptyEnv() as unknown as Env,
          SS58,
          url(`/api/v1/accounts/${SS58}/extrinsics`),
        ),
      assertData: (d: Row) => assert.equal(d.extrinsic_count, 0),
    },
    {
      name: "handleAccountTransfers",
      run: () =>
        handleAccountTransfers(
          req(`/api/v1/accounts/${SS58}/transfers`),
          emptyEnv() as unknown as Env,
          SS58,
          url(`/api/v1/accounts/${SS58}/transfers`),
        ),
      assertData: (d: Row) => assert.equal(d.transfer_count, 0),
    },
    {
      name: "handleAccountSubnets",
      run: () =>
        handleAccountSubnets(
          req(`/api/v1/accounts/${SS58}/subnets`),
          emptyEnv() as unknown as Env,
          SS58,
        ),
      assertData: (d: Row) => assert.equal(d.subnet_count, 0),
    },
    {
      name: "handleSubnetEvents",
      run: () =>
        handleSubnetEvents(
          req(`/api/v1/subnets/${NETUID}/events`),
          emptyEnv() as unknown as Env,
          NETUID,
          url(`/api/v1/subnets/${NETUID}/events`),
        ),
      assertData: (d: Row) => assert.equal(d.event_count, 0),
    },
    {
      name: "handleBlockExtrinsics",
      run: () =>
        handleBlockExtrinsics(
          req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
          emptyEnv() as unknown as Env,
          String(BLOCK_NUM),
          url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
        ),
      assertData: (d: Row) => assert.equal(d.extrinsic_count, 0),
    },
    {
      name: "handleBlockEvents",
      run: () =>
        handleBlockEvents(
          req(`/api/v1/blocks/${BLOCK_NUM}/events`),
          emptyEnv() as unknown as Env,
          String(BLOCK_NUM),
          url(`/api/v1/blocks/${BLOCK_NUM}/events`),
        ),
      assertData: (d: Row) => assert.equal(d.event_count, 0),
    },
    {
      name: "handleExtrinsics",
      run: () =>
        handleExtrinsics(
          req("/api/v1/extrinsics"),
          emptyEnv() as unknown as Env,
          url("/api/v1/extrinsics"),
        ),
      assertData: (d: Row) => assert.equal(d.extrinsic_count, 0),
    },
  ];

  for (const { name, run, assertData } of coldCases) {
    test(`${name} never 404s on a cold store`, async () => {
      const res = await run();
      assert.equal(res.status, 200);
      const body = await jsonBody(res);
      assert.equal(body.ok, true);
      assertData(body.data);
    });
  }
});

describe("envelope + meta contracts (#1900)", () => {
  test("metagraph handlers set source metagraph-snapshot", async () => {
    const { env } = dbWith({ neurons: [neuronRow()] });
    const body = await json(
      await handleNeuron(
        req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        env as unknown as Env,
        NETUID,
        UID,
        url(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
      ),
    );
    assert.equal(body.meta.source, "metagraph-snapshot");
    assert.ok(body.meta.contract_version);
    assert.ok(
      resHasEtag(
        await handleNeuron(
          req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
          env as unknown as Env,
          NETUID,
          UID,
          url(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        ),
      ),
    );
  });

  test("chain-events handlers set source chain-events", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const res = await handleBlocks(
      req("/api/v1/blocks"),
      env as unknown as Env,
      url("/api/v1/blocks"),
    );
    const body = await json(res);
    assert.equal(body.meta.source, "chain-events");
    assert.ok(body.meta.artifact_path);
  });

  test("handleAccountBalance meta carries contract_version only", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => ({
          schema_version: 1,
          ss58: SS58,
          balance_tao: 1,
          queried_at: "2026-06-25T00:00:00.000Z",
        }),
      },
    };
    const body = await json(
      await handleAccountBalance(
        req(`/api/v1/accounts/${SS58}/balance`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.ok(body.meta.contract_version);
    assert.equal(body.meta.source, undefined);
  });
});

async function resHasEtag(res: Response) {
  return Boolean(res.headers.get("etag"));
}

describe("canonicalSubnetHistoryCachePath", () => {
  test("returns canonical key for valid window param", () => {
    assert.equal(
      canonicalSubnetHistoryCachePath(
        url("/api/v1/subnets/7/history?window=30d"),
      ),
      "/api/v1/subnets/7/history?window=30d",
    );
  });

  test("falls back to raw url when unknown query param is present", () => {
    const raw = "/api/v1/subnets/7/history?window=30d&extra=junk";
    assert.equal(canonicalSubnetHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw url when window value is invalid", () => {
    const raw = "/api/v1/subnets/7/history?window=invalid";
    assert.equal(canonicalSubnetHistoryCachePath(url(raw)), raw);
  });
});

// Fixture documentation: each factory above mirrors the D1 column contracts used
// by workers/request-handlers/entities.ts. When adding a new handler test,
// prefer reusing these rows so formatters stay aligned with production schemas.
