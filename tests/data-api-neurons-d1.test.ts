// The neurons-family D1 port (box decommission; migrations/d1/0007_neurons.sql),
// exercised END TO END against a REAL SQLite database -- same rationale as
// tests/data-api-user-state-d1.test.ts: the riskiest constructs here (chunked
// multi-row guarded upserts, ON CONFLICT ... WHERE captured_at guards, the
// per-netuid prune, the DISTINCT ON / date-arithmetic dialect translations)
// only fail at execution, and no queue fake parses SQL.
//
// Every request goes through the real Worker fetch handler. Writes are DUAL
// per #9157 (D1 required, Postgres only while HYPERDRIVE exists) and ignore
// the tier flag; READS switch on METAGRAPH_NEURONS_SOURCE, which this suite
// leaves unset (i.e. not "postgres") so the D1 read dispatcher serves them.
// What is under test is the full D1 lane against the real migration files:
// src/neurons-d1-write.ts's batch statements actually executing, the read
// dispatcher's route matching, and the SQLite dialect of every ported query.
// The Postgres READ lane's continued behavior under the flag is pinned both
// here (flag: "postgres" + no HYPERDRIVE -> the Postgres dispatcher's own
// 503) and in tests/data-api.test.ts (whose env sets the flag explicitly).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");

const NEURONS_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0007_neurons.sql"),
  "utf8",
);
const NEURONS_READ_INDEXES = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0008_neurons_read_indexes.sql"),
  "utf8",
);
// subnet_snapshots (the alpha-price join target) lives in the observations
// migration -- load it too, exactly as the real database carries both.
const OBSERVATIONS_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0002_observations.sql"),
  "utf8",
);
// validator_nominator_counts (the nominator_count join target, #9146) -- the
// same reason as subnet_snapshots above: the real database carries it, and the
// leaderboard's read joins against it.
const NOMINATOR_COUNTS_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0012_validator_nominator_counts.sql"),
  "utf8",
);
// subnet_hyperparams -- the tempo join target apy_estimate needs (#9342). Same
// reason as the two above: the real database carries it and the leaderboard's
// read joins against it.
const HYPERPARAMS_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0009_hyperparams_identity.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

/** Real D1 converts boolean binds to INTEGER 1/0 (its documented type
 * mapping); node:sqlite rejects them outright, so the fake applies the same
 * conversion the platform would. The write module (src/neurons-d1-write.ts)
 * binds coerceNeuronSyncRow's JS booleans raw and relies on exactly this. */
function d1Bind(value: unknown): unknown {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

/** The D1 surface both lanes use -- prepare(text).bind(...).all() for the
 * read runner, plus batch(), which D1 documents as one implicit transaction;
 * the fake mirrors that with BEGIN/COMMIT so a mid-batch failure genuinely
 * rolls back. */
function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            text,
            values: values.map(d1Bind),
            async all() {
              return {
                results: db
                  .prepare(text)
                  .all(...(values.map(d1Bind) as never[])),
              };
            },
          };
        },
      };
    },
    async batch(statements: { text: string; values: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          results: db
            .prepare(statement.text)
            .all(...(statement.values as never[])),
        }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const SYNC_SECRET = "test-neurons-sync-secret";
const BACKFILL_SECRET = "test-neuron-daily-backfill-secret";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    NEURONS_SYNC_SECRET: SYNC_SECRET,
    NEURON_DAILY_BACKFILL_SECRET: BACKFILL_SECRET,
    ...overrides,
  } as unknown as Env;
}

function req(
  urlPath: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return new Request(`https://d${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(request: Request, envOverride: Env = env()) {
  return worker.fetch(request, envOverride, {} as unknown as ExecutionContext);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

const CAPTURED_AT = Date.UTC(2026, 6, 15, 12); // -> snapshot_date 2026-07-15

/** One wire-shape neurons-sync row (NEURON_INSERT_COLUMNS only, 0/1 ints for
 * the boolean columns -- the exact shape scripts/fetch-metagraph-native.py
 * emits). */
function syncRow(overrides: Row = {}): Row {
  return {
    netuid: 7,
    uid: 0,
    hotkey: "5Hot7-0",
    coldkey: "5Cold7-0",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    validator_trust: 0.8,
    consensus: 0.7,
    incentive: 0.1,
    dividends: 0.2,
    emission_tao: 1.5,
    stake_tao: 100,
    registered_at_block: 1000,
    is_immunity_period: 0,
    axon: "1.2.3.4:8091",
    block_number: 8_600_000,
    captured_at: CAPTURED_AT,
    take: 0.18,
    ...overrides,
  };
}

const NEURON_DB_COLUMNS =
  "netuid, uid, hotkey, coldkey, active, validator_permit, rank, trust, " +
  "validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, " +
  "registered_at_block, is_immunity_period, axon, block_number, captured_at, take";

function insertNeuron(overrides: Row = {}) {
  const row = syncRow(overrides);
  db.prepare(
    `INSERT INTO neurons (${NEURON_DB_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
      row.netuid,
      row.uid,
      row.hotkey,
      row.coldkey,
      row.active,
      row.validator_permit,
      row.rank,
      row.trust,
      row.validator_trust,
      row.consensus,
      row.incentive,
      row.dividends,
      row.emission_tao,
      row.stake_tao,
      row.registered_at_block,
      row.is_immunity_period,
      row.axon,
      row.block_number,
      row.captured_at,
      row.take,
    ] as never[]),
  );
}

function insertDaily(overrides: Row = {}) {
  const row: Row = {
    snapshot_date: dayAgo(1),
    updated_at: Date.now(),
    ...syncRow(),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO neuron_daily (snapshot_date, updated_at, ${NEURON_DB_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
      row.snapshot_date,
      row.updated_at,
      row.netuid,
      row.uid,
      row.hotkey,
      row.coldkey,
      row.active,
      row.validator_permit,
      row.rank,
      row.trust,
      row.validator_trust,
      row.consensus,
      row.incentive,
      row.dividends,
      row.emission_tao,
      row.stake_tao,
      row.registered_at_block,
      row.is_immunity_period,
      row.axon,
      row.block_number,
      row.captured_at,
      row.take,
    ] as never[]),
  );
}

