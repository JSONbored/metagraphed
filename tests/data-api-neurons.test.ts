// The neurons family, exercised END TO END against a REAL SQLite database
// standing in for Postgres -- same rationale as tests/data-api-user-state.ts:
// the riskiest constructs here (chunked multi-row guarded upserts, the
// ON CONFLICT ... WHERE captured_at guards, the window/date translations that
// have twice emptied a route) only fail at execution, and no queue fake parses
// SQL.
//
// Every request goes through the real Worker fetch handler, and the store is
// Neon: the snapshot's three tables are in NEON_SOLE_STORE_TABLES, the sync
// gates on all three being declared, and a write that does not land IS the
// pass's failure rather than a lost mirror. What is under test is that whole
// lane against the real migration files -- the write's statements actually
// executing, the read dispatcher's route matching, and the dialect of every
// query on the way.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import type { Row } from "./row-type.ts";
import { persistComputeDeclaration } from "../src/compute-declarations-lane.ts";
import {
  explorerDirectoriesSnapshotKey,
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_DIRECTORIES_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
} from "../src/kv-keys.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { DataApiWorkerEnv } from "../workers/types.ts";

// The store is Postgres now (#10179), reached through `new Client(...)` inside
// src/pg-sql.ts and src/neon-write.ts -- neither of which a route caller can
// inject into, because the caller is `worker.fetch(request, env, ctx)`. Mocking
// the module is the seam; see tests/helpers/pg-mock.ts for why it is a module
// mock and not a production export, and why the controller is built inside
// vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

const {
  default: worker,
  materializationFromUnknown,
  refreshExplorerDirectoryMaterialization,
} = await import("../workers/data-api.ts");

/**
 * The REAL Neon DDL for every table this route family touches (#10328).
 *
 * Six SQLite fixtures became four migrations, and the collapse is the point:
 * the fixture set was a hand-curated subset, so "which tables does this lane
 * need" was a judgement made once and never rechecked. On the real files a
 * lane either finds its table or it does not.
 *
 * coerceNeuronSyncRow turns three flag columns into real booleans for Postgres
 * BOOLEAN -- a bind node:sqlite refuses outright -- and the prune emits
 * `unnest($1::int[], $2::bigint[])`, an ARRAY-typed cast the SQLite
 * translation deleted before the engine ever saw it.
 */
const MIGRATIONS = [
  "migrations/neon/0001_side_tables.sql",
  "migrations/neon/0002_probe_observations.sql",
  "migrations/neon/0005_remaining_d1_tables.sql",
  "migrations/neon/0007_hand_created_tables.sql",
  // #10929: owner-capture joins the rollup to the declared owner, and
  // `subnet_ownership` arrives in its own later migration.
  "migrations/neon/0024_subnet_ownership.sql",
  // #10933: the treasury readings store, exercised end to end because its
  // CHECK constraints are the only thing standing between a private extractor
  // and a published contradiction.
  "migrations/neon/0028_treasury_readings.sql",
  // #10932: same argument for the compute declarations -- the extractor writes
  // from a private lane, so its CHECK constraints are the only enforcement.
  "migrations/neon/0029_compute_declarations.sql",
  // #11282: and the migration that widened those CHECKs for a declaration
  // naming no role. Applied here because this file exists to run the REAL DDL
  // -- omitting it would test the extractor against a schema production no
  // longer has, which is the failure mode the hand-curated fixture set had.
  "migrations/neon/0030_compute_declarations_unscoped.sql",
]
  .map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"))
  // #11095: the emission-split USD legs read tao_usd_index, whose home
  // migration (0003) also creates history tables that collide with the
  // shapes the later files above establish under IF NOT EXISTS. Slice the
  // ONE table's block out of the real migration rather than restating its
  // DDL: the CREATE TABLE and its trailing index, single-sourced.
  .concat(
    (() => {
      const migration = fs.readFileSync(
        path.join(
          process.cwd(),
          "migrations/neon/0003_append_only_histories.sql",
        ),
        "utf8",
      );
      const start = migration.indexOf(
        "CREATE TABLE IF NOT EXISTS tao_usd_index",
      );
      const end = migration.indexOf("CREATE TABLE", start + 1);
      if (start === -1 || end === -1)
        throw new Error("tao_usd_index block not found in migration 0003");
      return [migration.slice(start, end)];
    })(),
  );

/** Tables a test may write, emptied between tests. */
const SEEDED_TABLES = [
  "neurons",
  "neuron_daily",
  "account_position_daily",
  "neurons_passes",
  "validator_nominator_counts",
  "subnet_hyperparams",
  "subnet_snapshots",
  "tao_usd_index",
  "surface_checks",
  "surface_status",
  "subnet_ownership",
  "nominator_positions",
  "treasury_readings",
  "compute_declarations",
];

let db: PGlite;

/**
 * Run a seed statement written with `?` placeholders.
 *
 * The fixtures below were written against node:sqlite and read clearly as they
 * are; rewriting each one to `$n` by hand would be a large diff that changes
 * nothing about what is being seeded. Postgres only accepts `$n`, so the
 * rewrite happens here -- the same conversion `toPositionalPlaceholders` does
 * for production SQL, kept local because these are fixtures rather than code
 * under test.
 */
const seed = async (sql: string, params: unknown[] = []) => {
  let i = 0;
  await db.query(
    sql.replace(/\?/g, () => `$${++i}`),
    params as never[],
  );
};

const SYNC_SECRET = "test-neurons-sync-secret";
const BACKFILL_SECRET = "test-neuron-daily-backfill-secret";

function env(overrides: Record<string, unknown> = {}): DataApiWorkerEnv {
  return dataApiEnv({
    ...pgMockEnv(),
    // Both write paths run through mirrorNeuronSnapshotToNeon, which is a no-op
    // unless the lane is named here -- so a suite that left this out would
    // assert an empty table and call it a passing write.
    NEURONS_SYNC_SECRET: SYNC_SECRET,
    NEURON_DAILY_BACKFILL_SECRET: BACKFILL_SECRET,
    ...overrides,
  });
}

function memoryKv() {
  const values = new Map<string, string>();
  let puts = 0;
  return {
    values,
    putCount: () => puts,
    get: async (key: string, type?: string) => {
      const value = values.get(key) ?? null;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      puts += 1;
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

function collectingCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil(value: Promise<unknown>) {
        pending.push(Promise.resolve(value));
      },
    } as unknown as ExecutionContext,
  };
}

/** A ctx with a real `waitUntil`. createPgSql hands the client back through it
 * from a `finally`, so an object without one turns every successful query into
 * a TypeError -- silently, because the rejection replaces the result. */
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

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

async function call(request: Request, envOverride: DataApiWorkerEnv = env()) {
  return worker.fetch(request, envOverride, ctx);
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

async function insertNeuron(overrides: Row = {}) {
  const row = syncRow(overrides);
  await seed(
    `INSERT INTO neurons (${NEURON_DB_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );
}

async function insertDaily(overrides: Row = {}) {
  const row: Row = {
    snapshot_date: dayAgo(1),
    updated_at: Date.now(),
    ...syncRow(),
    ...overrides,
  };
  await seed(
    `INSERT INTO neuron_daily (snapshot_date, updated_at, ${NEURON_DB_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
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
async function insertPrice(
  netuid: number,
  snapshotDate: string,
  price: number,
) {
  const alphaInPool = 1_000_000;
  await seed(
    `INSERT INTO subnet_snapshots
       (netuid, snapshot_date, alpha_price_tao, tao_in_pool_tao, alpha_in_pool)
     VALUES (?, ?, ?, ?, ?)`,
    [netuid, snapshotDate, price * 2, price * alphaInPool, alphaInPool],
  );
}

const one = async (sql: string, ...params: unknown[]) => {
  let i = 0;
  return (
    await db.query<Row>(
      sql.replace(/\?/g, () => `$${++i}`),
      params as never[],
    )
  ).rows[0] as Row;
};
const count = async (table: string) =>
  Number(
    (await db.query<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)).rows[0]!
      .n,
  );

// ONE instance for the file, TRUNCATE between tests. Several tests DROP a
// table on purpose to reach a decline path, so beforeEach re-applies the
// migrations first -- every statement is IF NOT EXISTS, a no-op otherwise.
beforeAll(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
});

beforeEach(async () => {
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec(`TRUNCATE ${SEEDED_TABLES.join(", ")}`);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  // Handed over VERBATIM: real booleans to real BOOLEAN columns, and the
  // prune's `unnest($1::int[], $2::bigint[])` judged by the engine that runs
  // it rather than by a translation that stripped its casts.
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
});

// netuid -> tempo(blocks), the row apy_estimate annualizes against. Values are
// the real chain ones (SubtensorModule::Tempo): root 100, netuid 1 is 99.
async function insertTempo(netuid: number, tempo: number | null) {
  await seed(
    "INSERT INTO subnet_hyperparams (netuid, tempo, captured_at) VALUES (?, ?, ?)",
    [netuid, tempo as never, Date.now()],
  );
}

// --- POST /api/v1/internal/neurons-sync: the D1 write lane -------------------

async function postSync(rows: Row[], envOverride: DataApiWorkerEnv = env()) {
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
  // One store, and it is named: `stores` stays REPORTED rather than inferred,
  // because "which store did this snapshot actually reach" is precisely the
  // question nobody could answer while Neon was frozen behind a mirror.
  assert.deepEqual(body.stores, ["neon"]);

  assert.equal(await count("neurons"), 3);
  assert.equal(await count("neuron_daily"), 3);
  assert.equal(await count("account_position_daily"), 2);
  const stored = await one(
    "SELECT * FROM neurons WHERE netuid = 7 AND uid = 0",
  );
  assert.equal(stored.hotkey, "5Hot7-0");
  // A REAL BOOLEAN. This read `1, "boolean stored as INTEGER 1"` -- which was
  // node:sqlite's coercion showing through the double, not the store: the
  // column is BOOLEAN in migrations/neon/0007.
  assert.equal(stored.validator_permit, true);
  assert.equal(stored.take, 0.18);
  const daily = await one(
    "SELECT * FROM neuron_daily WHERE netuid = 7 AND uid = 0",
  );
  assert.equal(daily.snapshot_date, "2026-07-15", "derived from captured_at");
  const position = await one(
    "SELECT * FROM account_position_daily WHERE account = '5Hot7-0'",
  );
  assert.equal(position.netuid, 7);
  assert.equal(position.stake_tao, 100);
});

test("the direct neurons path publishes explorer directories when its declared pass completes", async () => {
  const kv = memoryKv();
  const collected = collectingCtx();
  const response = await worker.fetch(
    req("/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": SYNC_SECRET },
      body: { rows: [syncRow()], pass_total: 1 },
    }),
    env({ METAGRAPH_CONTROL: kv }),
    collected.ctx,
  );

  assert.equal(response.status, 200);
  await Promise.all(collected.pending);
  const pointer = JSON.parse(
    kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!,
  ) as Row;
  assert.equal(pointer.captured_at, CAPTURED_AT);
  const stored = JSON.parse(
    kv.values.get(explorerDirectoriesSnapshotKey(CAPTURED_AT))!,
  ) as Row;
  assert.equal((stored.accounts as Row).account_count, 1);
  assert.equal((stored.validators as Row).validator_count, 1);
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT)!)
      .account_count,
    1,
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT)!)
      .validator_count,
    1,
  );
});

