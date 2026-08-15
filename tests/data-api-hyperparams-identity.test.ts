// The subnet-hyperparams + account-identity family, exercised END TO END
// against a REAL SQLite database standing in for Postgres, through the real
// Worker fetch handler -- same rationale and harness as
// tests/data-api-neurons.test.ts.
//
// Both families are Neon's outright (#10179): the sync reads its own history
// table to diff, writes both tables, and REPORTS a failure of either rather
// than swallowing it, because there is no second store left to have got the
// rows. The one behavior beyond the neurons lane is the COLD-TIER contract: a
// table with no rows at all answers 503 so the api worker's tryDataApiTier
// degrades to null and the serving handler falls through to the lakehouse
// cold-tier snapshot -- pinned here in both directions (empty table -> 503;
// populated table with an absent row -> the schema-stable shape).
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import type { Row } from "./row-type.ts";
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

const { default: worker } = await import("../workers/data-api.ts");

/**
 * The REAL Neon DDL, applied verbatim (#10328).
 *
 * THIS REPLACES A HAND-KEPT DIVERGENCE. The suite used to load a SQLite
 * fixture and then apply two `CREATE UNIQUE INDEX` statements by hand, under a
 * comment naming them "the one place the two stores' DDL genuinely differs,
 * and it is load bearing" -- because FAMILY_MIRROR_PLANS conflicts on
 * (netuid, observed_at) / (account, observed_at), and an ON CONFLICT naming
 * columns with no unique index behind them is a runtime error rather than a
 * slower query.
 *
 * A divergence patched back up by hand is a second schema. On the real DDL
 * there is nothing to patch: 0003 declares those constraints, so what the code
 * conflicts on is what production has.
 *
 * The boolean columns are the other half. The sync coerces nine flag columns
 * to real booleans for Postgres' BOOLEAN type -- a bind node:sqlite refuses
 * outright, which is why the old path needed a translation layer at all.
 */
const MIGRATIONS = [
  "migrations/neon/0001_side_tables.sql",
  "migrations/neon/0003_append_only_histories.sql",
].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));

/** Tables a test may write, emptied between tests. */
const SEEDED_TABLES = [
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "account_identity",
  "account_identity_history",
];

let db: PGlite;

const HYPERPARAMS_SECRET = "test-subnet-hyperparams-sync-secret";
const IDENTITY_SECRET = "test-account-identity-sync-secret";

function env(overrides: Record<string, unknown> = {}): DataApiWorkerEnv {
  return dataApiEnv({
    ...pgMockEnv(),
    // Both writes run through mirrorFamilyToNeon, which is a no-op unless the
    // lane is named here -- so a suite that left this out would assert an empty
    // table and call it a passing write.
    SUBNET_HYPERPARAMS_SYNC_SECRET: HYPERPARAMS_SECRET,
    ACCOUNT_IDENTITY_SYNC_SECRET: IDENTITY_SECRET,
    ...overrides,
  });
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

/** A ctx with a real `waitUntil`. createPgSql hands the client back through it
 * from a `finally`, so an object without one turns every successful query into
 * a TypeError -- silently, because the rejection replaces the result. */
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

async function call(request: Request, envOverride: DataApiWorkerEnv = env()) {
  return worker.fetch(request, envOverride, ctx);
}

const one = async (sql: string, ...params: unknown[]) =>
  (await db.query<Row>(sql, params as never[])).rows[0] as Row;
const count = async (table: string) =>
  Number(
    (await db.query<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)).rows[0]!
      .n,
  );

// ONE instance for the file, TRUNCATE between tests.
beforeAll(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
});