/**
 * A snapshot whose SPOT price is `price`.
 *
 * Positions are marked at spot -- tao_in_pool_tao / alpha_in_pool -- rather than at
 * alpha_price_tao, which is the chain's moving average (#9408). So a fixture that sets
 * only the latter no longer expresses a price at all. The reserves here are written to
 * divide exactly to `price`, and alpha_price_tao is set to a DELIBERATELY DIFFERENT
 * value so any code that regresses to reading it fails loudly instead of passing on a
 * coincidence.
 */
function insertPrice(netuid: number, snapshotDate: string, price: number) {
  const alphaInPool = 1_000_000;
  db.prepare(
    `INSERT INTO subnet_snapshots
       (netuid, snapshot_date, alpha_price_tao, tao_in_pool_tao, alpha_in_pool)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(netuid, snapshotDate, price * 2, price * alphaInPool, alphaInPool);
}

const one = (sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...(params as never[])) as Row;
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(NEURONS_SCHEMA);
  db.exec(NEURONS_READ_INDEXES);
  db.exec(OBSERVATIONS_SCHEMA);
  db.exec(NOMINATOR_COUNTS_SCHEMA);
  db.exec(HYPERPARAMS_SCHEMA);
});

// netuid -> tempo(blocks), the row apy_estimate annualizes against. Values are
// the real chain ones (SubtensorModule::Tempo): root 100, netuid 1 is 99.
function insertTempo(netuid: number, tempo: number | null) {
  db.prepare(
    "INSERT INTO subnet_hyperparams (netuid, tempo, captured_at) VALUES (?, ?, ?)",
  ).run(netuid, tempo as never, Date.now());
}

// --- POST /api/v1/internal/neurons-sync: the D1 write lane -------------------

async function postSync(rows: Row[], envOverride: Env = env()) {
  return call(
    req("/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": SYNC_SECRET },
      body: rows,
    }),
    envOverride,
  );
}

test("neurons-sync writes neurons, neuron_daily, and account_position_daily from one payload", async () => {
  const res = await postSync([
    syncRow(),
    syncRow({ uid: 1, hotkey: "5Hot7-1", stake_tao: 50 }),
    syncRow({ netuid: 8, uid: 0, hotkey: null, coldkey: "5Cold8-0" }),
  ]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, true);
  assert.equal(body.neurons_written, 3);
  assert.equal(body.neuron_daily_written, 3);
  // The netuid-8 row has hotkey null, so it never becomes a position row.
  assert.equal(body.account_position_daily_written, 2);
  assert.equal(body.netuids_covered, 2);
  // No HYPERDRIVE bound in this suite's env: the #9157 dual-write reports
  // the D1-only store set.
  assert.deepEqual(body.stores, ["d1"]);

  assert.equal(count("neurons"), 3);
  assert.equal(count("neuron_daily"), 3);
  assert.equal(count("account_position_daily"), 2);
  const stored = one("SELECT * FROM neurons WHERE netuid = 7 AND uid = 0");
  assert.equal(stored.hotkey, "5Hot7-0");
  assert.equal(stored.validator_permit, 1, "boolean stored as INTEGER 1");
  assert.equal(stored.take, 0.18);
  const daily = one("SELECT * FROM neuron_daily WHERE netuid = 7 AND uid = 0");
  assert.equal(daily.snapshot_date, "2026-07-15", "derived from captured_at");
  const position = one(
    "SELECT * FROM account_position_daily WHERE account = '5Hot7-0'",
  );
  assert.equal(position.netuid, 7);
  assert.equal(position.stake_tao, 100);
});

test("neurons-sync upsert: a newer capture replaces the row, an older one is discarded by the captured_at guard", async () => {
  insertNeuron({ stake_tao: 100, captured_at: CAPTURED_AT });
  // Older capture for the same (netuid, uid): the ON CONFLICT ... WHERE
  // captured_at <= excluded.captured_at guard must reject it.
  const stale = await postSync([
    syncRow({ stake_tao: 1, captured_at: CAPTURED_AT - 1000 }),
  ]);
  assert.equal(stale.status, 200);
  assert.equal(
    one("SELECT stake_tao FROM neurons WHERE netuid = 7 AND uid = 0").stake_tao,
    100,
    "older capture must not clobber",
  );
  const fresh = await postSync([
    syncRow({ stake_tao: 200, captured_at: CAPTURED_AT + 1000 }),
  ]);
  assert.equal(fresh.status, 200);
  assert.equal(
    one("SELECT stake_tao FROM neurons WHERE netuid = 7 AND uid = 0").stake_tao,
    200,
  );
});

test("neurons-sync prunes deregistered UIDs only within the netuids the batch covers", async () => {
  // Stale UIDs on netuid 7 (covered by the batch) and netuid 9 (NOT covered).
  insertNeuron({ netuid: 7, uid: 5, captured_at: CAPTURED_AT - 5000 });
  insertNeuron({ netuid: 9, uid: 5, captured_at: CAPTURED_AT - 5000 });
  const res = await postSync([syncRow()]);
  assert.equal(res.status, 200);
  assert.equal(
    one("SELECT COUNT(*) n FROM neurons WHERE netuid = 7 AND uid = 5").n,
    0,
    "stale UID on the covered netuid is pruned",
  );
  assert.equal(
    one("SELECT COUNT(*) n FROM neurons WHERE netuid = 9 AND uid = 5").n,
    1,
    "a netuid absent from the batch is never touched",
  );
});

test("neurons-sync chunks a payload past the D1 parameter budget into multiple statements atomically", async () => {
  // 100 rows x 20 columns = 2,000 binds, over D1_PARAM_BUDGET (900) -- the
  // writer must split each table's upsert into several statements (45 neuron
  // rows per statement) and every one of them must actually execute.
  const rows = Array.from({ length: 100 }, (_, uid) =>
    syncRow({ uid, hotkey: `5Hot7-${uid}` }),
  );
  const res = await postSync(rows);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(count("neurons"), 100);
  assert.equal(count("neuron_daily"), 100);
  assert.equal(count("account_position_daily"), 100);
  assert.ok(
    Number(body.d1_statements) > 3,
    "the write really split into chunked statements",
  );
});

test("neurons-sync 503s on a missing D1 binding instead of touching Hyperdrive", async () => {
  const res = await postSync([syncRow()], env({ METAGRAPH_HEALTH_DB: null }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "d1 binding unavailable" });
});

test("neurons-sync writes D1 regardless of the READ flag -- the write is dual per #9157, not flag-switched", async () => {
  // METAGRAPH_NEURONS_SOURCE only moves READS between tiers. With the flag
  // pinned to "postgres" and no HYPERDRIVE bound (the wipe case), the sync
  // must still land in D1 rather than 503 -- the exact scenario #9157's
  // dual-write exists for.
  const res = await postSync(
    [syncRow()],
    env({ METAGRAPH_NEURONS_SOURCE: "postgres" }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as Row).stores, ["d1"]);
  assert.equal(count("neurons"), 1);
});

test("neurons-sync maps a mid-batch failure to a 502 and rolls the whole batch back", async () => {
  db.exec("DROP TABLE account_position_daily");
  const res = await postSync([syncRow()]);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "d1 write failed" });
  assert.equal(count("neurons"), 0, "the batch rolled back atomically");
  assert.equal(count("neuron_daily"), 0);
});

// --- POST /api/v1/internal/backfill-neuron-daily: the D1 write lane ----------

async function postBackfill(rows: Row[], envOverride: Env = env()) {
  return call(
    req("/api/v1/internal/backfill-neuron-daily", {
      method: "POST",
      headers: { "x-neuron-daily-backfill-token": BACKFILL_SECRET },
      body: rows,
    }),
    envOverride,
  );
}

test("backfill-neuron-daily writes neuron_daily + account_position_daily and never touches neurons", async () => {
  insertNeuron({ netuid: 7, uid: 5, captured_at: CAPTURED_AT + 999_999 });
  const res = await postBackfill([
    syncRow(),
    syncRow({ uid: 1, hotkey: null }),
  ]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body, {
    ok: true,
    neuron_daily_written: 2,
    account_position_daily_written: 1,
    stores: ["d1"],
    d1_statements: 2,
  });
  assert.equal(count("neuron_daily"), 2);
  assert.equal(count("account_position_daily"), 1);
  // The pre-existing live row survived: no prune, no neurons write.
  assert.equal(count("neurons"), 1);
});

test("backfill-neuron-daily is idempotent under the captured_at guard", async () => {
  const first = await postBackfill([syncRow({ stake_tao: 100 })]);
  assert.equal(first.status, 200);
  const rePost = await postBackfill([
    syncRow({ stake_tao: 55, captured_at: CAPTURED_AT - 1 }),
  ]);
  assert.equal(rePost.status, 200);
  assert.equal(
    one("SELECT stake_tao FROM neuron_daily WHERE netuid = 7 AND uid = 0")
      .stake_tao,
    100,
    "an older backfill row can never clobber a fresher snapshot",
  );
});

test("backfill-neuron-daily 503s on a missing D1 binding -- D1 is the store this path requires", async () => {
  const noD1 = await postBackfill(
    [syncRow()],
    env({ METAGRAPH_HEALTH_DB: null }),
  );
  assert.equal(noD1.status, 503);
  assert.deepEqual(await noD1.json(), { error: "d1 binding unavailable" });
});

test("backfill-neuron-daily maps a write failure to a 502", async () => {
  db.exec("DROP TABLE neuron_daily");
  const res = await postBackfill([syncRow()]);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "d1 write failed" });
});

// --- The D1 read dispatcher: gates and fallthrough ---------------------------

test("a non-neurons route falls through the D1 dispatcher to the Postgres lane", async () => {
  const res = await call(req("/api/v1/blocks"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "hyperdrive binding unavailable",
  });
});

test("a neurons route with the flag pinned to postgres skips the D1 dispatcher", async () => {
  insertNeuron();
  const res = await call(
    req("/api/v1/subnets/7/metagraph"),
    env({ METAGRAPH_NEURONS_SOURCE: "postgres" }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "hyperdrive binding unavailable",
  });
});

test("a neurons route 503s cleanly when the D1 binding is absent", async () => {
  const res = await call(
    req("/api/v1/subnets/7/metagraph"),
    env({ METAGRAPH_HEALTH_DB: null }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "d1 binding unavailable" });
});

test("a failing D1 read maps to the dispatcher's opaque 502, never a leaked DB error", async () => {
  db.exec("DROP TABLE neurons");
  const res = await call(req("/api/v1/subnets/7/metagraph"));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "data query failed" });
});

// --- Per-UID metagraph tier ---------------------------------------------------

test("GET /api/v1/subnets/:netuid/metagraph serves the D1 snapshot", async () => {
  insertNeuron({ uid: 1, stake_tao: 50, validator_permit: 0 });
  insertNeuron({ uid: 0, stake_tao: 100 });
  insertNeuron({ netuid: 8, uid: 0 });
  const res = await call(req("/api/v1/subnets/7/metagraph"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.netuid, 7);
  assert.equal(body.neuron_count, 2);
  const neurons = body.neurons as Row[];
  assert.equal(neurons[0].uid, 0, "ORDER BY uid");
  assert.equal(neurons[0].stake_tao, 100);
  assert.equal(neurons[0].active, true, "0/1 coerced to a real boolean");
});

test("GET /api/v1/subnets/:netuid/metagraph?validator_permit=true filters to permitted rows", async () => {
  insertNeuron({ uid: 0, validator_permit: 1 });
  insertNeuron({ uid: 1, validator_permit: 0 });
  const res = await call(
    req("/api/v1/subnets/7/metagraph?validator_permit=true"),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.neuron_count, 1);
  assert.equal((body.neurons as Row[])[0].uid, 0);
});

test("GET /api/v1/subnets/:netuid/neurons/:uid resolves a detail and an unknown uid stays neuron:null", async () => {
  insertNeuron({ uid: 3 });
  const hit = await call(req("/api/v1/subnets/7/neurons/3"));
  assert.equal(hit.status, 200);
  const hitBody = (await hit.json()) as Row;
  assert.equal((hitBody.neuron as Row).uid, 3);
  const miss = await call(req("/api/v1/subnets/7/neurons/999"));
  assert.equal(miss.status, 200);
  assert.equal(((await miss.json()) as Row).neuron, null);
});

test("GET /api/v1/subnets/:netuid/validators ranks by stake with the uid tiebreak", async () => {
  insertNeuron({ uid: 0, stake_tao: 10, validator_permit: 1 });
  insertNeuron({ uid: 1, stake_tao: 500, validator_permit: 1 });
  insertNeuron({ uid: 2, stake_tao: 500, validator_permit: 1 });
  insertNeuron({ uid: 3, stake_tao: 999, validator_permit: 0 });
  const res = await call(req("/api/v1/subnets/7/validators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 3);
  const uids = (body.validators as Row[]).map((v) => v.uid);
  assert.deepEqual(uids, [1, 2, 0], "stake DESC, equal stake by uid ASC");
});

// --- Global validators + detail ----------------------------------------------

test("GET /api/v1/validators serves the leaderboard from D1 with real prices and realized-return baselines", async () => {
  // Current state: one validator on root (price 1) with stake 200.
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 200,
    validator_permit: 1,
  });
  // Yesterday's baseline: stake 100 on root -- inside the 1d window's
  // tolerance, so realized_return_1d resolves against it.
  insertDaily({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
    snapshot_date: dayAgo(1),
  });
  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 1);
  const entry = (body.validators as Row[])[0];
  assert.equal(entry.hotkey, "5Val");
  assert.equal(entry.total_stake_tao, 200);
  assert.notEqual(
    entry.realized_return_1d,
    null,
    "the baseline window resolved from neuron_daily on D1",
  );
});

test("GET /api/v1/validators honors an explicit sort and clamps a bogus limit", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5A",
    stake_tao: 10,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5B",
    stake_tao: 20,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators?sort=total_stake&limit=0"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.sort, "total_stake");
  assert.equal(
    (body.validators as Row[]).length,
    2,
    "limit=0 fell back to the default",
  );
});

test("GET /api/v1/validators/:hotkey aggregates one hotkey across subnets with priced totals", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 7,
    uid: 2,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 7,
    uid: 3,
    hotkey: "5Other",
    stake_tao: 50,
    validator_permit: 1,
  });
  insertPrice(7, dayAgo(0), 0.5);
  const res = await call(req("/api/v1/validators/5Val"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.hotkey, "5Val");
  assert.equal(body.subnet_count, 2);
  // root 100 * 1 + netuid-7 100 * 0.5
  assert.equal(body.total_stake_tao, 150);
});

// --- nominator_count, joined from D1 (#9146) ---------------------------------
//
// This field was null on EVERY validator for the whole period between the box
// wipe and migration 0012: the side table was Postgres-only, so both builders
// were handed a hardcoded empty map / null. What is under test is that the
// join now answers, and -- just as important -- that a hotkey with no row
// still reads as UNKNOWN rather than as a confident zero.

/** One row in the counts side table. */
/** A capture stamp inside the staleness threshold, so the zero-fill engages. */
const FRESH_SCAN = () => Date.now();
/** Far outside it -- absence then means "not looked recently", not "zero". */
const STALE_SCAN = 1_000;

function insertNominatorCount(hotkey: string, count: number, at = STALE_SCAN) {
  db.prepare(
    "INSERT INTO validator_nominator_counts (hotkey, nominator_count, captured_at) VALUES (?, ?, ?)",
  ).run(hotkey, count, at);
}

test("GET /api/v1/validators fills nominator_count from D1; a STALE scan leaves the rest null", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Counted",
    stake_tao: 200,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5Unscanned",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNominatorCount("5Counted", 42);

  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const entries = ((await res.json()) as Row).validators as Row[];
  const byHotkey = new Map(entries.map((e) => [e.hotkey as string, e]));

  assert.equal(byHotkey.get("5Counted")!.nominator_count, 42);
  assert.equal(
    byHotkey.get("5Unscanned")!.nominator_count,
    null,
    "a hotkey the scan has not reached is unknown, NOT a confident zero",
  );
});

test("GET /api/v1/validators/:hotkey fills nominator_count for that one hotkey", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNominatorCount("5Val", 7);
  // A second hotkey's row must not leak into this one's answer.
  insertNominatorCount("5Other", 999);

  const res = await call(req("/api/v1/validators/5Val"));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Row).nominator_count, 7);
});

test("GET /api/v1/validators/:hotkey reports a zero count as a real answer", async () => {
  // 0 is an ANSWER, not an absence -- the one case where the distinction the
  // rest of this lane preserves has to survive all the way to the payload.
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNominatorCount("5Val", 0);
  const res = await call(req("/api/v1/validators/5Val"));
  assert.equal(((await res.json()) as Row).nominator_count, 0);
});

test("GET /api/v1/validators/:hotkey leaves nominator_count null when the hotkey has no row", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators/5Val"));
  assert.equal(((await res.json()) as Row).nominator_count, null);
});

// --- Confirmed zero, from a FRESH scan only (#9314) --------------------------
//
// The producer never records a zero -- it emits a row only for hotkeys it saw
// in Alpha -- so 471 of 1,028 permitted validators had no row and read as
// "unknown". Its pass is exhaustive, so against a CURRENT scan that absence is
// a confirmed zero. Against a stale one it is still unknown, and the whole
// point of these tests is that the two cases stay apart.

test("a permitted validator absent from a FRESH scan serves 0, not null", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Counted",
    stake_tao: 200,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5NoNominators",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNominatorCount("5Counted", 42, FRESH_SCAN());

  const res = await call(req("/api/v1/validators"));
  const entries = ((await res.json()) as Row).validators as Row[];
  const byHotkey = new Map(entries.map((e) => [e.hotkey as string, e]));

  assert.equal(byHotkey.get("5Counted")!.nominator_count, 42);
  assert.equal(
    byHotkey.get("5NoNominators")!.nominator_count,
    0,
    "an exhaustive current pass that did not see this hotkey means zero",
  );
});

test("the same absence against a STALE scan stays null", async () => {
  // The gate that makes the inference above safe rather than reckless: with no
  // recent pass, absence means "we have not looked", and 0 would be a
  // confident wrong number.
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Counted",
    stake_tao: 200,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5Unknown",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertNominatorCount("5Counted", 42, STALE_SCAN);

  const res = await call(req("/api/v1/validators"));
  const entries = ((await res.json()) as Row).validators as Row[];
  const byHotkey = new Map(entries.map((e) => [e.hotkey as string, e]));
  assert.equal(byHotkey.get("5Counted")!.nominator_count, 42);
  assert.equal(byHotkey.get("5Unknown")!.nominator_count, null);
});

test("the detail route applies the same fresh-vs-stale rule", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  // No row for 5Val at all, but another hotkey's FRESH row stamps the scan.
  insertNominatorCount("5Other", 5, FRESH_SCAN());
  const fresh = await call(req("/api/v1/validators/5Val"));
  assert.equal(((await fresh.json()) as Row).nominator_count, 0);

  db.exec("DELETE FROM validator_nominator_counts");
  insertNominatorCount("5Other", 5, STALE_SCAN);
  const stale = await call(req("/api/v1/validators/5Val"));
  assert.equal(((await stale.json()) as Row).nominator_count, null);
});

test("an entirely empty counts table never invents zeros", async () => {
  // No scan has ever run: there is no stamp to judge freshness by, so every
  // count is unknown. This is the cutover state, and inventing zeros here
  // would publish a wrong number for the whole network at once.
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  const entries = ((await res.json()) as Row).validators as Row[];
  assert.equal(entries[0]!.nominator_count, null);
});

test("a failing counts read degrades to null rather than failing the request", async () => {
  // The whole lane's failure posture: the leaderboard is the product, the
  // count is an enrichment. Dropping the table is the bluntest way to make the
  // read throw for real, rather than asserting a mocked rejection.
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  db.exec("DROP TABLE validator_nominator_counts");

  const list = await call(req("/api/v1/validators"));
  assert.equal(list.status, 200, "the leaderboard still serves");
  assert.equal(
    (((await list.json()) as Row).validators as Row[])[0]!.nominator_count,
    null,
  );

  const detail = await call(req("/api/v1/validators/5Val"));
  assert.equal(detail.status, 200, "the detail card still serves");
  assert.equal(((await detail.json()) as Row).nominator_count, null);
});

// --- Live-neurons analytics routes -------------------------------------------

test("GET /api/v1/subnets/:netuid/concentration and /performance read the D1 snapshot", async () => {
  insertNeuron({ uid: 0, stake_tao: 90, coldkey: "5C1" });
  insertNeuron({ uid: 1, stake_tao: 10, coldkey: "5C2" });
  const conc = await call(req("/api/v1/subnets/7/concentration"));
  assert.equal(conc.status, 200);
  assert.equal(((await conc.json()) as Row).netuid, 7);
  const perf = await call(req("/api/v1/subnets/7/performance"));
  assert.equal(perf.status, 200);
  assert.equal(((await perf.json()) as Row).netuid, 7);
});

test("GET /api/v1/chain/concentration and /chain/performance scan every subnet", async () => {
  insertNeuron({ netuid: 7, uid: 0 });
  insertNeuron({ netuid: 8, uid: 0 });
  const conc = await call(req("/api/v1/chain/concentration"));
  assert.equal(conc.status, 200);
  assert.equal(((await conc.json()) as Row).subnet_count, 2);
  const perf = await call(req("/api/v1/chain/performance"));
  assert.equal(perf.status, 200);
  assert.equal(((await perf.json()) as Row).subnet_count, 2);
});

test("GET /api/v1/subnets/:netuid/idle-stake and /chain/idle-stake fold dividends against stake", async () => {
  insertNeuron({ uid: 0, stake_tao: 100, dividends: 0 });
  insertNeuron({ uid: 1, stake_tao: 50, dividends: 0.5 });
  const subnet = await call(req("/api/v1/subnets/7/idle-stake"));
  assert.equal(subnet.status, 200);
  const subnetBody = (await subnet.json()) as Row;
  assert.equal(subnetBody.netuid, 7);
  assert.equal(subnetBody.idle_stake_alpha, 100);
  const chain = await call(req("/api/v1/chain/idle-stake"));
  assert.equal(chain.status, 200);
});

test("GET /api/v1/chain/yield excludes root; /subnets/:netuid/yield ranks per UID", async () => {
  insertNeuron({ netuid: 0, uid: 0, stake_tao: 100, emission_tao: 10 });
  insertNeuron({ netuid: 7, uid: 0, stake_tao: 100, emission_tao: 1 });
  const chain = await call(req("/api/v1/chain/yield"));
  assert.equal(chain.status, 200);
  assert.equal(
    ((await chain.json()) as Row).subnet_count,
    1,
    "netuid != 0 filter held",
  );
  const subnet = await call(req("/api/v1/subnets/7/yield"));
  assert.equal(subnet.status, 200);
  assert.equal(((await subnet.json()) as Row).netuid, 7);
});

// --- Account-scoped neurons routes -------------------------------------------

test("GET /api/v1/accounts/:ss58/portfolio prices cross-subnet positions from D1 snapshots", async () => {
  insertNeuron({ netuid: 0, uid: 0, hotkey: "5Acct", stake_tao: 100 });
  insertNeuron({ netuid: 7, uid: 4, hotkey: "5Acct", stake_tao: 10 });
  insertPrice(7, dayAgo(0), 2);
  const res = await call(req("/api/v1/accounts/5Acct/portfolio"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.subnet_count, 2);
  // root 100 * 1 + netuid-7 10 * 2
  assert.equal(body.total_stake_tao, 120);
});

test("GET /api/v1/accounts/:ss58/subnets lists the live registrations", async () => {
  insertNeuron({ netuid: 7, uid: 0, hotkey: "5Acct" });
  insertNeuron({ netuid: 8, uid: 1, hotkey: "5Acct" });
  insertNeuron({ netuid: 9, uid: 2, hotkey: "5Someone" });
  const res = await call(req("/api/v1/accounts/5Acct/subnets"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal((body.subnets as Row[]).length, 2);
  assert.equal((body.subnets as Row[])[0].netuid, 7);
});

test("GET /api/v1/accounts serves the leaderboard from D1", async () => {
  insertNeuron({ netuid: 0, uid: 0, hotkey: "5A", stake_tao: 10 });
  insertNeuron({ netuid: 0, uid: 1, hotkey: "5B", stake_tao: 20 });
  insertNeuron({ netuid: 0, uid: 2, hotkey: null });
  const res = await call(req("/api/v1/accounts?limit=1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.account_count, 2, "hotkey IS NOT NULL filter held");
  assert.equal((body.accounts as Row[]).length, 1, "explicit limit applied");
});

test("GET /api/v1/accounts falls back to the default limit for an absent param", async () => {
  insertNeuron({ netuid: 0, uid: 0, hotkey: "5A", stake_tao: 10 });
  const res = await call(req("/api/v1/accounts"));
  assert.equal(res.status, 200);
  assert.equal((((await res.json()) as Row).accounts as Row[]).length, 1);
});

// --- neuron_daily history routes ---------------------------------------------

test("GET /api/v1/subnets/:netuid/neurons/:uid/history windows on snapshot_date and ?window=all lifts the bound", async () => {
  insertDaily({ uid: 3, snapshot_date: dayAgo(1), stake_tao: 10 });
  insertDaily({ uid: 3, snapshot_date: dayAgo(60), stake_tao: 5 });
  const windowed = await call(req("/api/v1/subnets/7/neurons/3/history"));
  assert.equal(windowed.status, 200);
  const windowedBody = (await windowed.json()) as Row;
  assert.equal((windowedBody.points as Row[]).length, 1, "30d default window");
  const all = await call(req("/api/v1/subnets/7/neurons/3/history?window=all"));
  assert.equal(all.status, 200);
  const allBody = (await all.json()) as Row;
  assert.equal((allBody.points as Row[]).length, 2);
  assert.equal(allBody.window, "all");
});

test("GET /api/v1/subnets/:netuid/history aggregates per day (SUM over 0/1 validator_permit)", async () => {
  insertDaily({
    uid: 0,
    snapshot_date: dayAgo(1),
    validator_permit: 1,
    stake_tao: 10,
    emission_tao: 1,
  });
  insertDaily({
    uid: 1,
    snapshot_date: dayAgo(1),
    validator_permit: 0,
    stake_tao: 20,
    emission_tao: 2,
  });
  insertDaily({
    uid: 0,
    snapshot_date: dayAgo(60),
    validator_permit: 1,
    stake_tao: 5,
    emission_tao: 1,
  });
  const res = await call(req("/api/v1/subnets/7/history"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  const points = body.points as Row[];
  assert.equal(points.length, 1, "the 60d-old day is outside the 30d default");
  assert.equal(points[0].neuron_count, 2);
  assert.equal(points[0].validator_count, 1);
  assert.equal(points[0].total_stake_alpha, 30);
  const all = await call(req("/api/v1/subnets/7/history?window=all"));
  assert.equal((((await all.json()) as Row).points as Row[]).length, 2);
});

test("GET /api/v1/validators/:hotkey/history prices each day at its own snapshot", async () => {
  const day = dayAgo(1);
  insertDaily({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    validator_permit: 1,
    stake_tao: 100,
    emission_tao: 10,
    snapshot_date: day,
  });
  insertDaily({
    netuid: 7,
    uid: 1,
    hotkey: "5Val",
    validator_permit: 1,
    stake_tao: 100,
    emission_tao: 10,
    snapshot_date: day,
  });
  insertPrice(7, day, 0.5);
  const res = await call(req("/api/v1/validators/5Val/history"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  const points = body.points as Row[];
  assert.equal(points.length, 1);
  assert.equal(points[0].subnet_count, 2);
  // root 100 * 1 + netuid-7 100 * 0.5
  assert.equal(points[0].total_stake_tao, 150);
  const all = await call(req("/api/v1/validators/5Val/history?window=all"));
  assert.equal(all.status, 200);
});

test("GET /api/v1/validators/:hotkey/history?netuid= scopes to one subnet (#9383)", async () => {
  const day = dayAgo(1);
  insertDaily({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    validator_permit: 1,
    stake_tao: 100,
    emission_tao: 10,
    snapshot_date: day,
  });
  insertDaily({
    netuid: 7,
    uid: 1,
    hotkey: "5Val",
    validator_permit: 1,
    stake_tao: 100,
    emission_tao: 10,
    validator_trust: 0.75,
    consensus: 0.4,
    dividends: 0.25,
    take: 0.18,
    snapshot_date: day,
  });
  insertPrice(7, day, 0.5);

  const res = await call(req("/api/v1/validators/5Val/history?netuid=7"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.netuid, 7);
  const points = body.points as Row[];
  assert.equal(points.length, 1, "root's row for the same day is excluded");
  assert.equal(points[0].netuid, 7);
  assert.equal(points[0].uid, 1);
  // Alpha stays alpha; the TAO figure is the same value priced at 0.5.
  assert.equal(points[0].stake_alpha, 100);
  assert.equal(points[0].emission_alpha, 10);
  assert.equal(points[0].total_stake_tao, 50);
  assert.equal(points[0].total_emission_tao, 5);
  // The per-subnet facts the unscoped rollup sums away.
  assert.equal(points[0].validator_trust, 0.75);
  assert.equal(points[0].consensus, 0.4);
  assert.equal(points[0].dividends, 0.25);
  assert.equal(points[0].take, 0.18);
  assert.equal(points[0].validator_permit, true);
});

test("GET /api/v1/validators/:hotkey/history?netuid= reports a lost permit (#9383)", async () => {
  // The unscoped query filters validator_permit = 1, which turns a lost permit
  // into an absent day -- indistinguishable from a day the poller missed. Scoped,
  // the day is returned with the permit false.
  const day = dayAgo(1);
  insertDaily({
    netuid: 7,
    uid: 1,
    hotkey: "5NoPermit",
    validator_permit: 0,
    stake_tao: 100,
    emission_tao: 0,
    snapshot_date: day,
  });
  insertPrice(7, day, 0.5);

  const unscoped = (await (
    await call(req("/api/v1/validators/5NoPermit/history"))
  ).json()) as Row;
  assert.equal((unscoped.points as Row[]).length, 0, "filtered out unscoped");
  assert.equal(unscoped.netuid, null);

  const scoped = (await (
    await call(req("/api/v1/validators/5NoPermit/history?netuid=7"))
  ).json()) as Row;
  const points = scoped.points as Row[];
  assert.equal(points.length, 1);
  assert.equal(points[0].validator_permit, false);
});

test("GET /api/v1/subnets/:netuid/{concentration,performance,yield}/history serve windowed day series", async () => {
  insertDaily({ uid: 0, snapshot_date: dayAgo(1) });
  insertDaily({ uid: 1, snapshot_date: dayAgo(1) });
  for (const route of [
    "/api/v1/subnets/7/concentration/history",
    "/api/v1/subnets/7/performance/history",
    "/api/v1/subnets/7/yield/history",
  ]) {
    const res = await call(req(route));
    assert.equal(res.status, 200, route);
    const body = (await res.json()) as Row;
    assert.equal(body.netuid, 7, route);
    assert.equal((body.points as Row[]).length, 1, route);
  }
});

// --- Turnover + movers (the date-arithmetic translations) --------------------

test("GET /api/v1/chain/turnover compares the window's boundary snapshots", async () => {
  const start = dayAgo(7);
  const end = dayAgo(1);
  insertDaily({
    netuid: 7,
    uid: 0,
    hotkey: "5A",
    validator_permit: 1,
    snapshot_date: start,
  });
  insertDaily({
    netuid: 7,
    uid: 1,
    hotkey: "5B",
    validator_permit: 1,
    snapshot_date: start,
  });
  insertDaily({
    netuid: 7,
    uid: 0,
    hotkey: "5A",
    validator_permit: 1,
    snapshot_date: end,
  });
  insertDaily({
    netuid: 7,
    uid: 1,
    hotkey: "5C",
    validator_permit: 1,
    snapshot_date: end,
  });
  const res = await call(req("/api/v1/chain/turnover?window=30d"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.start_date, start);
  assert.equal(body.end_date, end);
  const network = body.network as Row;
  assert.equal(network.validators_entered, 1);
  assert.equal(network.validators_exited, 1);
});

test("GET /api/v1/chain/turnover on an empty store serves the schema-stable empty shape", async () => {
  const res = await call(req("/api/v1/chain/turnover"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.start_date, null);
  assert.equal(body.end_date, null);
});

test("GET /api/v1/subnets/:netuid/turnover anchors the window to the subnet's own newest snapshot", async () => {
  const start = dayAgo(7);
  const end = dayAgo(1);
  insertDaily({
    uid: 0,
    hotkey: "5A",
    validator_permit: 1,
    snapshot_date: start,
  });
  insertDaily({
    uid: 0,
    hotkey: "5B",
    validator_permit: 1,
    snapshot_date: end,
  });
  const res = await call(req("/api/v1/subnets/7/turnover?window=30d"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.start_date, start);
  assert.equal(body.end_date, end);
  assert.equal(body.validators_entered, 1);
  assert.equal(body.validators_exited, 1);
});

test("GET /api/v1/subnets/:netuid/turnover?window=all&changes=true takes the unbounded branch and details the churn", async () => {
  const start = dayAgo(400);
  const end = dayAgo(1);
  insertDaily({
    uid: 0,
    hotkey: "5A",
    validator_permit: 1,
    snapshot_date: start,
  });
  insertDaily({
    uid: 0,
    hotkey: "5B",
    validator_permit: 1,
    snapshot_date: end,
  });
  const res = await call(
    req("/api/v1/subnets/7/turnover?window=all&changes=true"),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.start_date, start, "window=all reaches past 365 days");
  assert.ok(body.changes, "changes=true adds the detail block");
});

test("GET /api/v1/subnets/movers groups both boundary snapshots per netuid", async () => {
  const start = dayAgo(7);
  const end = dayAgo(1);
  insertDaily({
    netuid: 7,
    uid: 0,
    snapshot_date: start,
    stake_tao: 100,
    validator_permit: 1,
  });
  insertDaily({
    netuid: 7,
    uid: 0,
    snapshot_date: end,
    stake_tao: 150,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/subnets/movers?window=30d"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.start_date, start);
  assert.equal(body.end_date, end);
  assert.equal(body.subnet_count, 1);
  assert.equal((body.movers as Row[])[0].netuid, 7);
});

test("GET /api/v1/subnets/movers with a single stored day stays empty (not comparable)", async () => {
  insertDaily({ netuid: 7, uid: 0, snapshot_date: dayAgo(1) });
  const res = await call(req("/api/v1/subnets/movers"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.subnet_count, 0);
});

// --- account_position_daily reader -------------------------------------------

test("GET /api/v1/accounts/:ss58/subnets/:netuid/history reads account_position_daily with the window bound", async () => {
  const insertPosition = (snapshotDate: string, stake: number) =>
    db
      .prepare(
        `INSERT INTO account_position_daily
           (account, netuid, snapshot_date, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao, captured_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...([
          "5Acct",
          7,
          snapshotDate,
          0,
          "5Cold",
          1,
          1,
          0.5,
          0.9,
          0.1,
          0.2,
          stake,
          1.5,
          CAPTURED_AT,
          CAPTURED_AT,
        ] as never[]),
      );
  insertPosition(dayAgo(1), 100);
  insertPosition(dayAgo(60), 50);
  const res = await call(req("/api/v1/accounts/5Acct/subnets/7/history"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal((body.points as Row[]).length, 1, "30d default window");
  assert.equal((body.points as Row[])[0].stake_tao, 100);
  const all = await call(
    req("/api/v1/accounts/5Acct/subnets/7/history?window=all"),
  );
  assert.equal((((await all.json()) as Row).points as Row[]).length, 2);
});

// --- Enrichment degrade paths ------------------------------------------------

test("windowed leaderboard params: an explicit valid limit is honored on /api/v1/validators", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5A",
    stake_tao: 10,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5B",
    stake_tao: 20,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators?limit=1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.limit, 1);
  assert.equal((body.validators as Row[]).length, 1);
});