test("the direct neurons path does not publish an incomplete declared pass", async () => {
  const kv = memoryKv();
  const collected = collectingCtx();
  const response = await worker.fetch(
    req("/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": SYNC_SECRET },
      body: { rows: [syncRow()], pass_total: 2 },
    }),
    env({ METAGRAPH_CONTROL: kv }),
    collected.ctx,
  );

  assert.equal(response.status, 200);
  await Promise.all(collected.pending);
  assert.equal(kv.putCount(), 0);
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
    (await one("SELECT stake_tao FROM neurons WHERE netuid = 7 AND uid = 0"))
      .stake_tao,
    100,
    "older capture must not clobber",
  );
  const fresh = await postSync([
    syncRow({ stake_tao: 200, captured_at: CAPTURED_AT + 1000 }),
  ]);
  assert.equal(fresh.status, 200);
  assert.equal(
    (await one("SELECT stake_tao FROM neurons WHERE netuid = 7 AND uid = 0"))
      .stake_tao,
    200,
  );
});

// The per-netuid deregistration prune used to live here: the D1 write appended
// a `DELETE FROM neurons WHERE netuid = ? AND captured_at < ?` per netuid the
// batch covered, which is what retired a UID that had been deregistered, and
// what scoped that retirement to the netuids the batch actually carried.
//
// Nothing on the Neon path does it. NEURON_MIRROR_PLANS upserts three tables
// and deletes from none, and NEON_PRUNE_PLANS covers only surface_checks and
// subnet_burn_history. The test is deleted rather than rewritten because there
// is no behaviour left to assert -- see the report accompanying this change.

test("a payload that D1 had to split into chunks now travels as one statement", async () => {
  // 100 rows x 20 columns = 2,000 binds. D1 capped a statement at 100 bound
  // parameters, so this was 45 neuron rows per statement and several statements
  // per table -- the wall #9157 hit, and the reason the D1 writer smuggled whole
  // chunks through a single json_each parameter. Postgres takes 65,535, and
  // writeRowsToNeon budgets 80% of that, so 2,621 twenty-column rows fit in one.
  //
  // The chunking still exists and still has to be right; it simply does not
  // engage at this size. What matters end to end is unchanged: every row lands.
  const rows = Array.from({ length: 100 }, (_, uid) =>
    syncRow({ uid, hotkey: `5Hot7-${uid}` }),
  );
  const res = await postSync(rows);
  assert.equal(res.status, 200);
  assert.equal(await count("neurons"), 100);
  assert.equal(await count("neuron_daily"), 100);
  assert.equal(await count("account_position_daily"), 100);
  assert.equal(
    pg.control.queries.filter((q) => q.text.startsWith("INSERT INTO neurons "))
      .length,
    1,
    "one statement for the whole table, not 45 rows at a time",
  );
});

test("neurons-sync 503s when there is no store bound for the route", async () => {
  const res = await postSync([syncRow()], env({ HYPERDRIVE: undefined }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "no store bound for this route",
  });
});

// The all-three-tables-declared 503 retired with NEON_SOLE_STORE_TABLES
// (#10051): Neon is the only store, so a partially-declared snapshot cannot
// exist. The no-store 503 above pins what remains refusable.

test("a failed table is a 502, and the tables written before it are NOT rolled back", async () => {
  // A behaviour change worth stating rather than discovering. D1's batch was
  // one implicit transaction, so a mid-batch failure rolled the whole snapshot
  // back. writeRowsToNeon writes the three tables in sequence with no
  // transaction around them, so `neurons` lands and then the position write
  // fails.
  //
  // That is survivable only because every one of these writes is an idempotent
  // guarded upsert and the producer retries the whole chunk: the retry
  // converges on the same state rather than double-counting. What must NOT
  // happen is the request reporting ok -- the producer would advance past a
  // snapshot two of whose three tables are missing.
  await db.exec("DROP TABLE account_position_daily");
  const res = await postSync([syncRow()]);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "neon write failed" });
  assert.equal(
    await count("neurons"),
    1,
    "written before the failure, and kept",
  );
  assert.equal(await count("neuron_daily"), 1);
});

// --- POST /api/v1/internal/backfill-neuron-daily: the D1 write lane ----------

async function postBackfill(
  rows: Row[],
  envOverride: DataApiWorkerEnv = env(),
) {
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
  assert.equal(body.ok, true);
  assert.equal(body.neuron_daily_written, 2);
  assert.equal(body.account_position_daily_written, 1);
  assert.deepEqual(body.stores, ["neon"]);
  assert.equal(await count("neuron_daily"), 2);
  assert.equal(await count("account_position_daily"), 1);
  // The pre-existing live row survived: no prune, no neurons write.
  assert.equal(await count("neurons"), 1);
});

// "backfill-neuron-daily is idempotent under the captured_at guard" was here.
//
// It posted a row, then re-posted the same (netuid, uid, snapshot_date) with an
// OLDER captured_at, and asserted the fresher value survived. The D1 writer
// enforced that with `ON CONFLICT ... WHERE captured_at <= EXCLUDED.captured_at`
// on neuron_daily and account_position_daily, and this route's own header still
// describes it: "a backfill re-POST (or a backfill overlapping a date the
// forward sync already covered) is idempotent and can never clobber a fresher
// row -- it can only fill a genuinely missing past snapshot_date".
//
// NEURON_MIRROR_PLANS puts that guard on `neurons` only, and
// tests/neurons-neon-write.test.ts asserts the other two carry none, reasoning
// that "the daily tables are keyed by snapshot_date, so a late arrival lands on
// its own day rather than overwriting a newer one". That holds ACROSS days and
// not WITHIN one: a backfill overlapping today's date has the same
// snapshot_date as the forward sync and an older captured_at, which is exactly
// the case this test constructed -- and it now overwrites.
//
// Deleted rather than inverted, because pinning the overwrite would read as a
// decision. The fix is two `guard:` entries in NEURON_MIRROR_PLANS and an
// update to the test that currently asserts their absence, which is a change
// this suite should not make on its own -- see the report.

test("backfill-neuron-daily 503s with no store -- it writes, so it needs one", async () => {
  const noStore = await postBackfill(
    [syncRow()],
    env({ HYPERDRIVE: undefined }),
  );
  assert.equal(noStore.status, 503);
  assert.deepEqual(await noStore.json(), {
    error: "no store bound for this route",
  });
});

test("backfill-neuron-daily maps a write failure to a 502", async () => {
  // The operator replaying a year of history is precisely the caller who must
  // not be told `ok` for rows that landed nowhere.
  await db.exec("DROP TABLE neuron_daily");
  const res = await postBackfill([syncRow()]);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "neon write failed" });
});

// --- The D1 read dispatcher: gates and fallthrough ---------------------------

test("a route no matcher claims falls through to the no-handler 503", async () => {
  // The message says what the gate actually tests -- no branch matched. It read
  // `hyperdrive binding unavailable` from #9193 until #10060 bound Hyperdrive
  // again, after which a 503 from here pointed a reader at a healthy database
  // link instead of at the missing route.
  const res = await call(req("/api/v1/blocks"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "no handler on the data tier for this route",
  });
});

// The METAGRAPH_NEURONS_SOURCE gate is gone from this dispatcher --
// matchNeuronsStoreRoute takes only a URL now. It existed to hand a route back to
// a Postgres tier that no longer exists, and the test that pinned it is deleted
// rather than rewritten: the main Worker still reads the flag to decide whether
// to FORWARD here, which is a different assertion in a different suite. What
// gates these routes instead is the HYPERDRIVE binding alone (#10051).

test("a neurons route 503s cleanly when there is no store bound", async () => {
  const res = await call(
    req("/api/v1/subnets/7/metagraph"),
    env({ HYPERDRIVE: undefined }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: "no store bound for this route",
  });
});

test("a failing read maps to the dispatcher's opaque 502, never a leaked DB error", async () => {
  await db.exec("DROP TABLE neurons");
  const res = await call(req("/api/v1/subnets/7/metagraph"));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "data query failed" });
});

// --- Per-UID metagraph tier ---------------------------------------------------

