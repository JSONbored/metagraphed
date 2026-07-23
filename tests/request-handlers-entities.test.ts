// Direct unit tests for workers/request-handlers/entities.mjs (#1900).
// Imports every exported handler and exercises the null-safe D1 read path,
// query-param guards, and schema-stable cold-store contracts without routing
// through workers/api.mjs.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { MOVERS_WINDOWS } from "../src/movers.ts";
import { unsupportedWindowMessage } from "../src/neuron-history.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import { type Row, type AnyFn, jsonBody } from "./row-type.ts";
import {
  handleSubnetMetagraph,
  handleSubnetYield,
  handleNeuron,
  handleSubnetValidators,
  handleGlobalValidators,
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
  handleChainPerformance,
  handleChainYield,
  handleAccountPortfolio,
  handleAccountPositions,
  handleAccountsList,
  handleTopHoldersList,
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
} from "../workers/request-handlers/entities.mjs";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const COUNTERPARTY = "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ";
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

function identityHistoryRow(overrides = {}) {
  return {
    id: 10,
    block_number: 100,
    observed_at: OBSERVED_AT,
    subnet_name: "MIAO",
    symbol: "α",
    description: "old",
    github_repo: null,
    subnet_url: null,
    discord: null,
    logo_url: null,
    identity_hash: "abc",
    ...overrides,
  };
}

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