beforeEach(async () => {
  // RE-APPLY, not just TRUNCATE. One instance serves the whole file, and two
  // tests below DROP a table on purpose to reach the two 502 paths -- so
  // emptying is not enough to undo them. Every statement is `IF NOT EXISTS`,
  // so this is a no-op on every tick except those two.
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec(`TRUNCATE ${SEEDED_TABLES.join(", ")}`);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  // Handed over VERBATIM. Real booleans reach real BOOLEAN columns and the
  // ON CONFLICT finds the unique constraints 0003 declares -- neither of
  // which the SQLite path could represent without patching.
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
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

async function postHyperparams(
  rows: Row[],
  envOverride: DataApiWorkerEnv = env(),
) {
  return call(
    req("/api/v1/internal/subnet-hyperparams-sync", {
      method: "POST",
      headers: { "x-subnet-hyperparams-sync-token": HYPERPARAMS_SECRET },
      body: { rows },
    }),
    envOverride,
  );
}

async function postIdentity(
  rows: Row[],
  envOverride: DataApiWorkerEnv = env(),
) {
  return call(
    req("/api/v1/internal/account-identity-sync", {
      method: "POST",
      headers: { "x-account-identity-sync-token": IDENTITY_SECRET },
      body: { rows },
    }),
    envOverride,
  );
}

/**
 * Wait until the wall clock has moved on.
 *
 * A history row's identity is (netuid, observed_at) / (account, observed_at),
 * and Neon declares that pair UNIQUE (migrations/neon/0003) -- so two
 * revisions stamped in the same millisecond are ONE row there, where D1's
 * append-only writer made them two rows ordered by id. Every row of one sync
 * shares a single `now`, and back-to-back posts in a test finish inside a
 * millisecond routinely.
 *
 * So a test that wants a SECOND revision has to let the clock advance, which
 * production gets for free -- these syncs are minutes apart. Spinning on
 * Date.now() rather than sleeping a guessed interval, because the thing being
 * waited for is exactly "the stamp will differ".
 */
async function nextObservedAt() {
  const started = Date.now();
  while (Date.now() === started) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// --- the hyperparams write lane ---------------------------------------------

test("hyperparams sync writes the family and reports what it did", async () => {
  const res = await postHyperparams([
    hyperparamsSyncRow({ netuid: 8 }),
    hyperparamsSyncRow({ netuid: 9, tempo: 100 }),
  ]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.stores, ["neon"]);
  assert.equal(body.subnet_hyperparams_written, 2);
  // Cold history: every netuid diffs as changed on the first sync.
  assert.equal(body.history_appended, 2);
  const row = await one("SELECT * FROM subnet_hyperparams WHERE netuid = 8");
  assert.equal(row.tempo, 360);
  // A REAL BOOLEAN, and this assertion used to read `1, "booleans land as
  // 0/1"`. That was never true of the store -- `registration_allowed` is
  // BOOLEAN in migrations/neon/0001, and 0/1 was node:sqlite's coercion showing
  // through the double. The suite was pinning the harness's behaviour and
  // calling it the store's, which is the quietest way a test can be wrong.
  assert.equal(row.registration_allowed, true);
  assert.equal(row.commit_reveal_enabled, false);
  assert.equal(await count("subnet_hyperparams_history"), 2);
});

test("a replayed identical batch appends nothing to history", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  const res = await postHyperparams([hyperparamsSyncRow()]);
  const body = (await res.json()) as Row;
  assert.equal(body.history_appended, 0);
  assert.equal(await count("subnet_hyperparams_history"), 1);
});

test("a changed value appends exactly one history revision", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  await nextObservedAt();
  const res = await postHyperparams([
    hyperparamsSyncRow({ tempo: 99, captured_at: 1_780_000_000_001 }),
  ]);
  const body = (await res.json()) as Row;
  assert.equal(body.history_appended, 1);
  const revisions = (
    await db.query<Row>(
      "SELECT id, tempo FROM subnet_hyperparams_history WHERE netuid = 8 ORDER BY id",
    )
  ).rows;
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].tempo, 99);
});

test("two revisions inside ONE millisecond are one row, not two", async () => {
  // The consequence of (netuid, observed_at) being the history's declared
  // identity in Neon, pinned rather than left to be discovered. D1 appended
  // without an upsert, so this same pair of posts produced TWO rows there,
  // ordered by an id the two stores numbered differently -- which is what
  // migrations/neon/0004 was written about.
  //
  // The clock is frozen rather than raced, because the whole subject is what
  // happens when two syncs share a stamp; a real-time version of this test
  // would assert one thing or the other depending on scheduling.
  //
  // Nothing a reader can see is lost -- the surviving row is the LATER
  // revision, and the intermediate one existed for under a millisecond -- but
  // it is a real difference from the D1 era and belongs in writing.
  vi.useFakeTimers();
  vi.setSystemTime(1_780_000_500_000);
  try {
    await postHyperparams([hyperparamsSyncRow()]);
    await postHyperparams([
      hyperparamsSyncRow({ tempo: 99, captured_at: 1_780_000_000_001 }),
    ]);
  } finally {
    vi.useRealTimers();
  }
  const revisions = (
    await db.query<Row>(
      "SELECT observed_at, tempo FROM subnet_hyperparams_history",
    )
  ).rows;
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].tempo, 99, "the later revision is the one kept");
});

test("a stale replay cannot regress the latest-only table", async () => {
  await postHyperparams([
    hyperparamsSyncRow({ tempo: 99, captured_at: 1_780_000_000_001 }),
  ]);
  await postHyperparams([
    hyperparamsSyncRow({ tempo: 1, captured_at: 1_779_000_000_000 }),
  ]);
  assert.equal(
    (await one("SELECT tempo FROM subnet_hyperparams WHERE netuid = 8")).tempo,
    99,
  );
});

// A netuid absent from the batch used to be PRUNED from subnet_hyperparams --
// the D1 writer issued a `DELETE ... WHERE netuid NOT IN (this batch)` and its
// history was deliberately left behind, so the audit trail outlived the
// deregistration. Nothing on the Neon path does that: LEDGER/FAMILY mirror
// plans upsert and never delete, and NEON_PRUNE_PLANS covers only
// surface_checks and subnet_burn_history. The test for it is deleted rather
// than rewritten because there is no behaviour left to assert -- see the
// report accompanying this change; a deregistered subnet now keeps its
// hyperparameter card forever, with an ageing captured_at as the only signal.