test("GET /api/v1/subnets/:netuid/metagraph serves the snapshot store", async () => {
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

// The coldkey-identity join reads account_identity in the same database.
// Regression pin for the post-Postgres blackout: the dispatcher used to pass
// identityByColdkey: new Map(), so every operator name vanished when the
// Postgres route (which did the join) was removed.
async function insertIdentity(account: string, name: string) {
  await seed(
    `INSERT INTO account_identity (account, name, url, github, image, discord, description, additional, captured_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    [account, name, Date.now()],
  );
}

test("GET /api/v1/validators keeps priced stake and identity without fabricated returns", async () => {
  // Current state: one validator on root (price 1) with stake 200.
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    coldkey: "5ColdVal",
    stake_tao: 200,
    validator_permit: 1,
  });
  // Yesterday's balance cannot tell whether the increase was a delegation
  // deposit or performance, so the legacy return remains unavailable.
  insertDaily({
    netuid: 0,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
    snapshot_date: dayAgo(1),
  });
  insertIdentity("5ColdVal", "Ventura Labs");
  const res = await call(req("/api/v1/validators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 1);
  const entry = (body.validators as Row[])[0];
  assert.equal(entry.hotkey, "5Val");
  assert.equal(entry.total_stake_tao, 200);
  assert.equal(entry.realized_return_1d, null);
  assert.equal(entry.realized_return_1d_as_of, null);
  // The identity join is live again: the coldkey's account_identity row
  // surfaces as coldkey_identity, not the degraded has_identity:false shape.
  const identity = entry.coldkey_identity as Row;
  assert.equal(identity.has_identity, true);
  assert.equal(identity.name, "Ventura Labs");
});

test.each([
  { label: "deposit", stake: 200, history: true },
  { label: "unstake", stake: 80, history: true },
  { label: "missing history", stake: 100, history: false },
])(
  "validator REST routes keep $label out of realized returns (#12015)",
  async ({ stake, history }) => {
    await insertNeuron({
      netuid: 7,
      uid: 0,
      hotkey: "5Return",
      coldkey: "5ColdReturn",
      stake_tao: stake,
      emission_tao: 0,
      validator_permit: 1,
    });
    await insertPrice(7, dayAgo(0), 3);
    if (history) {
      for (const days of [1, 7, 30]) {
        await insertDaily({
          netuid: 7,
          uid: 0,
          hotkey: "5Return",
          stake_tao: 100,
          emission_tao: 0,
          validator_permit: 1,
          snapshot_date: dayAgo(days),
        });
        await insertPrice(7, dayAgo(days), 3);
      }
    }
    for (const route of ["/api/v1/validators", "/api/v1/validators/5Return"]) {
      pg.control.queries.length = 0;
      const response = await call(req(route));
      assert.equal(response.status, 200);
      const body = (await response.json()) as Row;
      const entry = route === "/api/v1/validators" ? body.validators[0] : body;
      assert.equal(entry.total_stake_tao, stake * 3);
      for (const window of ["1d", "1w", "1m"]) {
        assert.equal(entry[`realized_return_${window}`], null);
        assert.equal(entry[`realized_return_${window}_as_of`], null);
      }
      assert.equal(
        pg.control.queries.some(({ text }) => /FROM neuron_daily/i.test(text)),
        false,
        "no historical balance scan is needed for an unavailable return",
      );
    }
  },
);

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

test("GET /api/v1/validators/operators serves the grouped website projection", async () => {
  insertNeuron({
    netuid: 0,
    uid: 0,
    hotkey: "5TeamLarge",
    coldkey: "5TeamColdLarge",
    stake_tao: 75,
    emission_tao: 6,
    take: 0.1,
  });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5TeamSmall",
    coldkey: "5TeamColdSmall",
    stake_tao: 25,
    emission_tao: 2,
    take: 0.2,
  });
  insertNeuron({
    netuid: 0,
    uid: 2,
    hotkey: "5Anonymous",
    coldkey: "5AnonymousCold",
    stake_tao: 50,
    emission_tao: 1,
    take: null,
  });
  await insertIdentity("5TeamColdLarge", "Tensor Team");
  await insertIdentity("5TeamColdSmall", "Tensor Team");

  const res = await call(req("/api/v1/validators/operators"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.validator_count, 3);
  assert.equal(body.operator_count, 2);
  const operators = body.operators as Row[];
  assert.equal(operators[0]!.identity_name, "Tensor Team");
  assert.equal(operators[0]!.hotkey_count, 2);
  assert.equal(operators[0]!.primary_hotkey, "5TeamLarge");
  assert.equal(operators[0]!.total_stake_tao, 100);
  assert.deepEqual(
    (operators[0]!.hotkeys as Row[]).map((entry) => entry.hotkey),
    ["5TeamLarge", "5TeamSmall"],
  );
  assert.equal(operators[1]!.identity_name, null);
  assert.equal(operators[1]!.primary_hotkey, "5Anonymous");
  assert.deepEqual(operators[1]!.hotkeys, []);
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
  insertIdentity("5Cold7-0", "Yuma");
  const res = await call(req("/api/v1/validators/5Val"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.hotkey, "5Val");
  assert.equal(body.subnet_count, 2);
  // root 100 * 1 + netuid-7 100 * 0.5
  assert.equal(body.total_stake_tao, 150);
  // Detail carries the same identity join as the leaderboard.
  assert.equal((body.coldkey_identity as Row).name, "Yuma");
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

async function insertNominatorCount(
  hotkey: string,
  count: number,
  at = STALE_SCAN,
) {
  await seed(
    "INSERT INTO validator_nominator_counts (hotkey, nominator_count, captured_at) VALUES (?, ?, ?)",
    [hotkey, count, at],
  );
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
  await db.exec("DROP TABLE validator_nominator_counts");

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

test("GET /api/v1/subnets/:netuid/concentration and /performance read the snapshot store", async () => {
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

test("GET /api/v1/chain/concentration/subnets ranks per netuid off the same scan", async () => {
  // Two subnets with opposite reward shapes: netuid 7 spreads emission over
  // three holders, netuid 8 hands it all to one.
  insertNeuron({ netuid: 7, uid: 0, coldkey: "a", emission_tao: 1 });
  insertNeuron({ netuid: 7, uid: 1, coldkey: "b", emission_tao: 1 });
  insertNeuron({ netuid: 7, uid: 2, coldkey: "c", emission_tao: 1 });
  insertNeuron({ netuid: 8, uid: 0, coldkey: "whale", emission_tao: 99 });

  const res = await call(req("/api/v1/chain/concentration/subnets"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.subnet_count, 2);
  assert.equal(body.lens, "emission");
  assert.equal(body.sort, "nakamoto_coefficient");
  assert.equal(body.order, "desc");
  // The spread subnet leads: two of its three holders are needed to pass 50%,
  // against the monopoly's one.
  const ranked = body.subnets as Row[];
  assert.equal(ranked[0].netuid, 7);
  assert.equal(ranked[0].nakamoto_coefficient, 2);
  assert.equal(ranked[1].netuid, 8);
  assert.equal(ranked[1].nakamoto_coefficient, 1);
  assert.equal((body.network as Row).single_holder_subnet_count, 1);
});

test("GET /api/v1/chain/concentration/subnets rejects a bad parameter before the scan", async () => {
  insertNeuron({ netuid: 7, uid: 0 });
  for (const [qs, parameter] of [
    ["lens=vibes", "lens"],
    ["sort=whatever", "sort"],
    ["order=sideways", "order"],
    ["limit=0", "limit"],
    ["limit=99999", "limit"],
  ] as const) {
    const res = await call(req(`/api/v1/chain/concentration/subnets?${qs}`));
    assert.equal(res.status, 400, `${qs} should have been rejected`);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).parameter, parameter);
  }
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

test("GET /api/v1/accounts/:ss58/portfolio prices cross-subnet positions from snapshot stores", async () => {
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

test("GET /api/v1/accounts/directory derives every website ranking from one snapshot", async () => {
  insertNeuron({ netuid: 0, uid: 0, hotkey: "5Stake", stake_tao: 100 });
  insertNeuron({
    netuid: 0,
    uid: 1,
    hotkey: "5Emission",
    stake_tao: 10,
    emission_tao: 20,
  });
  insertNeuron({ netuid: 0, uid: 2, hotkey: "5Reach", stake_tao: 5 });
  insertNeuron({ netuid: 7, uid: 0, hotkey: "5Reach", stake_tao: 5 });
  insertPrice(7, dayAgo(0), 2);

  const res = await call(req("/api/v1/accounts/directory"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.account_count, 3);
  assert.equal(body.priced_registered_stake_tao, 125);
  const rankings = body.rankings as Row;
  assert.equal((rankings.stake as Row[])[0]!.hotkey, "5Stake");
  assert.equal((rankings.emission as Row[])[0]!.hotkey, "5Emission");
  assert.equal((rankings.reach as Row[])[0]!.hotkey, "5Reach");
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

// #9523. Both of the next two assert a SELECT LIST, not a builder: each handler
// hand-transcribed its column list instead of using the shared read constant,
// and each quietly dropped one column. The builders were already covered --
// tests/subnet-performance.test.ts feeds validator_trust straight in -- so the
// gap could only ever be caught by reading a real row back through the route.
// Assert every column the builder consumes, so the next omission fails here.
test("GET /api/v1/subnets/:netuid/neurons/:uid/history serves take (SELECT list must match NEURON_DAILY_READ_COLUMNS)", async () => {
  insertDaily({ uid: 3, snapshot_date: dayAgo(1), take: 0.18 });
  const res = await call(req("/api/v1/subnets/7/neurons/3/history"));
  assert.equal(res.status, 200);
  const point = ((await res.json()) as Row).points as Row[];
  assert.equal(point.length, 1);
  assert.equal(point[0].take, 0.18, "take was dropped from the SELECT list");
  // The neighbours that were never broken, so a regression here reads as the
  // whole projection going wrong rather than one column.
  assert.equal(point[0].validator_trust, 0.8);
  assert.equal(point[0].axon, "1.2.3.4:8091");
});

test("GET /api/v1/subnets/:netuid/performance/history serves validator_trust_mean/median (SELECT list must match PERFORMANCE_HISTORY_READ_COLUMNS)", async () => {
  // Two permit-holding validators on one day: mean 0.6, median 0.6. Distinct
  // values so a mean/median computed over an all-undefined array (the bug)
  // cannot coincidentally match.
  insertDaily({ uid: 0, snapshot_date: dayAgo(1), validator_trust: 0.4 });
  insertDaily({ uid: 1, snapshot_date: dayAgo(1), validator_trust: 0.8 });
  const res = await call(req("/api/v1/subnets/7/performance/history"));
  assert.equal(res.status, 200);
  const points = ((await res.json()) as Row).points as Row[];
  assert.equal(points.length, 1);
  assert.equal(
    points[0].validator_trust_mean,
    0.6,
    "validator_trust was dropped from the SELECT list",
  );
  assert.equal(points[0].validator_trust_median, 0.6);
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
  // The unscoped query filters validator_permit = TRUE, which turns a lost permit
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
    "/api/v1/subnets/7/emission-split/history",
  ]) {
    const res = await call(req(route));
    assert.equal(res.status, 200, route);
    const body = (await res.json()) as Row;
    assert.equal(body.netuid, 7, route);
    assert.equal((body.points as Row[]).length, 1, route);
  }
});

// #10929: owner-capture is the only route in this family that joins THREE
// tables, and two of them (`subnet_ownership`, `nominator_positions`) are
// touched by nothing else here. Driven against the real DDL because the
// pinned-`captured_at` subquery and the coldkey join only fail at execution.
test("GET /api/v1/subnets/:netuid/owner-capture joins the rollup to the declared owner", async () => {
  const date = dayAgo(1);
  await seed(
    `INSERT INTO subnet_ownership (netuid, owner_hotkey, owner_coldkey, captured_at)
     VALUES (?, ?, ?, ?)`,
    [7, "5OwnerHot", "5OwnerCold", Date.now()],
  );
  // The owner's validator UID, and one unrelated miner.
  await insertDaily({
    uid: 0,
    hotkey: "5OwnerHot",
    coldkey: "5OwnerCold",
    validator_permit: 1,
    emission_tao: 30,
    take: 0.18,
    snapshot_date: date,
  });
  await insertDaily({
    uid: 1,
    hotkey: "5Other",
    coldkey: "5Someone",
    validator_permit: 0,
    emission_tao: 70,
    snapshot_date: date,
  });
  // Two captures of the stake behind the owner's hotkey. ONLY THE NEWER ONE
  // may be read -- mixing two passes would produce fractions that sum past 1.
  await seed(
    `INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    ["5OwnerCold", "5OwnerHot", 7, 0.25, 2000],
  );
  await seed(
    `INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    ["5Whale", "5OwnerHot", 7, 0.75, 2000],
  );

  const res = await call(req("/api/v1/subnets/7/owner-capture"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.netuid, 7);
  assert.equal(body.owner_coldkey, "5OwnerCold");

  const point = (body.points as Row[])[0];
  assert.equal(point.uid_alpha, 100, "both UIDs are summed");
  assert.equal(point.owner_uid_alpha, 30, "only the owner's UID is attributed");
  assert.equal(point.owner_uid_count, 1);
  assert.equal(point.owner_attributed_share_of_uid, 0.3);

  const uid = (body.owner_uids as Row[])[0];
  assert.equal(uid.uid, 0);
  assert.equal(uid.take, 0.18);
  assert.equal(uid.owner_stake_share, 0.25);
  assert.equal(uid.nominator_share, 0.75);

  // The whale is reported, and reported as UNRESOLVED. The coldkey holding
  // three quarters of the owner's validator is exactly what a heuristic would
  // promote; nothing in this lane may.
  const whale = (body.attribution as Row[]).find(
    (a) => a.coldkey === "5Whale",
  ) as Row;
  assert.equal(whale.verdict, "unresolved");
  assert.deepEqual(whale.evidence, []);
  const owner = (body.attribution as Row[]).find(
    (a) => a.coldkey === "5OwnerCold",
  ) as Row;
  assert.equal(owner.verdict, "owner");
});

test("owner-capture reads only the newest nominator capture", async () => {
  // The pinned-`captured_at` subquery, asserted rather than assumed. With both
  // passes read the fractions would sum to 2 and the completeness guard would
  // decline -- so a regression here is silent in the other direction: a null
  // where a real split exists.
  const date = dayAgo(1);
  await seed(
    `INSERT INTO subnet_ownership (netuid, owner_hotkey, owner_coldkey, captured_at)
     VALUES (?, ?, ?, ?)`,
    [7, "5OwnerHot", "5OwnerCold", Date.now()],
  );
  await insertDaily({
    uid: 0,
    hotkey: "5OwnerHot",
    coldkey: "5OwnerCold",
    validator_permit: 1,
    emission_tao: 10,
    snapshot_date: date,
  });
  // An older, DIFFERENT split for the same hotkey.
  await seed(
    `INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    ["5Stale", "5OwnerHot", 7, 1, 1000],
  );
  await seed(
    `INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    ["5OwnerCold", "5OwnerHot", 7, 1, 3000],
  );

  const body = (await (
    await call(req("/api/v1/subnets/7/owner-capture"))
  ).json()) as Row;
  const uid = (body.owner_uids as Row[])[0];
  assert.equal(uid.owner_stake_share, 1, "the newest pass alone");
  assert.equal(uid.nominator_share, 0);
  assert.deepEqual(
    (body.attribution as Row[]).map((a) => a.coldkey),
    ["5OwnerCold"],
    "the stale capture must not appear",
  );
});

test("owner-capture with no ownership row answers with nulls, not zeros", async () => {
  await insertDaily({ uid: 0, emission_tao: 50, snapshot_date: dayAgo(1) });
  const body = (await (
    await call(req("/api/v1/subnets/7/owner-capture"))
  ).json()) as Row;
  assert.equal(body.owner_coldkey, null);
  assert.equal(body.owner_uid_count, null);
  const point = (body.points as Row[])[0];
  assert.equal(point.owner_uid_alpha, null);
  assert.equal(point.owner_attributed_share, null);
  // The leg that does not depend on knowing the owner still answers.
  assert.equal(point.uid_alpha, 50);
});

// #10931: miner-fairness selects `uid` and the owning address on top of what
// the emission-split read takes, and clusters by that address. Driven against
// the real DDL because the entity grouping only means anything over rows the
// store actually returned.
test("GET /api/v1/subnets/:netuid/miner-fairness clusters by controlling entity", async () => {
  const date = dayAgo(1);
  // Three miner UIDs behind ONE address, one behind another, plus a validator
  // that must not enter the miner population at all.
  for (const uid of [0, 1, 2]) {
    await insertDaily({
      uid,
      coldkey: "5Whale",
      validator_permit: 0,
      emission_tao: 1,
      snapshot_date: date,
    });
  }
  await insertDaily({
    uid: 3,
    coldkey: "5Solo",
    validator_permit: 0,
    emission_tao: 1,
    snapshot_date: date,
  });
  await insertDaily({
    uid: 4,
    coldkey: "5Vali",
    validator_permit: 1,
    emission_tao: 99,
    snapshot_date: date,
  });

  const res = await call(req("/api/v1/subnets/7/miner-fairness"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.netuid, 7);
  assert.equal(body.days_covered, 1);
  assert.equal(body.miner_uid_count, 4, "the validator is not a miner");
  assert.equal(body.entity_count, 2);
  assert.equal(body.uids_per_entity, 2);

  const point = (body.points as Row[])[0];
  assert.equal(point.miner_count, 4);
  assert.equal(point.earning_miner_count, 4);
  assert.equal(point.zero_emission_pct, 0);

  // THE DIVERGENCE, over real rows: per-UID reads as perfectly equal, the
  // entity lens does not.
  const conc = body.concentration as Row;
  const uidLens = conc.uid as Row;
  const entityLens = conc.entity as Row;
  assert.equal(uidLens.holders, 4);
  assert.equal(entityLens.holders, 2);
  assert.ok((entityLens.gini as number) > (uidLens.gini as number));
});

// #11091: the live block rides the same response, from the CURRENT neurons
// table -- the SN75 shape driven end-to-end through the real DDL: a smooth
// window beside a live single-UID capture, plus a null-incentive row that must
// read as zero rather than poison the lens.
test("miner-fairness carries the live capture tripwire beside the window", async () => {
  const date = dayAgo(1);
  for (const uid of [0, 1]) {
    await insertDaily({
      uid,
      coldkey: `5Even${uid}`,
      validator_permit: 0,
      emission_tao: 1,
      snapshot_date: date,
    });
  }
  await insertNeuron({
    uid: 238,
    coldkey: "5Captor",
    validator_permit: 0,
    incentive: 0.990829,
  });
  await insertNeuron({
    uid: 1,
    hotkey: "5Hot7-1",
    coldkey: "5Crumb",
    validator_permit: 0,
    incentive: 0.000107,
  });
  await insertNeuron({
    uid: 2,
    hotkey: "5Hot7-2",
    coldkey: "5Null",
    validator_permit: 0,
    incentive: null,
  });
  await insertNeuron({
    uid: 3,
    hotkey: "5Hot7-3",
    coldkey: "5Vali",
    validator_permit: 1,
    incentive: 0.5,
  });

  const res = await call(req("/api/v1/subnets/7/miner-fairness"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  const live = body.live as Row;
  assert.ok(live, "the live block must ride the response");
  const liveUid = live.uid as Row;
  // One UID holds ~99.99% of live incentive: the tripwire the window hides.
  assert.equal(liveUid.nakamoto_coefficient, 1);
  // Three miners counted (the null-incentive one reads as zero, the validator
  // is excluded), two of them positive holders.
  assert.equal(liveUid.holders, 2);
  assert.equal(live.captured_at, CAPTURED_AT);
});

test("miner-fairness counts a registered UID that earns nothing", async () => {
  // The headline fact: the population includes UIDs on zero, and a read that
  // dropped them would report 100% of miners earning on every subnet.
  const date = dayAgo(1);
  await insertDaily({
    uid: 0,
    coldkey: "5A",
    validator_permit: 0,
    emission_tao: 1,
    snapshot_date: date,
  });
  for (const uid of [1, 2, 3]) {
    await insertDaily({
      uid,
      coldkey: `5Z${uid}`,
      validator_permit: 0,
      emission_tao: 0,
      snapshot_date: date,
    });
  }
  const body = (await (
    await call(req("/api/v1/subnets/7/miner-fairness"))
  ).json()) as Row;
  const point = (body.points as Row[])[0];
  assert.equal(point.miner_count, 4);
  assert.equal(point.earning_miner_count, 1);
  assert.equal(point.zero_emission_pct, 0.75);
  assert.equal((body.persistence as Row).never_earned_count, 3);
});

// #10932: the cost-to-participate read, against the real DDL.
//
// The ENTRY COSTS are not asserted here on purpose: this tier does not compute
// them. They are merged by the API worker from the validator-economics
// composer, which tests/validator-economics covers -- so what this exercises is
// the half the store owns, plus the constraints that keep a private extractor
// from publishing a contradiction.
test("GET /api/v1/subnets/:netuid/cost-to-participate reads the declaration", async () => {
  await seed(
    `INSERT INTO compute_declarations (netuid, source_url, read_at_sha,
       observed_at, first_seen, found, spec_version, miner, validator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      7,
      "https://raw.githubusercontent.com/a/b/main/min_compute.yml",
      "abc1234",
      1760000000000,
      1760000000000,
      true,
      "0.0.17",
      JSON.stringify({
        cpu: { min_cores: 4 },
        gpu: { required: false, min_vram: 8, recommended_gpu: "NVIDIA A100" },
      }),
      JSON.stringify({ cpu: { min_cores: 4 } }),
    ],
  );

  const res = await call(req("/api/v1/subnets/7/cost-to-participate"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.declarations_read, 1);
  const miner = (body.declared_compute as Row).miner as Row;
  // THE ROUND TRIP THAT MATTERS: a JSONB column read back out of a real
  // Postgres and through the tri-state rule. `required: false` beside a
  // non-zero minimum VRAM is neither boolean.
  assert.equal((miner.gpu as Row).requirement, "declared-inconsistently");
  assert.equal((miner.gpu as Row).declared_min_vram_gb, 8);
  assert.equal((miner.gpu as Row).declared_model, "NVIDIA A100");
  // The validator declares no gpu stanza at all -- a FOURTH answer, and not a
  // "no GPU needed".
  assert.equal(
    (((body.declared_compute as Row).validator as Row).gpu as Row).requirement,
    null,
  );
  assert.equal(
    ((body.declarations as Row[])[0].evidence as Row).read_at_sha,
    "abc1234",
  );
});

test("a subnet whose declaration nobody has read answers with declarations_read 0", async () => {
  const body = (await (
    await call(req("/api/v1/subnets/7/cost-to-participate"))
  ).json()) as Row;
  assert.equal(body.declarations_read, 0);
  assert.deepEqual(body.declarations, []);
  // Null, not an empty spec. An empty spec renders as a row of dashes that
  // reads like "declared, and needs nothing".
  assert.equal((body.declared_compute as Row).miner, null);
  assert.ok((body.not_modelled as string[]).length > 0);
});

test("the lane's own write survives the real DDL and reaches the card", async () => {
  // The producer and the serving read, joined against real Postgres. The
  // stanza goes in as JSON text through persistComputeDeclaration and comes
  // back out of a JSONB column through the tri-state rule -- the round trip
  // neither unit test can make on its own.
  const record = {
    netuid: 7,
    source_url: "https://raw.githubusercontent.com/a/b/main/min_compute.yml",
    read_at_sha: "abc1234def5678",
    observed_at: 1760000000000,
    found: true,
    spec_version: "0.0.17",
    miner: {
      cpu: { min_cores: 4 },
      gpu: { required: false, min_vram: 8, recommended_gpu: "NVIDIA A100" },
    },
    validator: null,
    unscoped: null,
  };
  await persistComputeDeclaration(
    { run: (sql: string, params: unknown[]) => seed(sql, params) },
    record,
  );
  // Re-reading the same surface must UPDATE rather than duplicate, and must
  // leave first_seen where it was.
  await persistComputeDeclaration(
    { run: (sql: string, params: unknown[]) => seed(sql, params) },
    { ...record, observed_at: 1760000900000, spec_version: "0.0.18" },
  );

  const body = (await (
    await call(req("/api/v1/subnets/7/cost-to-participate"))
  ).json()) as Row;
  assert.equal(body.declarations_read, 1, "a re-read is an update, not a row");
  const declaration = (body.declarations as Row[])[0];
  assert.equal((declaration.evidence as Row).spec_version, "0.0.18");
  assert.equal(
    (declaration.evidence as Row).first_seen,
    new Date(1760000000000).toISOString(),
    "first_seen must survive the re-read",
  );
  assert.equal(
    (((body.declared_compute as Row).miner as Row).gpu as Row).requirement,
    "declared-inconsistently",
  );
});

test("THE CHECK CONSTRAINTS REFUSE A DECLARATION THAT CONTRADICTS ITSELF", async () => {
  const base = [7, "u1", "sha1234", 1760000000000, 1760000000000];
  // found:false may not carry a stanza...
  await assert.rejects(
    seed(
      `INSERT INTO compute_declarations (netuid, source_url, read_at_sha,
         observed_at, first_seen, found, miner) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [...base, false, JSON.stringify({ cpu: {} })],
    ),
    /nothing_found_declares_nothing/,
  );
  // ...and found:true must carry one.
  await assert.rejects(
    seed(
      `INSERT INTO compute_declarations (netuid, source_url, read_at_sha,
         observed_at, first_seen, found) VALUES (?, ?, ?, ?, ?, ?)`,
      [...base, true],
    ),
    /finding_needs_a_stanza/,
  );
  // A stanza must be an OBJECT. A YAML list reaching this column means the
  // extractor read the wrong node, and every reader below would be indexing
  // into something that cannot answer.
  await assert.rejects(
    seed(
      `INSERT INTO compute_declarations (netuid, source_url, read_at_sha,
         observed_at, first_seen, found, miner) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [...base, true, JSON.stringify(["4 cores"])],
    ),
    /stanzas_are_objects/,
  );
  // Seconds where millis belong is the shape a unit mix-up takes.
  await assert.rejects(
    seed(
      `INSERT INTO compute_declarations (netuid, source_url, read_at_sha,
         observed_at, first_seen, found, miner) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [7, "u2", "sha1234", 1760000000, 1760000000000, true, JSON.stringify({})],
    ),
    /observed_at_is_millis/,
  );
});

// #10933: the treasury read, against the real DDL. The CHECK constraints are
// the enforcement here -- the extractor writes from a private lane with no
// route in front of it -- so they are asserted to actually fire.
test("GET /api/v1/subnets/:netuid/treasury withholds an unreviewed finding", async () => {
  await seed(
    `INSERT INTO treasury_readings (netuid, source_url, read_at_sha, observed_at,
       first_seen, found, declared_share, treasury_address, applies_to,
       evidence_path, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      7,
      "https://github.com/a/b",
      "abc1234",
      1760000000000,
      1760000000000,
      true,
      0.1,
      "5T",
      "miner-emission",
      "validator.py",
      "reviewed",
    ],
  );
  await seed(
    `INSERT INTO treasury_readings (netuid, source_url, read_at_sha, observed_at,
       first_seen, found, declared_share, treasury_address, applies_to,
       evidence_path, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      7,
      "https://github.com/c/d",
      "def5678",
      1760000000000,
      1760000000000,
      true,
      0.6,
      "5X",
      "miner-emission",
      null,
      "candidate",
    ],
  );

  const res = await call(req("/api/v1/subnets/7/treasury"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.repos_read, 2);
  assert.equal(body.reviewed_count, 1);
  assert.equal(body.pending_review_count, 1);
  // Only the REVIEWED cut reaches the headline. The 0.6 candidate does not.
  assert.equal(body.declared_share, 0.1);
  const candidate = (body.readings as Row[]).find(
    (r) => r.review_state === "candidate",
  ) as Row;
  assert.equal(candidate.found, null);
  assert.equal(candidate.declared_share, null);
  assert.equal((candidate.evidence as Row).read_at_sha, "def5678");
});

test("a subnet nobody has read answers with repos_read 0", async () => {
  const body = (await (
    await call(req("/api/v1/subnets/7/treasury"))
  ).json()) as Row;
  assert.equal(body.repos_read, 0);
  assert.deepEqual(body.readings, []);
  assert.equal(body.declared_matches_observed, null);
});

test("THE CHECK CONSTRAINTS REFUSE A SELF-CONTRADICTING ROW", async () => {
  // The extractor writes directly with no Zod in front of it, so these are the
  // enforcement. Proven to fire rather than assumed.
  await assert.rejects(
    seed(
      `INSERT INTO treasury_readings (netuid, source_url, read_at_sha, observed_at,
         first_seen, found, declared_share) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [7, "u1", "sha", 1760000000000, 1760000000000, false, 0.1],
    ),
    /nothing_found_declares_nothing/,
    "found:false may not carry a share",
  );
  await assert.rejects(
    seed(
      `INSERT INTO treasury_readings (netuid, source_url, read_at_sha, observed_at,
         first_seen, found) VALUES (?, ?, ?, ?, ?, ?)`,
      [7, "u2", "sha", 1760000000000, 1760000000000, true],
    ),
    /finding_needs_a_share/,
    "found:true must say what it found",
  );
  await assert.rejects(
    seed(
      `INSERT INTO treasury_readings (netuid, source_url, read_at_sha, observed_at,
         first_seen, found, declared_share) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [7, "u3", "sha", 1760000000000, 1760000000000, true, 10],
    ),
    /share_is_a_fraction/,
    "a percentage written where a fraction belongs must not land",
  );
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

// THE WINDOW BOUNDARY ITSELF, which nothing asserted until #9798. Every test
// above seeds rows entirely INSIDE the window, so they pass unchanged even if
// the boundary is dropped altogether -- verified by mutation: replacing the
// computed cutoff with `null` left all 75 tests green. That is the shape of gap
// that let #9784 ship: the SQL said `date(MAX(snapshot_date), '-N days')`,
// Postgres has no such function, the subquery yielded nothing, and two routes
// served an empty 200 in production with a full suite behind them.
//
// So these seed a row OUTSIDE the window and require it to be excluded. Both
// neuronDailyWindowBounds shapes are covered: chain-wide, and per-netuid.
test("GET /api/v1/chain/turnover excludes snapshots older than the window", async () => {
  const ancient = dayAgo(60);
  const start = dayAgo(5);
  const end = dayAgo(1);
  for (const snapshot_date of [ancient, start, end]) {
    insertDaily({
      netuid: 7,
      uid: 0,
      hotkey: "5A",
      validator_permit: 1,
      snapshot_date,
    });
  }
  const res = await call(req("/api/v1/chain/turnover?window=7d"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  // The 60-day-old row is the oldest in the table, so an unbounded MIN would
  // return it -- which is exactly what a dropped boundary produces.
  assert.equal(
    body.start_date,
    start,
    "the window's start must be the oldest row INSIDE it, not the table's oldest",
  );
  assert.equal(body.end_date, end);
});

test("GET /api/v1/subnets/:netuid/history excludes snapshots older than the window", async () => {
  const ancient = dayAgo(60);
  const start = dayAgo(5);
  for (const snapshot_date of [ancient, start, dayAgo(1)]) {
    insertDaily({
      netuid: 7,
      uid: 0,
      hotkey: "5A",
      validator_permit: 1,
      snapshot_date,
    });
  }
  // A netuid the window must not reach across: its own bounds are computed
  // per-netuid, so a row here must not become subnet 7's start date.
  insertDaily({
    netuid: 9,
    uid: 0,
    hotkey: "5Z",
    validator_permit: 1,
    snapshot_date: dayAgo(90),
  });
  const res = await call(req("/api/v1/subnets/7/turnover?window=7d"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(
    body.start_date,
    start,
    "the per-netuid window must exclude both the old row and the other netuid",
  );
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
  const insertPosition = async (snapshotDate: string, stake: number) =>
    seed(
      `INSERT INTO account_position_daily
           (account, netuid, snapshot_date, uid, coldkey, active, validator_permit, rank, trust, incentive, dividends, stake_tao, emission_tao, captured_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
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

test("a NULL alpha_price_tao snapshot excludes unpriceable stake without crashing", async () => {
  insertNeuron({
    netuid: 7,
    uid: 0,
    hotkey: "5Val",
    stake_tao: 100,
    validator_permit: 1,
  });
  // Latest snapshot for netuid 7 carries an explicitly NULL price.
  await seed(
    "INSERT INTO subnet_snapshots (netuid, snapshot_date, alpha_price_tao, tao_in_pool_tao, alpha_in_pool) VALUES (7, ?, NULL, NULL, NULL)",
    [dayAgo(0)],
  );
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

test("a missing subnet_snapshots table degrades prices, never the validators route", async () => {
  await db.exec("DROP TABLE subnet_snapshots");
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
  // 1:1). Realized returns remain unavailable regardless of snapshot coverage.
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
  await db.exec("DROP TABLE subnet_hyperparams");
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

// --- routed to the sync queue (metagraphed-infra#357) -----------------------
//
// This lane waited on the queue because its write PRUNES: it deletes rows for a
// netuid older than the newest captured_at it saw for that netuid. Applied to a
// message holding only part of a netuid, that deletes rows the message never
// carried, and no retry undoes a delete.
//
// What makes the claim safe is the producer, not the transport: metagraph.rs
// bails -- "refusing to truncate a partial snapshot" -- rather than chunk above
// its 50,000-row ceiling, and a pass is ~33,000 rows. So a POST always holds
// every row for every netuid it names, and the packer only has to not break it.
function queueEnv(send: (m: unknown) => Promise<void>) {
  return env({ SYNC_BATCHES: { send }, SYNC_QUEUE_LANES: "neurons" });
}

test("neurons-sync enqueues instead of writing, and never both", async () => {
  const sent: Record<string, unknown>[] = [];
  const res = await postSync(
    [syncRow(), syncRow({ uid: 1, hotkey: "5Hot7-1" })],
    queueEnv(async (m) => {
      sent.push(m as Record<string, unknown>);
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.stores, ["queue"]);
  assert.equal(body.neurons_written, 2);
  assert.equal(sent.length, 1);
  // The derived counts are still reported, because a caller reads them to know
  // the snapshot was understood -- they are computed either way.
  assert.equal(body.neuron_daily_written, 2);
  assert.equal(body.netuids_covered, 1);
});

test("neurons-sync claims key-completeness on what it enqueues", async () => {
  // The consumer REFUSES a neurons message without this, and a refused message
  // is acked rather than retried -- so a missing flag drops the snapshot.
  const sent: Record<string, unknown>[] = [];
  await postSync(
    [syncRow()],
    queueEnv(async (m) => {
      sent.push(m as Record<string, unknown>);
    }),
  );
  assert.equal(sent[0]!.key_complete, true);
  assert.equal(sent[0]!.lane, "neurons");
  // This REQUEST declared none, so the message must not invent one -- a
  // fabricated total would mark an unproven load complete. (The lane does have
  // a pass contract now, #9812; the declaration is the producer's to make.)
  assert.equal("pass_total" in sent[0]!, false);
});

test("a declared pass_total rides the message and tallies to COMPLETE", async () => {
  // The whole contract in one pass, split across two requests the way the
  // producer actually chunks: the netuids that land are written immediately,
  // so only the tally can say whether the REST of them ever arrived.
  const passRow = (over: Record<string, unknown> = {}) =>
    syncRow({ captured_at: 1_780_000_000_000, ...over });

  const first = await call(
    req("/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": SYNC_SECRET },
      body: { rows: [passRow()], pass_total: 2 },
    }),
  );
  assert.equal(first.status, 200);
  let pass = (
    await db.query<Row>(
      "SELECT expected_rows, received_rows, completed_at FROM neurons_passes",
    )
  ).rows;
  assert.equal(pass.length, 1);
  assert.equal(pass[0]!.expected_rows, 2);
  assert.equal(pass[0]!.received_rows, 1);
  assert.equal(
    pass[0]!.completed_at,
    null,
    "one chunk of two is exactly the state that used to be invisible",
  );

  const second = await call(
    req("/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": SYNC_SECRET },
      body: { rows: [passRow({ netuid: 8, uid: 0 })], pass_total: 2 },
    }),
  );
  assert.equal(second.status, 200);
  pass = (
    await db.query<Row>(
      "SELECT expected_rows, received_rows, completed_at FROM neurons_passes",
    )
  ).rows;
  assert.equal(pass.length, 1, "one row per pass, keyed on its captured_at");
  assert.equal(pass[0]!.received_rows, 2);
  assert.ok(
    pass[0]!.completed_at,
    "the pass is complete once both chunks land",
  );
});

test("the neuron snapshot stamp exposes only the newest completed pass", async () => {
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
    [
      1_780_000_000_000,
      2,
      2,
      10,
      1_780_000_000_100,
      2,
      2,
      20,
      1_780_000_000_200,
      2,
      1,
      null,
    ],
  );
  const res = await call(req("/api/v1/internal/neurons-snapshot-stamp"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { captured_at: 1_780_000_000_100 });
});

test("the neuron snapshot stamp stays null until a pass completes", async () => {
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [1_780_000_000_200, 2, 1, null],
  );
  const res = await call(req("/api/v1/internal/neurons-snapshot-stamp"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { captured_at: null });
});

test("the snapshot stamp prepares one atomic directory materialization and both routes reuse it", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Stake", stake_tao: 100 });
  await insertNeuron({ uid: 1, hotkey: "5Emission", emission_tao: 20 });
  await insertNeuron({ uid: 2, hotkey: "5Reach", stake_tao: 5 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 3, 3, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  const materializedEnv = env({ METAGRAPH_CONTROL: kv });
  const collected = collectingCtx();

  const stamp = await worker.fetch(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    materializedEnv,
    collected.ctx,
  );
  assert.deepEqual(await stamp.json(), { captured_at: CAPTURED_AT });
  await Promise.all(collected.pending);

  const pointer = JSON.parse(
    kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!,
  ) as Row;
  assert.equal(pointer.captured_at, CAPTURED_AT);
  const stored = JSON.parse(
    kv.values.get(explorerDirectoriesSnapshotKey(CAPTURED_AT))!,
  ) as Row;
  assert.equal(stored.captured_at, CAPTURED_AT);
  assert.equal((stored.accounts as Row).account_count, 3);
  assert.equal((stored.validators as Row).validator_count, 3);
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT)!)
      .account_count,
    3,
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT)!)
      .validator_count,
    3,
  );

  // Prove these are KV reads rather than another whole-network aggregation:
  // once the materialization exists, even an unavailable source table cannot
  // turn the two compact website routes into an error or an empty directory.
  await db.exec("TRUNCATE neurons");
  const accounts = await call(
    req("/api/v1/accounts/directory"),
    materializedEnv,
  );
  const validators = await call(
    req("/api/v1/validators/operators"),
    materializedEnv,
  );
  assert.equal(((await accounts.json()) as Row).account_count, 3);
  assert.equal(((await validators.json()) as Row).validator_count, 3);
});

test.each(["/api/v1/accounts/directory", "/api/v1/validators/operators"])(
  "%s repairs an older materialization from the newest completed pass",
  async (route) => {
    await insertNeuron({ uid: 0, hotkey: "5Old", stake_tao: 100 });
    await seed(
      "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
      [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
    );
    const kv = memoryKv();
    const materializedEnv = env({ METAGRAPH_CONTROL: kv });
    await refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      ctx,
      CAPTURED_AT,
    );

    const newer = CAPTURED_AT + 900_000;
    await seed("UPDATE neurons SET captured_at = ?, stake_tao = ?", [
      newer,
      200,
    ]);
    await seed(
      "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
      [newer, 1, 1, newer + 1],
    );
    const collected = collectingCtx();
    const response = await worker.fetch(
      req(route),
      materializedEnv,
      collected.ctx,
    );
    assert.equal(response.status, 200);
    await Promise.all(collected.pending);
    assert.equal(
      JSON.parse(kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!).captured_at,
      newer,
    );
    assert.equal(
      JSON.parse(kv.values.get(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT)!)
        .captured_at,
      new Date(newer).toISOString(),
    );
  },
);

test.each(["/api/v1/accounts/directory", "/api/v1/validators/operators"])(
  "%s retains the last verified directory when completed-pass metadata is unavailable",
  async (route) => {
    await insertNeuron({ uid: 0, hotkey: "5Verified", stake_tao: 100 });
    await seed(
      "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
      [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
    );
    const kv = memoryKv();
    const materializedEnv = env({ METAGRAPH_CONTROL: kv });
    await refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      ctx,
      CAPTURED_AT,
    );
    const previousPointer = kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT);
    await db.exec("TRUNCATE neurons_passes");
    const collected = collectingCtx();
    const response = await worker.fetch(
      req(route),
      materializedEnv,
      collected.ctx,
    );
    assert.equal(response.status, 200);
    await Promise.all(collected.pending);
    assert.equal(
      kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT),
      previousPointer,
    );
    assert.equal(
      ((await response.json()) as Row).captured_at,
      new Date(CAPTURED_AT).toISOString(),
    );
  },
);

test.each(["/api/v1/accounts/directory", "/api/v1/validators/operators"])(
  "%s still serves the verified directory when the freshness lookup fails",
  async (route) => {
    await insertNeuron({ uid: 0, hotkey: "5Verified", stake_tao: 100 });
    await seed(
      "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
      [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
    );
    const kv = memoryKv();
    const materializedEnv = env({ METAGRAPH_CONTROL: kv });
    await refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      ctx,
      CAPTURED_AT,
    );
    const previousPointer = kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT);
    pg.control.failNext = new Error("Neon temporarily unavailable");
    const collected = collectingCtx();
    const response = await worker.fetch(
      req(route),
      materializedEnv,
      collected.ctx,
    );
    assert.equal(response.status, 200);
    await Promise.all(collected.pending);
    assert.equal(
      kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT),
      previousPointer,
    );
    assert.equal(
      ((await response.json()) as Row).captured_at,
      new Date(CAPTURED_AT).toISOString(),
    );
  },
);

test("concurrent requests share one directory refresh for a completed snapshot", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Only", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  const materializedEnv = env({ METAGRAPH_CONTROL: kv });
  const collected = collectingCtx();
  const [first, second] = await Promise.all([
    refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      collected.ctx,
      CAPTURED_AT,
    ),
    refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      collected.ctx,
      CAPTURED_AT,
    ),
  ]);
  assert.deepEqual([first, second], [true, true]);
  // One versioned payload, two route-specific hot values and one tiny current
  // pointer, still from one shared build rather than one write set per caller.
  assert.equal(kv.putCount(), 4);
});