test("a NULL alpha_price_tao snapshot and a NULL-hotkey daily row are carried and skipped, not crashed on", async () => {
  insertNeuron({
    netuid: 7,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  // Latest snapshot for netuid 7 carries an explicitly NULL price.
  db.prepare(
    "INSERT INTO subnet_snapshots (netuid, snapshot_date, alpha_price_tao, tao_in_pool_tao, alpha_in_pool) VALUES (7, ?, NULL, NULL, NULL)",
  ).run(dayAgo(0));
  // A permitted daily row with no hotkey: the baseline fold must skip it.
  insertDaily({
    netuid: 7,
    uid: 1,
    hotkey: null,
    validator_permit: 1,
    snapshot_date: dayAgo(1),
  });
  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 1);
  // A null price excludes the membership from the totals (never 1:1).
  assert.equal((body.validators as Row[])[0].total_stake_tao, 0);
});

test("chain turnover normalizes a bogus window and an explicit limit on an empty store", async () => {
  const res = await call(req("/api/v1/chain/turnover?window=bogus&limit=5"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.window, "30d", "unknown window falls back to the default");
  assert.equal(body.start_date, null);
});

test("subnet turnover on an empty subnet resolves null bounds and the schema-stable empty block", async () => {
  const res = await call(req("/api/v1/subnets/42/turnover?window=bogus"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.window, "30d");
  assert.equal(body.start_date, null);
  assert.equal(body.end_date, null);
  // And with no window param at all: the default label applies.
  const defaulted = await call(req("/api/v1/subnets/42/turnover"));
  assert.equal(defaulted.status, 200);
  assert.equal(((await defaulted.json()) as Row).window, "30d");
});

test("movers normalizes a bogus window plus explicit sort/limit on an empty store", async () => {
  const res = await call(
    req("/api/v1/subnets/movers?window=bogus&sort=emission&limit=3"),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.window, "30d");
  assert.equal(body.sort, "emission");
  assert.equal(body.start_date, null);
  assert.equal(body.subnet_count, 0);
});

test("a missing subnet_snapshots table degrades prices and baselines, never the validators route", async () => {
  db.exec("DROP TABLE subnet_snapshots");
  insertNeuron({
    netuid: 7,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  insertDaily({
    netuid: 7,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 50,
    validator_permit: 1,
    snapshot_date: dayAgo(1),
  });
  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 1);
  const entry = (body.validators as Row[])[0];
  // Unpriceable non-root stake is EXCLUDED from the totals (never counted
  // 1:1), and the baseline map degraded to empty -> realized returns null.
  assert.equal(entry.total_stake_tao, 0);
  assert.equal(entry.realized_return_1d, null);
});

// --- apy_estimate (#9342) ----------------------------------------------------
//
// The computation was always correct; both handlers passed `tempoByNetuid:
// new Map()`, so every lookup missed and apy_estimate was `null` on EVERY served
// response. These pin the wiring, not the maths -- each one fails against the
// empty-map placeholder.

test("GET /api/v1/validators resolves apy_estimate from the subnet_hyperparams tempo", async () => {
  insertTempo(1, 99);
  // A non-root membership needs a price or it is excluded from the totals
  // entirely, before apy is ever reached.
  insertPrice(1, dayAgo(0), 0.5);
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Apy",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const entry = ((await res.json()) as Row).validators as Row[];
  assert.notEqual(
    entry[0].apy_estimate,
    null,
    "an empty tempo map made this unconditionally null",
  );
  assert.equal(entry[0].apy_estimate_eligible_subnet_count, 1);
});

test("GET /api/v1/validators/:hotkey resolves apy_estimate too", async () => {
  // The detail route had the same placeholder as the leaderboard, so fixing one
  // and not the other would leave the two surfaces disagreeing about the same
  // validator.
  insertTempo(1, 99);
  insertPrice(1, dayAgo(0), 0.5);
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Apy",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators/5Apy"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.notEqual(body.apy_estimate, null);
  assert.equal(body.apy_estimate_eligible_subnet_count, 1);
});

test("a shorter tempo annualizes to a higher apy for the same emission", async () => {
  // The tempo has to actually reach the maths, not merely be non-empty: more
  // epochs per year on the same per-epoch emission means more annual yield.
  insertTempo(1, 99);
  insertTempo(2, 990);
  insertPrice(1, dayAgo(0), 0.5);
  insertPrice(2, dayAgo(0), 0.5);
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Fast",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 2,
    uid: 0,
    hotkey: "5Slow",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  const rows = ((await res.json()) as Row).validators as Row[];
  const fast = rows.find((r) => r.hotkey === "5Fast") as Row;
  const slow = rows.find((r) => r.hotkey === "5Slow") as Row;
  assert.ok(
    (fast.apy_estimate as number) > (slow.apy_estimate as number),
    "10x the tempo must be ~1/10th the apy",
  );
});

test("root counts toward apy_estimate — it is a real network with a real tempo", async () => {
  // Verified against finney: NetworksAdded(0) is true and Tempo(0) is 100, so a
  // root membership is not a capture artefact. Excluding it would drop the
  // position of exactly the validators whose stake is mostly on root.
  insertTempo(0, 100);
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Root",
    stake_tao: 500,
    emission_tao: 2,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  const entry = (((await res.json()) as Row).validators as Row[])[0];
  assert.notEqual(entry.apy_estimate, null);
  assert.equal(entry.apy_estimate_eligible_subnet_count, 1);
});

test("a membership whose tempo is missing is excluded, not defaulted", async () => {
  // netuid 2 has no hyperparams row at all, so only netuid 1 is eligible -- the
  // count is what says so, and a fabricated default would hide it.
  insertTempo(1, 99);
  insertPrice(1, dayAgo(0), 0.5);
  insertPrice(2, dayAgo(0), 0.5);
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Mix",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  insertNeuron({
    netuid: 2,
    uid: 0,
    hotkey: "5Mix",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  const entry = (((await res.json()) as Row).validators as Row[])[0];
  assert.equal(entry.apy_estimate_eligible_subnet_count, 1);
});

test("a zero tempo is treated as unresolved rather than an infinite yield", async () => {
  // tempo=0 would divide into an infinite epochsPerYear; tempoByNetuid drops it,
  // so the row is excluded and apy_estimate stays null.
  insertTempo(1, 0);
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Zero",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  const entry = (((await res.json()) as Row).validators as Row[])[0];
  assert.equal(entry.apy_estimate, null);
  assert.equal(entry.apy_estimate_eligible_subnet_count, 0);
});

test("apy_estimate stays null when the hyperparams table is cold", async () => {
  // The degrade contract: no tempo rows at all means no APY opinion, which is
  // what a caller got unconditionally before the read was wired.
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Cold",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  const entry = (((await res.json()) as Row).validators as Row[])[0];
  assert.equal(entry.apy_estimate, null);
  assert.equal(entry.apy_estimate_eligible_subnet_count, 0);
});

test("a missing subnet_hyperparams table degrades apy_estimate, never the validators route", async () => {
  // Same degrade contract as the subnet_snapshots case above: the tempo read is
  // an ENRICHMENT, so losing it costs the APY opinion and nothing else. A throw
  // that escaped here would take down the whole leaderboard over a side table.
  db.exec("DROP TABLE subnet_hyperparams");
  insertPrice(1, dayAgo(0), 0.5);
  insertNeuron({
    netuid: 1,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    emission_tao: 1,
    validator_permit: 1,
  });
  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 1, "the route still serves");
  const entry = (body.validators as Row[])[0];
  // 100 alpha priced at 0.5 = 50 TAO. The point is that it is unchanged by the
  // missing tempo table -- the stake path and the APY path are independent.
  assert.equal(entry.total_stake_tao, 50, "the stake total is unaffected");
  assert.equal(entry.apy_estimate, null, "only the APY opinion is lost");
  assert.equal(entry.apy_estimate_eligible_subnet_count, 0);
});