// A D1 mock that routes SQL by regex patterns (order-sensitive: specific first).
// Named buckets let each handler test supply only the rows it needs.
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
  const record = (sql: string, params: unknown[]) => {
    cap.sql.push(sql);
    cap.params.push(params);
  };
  return {
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind(...params: unknown[]) {
              record(sql, params);
              return {
                async all() {
                  // Block prev/next neighbor lookup (#1853).
                  if (
                    /SELECT MAX\(block_number\) FROM blocks WHERE block_number < \?/.test(
                      sql,
                    )
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
                  if (
                    /FROM neuron_daily WHERE netuid = \? AND uid = \?/.test(sql)
                  ) {
                    return { results: neuronDailyUid || [] };
                  }
                  // Turnover: MIN/MAX boundary-date probe (checked before the
                  // generic `snapshot_date >=` history match below).
                  if (/MIN\(snapshot_date\) AS start_date/.test(sql)) {
                    return { results: turnoverBounds || [] };
                  }
                  // Turnover: the two boundary snapshots' rows.
                  if (
                    /FROM neuron_daily WHERE netuid = \? AND snapshot_date IN/.test(
                      sql,
                    )
                  ) {
                    return { results: turnoverRows || [] };
                  }
                  // Raw per-day neuron_daily rows (concentration history).
                  if (
                    /FROM neuron_daily WHERE netuid = \? AND snapshot_date >= \?/.test(
                      sql,
                    )
                  ) {
                    return { results: neuronDailyHistory || [] };
                  }
                  // Net stake flow: SUM(amount_tao) over stake kinds
                  // (checked before the generic event_kind aggregate below).
                  if (
                    /SUM\(amount_tao\)/.test(sql) &&
                    /event_kind IN \(/.test(sql)
                  ) {
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
                    /FROM account_events WHERE netuid = \? AND observed_at >= \?/.test(
                      sql,
                    ) &&
                    /ORDER BY block_number DESC, event_index DESC LIMIT \?/.test(
                      sql,
                    )
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
                    /event_kind = 'Transfer' AND hotkey = \? AND coldkey = \?/.test(
                      sql,
                    )
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
                  if (
                    /SELECT block_number FROM blocks WHERE block_hash = \?/.test(
                      sql,
                    )
                  ) {
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
                  if (
                    /SELECT block_number FROM blocks WHERE block_number = \?/.test(
                      sql,
                    )
                  ) {
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
                  if (
                    /WHERE block_number = \? AND extrinsic_index = \?/.test(sql)
                  ) {
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
                  if (
                    /validator_permit = 1 ORDER BY stake_tao DESC/.test(sql)
                  ) {
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
                },
              };
            },
          };
        },
      },
    } as unknown as Row,
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
// failure). d1All catches this and degrades to [] — the handler must stay 200 +
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetMetagraph(
      req(`/api/v1/subnets/${NETUID}/metagraph`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/metagraph?bogus=1`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.match(body.error.message, /bogus/);
  });

  test("returns schema-stable empty payload on cold/unbound D1", async () => {
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
});

describe("handleSubnetYield", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield?bogus=1`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
  });

  test("returns schema-stable empty payload on cold/unbound D1", async () => {
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
  test("returns schema-stable neuron:null on cold/unbound D1", async () => {
    const body = await assertColdSchema(
      handleNeuron,
      req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
      emptyEnv(),
      NETUID,
      UID,
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
        env,
        NETUID,
        999,
      ),
    );
    assert.equal(body.data.neuron, null);
  });
});

describe("handleSubnetValidators", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetValidators(
      req(`/api/v1/subnets/${NETUID}/validators`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/validators?limit=10`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty validators on cold D1", async () => {
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
      METAGRAPH_NEURONS_SOURCE: "postgres",
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
      env,
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
  // workers/api.mjs always resolves canonicalGlobalValidatorsCachePath(url)
  // first and short-circuits on its { response } before handleGlobalValidators
  // ever runs, so the router never reaches this guard with an invalid query.
  // It stays as defense in depth for any direct/non-cached caller, so cover it
  // directly here rather than only through the edge-cache route.
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleGlobalValidators(
      req("/api/v1/validators"),
      emptyEnv(),
      url("/api/v1/validators?bogus=1"),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty leaderboard on cold D1", async () => {
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
      realized_return_1w: null,
      realized_return_1m: null,
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
      METAGRAPH_NEURONS_SOURCE: "postgres",
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
      env,
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
      METAGRAPH_NEURONS_SOURCE: "postgres",
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
      env,
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

describe("canonicalGlobalValidatorsCachePath", () => {
  test("returns a response short-circuit for an unsupported query param", () => {
    const result = canonicalGlobalValidatorsCachePath(
      url("/api/v1/validators?bogus=1"),
    );
    assert.equal(result.cachePathAndSearch, undefined);
    assert.ok(result.response instanceof Response);
    assert.equal(result.response.status, 400);
  });

  test("returns a response short-circuit for an unsupported sort value", () => {
    const result = canonicalGlobalValidatorsCachePath(
      url("/api/v1/validators?sort=bogus"),
    );
    assert.equal(result.cachePathAndSearch, undefined);
    assert.equal(result.response!.status, 400);
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleNeuronHistory(
      req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
      emptyEnv(),
      NETUID,
      UID,
      url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an invalid window param with 400", async () => {
    const res = await handleNeuronHistory(
      req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
      emptyEnv(),
      NETUID,
      UID,
      url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history?window=400d`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty points on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetHistory(
      req(`/api/v1/subnets/${NETUID}/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/history?offset=0`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty series on cold D1", async () => {
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
    const res = await handleSubnetHistory(
      req(`/api/v1/subnets/${NETUID}/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/history?window=bogus`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });
});

describe("handleSubnetIdentityHistory", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetIdentityHistory(
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty entries on cold D1", async () => {
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

  test("happy path returns identity timeline rows", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            netuid: NETUID,
            entry_count: 1,
            limit: 20,
            offset: null,
            next_cursor: null,
            entries: [{ subnet_name: "MIAO", identity_hash: "abc" }],
          }),
      },
    };
    const body = await json(
      await handleSubnetIdentityHistory(
        req(`/api/v1/subnets/${NETUID}/identity-history`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/identity-history?limit=20`),
      ),
    );
    assert.equal(body.data.entry_count, 1);
    assert.equal(body.data.entries[0].subnet_name, "MIAO");
    assert.equal(body.data.limit, 20);
  });
});

describe("handleSubnetHyperparams", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetHyperparams(
      req(`/api/v1/subnets/${NETUID}/hyperparameters`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters?bogus=1`),
    );
    await errorJson(res);
  });

  // D1 retirement: subnet_hyperparams's D1 write/read path is retired
  // (workers/request-handlers/entities.mjs's handleSubnetHyperparams no
  // longer queries D1 at all), so this is now "Postgres unconfigured" rather
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetHyperparamsHistory(
      req(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters/history?bogus=1`),
    );
    await errorJson(res);
  });

  // D1 retirement: same as handleSubnetHyperparams above -- no D1 fallback
  // left to query, so this is "Postgres unconfigured" rather than "D1 cold".
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetPerformance(
      req(`/api/v1/subnets/${NETUID}/performance`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance?window=7d`),
    );
    await errorJson(res);
  });

  test("returns schema-stable null blocks on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetConcentration(
      req(`/api/v1/subnets/${NETUID}/concentration`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration?window=7d`),
    );
    await errorJson(res);
  });

  test("returns schema-stable null blocks on cold D1", async () => {
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

  test("degrades to schema-stable null blocks when the D1 read throws", async () => {
    // A bound DB whose .all() rejects (schema drift) — d1All swallows it to [],
    // so the handler still answers 200 with null metric blocks, never 5xx/404.
    const res = await handleSubnetConcentration(
      req(`/api/v1/subnets/${NETUID}/concentration`),
      dbThrows("no such column: validator_permit"),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration`),
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an out-of-range window with 400", async () => {
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty series on cold D1", async () => {
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

  test("degrades to an empty series when the D1 read throws", async () => {
    // d1All swallows the rejecting read to []; the trend stays 200 + points:[].
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      dbThrows("d1 timeout"),
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an out-of-range window with 400", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty series on cold D1", async () => {
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

  test("degrades to an empty series when the D1 read throws", async () => {
    // d1All swallows the rejecting read to []; the trend stays 200 + points:[].
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      dbThrows("d1 timeout"),
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an out-of-range window with 400", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable empty series on cold D1", async () => {
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

  test("degrades to an empty series when the D1 read throws", async () => {
    // d1All swallows the rejecting read to []; the trend stays 200 + points:[].
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      dbThrows("d1 timeout"),
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetTurnover(
      req(`/api/v1/subnets/${NETUID}/turnover`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/turnover?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty turnover on cold D1", async () => {
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
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/turnover?changes=false`),
    );
    await errorJson(res);
  });

  test("changes=true returns schema-stable empty detail on cold D1", async () => {
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
    test("omitted validator_permit and explicit =false produce the same cache key", () => {
      const bare = canonicalSubnetMetagraphCachePath(
        new URL("https://api.metagraph.sh/api/v1/subnets/1/metagraph"),
      );
      const explicitFalse = canonicalSubnetMetagraphCachePath(
        new URL(
          "https://api.metagraph.sh/api/v1/subnets/1/metagraph?validator_permit=false",
        ),
      );
      assert.equal(bare, explicitFalse);
      assert.equal(bare, "/api/v1/subnets/1/metagraph");
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetWeights(
      req(`/api/v1/subnets/${NETUID}/weights`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/weights?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetWeights(
      req(`/api/v1/subnets/${NETUID}/weights`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/weights?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetServing(
      req(`/api/v1/subnets/${NETUID}/serving`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/serving?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetServing(
      req(`/api/v1/subnets/${NETUID}/serving`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/serving?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetPrometheus(
      req(`/api/v1/subnets/${NETUID}/prometheus`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/prometheus?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetPrometheus(
      req(`/api/v1/subnets/${NETUID}/prometheus`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/prometheus?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetStakeMoves(
      req(`/api/v1/subnets/${NETUID}/stake-moves`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-moves?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetStakeMoves(
      req(`/api/v1/subnets/${NETUID}/stake-moves`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-moves?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetStakeTransfers(
      req(`/api/v1/subnets/${NETUID}/stake-transfers`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-transfers?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetStakeTransfers(
      req(`/api/v1/subnets/${NETUID}/stake-transfers`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-transfers?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetRegistrations(
      req(`/api/v1/subnets/${NETUID}/registrations`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/registrations?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetRegistrations(
      req(`/api/v1/subnets/${NETUID}/registrations`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/registrations?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetAxonRemovals(
      req(`/api/v1/subnets/${NETUID}/axon-removals`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/axon-removals?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetAxonRemovals(
      req(`/api/v1/subnets/${NETUID}/axon-removals`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/axon-removals?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetDeregistrations(
      req(`/api/v1/subnets/${NETUID}/deregistrations`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/deregistrations?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetDeregistrations(
      req(`/api/v1/subnets/${NETUID}/deregistrations`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/deregistrations?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("returns a schema-stable zeroed card on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetStakeFlow(
      req(`/api/v1/subnets/${NETUID}/stake-flow`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-flow?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an out-of-retention window with 400", async () => {
    const res = await handleSubnetStakeFlow(
      req(`/api/v1/subnets/${NETUID}/stake-flow`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-flow?window=1y`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported direction enum value with 400", async () => {
    const res = await handleSubnetStakeFlow(
      req(`/api/v1/subnets/${NETUID}/stake-flow`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/stake-flow?direction=invalid`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "direction");
  });

  test("returns schema-stable zeros on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    await errorJson(
      await handleSubnetMovers(
        req("/api/v1/subnets/movers"),
        emptyEnv(),
        url("/api/v1/subnets/movers?bogus=1"),
      ),
    );
  });

  test("rejects an unsupported window with 400", async () => {
    const body = await errorJson(
      await handleSubnetMovers(
        req("/api/v1/subnets/movers"),
        emptyEnv(),
        url("/api/v1/subnets/movers?window=1y"),
      ),
    );
    assert.equal(body.meta.parameter, "window");
    assert.equal(
      body.error.message,
      unsupportedWindowMessage("1y", MOVERS_WINDOWS),
    );
  });

  test("rejects an unsupported sort with 400", async () => {
    await errorJson(
      await handleSubnetMovers(
        req("/api/v1/subnets/movers"),
        emptyEnv(),
        url("/api/v1/subnets/movers?sort=bogus"),
      ),
    );
  });

  test("rejects an out-of-range limit with 400", async () => {
    await errorJson(
      await handleSubnetMovers(
        req("/api/v1/subnets/movers"),
        emptyEnv(),
        url("/api/v1/subnets/movers?limit=0"),
      ),
    );
  });

  test("returns a schema-stable empty leaderboard on cold D1", async () => {
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
  test("returns schema-stable zero summary on cold/unbound D1", async () => {
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
      emptyEnv(),
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
      emptyEnv(),
      SS58,
    );
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const second = await handleAccount(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}`, {
        headers: { "if-none-match": etag },
      }),
      emptyEnv(),
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

describe("handleAccountEvents", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/events?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects a non-integer block_start with 400", async () => {
    const res = await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/events?block_start=abc`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/events?block_end=oops`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });

  test("rejects a malformed netuid with 400", async () => {
    const res = await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/events?netuid=abc`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "netuid");
  });

  test("netuid absent leaves the feed unfiltered", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow()],
    });
    await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      env,
      SS58,
      url(`/api/v1/accounts/${SS58}/events`),
    );
    assert.ok(
      captures.sql.every((s: string) => !/AND netuid = \?/.test(s)),
      "expected no netuid filter when param is absent",
    );
  });

  test("short-circuits an inverted block_start>block_end window before D1", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow()],
    });
    const body = await json(
      await handleAccountEvents(
        req(`/api/v1/accounts/${SS58}/events`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/events?block_start=500&block_end=100`),
      ),
    );
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
    assert.equal(captures.sql.length, 0);
  });

  test("returns schema-stable empty events on cold D1", async () => {
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
      env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountHistory(
      req(`/api/v1/accounts/${SS58}/history`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/history?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects malformed from/to dates with 400", async () => {
    const res = await handleAccountHistory(
      req(`/api/v1/accounts/${SS58}/history`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/history?from=June`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "from");
  });

  test("rejects malformed netuid filters with 400", async () => {
    // 9007199254740993 = Number.MAX_SAFE_INTEGER + 2: passes /^\d+$/ but loses
    // precision under Number(), so the safe-integer guard rejects it.
    for (const netuid of ["abc", "-1", "7.5", "", "9007199254740993"]) {
      const res = await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        emptyEnv(),
        SS58,
        url(`/api/v1/accounts/${SS58}/history?netuid=${netuid}`),
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "netuid");
    }
  });

  test("returns schema-stable empty days on cold D1", async () => {
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
  // schema-stable empty days on cold D1" above for that coverage.

  test("short-circuits an inverted from>to date window before D1", async () => {
    const { env, captures } = dbWith({ accountEventsDaily: [accountDayRow()] });
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountExtrinsics(
      req(`/api/v1/accounts/${SS58}/extrinsics`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/extrinsics?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty extrinsics on cold D1", async () => {
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
    const res = await handleAccountExtrinsics(
      req(`/api/v1/accounts/${SS58}/extrinsics`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/extrinsics?block_start=abc`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await handleAccountExtrinsics(
      req(`/api/v1/accounts/${SS58}/extrinsics`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/extrinsics?block_end=oops`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });

  test("short-circuits an inverted block_start>block_end window before D1", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    const body = await json(
      await handleAccountExtrinsics(
        req(`/api/v1/accounts/${SS58}/extrinsics`),
        env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountTransfers(
      req(`/api/v1/accounts/${SS58}/transfers`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported direction enum value with 400", async () => {
    const res = await handleAccountTransfers(
      req(`/api/v1/accounts/${SS58}/transfers`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers?direction=invalid`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "direction");
  });

  test("rejects a non-integer block_start with 400", async () => {
    const res = await handleAccountTransfers(
      req(`/api/v1/accounts/${SS58}/transfers`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers?block_start=abc`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await handleAccountTransfers(
      req(`/api/v1/accounts/${SS58}/transfers`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers?block_end=oops`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });

  test("short-circuits an inverted block_start>block_end window before D1", async () => {
    const { env, captures } = dbWith({ transfers: [transferEventRow()] });
    const body = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers?block_start=500&block_end=100`),
      ),
    );
    assert.equal(body.data.transfer_count, 0);
    assert.deepEqual(body.data.transfers, []);
    assert.equal(body.data.next_cursor, null);
    assert.equal(captures.sql.length, 0);
  });

  test("returns schema-stable empty transfers on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountCounterparties(
      req(`/api/v1/accounts/${SS58}/counterparties`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/counterparties?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects malformed and out-of-range limits before D1 work", async () => {
    for (const limit of ["random_nonce", "Infinity", "0", "101", "10.5"]) {
      const captures = { sql: [], params: [] };
      const { env } = dbWith({ captures, transfers: [transferEventRow()] });
      const res = await handleAccountCounterparties(
        req(`/api/v1/accounts/${SS58}/counterparties?limit=${limit}`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/counterparties?limit=${limit}`),
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "limit");
      assert.equal(
        body.error.message,
        "limit must be an integer from 1 to 100.",
      );
      assert.equal(captures.sql.length, 0);
    }
  });

  test("returns schema-stable empty rollup on cold D1", async () => {
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
    const res = await handleAccountCounterparties(
      req(`/api/v1/accounts/${SS58}/counterparties?format=xml`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/counterparties?format=xml`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "format");
  });

  test("?format=csv exports the list-mode leaderboard as CSV", async () => {
    const { env } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
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
        }),
    };
    const res = await handleAccountCounterparties(
      req(`/api/v1/accounts/${SS58}/counterparties?format=csv`),
      env,
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
  });

  test("empty CSV export still emits the header row", async () => {
    const res = await handleAccountCounterparties(
      req(`/api/v1/accounts/${SS58}/counterparties?format=csv`),
      emptyEnv(),
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
      emptyEnv(),
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
      emptyEnv(),
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
    for (const counterparty of ["not-ss58", SS58]) {
      const captures = { sql: [], params: [] };
      const { env } = dbWith({ captures });
      const res = await handleAccountCounterparties(
        req(`/api/v1/accounts/${SS58}/counterparties`),
        env,
        SS58,
        url(
          `/api/v1/accounts/${SS58}/counterparties?counterparty=${counterparty}`,
        ),
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "counterparty");
      assert.equal(captures.sql.length, 0);
    }

    for (const limit of ["random_nonce", "Infinity", "0", "101", "10.5"]) {
      const captures = { sql: [], params: [] };
      const { env } = dbWith({ captures });
      const res = await handleAccountCounterparties(
        req(`/api/v1/accounts/${SS58}/counterparties`),
        env,
        SS58,
        url(
          `/api/v1/accounts/${SS58}/counterparties?counterparty=${COUNTERPARTY}&limit=${limit}`,
        ),
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "limit");
      assert.equal(
        body.error.message,
        "limit must be an integer from 1 to 100.",
      );
      assert.equal(captures.sql.length, 0);
    }
  });

  test("returns schema-stable empty pair detail on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountStakeFlow(
      req(`/api/v1/accounts/${SS58}/stake-flow`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-flow?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleAccountStakeFlow(
      req(`/api/v1/accounts/${SS58}/stake-flow`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-flow?window=1y`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported direction enum value with 400 (#2694 parity)", async () => {
    const res = await handleAccountStakeFlow(
      req(`/api/v1/accounts/${SS58}/stake-flow`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-flow?direction=invalid`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "direction");
  });

  test("returns schema-stable zeros on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountStakeMoves(
      req(`/api/v1/accounts/${SS58}/stake-moves`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-moves?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleAccountStakeMoves(
      req(`/api/v1/accounts/${SS58}/stake-moves`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/stake-moves?window=1y`),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("returns schema-stable zeros on cold D1", async () => {
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
  test("returns schema-stable empty subnets on cold D1", async () => {
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetEvents(
      req(`/api/v1/subnets/${NETUID}/events`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty events on cold D1", async () => {
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
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events?kind=Nonexistent`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "kind");
  });

  test("short-circuits an inverted block_start>block_end window before D1", async () => {
    const { env, captures } = dbWith({
      subnetEvents: [accountEventRow({ block_number: 500 })],
    });
    const body = await json(
      await handleSubnetEvents(
        req(`/api/v1/subnets/${NETUID}/events`),
        env,
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
    const res = await handleSubnetEvents(
      req(`/api/v1/subnets/${NETUID}/events`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events?block_start=abc`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_start");
  });

  test("rejects a non-integer block_end with 400", async () => {
    const res = await handleSubnetEvents(
      req(`/api/v1/subnets/${NETUID}/events`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events?block_end=oops`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "block_end");
  });
});

describe("handleSubnetEventSummary", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleSubnetEventSummary(
      req(`/api/v1/subnets/${NETUID}/event-summary`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/event-summary?bogus=1`),
    );
    await errorJson(res);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleSubnetEventSummary(
      req(`/api/v1/subnets/${NETUID}/event-summary`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/event-summary?window=365d`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("rejects an invalid recent-event limit with 400", async () => {
    const res = await handleSubnetEventSummary(
      req(`/api/v1/subnets/${NETUID}/event-summary`),
      emptyEnv(),
      NETUID,
      url(`/api/v1/subnets/${NETUID}/event-summary?limit=0`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "limit");
  });

  test("returns schema-stable empty summary on cold D1", async () => {
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
      emptyEnv(),
      "notanss58address",
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_ss58");
  });

  test("returns 400 for a too-short ss58", async () => {
    const short = "5" + "a".repeat(45);
    const res = await handleAccountBalance(
      req(`/api/v1/accounts/${short}/balance`),
      emptyEnv(),
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
          env,
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
          env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountIdentity(
      req(`/api/v1/accounts/${SS58}/identity`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/identity?bogus=1`),
    );
    await errorJson(res);
  });

  test("has_identity is false on cold D1 (schema-stable, never 404)", async () => {
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
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
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
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/identity`),
      ),
    );
    assert.equal(body.data.has_identity, true);
    assert.equal(body.data.name, "Example Team");
  });
});

describe("handleAccountIdentityHistory", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleAccountIdentityHistory(
      req(`/api/v1/accounts/${SS58}/identity-history`),
      emptyEnv(),
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty entries on cold D1", async () => {
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
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
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
        env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleBlocks(
      req("/api/v1/blocks"),
      emptyEnv(),
      url("/api/v1/blocks?bogus=1"),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty feed on cold D1", async () => {
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
      env,
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
      env,
      url("/api/v1/blocks"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^application\/json/);
    assert.equal(res.headers.get("vary"), "Accept, Accept-Encoding");
  });

  test("empty CSV export still emits the header row", async () => {
    const { env } = dbWith({ blocksFeed: [] });
    const res = await handleBlocks(
      req("/api/v1/blocks?format=csv"),
      env,
      url("/api/v1/blocks?format=csv"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/csv/);
    assert.equal(
      await res.text(),
      "block_number,block_hash,parent_hash,author,extrinsic_count,event_count,spec_version,observed_at",
    );
  });

  test("?format=json keeps the JSON envelope even under Accept: text/csv", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const res = await handleBlocks(
      new Request("https://api.metagraph.sh/api/v1/blocks?format=json", {
        headers: { accept: "text/csv" },
      }),
      env,
      url("/api/v1/blocks?format=json"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^application\/json/);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.data.blocks), true);
  });

  test("rejects an unsupported format value with 400", async () => {
    await errorJson(
      await handleBlocks(
        req("/api/v1/blocks?format=xml"),
        emptyEnv(),
        url("/api/v1/blocks?format=xml"),
      ),
    );
  });

  test("clamps limit to <=100", async () => {
    const { env } = dbWith({ blocksFeed: [] });
    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env,
        url("/api/v1/blocks?limit=999"),
      ),
    );
    assert.equal(body.data.limit, 100);
  });

  test("short-circuits impossible count floors before querying D1", async () => {
    const { env, captures } = dbWith({ blocksFeed: [blockRow()] });
    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env,
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
        env,
        url("/api/v1/blocks?block_start=20&block_end=10&from=200&to=100"),
      ),
    );
    assert.equal(body.data.block_count, 0);
    assert.deepEqual(body.data.blocks, []);
    assert.equal(captures.sql.length, 0);
  });
});

describe("handleBlock", () => {
  test("returns schema-stable block:null on cold D1", async () => {
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
      emptyEnv(),
      String(BLOCK_NUM),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /max-age=60/);
    assert.equal(res.headers.get("x-metagraph-cache-profile"), "short");
  });
});

describe("handleBlockExtrinsics", () => {
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleBlockExtrinsics(
      req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
      emptyEnv(),
      String(BLOCK_NUM),
      url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty extrinsics on cold D1", async () => {
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
        env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleBlockEvents(
      req(`/api/v1/blocks/${BLOCK_NUM}/events`),
      emptyEnv(),
      String(BLOCK_NUM),
      url(`/api/v1/blocks/${BLOCK_NUM}/events?bogus=1`),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty events on cold D1", async () => {
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
        env,
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
        env,
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
  test("rejects an unsupported query param with 400", async () => {
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      emptyEnv(),
      url("/api/v1/extrinsics?bogus=1"),
    );
    await errorJson(res);
  });

  test("returns schema-stable empty feed on cold D1", async () => {
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
    const { env, captures } = dbWith({ extrinsics: [] });
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url("/api/v1/extrinsics?success=1"),
    );
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
    const { env, captures } = dbWith({ extrinsics: [] });
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url("/api/v1/extrinsics?call_hash=not-a-hash"),
    );
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
      env,
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
    const { env, captures } = dbWith({ extrinsics: [] });
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url("/api/v1/extrinsics?from=abc"),
    );
    await errorJson(res);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits impossible future time filters before D1", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url("/api/v1/extrinsics?from=9007199254740991"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits an expired to< retention-floor window before D1", async () => {
    // to=2000 (1970 epoch) is below the retained hot window floor; every
    // candidate row would already be pruned, so never touch D1.
    const { env, captures } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url("/api/v1/extrinsics?to=2000"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits an inverted from>to window before D1", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const now = Date.now();
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url(`/api/v1/extrinsics?from=${now}&to=${now - 60_000}`),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(
      captures.sql.filter((s: string) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("short-circuits an inverted block_start>block_end window before D1", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url("/api/v1/extrinsics?block_start=500&block_end=100"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 0);
    assert.deepEqual(body.data.extrinsics, []);
    assert.equal(captures.sql.length, 0);
  });

  test("clamps limit to <=100", async () => {
    const { env } = dbWith({ extrinsics: [] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url("/api/v1/extrinsics?limit=500"),
      ),
    );
    assert.equal(body.data.limit, 100);
  });

  const EXTRINSICS_CSV_HEADER =
    "extrinsic_id,block_number,signer,call_module,call_function,success";

  test("Accept: text/csv negotiates CSV on the extrinsics feed", async () => {
    const { env } = dbWith({ extrinsics: [extrinsicRow()] });
    const res = await handleExtrinsics(
      new Request("https://api.metagraph.sh/api/v1/extrinsics?limit=10", {
        headers: { accept: "text/csv" },
      }),
      env,
      url("/api/v1/extrinsics?limit=10"),
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type") || "",
      "text/csv; charset=utf-8",
    );
  });

  test("?format=csv emits a header-only export on cold D1", async () => {
    const res = await handleExtrinsics(
      req("/api/v1/extrinsics"),
      emptyEnv(),
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
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        emptyEnv(),
        url("/api/v1/extrinsics?format=pdf"),
      ),
    );
    assert.equal(body.meta.parameter, "format");
  });
});

describe("handleExtrinsic", () => {
  test("returns schema-stable extrinsic:null on cold D1", async () => {
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
        emptyEnv(),
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

  test("flag=postgres + DATA_API succeeds: Postgres data wins, D1 never queried", async () => {
    const { env, captures } = dbWith({ blocksFeed: [blockRow()] });
    env.METAGRAPH_BLOCKS_SOURCE = "postgres";
    env.DATA_API = dataApi(
      Response.json({ schema_version: 1, block_count: 99, blocks: [] }),
    );
    const body = await json(
      await handleBlocks(req("/api/v1/blocks"), env, url("/api/v1/blocks")),
    );
    assert.equal(body.data.block_count, 99); // the Postgres fixture, not D1's
    assert.deepEqual(captures.sql, []); // D1 was never touched
  });

  test("handleBlock: flag=postgres uses Postgres data over the D1 fixture", async () => {
    const { env, captures } = dbWith({ blockDetail: blockRow() });
    env.METAGRAPH_BLOCKS_SOURCE = "postgres";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        ref: String(BLOCK_NUM),
        block: { ...blockRow(), author: "postgres-author" },
        prev_block_number: null,
        next_block_number: null,
      }),
    );
    const body = await json(
      await handleBlock(
        req(`/api/v1/blocks/${BLOCK_NUM}`),
        env,
        String(BLOCK_NUM),
      ),
    );
    assert.equal(body.data.block.author, "postgres-author");
    assert.deepEqual(captures.sql, []);
  });

  test("handleExtrinsics: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        extrinsic_count: 99,
        limit: 50,
        offset: 0,
        next_cursor: null,
        extrinsics: [],
      }),
    );
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url("/api/v1/extrinsics"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleExtrinsic: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ extrinsicDetail: extrinsicRow() });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        ref: HASH,
        extrinsic: { ...extrinsicRow(), signer: "postgres-signer" },
        events: [],
      }),
    );
    const body = await json(
      await handleExtrinsic(req(`/api/v1/extrinsics/${HASH}`), env, HASH),
    );
    assert.equal(body.data.extrinsic.signer, "postgres-signer");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountEvents: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        ss58: SS58,
        event_count: 99,
        limit: 50,
        offset: 0,
        next_cursor: null,
        events: [],
      }),
    );
    const path = `/api/v1/accounts/${SS58}/events`;
    const body = await json(
      await handleAccountEvents(req(path), env, SS58, url(path)),
    );
    assert.equal(body.data.event_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  // #4771: neurons/neuron_daily's new Postgres tier, same shared-fallback
  // wiring as blocks/extrinsics/account_events above (METAGRAPH_NEURONS_SOURCE).
  test("handleSubnetMetagraph: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
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
      await handleSubnetMetagraph(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.neuron_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleNeuron: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
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
        env,
        NETUID,
        UID,
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
  test("handleSubnetHyperparams: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ subnetHyperparams: [hyperparamsRow()] });
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "postgres";
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
      await handleSubnetHyperparams(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.hyperparameters.tempo, 999);
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetHyperparams: flag=postgres falls back to schema-stable null on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/subnets/${NETUID}/hyperparameters`;
    const body = await json(
      await handleSubnetHyperparams(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.hyperparameters, null);
    assert.equal(body.data.captured_at, null);
  });

  test("handleSubnetHyperparamsHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      subnetHyperparamsHistory: [hyperparamsHistoryRow()],
    });
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "postgres";
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
      await handleSubnetHyperparamsHistory(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.entries[0].hyperparams_hash, "pg-hash");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetHyperparamsHistory: flag=postgres falls back to schema-stable empty on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_SUBNET_HYPERPARAMS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/subnets/${NETUID}/hyperparameters/history`;
    const body = await json(
      await handleSubnetHyperparamsHistory(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  // #4832 gap-closure: account_identity/account_identity_history's new
  // Postgres tier, own dedicated flag (METAGRAPH_ACCOUNT_IDENTITY_SOURCE).
  test("handleAccountIdentity: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      accountIdentity: [accountIdentityRow()],
    });
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "postgres";
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
      await handleAccountIdentity(req(path), env, SS58, url(path)),
    );
    assert.equal(body.data.name, "Postgres Team");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountIdentity: flag=postgres falls back to schema-stable null on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/accounts/${SS58}/identity`;
    const body = await json(
      await handleAccountIdentity(req(path), env, SS58, url(path)),
    );
    assert.equal(body.data.has_identity, false);
    assert.equal(body.data.name, null);
  });

  test("handleAccountIdentityHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
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
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "postgres";
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
      await handleAccountIdentityHistory(req(path), env, SS58, url(path)),
    );
    assert.equal(body.data.entries[0].identity_hash, "pg-hash");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountIdentityHistory: flag=postgres falls back to schema-stable empty on failure (D1 retired)", async () => {
    const env: Row = {};
    env.METAGRAPH_ACCOUNT_IDENTITY_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const path = `/api/v1/accounts/${SS58}/identity-history`;
    const body = await json(
      await handleAccountIdentityHistory(req(path), env, SS58, url(path)),
    );
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  // #4832 gap-closure: subnet_identity_history's new Postgres tier, own
  // dedicated flag (METAGRAPH_SUBNET_IDENTITY_SOURCE). Written from the main
  // Worker's own hourly cron (writeSubnetSnapshot), not an external GitHub
  // Actions workflow -- but served the same way as every other tier here.
  test("handleSubnetIdentityHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      subnetIdentityHistory: [identityHistoryRow()],
    });
    env.METAGRAPH_SUBNET_IDENTITY_SOURCE = "postgres";
    env.DATA_API = dataApi(
      Response.json({
        schema_version: 1,
        netuid: NETUID,
        entry_count: 1,
        limit: null,
        offset: null,
        next_cursor: null,
        entries: [{ identity_hash: "pg-hash" }],
      }),
    );
    const path = `/api/v1/subnets/${NETUID}/identity-history`;
    const body = await json(
      await handleSubnetIdentityHistory(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.entries[0].identity_hash, "pg-hash");
    assert.deepEqual(captures.sql, []);
  });

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
      await handleSubnetIdentityHistory(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  test("handleSubnetValidators: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
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
      await handleSubnetValidators(req(path), env, NETUID, url(path)),
    );
    assert.equal(body.data.validator_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleGlobalValidators: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      neurons: [neuronRow({ netuid: NETUID })],
    });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
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
        env,
        url("/api/v1/validators"),
      ),
    );
    assert.equal(body.data.validator_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleValidatorDetail: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
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
      await handleValidatorDetail(req(`/api/v1/validators/${SS58}`), env, SS58),
    );
    assert.equal(body.data.subnet_count, 99);
    assert.deepEqual(captures.sql, []);
  });

  test("handleValidatorNominators: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleValidatorNominators(
        req(`/api/v1/validators/${SS58}/nominators`),
        env,
        SS58,
        url(`/api/v1/validators/${SS58}/nominators`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountWeightSetters: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountWeightSetters(
        req(`/api/v1/accounts/${SS58}/weight-setters`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/weight-setters`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetWeightSetters: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetWeightSetters(
        req(`/api/v1/subnets/${NETUID}/weights/setters`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/weights/setters`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountStakeFlow: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountStakeFlow(
        req(`/api/v1/accounts/${SS58}/stake-flow`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/stake-flow`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetStakeFlow: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleSubnetStakeFlow(
        req(`/api/v1/subnets/${NETUID}/stake-flow`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-flow`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountStakeMoves: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountStakeMoves(
        req(`/api/v1/accounts/${SS58}/stake-moves`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/stake-moves`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetStakeMoves: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetStakeMoves(
        req(`/api/v1/subnets/${NETUID}/stake-moves`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-moves`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetStakeTransfers: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetStakeTransfers(
        req(`/api/v1/subnets/${NETUID}/stake-transfers`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-transfers`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountRegistrations: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountRegistrations(
        req(`/api/v1/accounts/${SS58}/registrations`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/registrations`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetRegistrations: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetRegistrations(
        req(`/api/v1/subnets/${NETUID}/registrations`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/registrations`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountServing: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountServing(
        req(`/api/v1/accounts/${SS58}/serving`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/serving`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetServing: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetServing(
        req(`/api/v1/subnets/${NETUID}/serving`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/serving`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountAxonRemovals: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountAxonRemovals(
        req(`/api/v1/accounts/${SS58}/axon-removals`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/axon-removals`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetAxonRemovals: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetAxonRemovals(
        req(`/api/v1/subnets/${NETUID}/axon-removals`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/axon-removals`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountPrometheus: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountPrometheus(
        req(`/api/v1/accounts/${SS58}/prometheus`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/prometheus`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetPrometheus: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetPrometheus(
        req(`/api/v1/subnets/${NETUID}/prometheus`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/prometheus`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountDeregistrations: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleAccountDeregistrations(
        req(`/api/v1/accounts/${SS58}/deregistrations`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/deregistrations`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetDeregistrations: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleSubnetDeregistrations(
        req(`/api/v1/subnets/${NETUID}/deregistrations`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/deregistrations`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountTransfers: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", transfers: [] }),
    };
    const body = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountCounterparties: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleAccountCounterparties(
        req(`/api/v1/accounts/${SS58}/counterparties`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/counterparties`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountCounterparties: flag=postgres accepts relationship drilldown envelope", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
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
        env,
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

  test("handleBlockExtrinsics: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg", extrinsics: [] },
        }),
    };
    const body = await json(
      await handleBlockExtrinsics(
        req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
        env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleBlockEvents: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ blockEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg", events: [] },
        }),
    };
    const body = await json(
      await handleBlockEvents(
        req(`/api/v1/blocks/${BLOCK_NUM}/events`),
        env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/events`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleBlocksSummary: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ blocksFeed: [blockRow()] });
    env.METAGRAPH_BLOCKS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", block_count: 0 }),
    };
    const body = await json(
      await handleBlocksSummary(
        req("/api/v1/blocks/summary"),
        env,
        url("/api/v1/blocks/summary"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountExtrinsics: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ extrinsics: [extrinsicRow()] });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", extrinsics: [] }),
    };
    const body = await json(
      await handleAccountExtrinsics(
        req(`/api/v1/accounts/${SS58}/extrinsics`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/extrinsics`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSudo: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      extrinsics: [extrinsicRow({ call_module: "Sudo" })],
    });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", extrinsics: [] }),
    };
    const body = await json(
      await handleSudo(req("/api/v1/sudo"), env, url("/api/v1/sudo")),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleGovernanceConfigChanges: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      extrinsics: [extrinsicRow({ call_module: "AdminUtils" })],
    });
    env.METAGRAPH_EXTRINSICS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", extrinsics: [] }),
    };
    const body = await json(
      await handleGovernanceConfigChanges(
        req("/api/v1/governance/config-changes"),
        env,
        url("/api/v1/governance/config-changes"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleRuntime: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ blocksFeed: [blockRow()] });
    env.METAGRAPH_BLOCKS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", transitions: [] }),
    };
    const body = await json(
      await handleRuntime(req("/api/v1/runtime"), env, url("/api/v1/runtime")),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #6392: /runtime was the one Explorer list page with no CSV export, because
  // the route rejected every query param -- ?format=csv 400'd before it could
  // reach the handler.
  describe("handleRuntime CSV export (#6392)", () => {
    function pgEnv(transitions: Row[]) {
      const { env } = dbWith({ blocksFeed: [blockRow()] });
      env.METAGRAPH_BLOCKS_SOURCE = "postgres";
      env.DATA_API = {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            transitions,
            transition_count: transitions.length,
            current_spec_version: transitions.at(-1)?.spec_version ?? null,
            coverage_from_block: transitions[0]?.block_number ?? null,
            coverage_from_at: transitions[0]?.observed_at ?? null,
          }),
      };
      return env;
    }

    const ROWS = [
      {
        spec_version: 423,
        block_number: 8000000,
        observed_at: "2026-06-25T00:00:00.000Z",
      },
      {
        spec_version: 424,
        block_number: 8100000,
        observed_at: "2026-07-01T00:00:00.000Z",
      },
    ];

    test("?format=csv exports the transition timeline with the on-screen columns", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?format=csv"),
        pgEnv(ROWS),
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
        pgEnv(ROWS),
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
        pgEnv(ROWS),
        url("/api/v1/runtime?format=json"),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /application\/json/);
    });

    test("a cold store yields a header-only CSV, never an error", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?format=csv"),
        pgEnv([]),
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
        pgEnv(ROWS),
        url("/api/v1/runtime?format=bogus"),
      );
      assert.equal(res.status, 400);
    });

    test("an unknown query param is still rejected (format is the only one)", async () => {
      const res = await handleRuntime(
        req("/api/v1/runtime?limit=5"),
        pgEnv(ROWS),
        url("/api/v1/runtime?limit=5"),
      );
      assert.equal(res.status, 400);
    });
  });

  // #4832 Tier 1b: the remaining account_events-derived handlers with no
  // Postgres tier at all -- same pattern as Tier 1a above.

  test("handleSubnetWeights: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", weight_sets: 0 }),
    };
    const body = await json(
      await handleSubnetWeights(
        req(`/api/v1/subnets/${NETUID}/weights`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/weights`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetAlphaVolume: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          data: { schema_version: 1, marker: "pg" },
          generatedAt: null,
        }),
    };
    const body = await json(
      await handleSubnetAlphaVolume(
        req(`/api/v1/subnets/${NETUID}/volume`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/volume`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetEvents: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ subnetEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", events: [] }),
    };
    const body = await json(
      await handleSubnetEvents(
        req(`/api/v1/subnets/${NETUID}/events`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/events`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetEventSummary: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({
      subnetEventSummaryKinds: [],
      subnetEventSummaryRecent: [],
    });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", event_kinds: [] }),
    };
    const body = await json(
      await handleSubnetEventSummary(
        req(`/api/v1/subnets/${NETUID}/event-summary`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/event-summary`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 Tier 1c: handleAccount (multi-table: account_events + neurons +
  // extrinsics) and handleAccountSubnets (neurons-derived).

  test("handleAccount: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ accountEvents: [accountEventRow()] });
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", event_count: 0 }),
    };
    const body = await json(
      await handleAccount(req(`/api/v1/accounts/${SS58}`), env, SS58),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountSubnets: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", subnets: [] }),
    };
    const body = await json(
      await handleAccountSubnets(
        req(`/api/v1/accounts/${SS58}/subnets`),
        env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 Tier 2a: the 8 flat-`neurons` handlers (concentration, performance,
  // yield, portfolio, accounts list) across the subnet/chain/account scopes.

  test("handleSubnetConcentration: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", netuid: NETUID }),
    };
    const body = await json(
      await handleSubnetConcentration(
        req(`/api/v1/subnets/${NETUID}/concentration`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/concentration`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetPerformance: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", netuid: NETUID }),
    };
    const body = await json(
      await handleSubnetPerformance(
        req(`/api/v1/subnets/${NETUID}/performance`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/performance`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetYield: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", neurons: [] }),
    };
    const body = await json(
      await handleSubnetYield(
        req(`/api/v1/subnets/${NETUID}/yield`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/yield`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainConcentration: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainConcentration(
        req("/api/v1/chain/concentration"),
        env,
        url("/api/v1/chain/concentration"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainPerformance: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainPerformance(
        req("/api/v1/chain/performance"),
        env,
        url("/api/v1/chain/performance"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainYield: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => Response.json({ schema_version: 1, marker: "pg" }),
    };
    const body = await json(
      await handleChainYield(
        req("/api/v1/chain/yield"),
        env,
        url("/api/v1/chain/yield"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountPortfolio: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", positions: [] }),
    };
    const body = await json(
      await handleAccountPortfolio(
        req(`/api/v1/accounts/${SS58}/portfolio`),
        env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountPositions: flag=postgres uses Postgres data, D1 never queried (#5233)", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", positions: [] }),
    };
    const body = await json(
      await handleAccountPositions(
        req(`/api/v1/accounts/${SS58}/positions`),
        env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountPositions: flag=postgres degrades to an empty schema-stable card on failure, D1 never queried (#5233)", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const body = await json(
      await handleAccountPositions(
        req(`/api/v1/accounts/${SS58}/positions`),
        env,
        SS58,
      ),
    );
    assert.equal(body.data.marker, undefined);
    assert.equal(body.data.ss58, SS58);
    assert.deepEqual(body.data.positions, []);
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_stake_tao, 0);
    assert.deepEqual(captures.sql, []);
  });

  test("handleAccountsList: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", accounts: [] }),
    };
    const body = await json(
      await handleAccountsList(
        req("/api/v1/accounts"),
        env,
        url("/api/v1/accounts"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // Called directly (bypassing workers/api.mjs's canonicalTopHoldersCachePath,
  // which already validates and short-circuits on a bad query before ever
  // reaching this handler) so handleTopHoldersList's own defensive
  // parsed.error guard -- the same defense-in-depth shape as every other
  // handler in this file -- is exercised too.
  test("handleTopHoldersList: rejects an unsupported query param with 400", async () => {
    const res = await handleTopHoldersList(
      req("/api/v1/accounts/top-holders?bogus=1"),
      emptyEnv(),
      url("/api/v1/accounts/top-holders?bogus=1"),
    );
    const body = await errorJson(res);
    assert.equal(body.error.code, "invalid_query");
  });

  test("handleTopHoldersList: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_TOP_HOLDERS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", accounts: [] }),
    };
    const body = await json(
      await handleTopHoldersList(
        req("/api/v1/accounts/top-holders"),
        env,
        url("/api/v1/accounts/top-holders"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 Tier 2b: the 9 neuron_daily-history handlers (structural history,
  // concentration/performance/yield history, chain/subnet turnover, movers).

  test("handleValidatorHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleValidatorHistory(
        req(`/api/v1/validators/${SS58}/history`),
        env,
        SS58,
        url(`/api/v1/validators/${SS58}/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleNeuronHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleNeuronHistory(
        req(`/api/v1/subnets/${NETUID}/neurons/1/history`),
        env,
        NETUID,
        1,
        url(`/api/v1/subnets/${NETUID}/neurons/1/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetHistory(
        req(`/api/v1/subnets/${NETUID}/history`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetConcentrationHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetConcentrationHistory(
        req(`/api/v1/subnets/${NETUID}/concentration/history`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/concentration/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetPerformanceHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetPerformanceHistory(
        req(`/api/v1/subnets/${NETUID}/performance/history`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/performance/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetYieldHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleSubnetYieldHistory(
        req(`/api/v1/subnets/${NETUID}/yield/history`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/yield/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleChainTurnover: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", subnets: [] }),
    };
    const body = await json(
      await handleChainTurnover(
        req("/api/v1/chain/turnover"),
        env,
        url("/api/v1/chain/turnover"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetTurnover: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", subnets: [] }),
    };
    const body = await json(
      await handleSubnetTurnover(
        req(`/api/v1/subnets/${NETUID}/turnover`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/turnover`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  test("handleSubnetMovers: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", movers: [] }),
    };
    const body = await json(
      await handleSubnetMovers(
        req("/api/v1/subnets/movers"),
        env,
        url("/api/v1/subnets/movers"),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // #4832 gap-closure: handleAccountPositionHistory (account_position_daily,
  // rolled from the same neurons snapshot as neuron_daily).

  test("handleAccountPositionHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", points: [] }),
    };
    const body = await json(
      await handleAccountPositionHistory(
        req(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
        env,
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
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
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
      env,
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

  // No D1 fallback here (unlike the ~40 branches #4909 tracks separately):
  // D1's own account_position_daily rollup has been permanently broken since
  // #4908 dropped D1's `neurons` table, so a Postgres failure degrades to the
  // same schema-stable empty series a cold store returns, never a D1 read.
  test("handleAccountPositionHistory: flag=postgres degrades to an empty schema-stable series on failure, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const body = await json(
      await handleAccountPositionHistory(
        req(`/api/v1/accounts/${SS58}/subnets/${NETUID}/history`),
        env,
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

  test("handleAccountHistory: flag=postgres uses Postgres data, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, marker: "pg", days: [] }),
    };
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/history`),
      ),
    );
    assert.equal(body.data.marker, "pg");
    assert.deepEqual(captures.sql, []);
  });

  // D1 fully eliminated (2026-07-17): a Postgres-tier failure now falls
  // through to the schema-stable empty shape, never a live D1 read.
  test("handleAccountHistory: flag=postgres falls back to schema-stable empty on failure, D1 never queried", async () => {
    const { env, captures } = dbWith({});
    env.METAGRAPH_ACCOUNT_EVENTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env,
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

  test("every handler returns an envelope with ok:true on cold D1 (sample)", async () => {
    const samples = [
      () =>
        handleSubnetMetagraph(
          req(`/api/v1/subnets/${NETUID}/metagraph`),
          emptyEnv(),
          NETUID,
          url(`/api/v1/subnets/${NETUID}/metagraph`),
        ),
      () =>
        handleNeuron(
          req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
          emptyEnv(),
          NETUID,
          UID,
        ),
      () => handleAccount(req(`/api/v1/accounts/${SS58}`), emptyEnv(), SS58),
      () =>
        handleBlocks(req("/api/v1/blocks"), emptyEnv(), url("/api/v1/blocks")),
      () =>
        handleExtrinsic(req(`/api/v1/extrinsics/${HASH}`), emptyEnv(), HASH),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
          SS58,
        ),
      assertData: (d: Row) => assert.equal(d.subnet_count, 0),
    },
    {
      name: "handleSubnetEvents",
      run: () =>
        handleSubnetEvents(
          req(`/api/v1/subnets/${NETUID}/events`),
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
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
          emptyEnv(),
          url("/api/v1/extrinsics"),
        ),
      assertData: (d: Row) => assert.equal(d.extrinsic_count, 0),
    },
  ];

  for (const { name, run, assertData } of coldCases) {
    test(`${name} never 404s on cold D1`, async () => {
      const res = await run();
      assert.equal(res.status, 200);
      const body = await jsonBody(res);
      assert.equal(body.ok, true);
      assertData(body.data);
    });
  }
});

describe("query-param guard matrix (#1900)", () => {
  const unsupportedCases = [
    {
      name: "handleSubnetMetagraph",
      run: () =>
        handleSubnetMetagraph(
          req(`/api/v1/subnets/${NETUID}/metagraph`),
          emptyEnv(),
          NETUID,
          url(`/api/v1/subnets/${NETUID}/metagraph?foo=bar`),
        ),
    },
    {
      name: "handleSubnetValidators",
      run: () =>
        handleSubnetValidators(
          req(`/api/v1/subnets/${NETUID}/validators`),
          emptyEnv(),
          NETUID,
          url(`/api/v1/subnets/${NETUID}/validators?foo=bar`),
        ),
    },
    {
      name: "handleNeuronHistory",
      run: () =>
        handleNeuronHistory(
          req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
          emptyEnv(),
          NETUID,
          UID,
          url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history?foo=bar`),
        ),
    },
    {
      name: "handleSubnetHistory",
      run: () =>
        handleSubnetHistory(
          req(`/api/v1/subnets/${NETUID}/history`),
          emptyEnv(),
          NETUID,
          url(`/api/v1/subnets/${NETUID}/history?foo=bar`),
        ),
    },
    {
      name: "handleSubnetIdentityHistory",
      run: () =>
        handleSubnetIdentityHistory(
          req(`/api/v1/subnets/${NETUID}/identity-history`),
          emptyEnv(),
          NETUID,
          url(`/api/v1/subnets/${NETUID}/identity-history?foo=bar`),
        ),
    },
    {
      name: "handleAccountEvents",
      run: () =>
        handleAccountEvents(
          req(`/api/v1/accounts/${SS58}/events`),
          emptyEnv(),
          SS58,
          url(`/api/v1/accounts/${SS58}/events?foo=bar`),
        ),
    },
    {
      name: "handleAccountHistory",
      run: () =>
        handleAccountHistory(
          req(`/api/v1/accounts/${SS58}/history`),
          emptyEnv(),
          SS58,
          url(`/api/v1/accounts/${SS58}/history?foo=bar`),
        ),
    },
    {
      name: "handleAccountExtrinsics",
      run: () =>
        handleAccountExtrinsics(
          req(`/api/v1/accounts/${SS58}/extrinsics`),
          emptyEnv(),
          SS58,
          url(`/api/v1/accounts/${SS58}/extrinsics?foo=bar`),
        ),
    },
    {
      name: "handleAccountTransfers",
      run: () =>
        handleAccountTransfers(
          req(`/api/v1/accounts/${SS58}/transfers`),
          emptyEnv(),
          SS58,
          url(`/api/v1/accounts/${SS58}/transfers?foo=bar`),
        ),
    },
    {
      name: "handleSubnetEvents",
      run: () =>
        handleSubnetEvents(
          req(`/api/v1/subnets/${NETUID}/events`),
          emptyEnv(),
          NETUID,
          url(`/api/v1/subnets/${NETUID}/events?foo=bar`),
        ),
    },
    {
      name: "handleBlocks",
      run: () =>
        handleBlocks(
          req("/api/v1/blocks"),
          emptyEnv(),
          url("/api/v1/blocks?foo=bar"),
        ),
    },
    {
      name: "handleBlockExtrinsics",
      run: () =>
        handleBlockExtrinsics(
          req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
          emptyEnv(),
          String(BLOCK_NUM),
          url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics?foo=bar`),
        ),
    },
    {
      name: "handleBlockEvents",
      run: () =>
        handleBlockEvents(
          req(`/api/v1/blocks/${BLOCK_NUM}/events`),
          emptyEnv(),
          String(BLOCK_NUM),
          url(`/api/v1/blocks/${BLOCK_NUM}/events?foo=bar`),
        ),
    },
    {
      name: "handleExtrinsics",
      run: () =>
        handleExtrinsics(
          req("/api/v1/extrinsics"),
          emptyEnv(),
          url("/api/v1/extrinsics?foo=bar"),
        ),
    },
  ];

  for (const { name, run } of unsupportedCases) {
    test(`${name} → 400 on unsupported query param`, async () => {
      const body = await errorJson(await run());
      assert.equal(body.error.code, "invalid_query");
    });
  }
});

describe("envelope + meta contracts (#1900)", () => {
  test("metagraph handlers set source metagraph-snapshot", async () => {
    const { env } = dbWith({ neurons: [neuronRow()] });
    const body = await json(
      await handleNeuron(
        req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        env,
        NETUID,
        UID,
      ),
    );
    assert.equal(body.meta.source, "metagraph-snapshot");
    assert.ok(body.meta.contract_version);
    assert.ok(
      resHasEtag(
        await handleNeuron(
          req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
          env,
          NETUID,
          UID,
        ),
      ),
    );
  });

  test("chain-events handlers set source chain-events", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const res = await handleBlocks(
      req("/api/v1/blocks"),
      env,
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
        env,
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
// by workers/request-handlers/entities.mjs. When adding a new handler test,
// prefer reusing these rows so formatters stay aligned with production schemas.