test("the cache-stamp hot path reads only the small directory pointer", async () => {
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const reads: string[] = [];
  const pointerKv = {
    get: async (key: string, type?: string) => {
      reads.push(key);
      const value =
        key === KV_EXPLORER_DIRECTORIES_CURRENT
          ? JSON.stringify({
              schema_version: 1,
              captured_at: CAPTURED_AT,
              route_values_ready: true,
            })
          : null;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    },
  };
  const stamp = await call(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    env({ METAGRAPH_CONTROL: pointerKv }),
  );
  assert.deepEqual(await stamp.json(), { captured_at: CAPTURED_AT });
  assert.deepEqual(reads, [KV_EXPLORER_DIRECTORIES_CURRENT]);
});

test("a refresh already represented by the current pointer does no database work", async () => {
  const kv = memoryKv();
  kv.values.set(
    KV_EXPLORER_DIRECTORIES_CURRENT,
    JSON.stringify({
      schema_version: 1,
      captured_at: CAPTURED_AT,
      route_values_ready: true,
    }),
  );
  assert.equal(
    await refreshExplorerDirectoryMaterialization(
      env({ METAGRAPH_CONTROL: kv }) as DataApiEnv,
      ctx,
      CAPTURED_AT,
    ),
    true,
  );
  assert.equal(kv.putCount(), 0);
  assert.equal(pg.control.queries.length, 0);
});

