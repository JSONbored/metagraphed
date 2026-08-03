// The subnet-hyperparams + account-identity D1 port (box decommission;
// migrations/d1/0009_hyperparams_identity.sql), exercised END TO END against
// a REAL SQLite database through the real Worker fetch handler -- same
// rationale and harness as tests/data-api-neurons-d1.test.ts.
//
// Writes are DUAL per #9157 (D1 required, Postgres only while HYPERDRIVE
// exists) and ignore the tier flags; READS switch per family on
// METAGRAPH_SUBNET_HYPERPARAMS_SOURCE / METAGRAPH_ACCOUNT_IDENTITY_SOURCE,
// which this suite leaves unset (i.e. not "postgres") so the D1 read
// dispatcher serves them. The one behavior beyond the neurons port is the
// COLD-TIER contract: a D1 table with no rows at all answers 503 so the api
// worker's tryPostgresTier degrades to null and the serving handler falls
// through to the lakehouse cold-tier snapshot -- pinned here in both
// directions (empty table -> 503; populated table with an absent row -> the
// schema-stable shape).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0009_hyperparams_identity.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

/** Real D1 converts boolean binds to INTEGER 1/0; node:sqlite rejects them,
 * so the fake applies the platform's documented conversion. */
function d1Bind(value: unknown): unknown {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

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

const HYPERPARAMS_SECRET = "test-subnet-hyperparams-sync-secret";
const IDENTITY_SECRET = "test-account-identity-sync-secret";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    SUBNET_HYPERPARAMS_SYNC_SECRET: HYPERPARAMS_SECRET,
    ACCOUNT_IDENTITY_SYNC_SECRET: IDENTITY_SECRET,
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

const one = (sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...(params as never[])) as Row;
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

/** One wire-shape hyperparams row (0/1 ints for the boolean-flag columns,
 * the exact shape the refresh workflow POSTs). */
function hyperparamsSyncRow(overrides: Row = {}): Row {
  return {
    netuid: 8,
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
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function identitySyncRow(overrides: Row = {}): Row {
  return {
    account: "5Alice",
    name: "Alice Labs",
    url: "https://alice.example/",
    github: "https://github.com/alice/alice",
    image: "https://alice.example/logo.png",
    discord: "alicehandle",
    description: "An example operator.",
    additional: null,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

async function postHyperparams(rows: Row[], envOverride: Env = env()) {
  return call(
    req("/api/v1/internal/subnet-hyperparams-sync", {
      method: "POST",
      headers: { "x-subnet-hyperparams-sync-token": HYPERPARAMS_SECRET },
      body: { rows },
    }),
    envOverride,
  );
}

async function postIdentity(rows: Row[], envOverride: Env = env()) {
  return call(
    req("/api/v1/internal/account-identity-sync", {
      method: "POST",
      headers: { "x-account-identity-sync-token": IDENTITY_SECRET },
      body: { rows },
    }),
    envOverride,
  );
}

// --- the hyperparams D1 write lane ------------------------------------------

test("hyperparams sync writes D1-only when HYPERDRIVE is unbound", async () => {
  const res = await postHyperparams([
    hyperparamsSyncRow({ netuid: 8 }),
    hyperparamsSyncRow({ netuid: 9, tempo: 100 }),
  ]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.stores, ["d1"]);
  assert.equal(body.subnet_hyperparams_written, 2);
  // Cold history: every netuid diffs as changed on the first sync.
  assert.equal(body.history_appended, 2);
  assert.ok((body.d1_statements as number) >= 1);
  const row = one("SELECT * FROM subnet_hyperparams WHERE netuid = 8");
  assert.equal(row.tempo, 360);
  assert.equal(row.registration_allowed, 1, "booleans land as 0/1");
  assert.equal(row.commit_reveal_enabled, 0);
  assert.equal(count("subnet_hyperparams_history"), 2);
});

test("a replayed identical batch appends nothing to history", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  const res = await postHyperparams([hyperparamsSyncRow()]);
  const body = (await res.json()) as Row;
  assert.equal(body.history_appended, 0);
  assert.equal(count("subnet_hyperparams_history"), 1);
});

test("a changed value appends exactly one history revision", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  const res = await postHyperparams([
    hyperparamsSyncRow({ tempo: 99, captured_at: 1_780_000_000_001 }),
  ]);
  const body = (await res.json()) as Row;
  assert.equal(body.history_appended, 1);
  const revisions = db
    .prepare(
      "SELECT id, tempo FROM subnet_hyperparams_history WHERE netuid = 8 ORDER BY id",
    )
    .all() as Row[];
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].tempo, 99);
});

test("a stale replay cannot regress the latest-only table", async () => {
  await postHyperparams([
    hyperparamsSyncRow({ tempo: 99, captured_at: 1_780_000_000_001 }),
  ]);
  await postHyperparams([
    hyperparamsSyncRow({ tempo: 1, captured_at: 1_779_000_000_000 }),
  ]);
  assert.equal(
    one("SELECT tempo FROM subnet_hyperparams WHERE netuid = 8").tempo,
    99,
  );
});

test("a netuid absent from the batch is pruned; its history survives", async () => {
  await postHyperparams([
    hyperparamsSyncRow({ netuid: 8 }),
    hyperparamsSyncRow({ netuid: 9 }),
  ]);
  await postHyperparams([
    hyperparamsSyncRow({ netuid: 8, captured_at: 1_780_000_000_001 }),
  ]);
  assert.equal(count("subnet_hyperparams"), 1);
  assert.equal(one("SELECT netuid FROM subnet_hyperparams").netuid, 8);
  assert.equal(
    count("subnet_hyperparams_history"),
    2,
    "the audit trail outlives the deregistration",
  );
});

test("hyperparams sync answers 503 with no D1 binding, 502 on a D1 failure", async () => {
  const noD1 = await postHyperparams(
    [hyperparamsSyncRow()],
    env({ METAGRAPH_HEALTH_DB: undefined }),
  );
  assert.equal(noD1.status, 503);
  db.exec("DROP TABLE subnet_hyperparams");
  const broken = await postHyperparams([hyperparamsSyncRow()]);
  assert.equal(broken.status, 502);
  assert.equal(((await broken.json()) as Row).error, "d1 write failed");
});

// --- the identity D1 write lane ---------------------------------------------

test("identity sync writes D1-only, strips NUL bytes, and never prunes", async () => {
  const res = await postIdentity([
    identitySyncRow({ discord: "abc\u0000def" }),
  ]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.stores, ["d1"]);
  assert.equal(body.account_identity_written, 1);
  assert.equal(body.history_appended, 1);
  assert.equal(
    one("SELECT discord FROM account_identity WHERE account = '5Alice'")
      .discord,
    "abcdef",
    "the NUL strip runs before the D1 write too, keeping both stores identical",
  );
  // A later batch covering a different account leaves the first in place.
  await postIdentity([identitySyncRow({ account: "5Bob", name: "Bob" })]);
  assert.equal(count("account_identity"), 2);
});

test("a replayed identical identity batch appends nothing to history", async () => {
  await postIdentity([identitySyncRow()]);
  const res = await postIdentity([identitySyncRow()]);
  assert.equal(((await res.json()) as Row).history_appended, 0);
  assert.equal(count("account_identity_history"), 1);
});

test("identity sync answers 503 with no D1 binding, 502 on a D1 failure", async () => {
  const noD1 = await postIdentity(
    [identitySyncRow()],
    env({ METAGRAPH_HEALTH_DB: undefined }),
  );
  assert.equal(noD1.status, 503);
  db.exec("DROP TABLE account_identity");
  const broken = await postIdentity([identitySyncRow()]);
  assert.equal(broken.status, 502);
  assert.equal(((await broken.json()) as Row).error, "d1 write failed");
});

// --- the hyperparams D1 read lane -------------------------------------------

test("GET /subnets/:netuid/hyperparameters serves the synced snapshot from D1", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  const res = await call(req("/api/v1/subnets/8/hyperparameters"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.netuid, 8);
  assert.equal(body.block_number, 5_000_000);
  assert.equal(body.captured_at, new Date(1_780_000_000_000).toISOString());
  const hp = body.hyperparameters as Row;
  assert.equal(hp.tempo, 360);
  assert.equal(hp.registration_allowed, true, "0/1 back to real booleans");
  assert.equal(hp.commit_reveal_enabled, false);
});

test("an absent netuid in a POPULATED table is the schema-stable null card", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  const res = await call(req("/api/v1/subnets/42/hyperparameters"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.hyperparameters, null);
});

test("a COLD hyperparams table answers 503 so the cold-tier fallback runs", async () => {
  const res = await call(req("/api/v1/subnets/8/hyperparameters"));
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as Row).error as string, /cold/);
});