test("hyperparams sync answers 503 with no store, 502 when the write fails", async () => {
  const noStore = await postHyperparams(
    [hyperparamsSyncRow()],
    env({ HYPERDRIVE: undefined }),
  );
  assert.equal(noStore.status, 503);
  assert.equal(
    ((await noStore.json()) as Row).error,
    "no store bound for this route",
  );
  // Neon IS the store, so a write it did not accept is the pass's failure --
  // ok:true here would tell the producer its rows are safe when nothing holds
  // them. The history read still succeeds (that table is intact), so this is
  // the WRITE half of the two 502s this route can answer.
  await db.exec("DROP TABLE subnet_hyperparams");
  const broken = await postHyperparams([hyperparamsSyncRow()]);
  assert.equal(broken.status, 502);
  assert.equal(((await broken.json()) as Row).error, "neon write failed");
});

test("a failed history read is its OWN 502, never a silent empty diff", async () => {
  // The diff is computed against the latest hash per netuid, so a history read
  // that fails and is treated as "no prior hashes" would append a revision for
  // every netuid on every sync -- growing the audit trail without a single
  // value having changed. It has to decline instead.
  await db.exec("DROP TABLE subnet_hyperparams_history");
  const res = await postHyperparams([hyperparamsSyncRow()]);
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as Row).error, "history read failed");
  assert.equal(
    await count("subnet_hyperparams"),
    0,
    "nothing was written first",
  );
});

// --- the identity write lane ------------------------------------------------

test("identity sync writes the family, strips NUL bytes, and never prunes", async () => {
  const res = await postIdentity([
    identitySyncRow({ discord: "abc\u0000def" }),
  ]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.stores, ["neon"]);
  assert.equal(body.account_identity_written, 1);
  assert.equal(body.history_appended, 1);
  assert.equal(
    (await one("SELECT discord FROM account_identity WHERE account = '5Alice'"))
      .discord,
    "abcdef",
    "Postgres TEXT rejects an embedded NUL outright, so the strip is what " +
      "keeps one real chain identity from failing the whole batch",
  );
  // A later batch covering a different account leaves the first in place.
  await postIdentity([identitySyncRow({ account: "5Bob", name: "Bob" })]);
  assert.equal(await count("account_identity"), 2);
});

test("a replayed identical identity batch appends nothing to history", async () => {
  await postIdentity([identitySyncRow()]);
  const res = await postIdentity([identitySyncRow()]);
  assert.equal(((await res.json()) as Row).history_appended, 0);
  assert.equal(await count("account_identity_history"), 1);
});

test("identity sync answers 503 with no store, 502 when the write fails", async () => {
  const noStore = await postIdentity(
    [identitySyncRow()],
    env({ HYPERDRIVE: undefined }),
  );
  assert.equal(noStore.status, 503);
  assert.equal(
    ((await noStore.json()) as Row).error,
    "no store bound for this route",
  );
  db.exec("DROP TABLE account_identity");
  const broken = await postIdentity([identitySyncRow()]);
  assert.equal(broken.status, 502);
  assert.equal(((await broken.json()) as Row).error, "neon write failed");
});

// --- the hyperparams read lane ----------------------------------------------

test("GET /subnets/:netuid/hyperparameters serves the synced snapshot", async () => {
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

// The per-family METAGRAPH_SUBNET_HYPERPARAMS_SOURCE gate is gone from this
// dispatcher: it existed to hand the route back to a Postgres tier that no
// longer exists, and the matcher no longer reads env at all. The test that
// pinned it is deleted rather than rewritten -- the main Worker still consults
// the flag to decide whether to FORWARD here, which is a different assertion in
// a different suite. What replaces it as this route's gate is
// the dispatcher's own runner, which is Postgres unconditionally (#10051).

test("GET /subnets/:netuid/hyperparameters/history pages newest-first with a keyset cursor", async () => {
  await postHyperparams([hyperparamsSyncRow()]);
  await nextObservedAt();
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

// --- the identity read lane -------------------------------------------------

test("GET /accounts/:ss58/identity serves the synced identity", async () => {
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

// The identity twin of the deleted hyperparams flag test above, gone for the
// same reason.

test("GET /accounts/:ss58/identity-history pages newest-first with a keyset cursor", async () => {
  await postIdentity([identitySyncRow()]);
  await nextObservedAt();
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

test("a matched read with no store answers 503, and a query failure an opaque 502", async () => {
  const noBinding = await call(
    req("/api/v1/subnets/8/hyperparameters"),
    env({ HYPERDRIVE: undefined }),
  );
  assert.equal(noBinding.status, 503);
  assert.equal(
    ((await noBinding.json()) as Row).error,
    "no store bound for this route",
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

// --- the family moves as a PAIR, or not at all (#10094) --------------------
//
// Four tests pinned the flag arms here: an undeclared or half-declared
// family answered 503. They retired with NEON_SOLE_STORE_TABLES (#10051) --
// Neon is the only store, so a family split across stores cannot exist and
// the gate collapsed to the binding. What survives of the property: one
// runner writes both tables of the family in one plan (the write module's
// own suite), and no binding still refuses rather than half-writing (the
// unbound tests above).