test("a matching legacy pointer backfills route-specific directory values once", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Legacy", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  kv.values.set(
    KV_EXPLORER_DIRECTORIES_CURRENT,
    JSON.stringify({ schema_version: 1, captured_at: CAPTURED_AT }),
  );
  const collected = collectingCtx();
  const stamp = await worker.fetch(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    env({ METAGRAPH_CONTROL: kv }),
    collected.ctx,
  );

  assert.deepEqual(await stamp.json(), { captured_at: CAPTURED_AT });
  await Promise.all(collected.pending);
  assert.deepEqual(
    JSON.parse(kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!),
    {
      schema_version: 1,
      captured_at: CAPTURED_AT,
      route_values_ready: true,
    },
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT)!)
      .account_count,
    1,
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT)!)
      .validator_count,
    1,
  );
});

test("a legacy combined directory restores both hot values without folding partial rows", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Verified", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  const materializedEnv = env({ METAGRAPH_CONTROL: kv });
  assert.equal(
    await refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      ctx,
      CAPTURED_AT,
    ),
    true,
  );
  kv.values.set(
    KV_EXPLORER_DIRECTORIES_CURRENT,
    JSON.stringify({ schema_version: 1, captured_at: CAPTURED_AT }),
  );
  kv.values.delete(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT);
  kv.values.delete(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT);
  await seed("UPDATE neurons SET captured_at = ?", [CAPTURED_AT + 60_000]);
  const queriesBeforeFallback = pg.control.queries.length;
  const collected = collectingCtx();

  const response = await worker.fetch(
    req("/api/v1/accounts/directory"),
    materializedEnv,
    collected.ctx,
  );
  assert.equal(((await response.json()) as Row).account_count, 1);
  await Promise.all(collected.pending);

  const fallbackQueries = pg.control.queries.slice(queriesBeforeFallback);
  assert.equal(fallbackQueries.length, 1);
  assert.match(fallbackQueries[0].text, /FROM neurons_passes/);
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT)!)
      .account_count,
    1,
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT)!)
      .validator_count,
    1,
  );
  assert.deepEqual(
    JSON.parse(kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!),
    {
      schema_version: 1,
      captured_at: CAPTURED_AT,
      route_values_ready: true,
    },
  );
});

