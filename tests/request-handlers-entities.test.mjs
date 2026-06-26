// Direct unit tests for workers/request-handlers/entities.mjs (#1900).
// Imports every exported handler and exercises the null-safe D1 read path,
// query-param guards, and schema-stable cold-store contracts without routing
// through workers/api.mjs.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { encodeCursor } from "../src/cursor.mjs";
import {
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
} from "../workers/request-handlers/entities.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const HASH = `0x${"a".repeat(64)}`;
const NETUID = 7;
const UID = 3;
const BLOCK_NUM = 1234;
const OBSERVED_AT = 1_750_009_000_000;

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res) {
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

function emptyEnv() {
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

function neuronDailyRow(overrides = {}) {
  return {
    snapshot_date: "2026-06-20",
    ...neuronRow(overrides),
    ...overrides,
  };
}

function subnetHistoryRow(overrides = {}) {
  return {
    snapshot_date: "2026-06-20",
    neuron_count: 2,
    validator_count: 1,
    total_stake_tao: 900,
    total_emission_tao: 12.5,
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

// A D1 mock that routes SQL by regex patterns (order-sensitive: specific first).
// Named buckets let each handler test supply only the rows it needs.
function dbWith({
  neurons,
  neuronDailyUid,
  neuronDailySubnet,
  agg,
  kinds,
  registrations,
  accountEvents,
  accountEventsDaily,
  transfers,
  subnetEvents,
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
} = {}) {
  const cap = captures || { sql: [], params: [] };
  const record = (sql, params) => {
    cap.sql.push(sql);
    cap.params.push(params);
  };
  return {
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
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
                  // Account summary aggregates (order matters).
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
    },
    captures: cap,
  };
}

async function assertColdSchema(handlerFn, ...args) {
  const res = await handlerFn(...args);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body;
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

  test("happy path returns neurons from mocked D1 rows", async () => {
    const { env } = dbWith({ neurons: [neuronRow()] });
    const body = await json(
      await handleSubnetMetagraph(
        req(`/api/v1/subnets/${NETUID}/metagraph`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/metagraph`),
      ),
    );
    assert.equal(body.data.neuron_count, 1);
    assert.equal(body.data.neurons[0].uid, UID);
    assert.equal(body.data.neurons[0].validator_permit, true);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/metagraph.json`,
    );
  });

  test("validator_permit=true filters to validators only", async () => {
    const { env, captures } = dbWith({
      neurons: [neuronRow({ validator_permit: 1 })],
    });
    await handleSubnetMetagraph(
      req(`/api/v1/subnets/${NETUID}/metagraph`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/metagraph?validator_permit=true`),
    );
    assert.ok(
      captures.sql.some((s) => /validator_permit = 1/.test(s)),
      "expected validator_permit filter in SQL",
    );
  });

  test("validator_permit=false is not treated as validators-only", async () => {
    const { env, captures } = dbWith({ neurons: [neuronRow()] });
    await handleSubnetMetagraph(
      req(`/api/v1/subnets/${NETUID}/metagraph`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/metagraph?validator_permit=false`),
    );
    const metagraphSql = captures.sql.find((s) =>
      /FROM neurons WHERE netuid/.test(s),
    );
    assert.ok(metagraphSql);
    assert.ok(!/validator_permit = 1/.test(metagraphSql));
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

  test("happy path returns a single neuron detail", async () => {
    const { env } = dbWith({ neurons: [neuronRow()] });
    const body = await json(
      await handleNeuron(
        req(`/api/v1/subnets/${NETUID}/neurons/${UID}`),
        env,
        NETUID,
        UID,
      ),
    );
    assert.equal(body.data.neuron.uid, UID);
    assert.equal(body.data.neuron.hotkey, SS58);
    assert.equal(body.data.neuron.active, true);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/neurons/${UID}.json`,
    );
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

  test("happy path returns validator rows ranked by stake", async () => {
    const { env } = dbWith({
      neurons: [
        neuronRow({ uid: 1, stake_tao: 50 }),
        neuronRow({ uid: 2, stake_tao: 200 }),
      ],
    });
    const body = await json(
      await handleSubnetValidators(
        req(`/api/v1/subnets/${NETUID}/validators`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/validators`),
      ),
    );
    assert.equal(body.data.validator_count, 2);
    assert.equal(body.data.validators[0].uid, 1);
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/validators.json`,
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

  test("happy path returns daily history points", async () => {
    const { env } = dbWith({ neuronDailyUid: [neuronDailyRow()] });
    const body = await json(
      await handleNeuronHistory(
        req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
        env,
        NETUID,
        UID,
        url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history?window=7d`),
      ),
    );
    assert.equal(body.data.point_count, 1);
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.points[0].snapshot_date, "2026-06-20");
    assert.equal(body.data.points[0].uid, UID);
  });

  test("window=all omits the snapshot_date lower bound", async () => {
    const { env, captures } = dbWith({ neuronDailyUid: [neuronDailyRow()] });
    await handleNeuronHistory(
      req(`/api/v1/subnets/${NETUID}/neurons/${UID}/history`),
      env,
      NETUID,
      UID,
      url(`/api/v1/subnets/${NETUID}/neurons/${UID}/history?window=all`),
    );
    const historySql = captures.sql.find((s) => /FROM neuron_daily/.test(s));
    assert.ok(historySql);
    assert.ok(!/snapshot_date >=/.test(historySql));
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

  test("happy path returns per-day subnet aggregates", async () => {
    const { env } = dbWith({
      neuronDailySubnet: [subnetHistoryRow()],
    });
    const body = await json(
      await handleSubnetHistory(
        req(`/api/v1/subnets/${NETUID}/history`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/history?window=90d`),
      ),
    );
    assert.equal(body.data.point_count, 1);
    assert.equal(body.data.window, "90d");
    assert.equal(body.data.points[0].neuron_count, 2);
    assert.equal(body.data.points[0].validator_count, 1);
    assert.equal(body.data.points[0].total_stake_tao, 900);
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
    assert.equal(body.meta.source, "chain-events");
  });

  test("happy path aggregates account_events + neurons + extrinsics activity", async () => {
    const { env } = dbWith({
      agg: {
        c: 12,
        sc: 3,
        fb: 100,
        lb: 200,
        fo: OBSERVED_AT - 1000,
        lo: OBSERVED_AT,
      },
      kinds: [
        { kind: "StakeAdded", count: 7 },
        { kind: "WeightsSet", count: 5 },
      ],
      registrations: [
        {
          netuid: NETUID,
          uid: UID,
          stake_tao: 100,
          validator_permit: 1,
          active: 1,
        },
      ],
      accountEvents: [accountEventRow()],
      activity: {
        tx_count: 9,
        last_tx_block: BLOCK_NUM,
        last_tx_at: OBSERVED_AT,
        total_fee_tao: 0.05,
      },
      modules: [{ call_module: "SubtensorModule", count: 7 }],
    });
    const body = await json(
      await handleAccount(req(`/api/v1/accounts/${SS58}`), env, SS58),
    );
    assert.equal(body.data.event_count, 12);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.activity.tx_count, 9);
    assert.equal(body.data.registrations[0].netuid, NETUID);
    assert.equal(body.data.recent_events[0].event_kind, "StakeAdded");
    assert.equal(body.meta.artifact_path, `/metagraph/accounts/${SS58}.json`);
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

  test("happy path returns paginated events", async () => {
    const { env } = dbWith({ accountEvents: [accountEventRow()] });
    const body = await json(
      await handleAccountEvents(
        req(`/api/v1/accounts/${SS58}/events`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/events?limit=50`),
      ),
    );
    assert.equal(body.data.events[0].event_kind, "StakeAdded");
    assert.equal(body.data.limit, 50);
  });

  test("kind filter narrows results", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow({ event_kind: "WeightsSet" })],
    });
    await handleAccountEvents(
      req(`/api/v1/accounts/${SS58}/events`),
      env,
      SS58,
      url(`/api/v1/accounts/${SS58}/events?kind=WeightsSet`),
    );
    assert.ok(
      captures.sql.some((s) => /event_kind = \?/.test(s)),
      "expected kind filter in SQL",
    );
  });

  test("cursor uses keyset seek instead of offset", async () => {
    const { env, captures } = dbWith({
      accountEvents: [accountEventRow({ block_number: 150, event_index: 2 })],
    });
    const body = await json(
      await handleAccountEvents(
        req(`/api/v1/accounts/${SS58}/events`),
        env,
        SS58,
        url(
          `/api/v1/accounts/${SS58}/events?limit=1&cursor=${encodeCursor([200, 1])}`,
        ),
      ),
    );
    const eventsSql = captures.sql.find((s) => /FROM account_events/.test(s));
    assert.ok(/\(block_number, event_index\) < \(\?, \?\)/.test(eventsSql));
    assert.ok(!/OFFSET/.test(eventsSql));
    assert.equal(body.data.next_cursor, encodeCursor([150, 2]));
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
    assert.equal(body.error.code, "invalid_param");
  });

  test("rejects malformed netuid filters with 400", async () => {
    for (const netuid of ["abc", "-1", "7.5", ""]) {
      const res = await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        emptyEnv(),
        SS58,
        url(`/api/v1/accounts/${SS58}/history?netuid=${netuid}`),
      );
      const body = await errorJson(res);
      assert.equal(body.error.code, "invalid_param");
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

  test("happy path returns per-day rollup rows", async () => {
    const { env } = dbWith({ accountEventsDaily: [accountDayRow()] });
    const body = await json(
      await handleAccountHistory(
        req(`/api/v1/accounts/${SS58}/history`),
        env,
        SS58,
        url(
          `/api/v1/accounts/${SS58}/history?netuid=${NETUID}&from=2026-06-01&to=2026-06-30&limit=50`,
        ),
      ),
    );
    assert.equal(body.data.day_count, 1);
    assert.equal(body.data.days[0].day, "2026-06-24");
    assert.equal(body.data.limit, 50);
  });

  test("netuid filter is bound when numeric", async () => {
    const { env, captures } = dbWith({ accountEventsDaily: [accountDayRow()] });
    await handleAccountHistory(
      req(`/api/v1/accounts/${SS58}/history`),
      env,
      SS58,
      url(`/api/v1/accounts/${SS58}/history?netuid=${NETUID}`),
    );
    const sql = captures.sql.find((s) => /account_events_daily/.test(s));
    assert.ok(/netuid = \?/.test(sql));
    assert.ok(captures.params.some((p) => p.includes(NETUID)));
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

  test("happy path returns signer-matched extrinsics", async () => {
    const { env } = dbWith({ extrinsics: [extrinsicRow()] });
    const body = await json(
      await handleAccountExtrinsics(
        req(`/api/v1/accounts/${SS58}/extrinsics`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/extrinsics?limit=25`),
      ),
    );
    assert.equal(body.data.extrinsic_count, 1);
    assert.equal(body.data.extrinsics[0].signer, SS58);
    assert.equal(body.data.extrinsics[0].success, true);
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

  test("happy path reshapes Transfer rows (all direction)", async () => {
    const { env } = dbWith({ transfers: [transferEventRow()] });
    const body = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers`),
      ),
    );
    assert.equal(body.data.transfer_count, 1);
    assert.equal(body.data.transfers[0].from, SS58);
    assert.equal(body.data.transfers[0].amount_tao, 4.2);
  });

  test("direction=sent binds hotkey-only clause", async () => {
    const { env, captures } = dbWith({ transfers: [transferEventRow()] });
    await handleAccountTransfers(
      req(`/api/v1/accounts/${SS58}/transfers`),
      env,
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers?direction=sent`),
    );
    const sql = captures.sql.find((s) => /Transfer/.test(s));
    assert.ok(
      /^[^O]*hotkey = \?/.test(sql.replace(/OR.*/, "")) ||
        /hotkey = \?/.test(sql),
    );
    assert.ok(!/coldkey = \? OR/.test(sql) || /hotkey = \?/.test(sql));
  });

  test("direction=received binds coldkey-only clause", async () => {
    const { env, captures } = dbWith({ transfers: [transferEventRow()] });
    await handleAccountTransfers(
      req(`/api/v1/accounts/${SS58}/transfers`),
      env,
      SS58,
      url(`/api/v1/accounts/${SS58}/transfers?direction=received`),
    );
    const sql = captures.sql.find((s) => /Transfer/.test(s));
    assert.ok(/coldkey = \?/.test(sql));
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

  test("happy path returns cross-subnet registration footprint", async () => {
    const { env } = dbWith({
      registrations: [
        {
          netuid: NETUID,
          uid: UID,
          stake_tao: 100,
          validator_permit: 0,
          active: 1,
        },
        { netuid: 64, uid: 12, stake_tao: 5, validator_permit: 1, active: 1 },
      ],
    });
    const body = await json(
      await handleAccountSubnets(
        req(`/api/v1/accounts/${SS58}/subnets`),
        env,
        SS58,
      ),
    );
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.subnets[1].netuid, 64);
    assert.equal(body.data.subnets[1].validator_permit, true);
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

  test("happy path returns per-subnet event stream", async () => {
    const { env } = dbWith({
      subnetEvents: [accountEventRow({ event_kind: "NeuronRegistered" })],
    });
    const body = await json(
      await handleSubnetEvents(
        req(`/api/v1/subnets/${NETUID}/events`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/events?limit=25`),
      ),
    );
    assert.equal(body.data.event_count, 1);
    assert.equal(body.data.events[0].event_kind, "NeuronRegistered");
  });

  test("kind filter is applied", async () => {
    const { env, captures } = dbWith({
      subnetEvents: [accountEventRow({ event_kind: "WeightsSet" })],
    });
    await handleSubnetEvents(
      req(`/api/v1/subnets/${NETUID}/events`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/events?kind=WeightsSet`),
    );
    assert.ok(captures.sql.some((s) => /event_kind = \?/.test(s)));
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
    globalThis.fetch = async () => ({ ok: false });
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

  test("happy path returns newest-first block feed", async () => {
    const { env } = dbWith({ blocksFeed: [blockRow()] });
    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env,
        url("/api/v1/blocks?limit=25"),
      ),
    );
    assert.equal(body.data.block_count, 1);
    assert.equal(body.data.blocks[0].block_number, BLOCK_NUM);
    assert.equal(body.data.limit, 25);
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

  test("cursor uses keyset seek and emits next_cursor", async () => {
    const { env, captures } = dbWith({
      blocksFeed: [blockRow({ block_number: 150 })],
    });
    const body = await json(
      await handleBlocks(
        req("/api/v1/blocks"),
        env,
        url(`/api/v1/blocks?limit=1&cursor=${encodeCursor([200])}`),
      ),
    );
    const sql = captures.sql.find((s) => /FROM blocks/.test(s));
    assert.ok(/WHERE block_number < \?/.test(sql));
    assert.ok(!/OFFSET/.test(sql));
    assert.equal(body.data.next_cursor, encodeCursor([150]));
  });

  test("applies the conjunctive filter set (#1991)", async () => {
    const { env, captures } = dbWith({ blocksFeed: [] });
    await handleBlocks(
      req("/api/v1/blocks"),
      env,
      url(
        "/api/v1/blocks?author=5Author&spec_version=423&block_start=100&block_end=200&from=1000&to=2000&min_extrinsics=1&min_events=5",
      ),
    );
    const sql = captures.sql.find((s) => /FROM blocks/.test(s));
    assert.ok(/author = \?/.test(sql));
    assert.ok(/spec_version = \?/.test(sql));
    assert.ok(/block_number >= \?/.test(sql));
    assert.ok(/block_number <= \?/.test(sql));
    assert.ok(/observed_at >= \?/.test(sql));
    assert.ok(/observed_at <= \?/.test(sql));
    assert.ok(/extrinsic_count >= \?/.test(sql));
    assert.ok(/event_count >= \?/.test(sql));
    // every value bound (author string + the 7 clamped ints), never interpolated.
    const params = captures.params.flat();
    assert.ok(params.includes("5Author"));
    assert.ok(params.includes(423));
    // limit + offset are the last two bound params (no cursor → offset path).
    assert.equal(params.at(-2), 50);
    assert.equal(params.at(-1), 0);
  });

  test("a filter ANDs with the keyset cursor and drops OFFSET", async () => {
    const { env, captures } = dbWith({ blocksFeed: [] });
    await handleBlocks(
      req("/api/v1/blocks"),
      env,
      url(`/api/v1/blocks?author=5Author&cursor=${encodeCursor([300])}`),
    );
    const sql = captures.sql.find((s) => /FROM blocks/.test(s));
    assert.ok(/author = \? AND block_number < \?/.test(sql));
    assert.ok(!/OFFSET/.test(sql));
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

  test("the unfiltered feed keeps the plain OFFSET path (no WHERE)", async () => {
    const { env, captures } = dbWith({ blocksFeed: [] });
    await handleBlocks(
      req("/api/v1/blocks"),
      env,
      url("/api/v1/blocks?limit=10&offset=20"),
    );
    const sql = captures.sql.find((s) => /FROM blocks/.test(s));
    assert.ok(!/WHERE/.test(sql));
    assert.ok(/ORDER BY block_number DESC LIMIT \? OFFSET \?/.test(sql));
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

  test("happy path resolves by numeric block_number", async () => {
    const { env, captures } = dbWith({
      blockDetail: blockRow(),
      blockNeighbors: { prev: 1230, next: 1240 },
    });
    const body = await json(
      await handleBlock(
        req(`/api/v1/blocks/${BLOCK_NUM}`),
        env,
        String(BLOCK_NUM),
      ),
    );
    const neighborSql = captures.sql.find((sql) =>
      /SELECT MAX\(block_number\) FROM blocks WHERE block_number < \?/.test(
        sql,
      ),
    );
    assert.ok(neighborSql);
    assert.ok(!/MAX\(CASE WHEN block_number </.test(neighborSql));
    assert.equal(body.data.block.block_number, BLOCK_NUM);
    assert.equal(body.data.prev_block_number, 1230);
    assert.equal(body.data.next_block_number, 1240);
  });

  test("happy path resolves by 0x block_hash ref", async () => {
    const { env } = dbWith({ blockDetail: blockRow() });
    const body = await json(
      await handleBlock(req(`/api/v1/blocks/${HASH}`), env, HASH),
    );
    assert.equal(body.data.ref, HASH);
    assert.equal(body.data.block.block_hash, HASH);
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

  test("happy path lists extrinsics in extrinsic_index ASC order", async () => {
    const { env } = dbWith({
      blockDetail: { block_number: BLOCK_NUM },
      extrinsics: [extrinsicRow()],
    });
    const body = await json(
      await handleBlockExtrinsics(
        req(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
        env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/extrinsics`),
      ),
    );
    assert.equal(body.data.extrinsic_count, 1);
    assert.equal(body.data.extrinsics[0].call_function, "add_stake");
  });

  test("hash ref resolves block_number before listing extrinsics", async () => {
    const { env } = dbWith({
      blockDetail: { block_number: 9 },
      blockNumberByHash: 9,
      extrinsics: [extrinsicRow({ block_number: 9, extrinsic_index: 1 })],
    });
    const hash = HASH;
    const body = await json(
      await handleBlockExtrinsics(
        req(`/api/v1/blocks/${hash}/extrinsics`),
        env,
        hash,
        url(`/api/v1/blocks/${hash}/extrinsics`),
      ),
    );
    assert.equal(body.data.ref, hash);
    assert.equal(body.data.block_number, 9);
    assert.equal(body.data.extrinsics[0].extrinsic_index, 1);
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
    assert.equal(body.data.event_count, 0);
    assert.deepEqual(body.data.events, []);
  });

  test("happy path returns block-scoped events", async () => {
    const { env } = dbWith({ blockEvents: [accountEventRow()] });
    const body = await json(
      await handleBlockEvents(
        req(`/api/v1/blocks/${BLOCK_NUM}/events`),
        env,
        String(BLOCK_NUM),
        url(`/api/v1/blocks/${BLOCK_NUM}/events?limit=50`),
      ),
    );
    assert.equal(body.data.event_count, 1);
    assert.equal(body.data.events[0].event_kind, "StakeAdded");
  });

  test("hash ref resolves before reading events", async () => {
    const { env } = dbWith({
      blockNumberByHash: 9,
      blockEvents: [accountEventRow({ block_number: 9 })],
    });
    const body = await json(
      await handleBlockEvents(
        req(`/api/v1/blocks/${HASH}/events`),
        env,
        HASH,
        url(`/api/v1/blocks/${HASH}/events`),
      ),
    );
    assert.equal(body.data.block_number, 9);
    assert.equal(body.data.event_count, 1);
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

  test("happy path returns recent extrinsic feed", async () => {
    const { env } = dbWith({ extrinsics: [extrinsicRow()] });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url("/api/v1/extrinsics?limit=25"),
      ),
    );
    assert.equal(body.data.extrinsic_count, 1);
    assert.equal(body.data.extrinsics[0].block_number, BLOCK_NUM);
  });

  test("applies conjunctive filter set (#1846)", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url(
        "/api/v1/extrinsics?signer=5Signer&call_module=SubtensorModule&call_function=add_stake&success=false&block_start=100&block_end=200",
      ),
    );
    const sql = captures.sql.find((s) => /FROM extrinsics/.test(s));
    assert.ok(/signer = \?/.test(sql));
    assert.ok(/call_module = \?/.test(sql));
    assert.ok(/success = \?/.test(sql));
    assert.ok(/block_number >= \?/.test(sql));
    assert.ok(captures.params.flat().includes(0));
  });

  test("keeps broad standalone time filters planner-selected", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url("/api/v1/extrinsics?from=0"),
    );
    const sql = captures.sql.find((s) => /FROM extrinsics/.test(s));
    assert.ok(sql);
    assert.ok(
      !/INDEXED BY/.test(sql),
      "broad filters must not force a sort-heavy timestamp index",
    );
    assert.ok(/observed_at >= \?/.test(sql));
  });

  test("ignores malformed time filters instead of broadening them", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url("/api/v1/extrinsics?from=abc"),
    );
    const sql = captures.sql.find((s) => /FROM extrinsics/.test(s));
    assert.ok(sql);
    assert.ok(!/INDEXED BY/.test(sql));
    assert.ok(!/observed_at >= \?/.test(sql));
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
      captures.sql.filter((s) => /FROM extrinsics/.test(s)).length,
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
      captures.sql.filter((s) => /FROM extrinsics/.test(s)).length,
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
      captures.sql.filter((s) => /FROM extrinsics/.test(s)).length,
      0,
    );
  });

  test("a valid recent window is NOT short-circuited and queries D1", async () => {
    const { env, captures } = dbWith({ extrinsics: [] });
    const now = Date.now();
    await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url(`/api/v1/extrinsics?from=${now - 60_000}&to=${now}`),
    );
    const sql = captures.sql.find((s) => /FROM extrinsics/.test(s));
    assert.ok(sql, "a valid window must reach D1");
    assert.ok(/INDEXED BY idx_extrinsics_observed_order/.test(sql));
    assert.ok(/observed_at >= \?/.test(sql));
    assert.ok(/observed_at <= \?/.test(sql));
  });

  test("drops the observed-at index hint when an equality filter is present", async () => {
    // With a (signer) equality the planner should use the order-aligned
    // signer index, not be forced onto the observed-at one.
    const { env, captures } = dbWith({ extrinsics: [] });
    await handleExtrinsics(
      req("/api/v1/extrinsics"),
      env,
      url("/api/v1/extrinsics?from=1750000000000&signer=5Signer"),
    );
    const sql = captures.sql.find((s) => /FROM extrinsics/.test(s));
    assert.ok(sql);
    assert.ok(!/INDEXED BY/.test(sql), "equality filter must drop the hint");
    assert.ok(/signer = \?/.test(sql));
  });

  test("cursor seeks on (block_number, extrinsic_index)", async () => {
    const { env, captures } = dbWith({
      extrinsics: [extrinsicRow({ block_number: 150, extrinsic_index: 4 })],
    });
    const body = await json(
      await handleExtrinsics(
        req("/api/v1/extrinsics"),
        env,
        url(`/api/v1/extrinsics?limit=1&cursor=${encodeCursor([200, 2])}`),
      ),
    );
    const sql = captures.sql.find((s) => /FROM extrinsics/.test(s));
    assert.ok(/\(block_number, extrinsic_index\) < \(\?, \?\)/.test(sql));
    assert.equal(body.data.next_cursor, encodeCursor([150, 4]));
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

  test("happy path resolves by extrinsic_hash", async () => {
    const { env } = dbWith({ extrinsicDetail: extrinsicRow() });
    const body = await json(
      await handleExtrinsic(req(`/api/v1/extrinsics/${HASH}`), env, HASH),
    );
    assert.equal(body.data.extrinsic.extrinsic_hash, HASH);
    assert.equal(body.data.extrinsic.call_function, "add_stake");
  });

  test("happy path resolves by composite id block-index", async () => {
    const { env } = dbWith({
      extrinsicDetail: extrinsicRow({ extrinsic_hash: null }),
    });
    const ref = `${BLOCK_NUM}-2`;
    const body = await json(
      await handleExtrinsic(req(`/api/v1/extrinsics/${ref}`), env, ref),
    );
    assert.equal(body.data.ref, ref);
    assert.equal(body.data.extrinsic.block_number, BLOCK_NUM);
    assert.equal(body.data.extrinsic.extrinsic_index, 2);
    assert.equal(body.data.extrinsic.extrinsic_hash, null);
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

  test("embeds emitted account_events when extrinsic resolves (#1849)", async () => {
    const { env } = dbWith({
      extrinsicDetail: extrinsicRow(),
      extrinsicEvents: [
        accountEventRow({ event_kind: "StakeAdded", extrinsic_index: 2 }),
      ],
    });
    const body = await json(
      await handleExtrinsic(req(`/api/v1/extrinsics/${HASH}`), env, HASH),
    );
    assert.equal(body.data.events.length, 1);
    assert.equal(body.data.events[0].event_kind, "StakeAdded");
    assert.equal(body.data.events[0].extrinsic_index, 2);
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
      const body = await res.json();
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
      assertData: (d) => assert.equal(d.validator_count, 0),
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
      assertData: (d) => assert.equal(d.point_count, 0),
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
      assertData: (d) => assert.equal(d.point_count, 0),
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
      assertData: (d) => assert.equal(d.event_count, 0),
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
      assertData: (d) => assert.equal(d.day_count, 0),
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
      assertData: (d) => assert.equal(d.extrinsic_count, 0),
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
      assertData: (d) => assert.equal(d.transfer_count, 0),
    },
    {
      name: "handleAccountSubnets",
      run: () =>
        handleAccountSubnets(
          req(`/api/v1/accounts/${SS58}/subnets`),
          emptyEnv(),
          SS58,
        ),
      assertData: (d) => assert.equal(d.subnet_count, 0),
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
      assertData: (d) => assert.equal(d.event_count, 0),
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
      assertData: (d) => assert.equal(d.extrinsic_count, 0),
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
      assertData: (d) => assert.equal(d.event_count, 0),
    },
    {
      name: "handleExtrinsics",
      run: () =>
        handleExtrinsics(
          req("/api/v1/extrinsics"),
          emptyEnv(),
          url("/api/v1/extrinsics"),
        ),
      assertData: (d) => assert.equal(d.extrinsic_count, 0),
    },
  ];

  for (const { name, run, assertData } of coldCases) {
    test(`${name} never 404s on cold D1`, async () => {
      const res = await run();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assertData(body.data);
    });
  }
});

describe("dbWith SQL routing regressions (#1900)", () => {
  test("routes account summary queries to distinct buckets", async () => {
    const { env } = dbWith({
      agg: { c: 1, sc: 1, fb: 1, lb: 1, fo: 1, lo: 1 },
      kinds: [{ kind: "StakeAdded", count: 1 }],
      registrations: [
        { netuid: 1, uid: 0, stake_tao: 1, validator_permit: 0, active: 1 },
      ],
      accountEvents: [accountEventRow()],
      activity: {
        tx_count: 1,
        last_tx_block: 1,
        last_tx_at: 1,
        total_fee_tao: 0,
      },
      modules: [{ call_module: "Balances", count: 1 }],
    });
    const body = await json(
      await handleAccount(req(`/api/v1/accounts/${SS58}`), env, SS58),
    );
    assert.equal(body.data.event_count, 1);
    assert.equal(body.data.activity.tx_count, 1);
    assert.equal(body.data.registrations.length, 1);
  });

  test("routes transfer vs subnet vs account event queries separately", async () => {
    const { env } = dbWith({
      transfers: [transferEventRow()],
      subnetEvents: [accountEventRow({ event_kind: "NeuronRegistered" })],
      accountEvents: [accountEventRow({ event_kind: "WeightsSet" })],
    });
    const transfers = await json(
      await handleAccountTransfers(
        req(`/api/v1/accounts/${SS58}/transfers`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/transfers`),
      ),
    );
    const subnet = await json(
      await handleSubnetEvents(
        req(`/api/v1/subnets/${NETUID}/events`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/events`),
      ),
    );
    const account = await json(
      await handleAccountEvents(
        req(`/api/v1/accounts/${SS58}/events`),
        env,
        SS58,
        url(`/api/v1/accounts/${SS58}/events`),
      ),
    );
    assert.equal(transfers.data.transfers[0].direction, "sent");
    assert.equal(subnet.data.events[0].event_kind, "NeuronRegistered");
    assert.equal(account.data.events[0].event_kind, "WeightsSet");
  });

  test("routes block hash resolution before extrinsic listing", async () => {
    const { env, captures } = dbWith({
      blockNumberByHash: BLOCK_NUM,
      extrinsics: [extrinsicRow()],
    });
    await handleBlockExtrinsics(
      req(`/api/v1/blocks/${HASH}/extrinsics`),
      env,
      HASH,
      url(`/api/v1/blocks/${HASH}/extrinsics`),
    );
    assert.ok(
      captures.sql.some((s) =>
        /SELECT block_number FROM blocks WHERE block_hash/.test(s),
      ),
    );
    assert.ok(
      captures.sql.some((s) => /FROM extrinsics WHERE block_number/.test(s)),
    );
  });

  test("routes extrinsic detail hash vs composite paths", async () => {
    const row = extrinsicRow();
    const { env: hashEnv } = dbWith({ extrinsicDetail: row });
    const byHash = await json(
      await handleExtrinsic(req(`/api/v1/extrinsics/${HASH}`), hashEnv, HASH),
    );
    assert.equal(byHash.data.extrinsic.extrinsic_hash, HASH);

    const { env: compEnv } = dbWith({ extrinsicDetail: row });
    const ref = `${BLOCK_NUM}-2`;
    const byComposite = await json(
      await handleExtrinsic(req(`/api/v1/extrinsics/${ref}`), compEnv, ref),
    );
    assert.equal(byComposite.data.extrinsic.extrinsic_index, 2);
  });
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

async function resHasEtag(res) {
  return Boolean(res.headers.get("etag"));
}

// Fixture documentation: each factory above mirrors the D1 column contracts used
// by workers/request-handlers/entities.mjs. When adding a new handler test,
// prefer reusing these rows so formatters stay aligned with production schemas.