test("flag 'postgres' keeps the read on the Postgres lane", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  const res = await call(
    req("/api/v1/subnets/8/hyperparameters"),
    env({ METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres" }),
  );
  // No HYPERDRIVE bound in this suite: the Postgres dispatcher's own 503,
  // proving the D1 dispatcher did not swallow the route.
  assert.equal(res.status, 503);
  assert.equal(
    ((await res.json()) as Row).error,
    "hyperdrive binding unavailable",
  );
});

test("GET /subnets/:netuid/hyperparameters/history pages newest-first with a keyset cursor", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  await postHyperparams([
    hyperparamsSyncRow({ tempo: 99, captured_at: 1_780_000_000_001 }),
  ]);
  const first = await call(
    req("/api/v1/subnets/8/hyperparameters/history?limit=1"),
  );
  assert.equal(first.status, 200);
  const page1 = (await first.json()) as Row;
  assert.equal(page1.entry_count, 1);
  const entries1 = page1.entries as Row[];
  assert.equal(
    (entries1[0].hyperparameters as Row).tempo,
    99,
    "newest revision first",
  );
  assert.ok(page1.next_cursor, "a full page emits a cursor");
  const second = await call(
    req(
      `/api/v1/subnets/8/hyperparameters/history?limit=1&cursor=${page1.next_cursor}`,
    ),
  );
  const page2 = (await second.json()) as Row;
  const entries2 = page2.entries as Row[];
  assert.equal(entries2.length, 1);
  assert.equal(
    (entries2[0].hyperparameters as Row).tempo,
    360,
    "the cursor seeks past the first revision",
  );
});