test("a directory refresh declines cleanly when its store runner is unavailable", async () => {
  const kv = memoryKv();
  assert.equal(
    await refreshExplorerDirectoryMaterialization(
      dataApiEnv({ METAGRAPH_CONTROL: kv }) as DataApiEnv,
      ctx,
      CAPTURED_AT,
    ),
    false,
  );
});

test("a failed background materialization leaves the current stamp readable", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Only", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const brokenKv = {
    get: async () => null,
    put: async () => {
      throw new Error("KV write unavailable");
    },
  };
  const collected = collectingCtx();
  const stamp = await worker.fetch(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    env({ METAGRAPH_CONTROL: brokenKv }),
    collected.ctx,
  );
  assert.deepEqual(await stamp.json(), { captured_at: CAPTURED_AT });
  await Promise.all(collected.pending);
  assert.ok(
    error.mock.calls.some((call) =>
      String(call[0]).includes("explorer directory materialization failed"),
    ),
  );
  error.mockRestore();
});

test("directory materializations reject malformed and mixed-snapshot values", () => {
  const capturedAt = CAPTURED_AT;
  const capturedAtIso = new Date(capturedAt).toISOString();
  const valid = {
    schema_version: 1,
    captured_at: capturedAt,
    accounts: {
      schema_version: 1,
      captured_at: capturedAtIso,
      block_number: 8_600_000,
      account_count: 0,
      limit: 20,
      priced_registered_stake_tao: 0,
      rankings: { stake: [], emission: [], reach: [] },
    },
    validators: {
      schema_version: 1,
      captured_at: capturedAtIso,
      block_number: 8_600_000,
      validator_count: 0,
      operator_count: 0,
      operators: [],
    },
  };
  assert.deepEqual(materializationFromUnknown(valid), valid);
  assert.equal(materializationFromUnknown(null), null);
  assert.equal(
    materializationFromUnknown({
      ...valid,
      validators: {
        ...valid.validators,
        captured_at: new Date(capturedAt + 1).toISOString(),
      },
    }),
    null,
  );
});

test("a directory KV read failure falls back to the truthful live projection", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Live", stake_tao: 100 });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failingKv = {
    get: async () => {
      throw new Error("KV unavailable");
    },
  };
  const accounts = await call(
    req("/api/v1/accounts/directory"),
    env({ METAGRAPH_CONTROL: failingKv }),
  );
  assert.equal(accounts.status, 200);
  const body = (await accounts.json()) as Row;
  assert.equal(body.account_count, 1);
  assert.equal(((body.rankings as Row).stake as Row[])[0]!.hotkey, "5Live");
  assert.equal(error.mock.calls.length, 1);
  error.mockRestore();
});

test("a versioned directory payload read failure also falls back to live data", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Live", stake_tao: 100 });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failingPayloadKv = {
    get: async (key: string, type?: string) => {
      if (key !== KV_EXPLORER_DIRECTORIES_CURRENT) {
        throw new Error("KV payload unavailable");
      }
      const pointer = { schema_version: 1, captured_at: CAPTURED_AT };
      return type === "json" ? pointer : JSON.stringify(pointer);
    },
  };
  const accounts = await call(
    req("/api/v1/accounts/directory"),
    env({ METAGRAPH_CONTROL: failingPayloadKv }),
  );
  assert.equal(
    ((((await accounts.json()) as Row).rankings as Row).stake as Row[])[0]!
      .hotkey,
    "5Live",
  );
  assert.ok(
    error.mock.calls.some((call) =>
      String(call[0]).includes("materialization read failed"),
    ),
  );
  error.mockRestore();
});

test("a pointer whose versioned payload has another stamp falls back to live data", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Live", stake_tao: 100 });
  const kv = memoryKv();
  const otherCapturedAt = CAPTURED_AT + 60_000;
  kv.values.set(
    KV_EXPLORER_DIRECTORIES_CURRENT,
    JSON.stringify({ schema_version: 1, captured_at: CAPTURED_AT }),
  );
  kv.values.set(
    explorerDirectoriesSnapshotKey(CAPTURED_AT),
    JSON.stringify({
      schema_version: 1,
      captured_at: otherCapturedAt,
      accounts: {
        schema_version: 1,
        captured_at: new Date(otherCapturedAt).toISOString(),
        block_number: 8_600_000,
        account_count: 0,
        limit: 20,
        priced_registered_stake_tao: 0,
        rankings: { stake: [], emission: [], reach: [] },
      },
      validators: {
        schema_version: 1,
        captured_at: new Date(otherCapturedAt).toISOString(),
        block_number: 8_600_000,
        validator_count: 0,
        operator_count: 0,
        operators: [],
      },
    }),
  );
  const accounts = await call(
    req("/api/v1/accounts/directory"),
    env({ METAGRAPH_CONTROL: kv }),
  );
  assert.equal(
    ((((await accounts.json()) as Row).rankings as Row).stake as Row[])[0]!
      .hotkey,
    "5Live",
  );
});

test("a newer complete snapshot keeps the previous directory live while its replacement builds", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Old", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  const materializedEnv = env({ METAGRAPH_CONTROL: kv });
  const first = collectingCtx();
  await worker.fetch(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    materializedEnv,
    first.ctx,
  );
  await Promise.all(first.pending);

  const nextCapturedAt = CAPTURED_AT + 60_000;
  await seed("UPDATE neurons SET captured_at = ?, hotkey = ? WHERE uid = ?", [
    nextCapturedAt,
    "5New",
    0,
  ]);
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [nextCapturedAt, 1, 1, nextCapturedAt + 1],
  );
  const next = collectingCtx();
  const duringRefresh = await worker.fetch(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    materializedEnv,
    next.ctx,
  );
  assert.deepEqual(await duringRefresh.json(), { captured_at: CAPTURED_AT });
  await Promise.all(next.pending);

  const ready = await call(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    materializedEnv,
  );
  assert.deepEqual(await ready.json(), { captured_at: nextCapturedAt });
  assert.equal(
    kv.values.has(explorerDirectoriesSnapshotKey(CAPTURED_AT)),
    false,
  );
  assert.equal(
    kv.values.has(explorerDirectoriesSnapshotKey(nextCapturedAt)),
    true,
  );
  const accounts = await call(
    req("/api/v1/accounts/directory"),
    materializedEnv,
  );
  assert.equal(
    ((((await accounts.json()) as Row).rankings as Row).stake as Row[])[0]!
      .hotkey,
    "5New",
  );
});

test("an obsolete-payload cleanup failure cannot undo a published directory", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Old", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  const materializedEnv = env({ METAGRAPH_CONTROL: kv });
  assert.equal(
    await refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      ctx,
      CAPTURED_AT,
    ),
    true,
  );

  const nextCapturedAt = CAPTURED_AT + 60_000;
  await seed("UPDATE neurons SET captured_at = ?, hotkey = ? WHERE uid = ?", [
    nextCapturedAt,
    "5New",
    0,
  ]);
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [nextCapturedAt, 1, 1, nextCapturedAt + 1],
  );
  kv.delete = async () => {
    throw new Error("KV cleanup unavailable");
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  assert.equal(
    await refreshExplorerDirectoryMaterialization(
      materializedEnv as DataApiEnv,
      ctx,
      nextCapturedAt,
    ),
    true,
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!).captured_at,
    nextCapturedAt,
  );
  assert.ok(
    error.mock.calls.some((call) =>
      String(call[0]).includes("materialization cleanup failed"),
    ),
  );
  error.mockRestore();
});

test("a partial newer neuron write cannot replace the last complete directory", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Stable", stake_tao: 100 });
  const nextCapturedAt = CAPTURED_AT + 60_000;
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    [
      CAPTURED_AT,
      1,
      1,
      CAPTURED_AT + 1,
      nextCapturedAt,
      1,
      1,
      nextCapturedAt + 1,
    ],
  );
  const kv = memoryKv();
  const previous = {
    schema_version: 1,
    captured_at: CAPTURED_AT,
    accounts: {
      schema_version: 1,
      captured_at: new Date(CAPTURED_AT).toISOString(),
      block_number: 8_600_000,
      account_count: 1,
      limit: 20,
      priced_registered_stake_tao: 100,
      rankings: { stake: [], emission: [], reach: [] },
    },
    validators: {
      schema_version: 1,
      captured_at: new Date(CAPTURED_AT).toISOString(),
      block_number: 8_600_000,
      validator_count: 1,
      operator_count: 1,
      operators: [],
    },
  };
  kv.values.set(
    KV_EXPLORER_DIRECTORIES_CURRENT,
    JSON.stringify({ schema_version: 1, captured_at: CAPTURED_AT }),
  );
  kv.values.set(
    explorerDirectoriesSnapshotKey(CAPTURED_AT),
    JSON.stringify(previous),
  );
  // A third pass has started mutating the in-place table but is not complete.
  await seed("UPDATE neurons SET captured_at = ? WHERE uid = ?", [
    nextCapturedAt + 60_000,
    0,
  ]);
  const materializedEnv = env({ METAGRAPH_CONTROL: kv });
  const collected = collectingCtx();
  const stamp = await worker.fetch(
    req("/api/v1/internal/neurons-snapshot-stamp"),
    materializedEnv,
    collected.ctx,
  );
  assert.deepEqual(await stamp.json(), { captured_at: CAPTURED_AT });
  await Promise.all(collected.pending);
  const stored = JSON.parse(
    kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!,
  ) as Row;
  assert.equal(stored.captured_at, CAPTURED_AT);
});

test("a neuron pass that starts during a directory fold is rejected by the final boundary check", async () => {
  await insertNeuron({ uid: 0, hotkey: "5Stable", stake_tao: 100 });
  await seed(
    "INSERT INTO neurons_passes (captured_at, expected_rows, received_rows, completed_at) VALUES (?, ?, ?, ?)",
    [CAPTURED_AT, 1, 1, CAPTURED_AT + 1],
  );
  const kv = memoryKv();
  const runQuery = pg.control.postgres!;
  let mutated = false;
  pg.control.postgres = async (text, values) => {
    const rows = await runQuery(text, values);
    if (!mutated && text.includes("ORDER BY hotkey ASC, stake_tao DESC")) {
      mutated = true;
      await db.query("UPDATE neurons SET captured_at = $1 WHERE uid = $2", [
        CAPTURED_AT + 60_000,
        0,
      ]);
    }
    return rows;
  };

  assert.equal(
    await refreshExplorerDirectoryMaterialization(
      env({ METAGRAPH_CONTROL: kv }) as DataApiEnv,
      ctx,
      CAPTURED_AT,
    ),
    false,
  );
  assert.equal(mutated, true);
  assert.equal(kv.putCount(), 0);
});

test("a pass_total smaller than the rows sent is refused", async () => {
  // The producer buffers before chunking, so a total under this request's own
  // row count is a producer bug -- accepting it would complete a pass that
  // never covered the network.
  const res = await call(
    req("/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": SYNC_SECRET },
      body: { rows: [syncRow(), syncRow({ uid: 1 })], pass_total: 1 },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(
    ((await one("SELECT COUNT(*) AS n FROM neurons_passes")) as Row).n,
    0,
  );
});

test("neurons-sync 502s when the enqueue fails, so the producer retries", async () => {
  const res = await postSync(
    [syncRow()],
    queueEnv(async () => Promise.reject(new Error("over capacity"))),
  );
  assert.equal(res.status, 502);
});

test("the queue consumer writes a neurons message and acks it", async () => {
  // Drives the Worker's own queue() handler against a real store, so the writer
  // wired into the consumer map is exercised rather than a stand-in.
  //
  // The prune this used to assert is gone with the D1 writer: a later capture
  // naming only uid 0 leaves uid 1 in place, because nothing on the Neon path
  // deletes. That assertion is deleted rather than inverted here -- the absence
  // is reported alongside the sync-side one, and pinning it in two places would
  // read as a decision rather than a gap.
  await postSync([
    syncRow({ uid: 0, hotkey: "5Hot7-0", captured_at: CAPTURED_AT }),
    syncRow({ uid: 1, hotkey: "5Hot7-1", captured_at: CAPTURED_AT }),
  ]);
  assert.equal(await count("neurons"), 2);

  // A later capture naming only uid 0 must retire uid 1 -- it is the shape of a
  // deregistration, and the reason a partial message could never be applied.
  const acked: string[] = [];
  await worker.queue(
    {
      messages: [
        {
          body: {
            lane: "neurons",
            captured_at: CAPTURED_AT + 60_000,
            key_complete: true,
            rows: [
              syncRow({
                uid: 0,
                hotkey: "5Hot7-0",
                captured_at: CAPTURED_AT + 60_000,
              }),
            ],
          },
          ack: () => acked.push("ack"),
          retry: () => acked.push("retry"),
        },
      ],
    } as never,
    env(),
    { waitUntil: (p: Promise<unknown>) => void p } as never,
  );

  assert.deepEqual(acked, ["ack"], "a written message is acked, never retried");
  assert.equal(
    (await one("SELECT * FROM neurons WHERE uid = 0")).captured_at,
    CAPTURED_AT + 60_000,
    "the later capture was applied through the guarded upsert",
  );
  // The derived tables are redone by the consumer from the message's rows.
  assert.equal((await count("neuron_daily")) > 0, true);
});

test("the queue consumer publishes explorer directories when a neuron pass completes", async () => {
  const kv = memoryKv();
  const pending = collectingCtx();
  const acked: string[] = [];

  await worker.queue(
    {
      messages: [
        {
          body: {
            lane: "neurons",
            captured_at: CAPTURED_AT,
            pass_total: 1,
            key_complete: true,
            rows: [syncRow()],
          },
          ack: () => acked.push("ack"),
          retry: () => acked.push("retry"),
        },
      ],
    } as never,
    env({ METAGRAPH_CONTROL: kv }),
    pending.ctx,
  );
  await Promise.all(pending.pending);

  assert.deepEqual(acked, ["ack"]);
  assert.deepEqual(
    JSON.parse(kv.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!),
    {
      schema_version: 1,
      captured_at: CAPTURED_AT,
      route_values_ready: true,
    },
  );
  const materialized = JSON.parse(
    kv.values.get(explorerDirectoriesSnapshotKey(CAPTURED_AT))!,
  );
  assert.equal(
    materialized.accounts.captured_at,
    new Date(CAPTURED_AT).toISOString(),
  );
  assert.equal(
    materialized.validators.captured_at,
    new Date(CAPTURED_AT).toISOString(),
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT)!)
      .captured_at,
    new Date(CAPTURED_AT).toISOString(),
  );
  assert.equal(
    JSON.parse(kv.values.get(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT)!)
      .captured_at,
    new Date(CAPTURED_AT).toISOString(),
  );
});