test("hyperparams history: cold table 503s; a populated table's empty page serves", async () => {
  const cold = await call(req("/api/v1/subnets/8/hyperparameters/history"));
  assert.equal(cold.status, 503);
  await postHyperparams([hyperparamsSyncRow({ netuid: 9 })]);
  const empty = await call(req("/api/v1/subnets/8/hyperparameters/history"));
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as Row).entry_count, 0);
});

// --- the identity D1 read lane ----------------------------------------------

test("GET /accounts/:ss58/identity serves the synced identity from D1", async () => {
  await postIdentity([identitySyncRow()]);
  const res = await call(req("/api/v1/accounts/5Alice/identity"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.has_identity, true);
  assert.equal(body.name, "Alice Labs");
  assert.equal(body.url, "https://alice.example/");
  assert.equal(body.captured_at, new Date(1_780_000_000_000).toISOString());
});

test("an account with no identity in a POPULATED table is has_identity:false", async () => {
  await postIdentity([identitySyncRow()]);
  const res = await call(req("/api/v1/accounts/5Nobody/identity"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.has_identity, false);
  assert.equal(body.name, null);
});

test("a COLD identity table answers 503 so the cold-tier fallback runs", async () => {
  const res = await call(req("/api/v1/accounts/5Alice/identity"));
  assert.equal(res.status, 503);
});

test("flag 'postgres' keeps the identity read on the Postgres lane", async () => {
  await postIdentity([identitySyncRow()]);
  const res = await call(
    req("/api/v1/accounts/5Alice/identity"),
    env({ METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres" }),
  );
  assert.equal(res.status, 503);
  assert.equal(
    ((await res.json()) as Row).error,
    "hyperdrive binding unavailable",
  );
});

test("GET /accounts/:ss58/identity-history pages newest-first with a keyset cursor", async () => {
  await postIdentity([identitySyncRow()]);
  await postIdentity([
    identitySyncRow({ name: "Alice Labs v2", captured_at: 1_780_000_000_001 }),
  ]);
  const first = await call(
    req("/api/v1/accounts/5Alice/identity-history?limit=1"),
  );
  assert.equal(first.status, 200);
  const page1 = (await first.json()) as Row;
  assert.equal(page1.entry_count, 1);
  assert.equal((page1.entries as Row[])[0].name, "Alice Labs v2");
  assert.ok(page1.next_cursor);
  const second = await call(
    req(
      `/api/v1/accounts/5Alice/identity-history?limit=1&cursor=${page1.next_cursor}`,
    ),
  );
  const page2 = (await second.json()) as Row;
  assert.equal((page2.entries as Row[])[0].name, "Alice Labs");
});

test("a matched read without the D1 binding answers 503, and a D1 query failure an opaque 502", async () => {
  const noBinding = await call(
    req("/api/v1/subnets/8/hyperparameters"),
    env({ METAGRAPH_HEALTH_DB: undefined }),
  );
  assert.equal(noBinding.status, 503);
  assert.equal(
    ((await noBinding.json()) as Row).error,
    "d1 binding unavailable",
  );
  db.exec("DROP TABLE account_identity");
  const broken = await call(req("/api/v1/accounts/5Alice/identity"));
  assert.equal(broken.status, 502);
  assert.equal(
    ((await broken.json()) as Row).error,
    "data query failed",
    "the catch envelope never leaks DB detail",
  );
});

test("identity history: cold table 503s; a populated table's empty page serves", async () => {
  const cold = await call(req("/api/v1/accounts/5Alice/identity-history"));
  assert.equal(cold.status, 503);
  await postIdentity([identitySyncRow({ account: "5Bob" })]);
  const empty = await call(req("/api/v1/accounts/5Alice/identity-history"));
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as Row).entry_count, 0);
});