test("an incomplete neuron queue pass is acknowledged without publishing a mixed directory", async () => {
  const kv = memoryKv();
  const pending = collectingCtx();
  const acked: string[] = [];

  await worker.queue(
    {
      messages: [
        {
          body: {
            lane: "neurons",
            captured_at: CAPTURED_AT,
            pass_total: 2,
            key_complete: true,
            rows: [syncRow()],
          },
          ack: () => acked.push("ack"),
          retry: () => acked.push("retry"),
        },
      ],
    } as never,
    env({ METAGRAPH_CONTROL: kv }),
    pending.ctx,
  );
  await Promise.all(pending.pending);

  assert.deepEqual(acked, ["ack"]);
  assert.equal(kv.putCount(), 0);
  assert.equal(kv.values.has(KV_EXPLORER_DIRECTORIES_CURRENT), false);
});

test("a queue publication failure cannot retry a neuron snapshot that already landed", async () => {
  const pending = collectingCtx();
  const acked: string[] = [];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await worker.queue(
    {
      messages: [
        {
          body: {
            lane: "neurons",
            captured_at: CAPTURED_AT,
            pass_total: 1,
            key_complete: true,
            rows: [syncRow()],
          },
          ack: () => acked.push("ack"),
          retry: () => acked.push("retry"),
        },
      ],
    } as never,
    env({
      METAGRAPH_CONTROL: {
        get: async () => null,
        put: async () => Promise.reject(new Error("KV unavailable")),
      },
    }),
    pending.ctx,
  );
  await Promise.all(pending.pending);

  assert.deepEqual(acked, ["ack"]);
  assert.ok(
    error.mock.calls.some((call) =>
      String(call[0]).includes("explorer directory publication failed"),
    ),
  );
  error.mockRestore();
});

test("the consumer refuses a neurons message that does not claim key-completeness", async () => {
  // Refused, not written. The claim was introduced because the D1 write PRUNED
  // -- applying a partial message would have deleted rows it never carried --
  // and the validator still enforces it, which is the right posture for a
  // snapshot message: a chunk that will not say it holds every row of every
  // netuid it names is not one this lane should apply.
  await postSync([
    syncRow({ uid: 0, captured_at: CAPTURED_AT }),
    syncRow({ uid: 1, hotkey: "5Hot7-1", captured_at: CAPTURED_AT }),
  ]);
  const acked: string[] = [];
  await worker.queue(
    {
      messages: [
        {
          body: {
            lane: "neurons",
            captured_at: CAPTURED_AT + 60_000,
            rows: [syncRow({ uid: 0, captured_at: CAPTURED_AT + 60_000 })],
          },
          ack: () => acked.push("ack"),
          retry: () => acked.push("retry"),
        },
      ],
    } as never,
    env(),
    { waitUntil: (p: Promise<unknown>) => void p } as never,
  );
  assert.deepEqual(acked, ["ack"], "unparseable is acked, not retried");
  assert.equal(await count("neurons"), 2, "nothing written, nothing pruned");
});

// #11094: the burn derivation end-to-end through the real DDL -- ownership +
// snapshot rows resolve the burn hotkey, the metagraph flags the sink, and
// the fairness card excludes it.
test("the burn sink is flagged on the metagraph and excluded from fairness", async () => {
  await seed(
    `INSERT INTO subnet_ownership (netuid, owner_coldkey, owner_hotkey, captured_at)
     VALUES (?, ?, ?, ?)`,
    [7, "5OwnerCold", "5OwnerHot", CAPTURED_AT],
  );
  await seed(
    `INSERT INTO subnet_snapshots (netuid, snapshot_date, miner_burned_fraction)
     VALUES (?, ?, ?)`,
    [7, dayAgo(0), 0.7156],
  );
  await insertNeuron({
    uid: 162,
    hotkey: "5OwnerHot",
    coldkey: "5OwnerCold",
    validator_permit: 0,
    incentive: 0.7156,
  });
  await insertNeuron({
    uid: 1,
    hotkey: "5Hot7-m1",
    coldkey: "5Cold7-m1",
    validator_permit: 0,
    incentive: 0.14,
  });
  await insertDaily({
    uid: 162,
    hotkey: "5OwnerHot",
    coldkey: "5OwnerCold",
    validator_permit: 0,
    emission_tao: 7,
    snapshot_date: dayAgo(1),
  });
  await insertDaily({
    uid: 1,
    hotkey: "5Hot7-m1",
    coldkey: "5Cold7-m1",
    validator_permit: 0,
    emission_tao: 1,
    snapshot_date: dayAgo(1),
  });

  const mg = await call(req("/api/v1/subnets/7/metagraph"));
  assert.equal(mg.status, 200);
  const neurons = ((await mg.json()) as Row).neurons as Row[];
  const sink = neurons.find((n) => n.uid === 162);
  assert.equal(sink?.is_burn_uid, true);

  const fair = await call(req("/api/v1/subnets/7/miner-fairness"));
  assert.equal(fair.status, 200);
  const body = (await fair.json()) as Row;
  assert.equal(body.burn_uid, 162);
  assert.equal(body.miner_uid_count, 1, "only the real miner counts");
});

test("no snapshot row, or a zero fraction, resolves no burn -- nothing excluded", async () => {
  // The two degrade arms: ownership without a snapshot (the ?? 0 arm), and a
  // snapshot whose fraction is zero (the > 0 refusal). Both must resolve null
  // -- a capture gap or a burn-free subnet never invents an exclusion.
  await seed(
    `INSERT INTO subnet_ownership (netuid, owner_coldkey, owner_hotkey, captured_at)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [8, "5OC8", "5OH8", CAPTURED_AT, 9, "5OC9", "5OH9", CAPTURED_AT],
  );
  await seed(
    `INSERT INTO subnet_snapshots (netuid, snapshot_date, miner_burned_fraction)
     VALUES (?, ?, ?)`,
    [9, dayAgo(0), 0],
  );
  await insertNeuron({
    netuid: 8,
    uid: 0,
    hotkey: "5OH8",
    coldkey: "5OC8",
    validator_permit: 0,
    incentive: 0.5,
  });
  await insertNeuron({
    netuid: 9,
    uid: 0,
    hotkey: "5OH9",
    coldkey: "5OC9",
    validator_permit: 0,
    incentive: 0.5,
  });

  for (const netuid of [8, 9]) {
    const res = await call(req(`/api/v1/subnets/${netuid}/metagraph`));
    assert.equal(res.status, 200);
    const rows = ((await res.json()) as Row).neurons as Row[];
    assert.equal(rows[0]?.is_burn_uid, false, `netuid ${netuid}`);
  }
});

test("emission-split serves the USD legs from the day's priced observation (#11095)", async () => {
  await insertDaily({
    uid: 5,
    hotkey: "5HotUsd",
    coldkey: "5ColdUsd",
    validator_permit: 0,
    emission_tao: 2,
    snapshot_date: dayAgo(1),
  });
  await seed(
    `INSERT INTO subnet_snapshots (netuid, snapshot_date, alpha_out_emission, alpha_price_tao)
     VALUES (?, ?, ?, ?)`,
    [7, dayAgo(1), 1, 0.01],
  );
  await seed(
    `INSERT INTO tao_usd_index (block_number, observed_at, usd_per_tao, price_basis, pool_count)
     VALUES (?, ?, ?, ?, ?)`,
    [
      8_800_000,
      Date.parse(`${dayAgo(1)}T12:00:00Z`),
      350,
      "wrapped_onchain_median",
      3,
    ],
  );
  const res = await call(req("/api/v1/subnets/7/emission-split/history"));
  assert.equal(res.status, 200);
  const point = (((await res.json()) as Row).points as Row[]).find(
    (p) => p.snapshot_date === dayAgo(1),
  ) as Row;
  assert.equal(point.tao_usd, 350);
  // 7200 alpha day total x 0.01 alpha price x 350 usd.
  assert.ok(Math.abs((point.total_usd_day as number) - 25200) < 1e-3);
});

test("the bulk ranking excludes each subnet's burn sink and counts its miners (#11098)", async () => {
  await seed(
    `INSERT INTO subnet_ownership (netuid, owner_coldkey, owner_hotkey, captured_at)
     VALUES (?, ?, ?, ?)`,
    [7, "5OwnerCold", "5OwnerHot", CAPTURED_AT],
  );
  await seed(
    `INSERT INTO subnet_snapshots (netuid, snapshot_date, miner_burned_fraction)
     VALUES (?, ?, ?)`,
    [7, dayAgo(0), 0.7],
  );
  await insertNeuron({
    uid: 162,
    hotkey: "5OwnerHot",
    coldkey: "5OwnerCold",
    validator_permit: 0,
    emission_tao: 70,
    incentive: 0.7,
  });
  await insertNeuron({
    uid: 1,
    hotkey: "5HotM1",
    coldkey: "5ColdM1",
    validator_permit: 0,
    emission_tao: 10,
    incentive: 0.1,
  });
  await insertNeuron({
    uid: 2,
    hotkey: "5HotM2",
    coldkey: "5ColdM2",
    validator_permit: 0,
    emission_tao: 0,
    incentive: 0,
  });
  await insertNeuron({
    uid: 3,
    hotkey: "5HotV",
    coldkey: "5ColdV",
    validator_permit: 1,
    emission_tao: 20,
    incentive: 0,
  });

  // A second subnet whose fraction is ZERO: its owner UID is an ordinary
  // holder, and the map must not invent an exclusion for it.
  await seed(
    `INSERT INTO subnet_ownership (netuid, owner_coldkey, owner_hotkey, captured_at)
     VALUES (?, ?, ?, ?)`,
    [9, "5OC9", "5OH9", CAPTURED_AT],
  );
  await seed(
    `INSERT INTO subnet_snapshots (netuid, snapshot_date, miner_burned_fraction)
     VALUES (?, ?, ?)`,
    [9, dayAgo(0), 0],
  );
  await insertNeuron({
    netuid: 9,
    uid: 0,
    hotkey: "5OH9",
    coldkey: "5OC9",
    validator_permit: 0,
    emission_tao: 5,
  });
  await insertNeuron({
    netuid: 9,
    uid: 1,
    hotkey: "5H9b",
    coldkey: "5C9b",
    validator_permit: 0,
    emission_tao: 5,
  });

  const res = await call(
    req("/api/v1/chain/concentration/subnets?lens=emission&limit=200"),
  );
  assert.equal(res.status, 200);
  const subnets = ((await res.json()) as Row).subnets as Row[];
  const row = subnets.find((r) => r.netuid === 7) as Row;
  assert.equal(row.miner_uid_count, 2, "sink and validator are not miners");
  assert.equal(row.earning_miner_count, 1);
  const zeroBurn = subnets.find((r) => r.netuid === 9) as Row;
  assert.equal(zeroBurn.miner_uid_count, 2, "no exclusion invented");
  assert.equal(zeroBurn.holders, 2);
  // With the 70-emission sink excluded, the emission lens sees the validator's
  // 20 and the miner's 10 -- two holders, not a 70% single-holder illusion.
  assert.equal(row.holders, 2);
});
