// The subnet-hyperparams + account-identity family, exercised END TO END
// against a REAL SQLite database standing in for Postgres, through the real
// Worker fetch handler -- same rationale and harness as
// tests/data-api-neurons-d1.test.ts.
//
// Both families are Neon's outright (#10179): the sync reads its own history
// table to diff, writes both tables, and REPORTS a failure of either rather
// than swallowing it, because there is no second store left to have got the
// rows. The one behavior beyond the neurons lane is the COLD-TIER contract: a
// table with no rows at all answers 503 so the api worker's tryPostgresTier
// degrades to null and the serving handler falls through to the lakehouse
// cold-tier snapshot -- pinned here in both directions (empty table -> 503;
// populated table with an absent row -> the schema-stable shape).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { sqliteBackedPg } from "./helpers/pg-sqlite.ts";
import type { Row } from "./row-type.ts";

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

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0009_hyperparams_identity.sql"),
  "utf8",
);

// The one place the two stores' DDL genuinely differs, and it is load bearing.
//
// Both history tables carry `UNIQUE (netuid, observed_at)` /
// `UNIQUE (account, observed_at)` in Neon (migrations/neon/0003), and that
// constraint is what FAMILY_MIRROR_PLANS conflicts on -- an ON CONFLICT naming
// columns with no unique index behind them is a runtime error, not a slower
// query. The D1 file indexes the same pair non-uniquely, because D1's writer
// appended without an upsert.
//
// So the fixture is the D1 tables plus this, rather than a hand-translation of
// the Postgres DDL: `BIGINT GENERATED ALWAYS AS IDENTITY` and `BOOLEAN` are not
// SQLite, and translating 37 columns to assert a two-column constraint would
// put the fixture further from both schemas rather than closer to either.
const NEON_HISTORY_UNIQUE = [
  "CREATE UNIQUE INDEX subnet_hyperparams_history_natural_key" +
    " ON subnet_hyperparams_history (netuid, observed_at)",
  "CREATE UNIQUE INDEX account_identity_history_natural_key" +
    " ON account_identity_history (account, observed_at)",
];

let db: InstanceType<typeof DatabaseSync>;

const HYPERPARAMS_SECRET = "test-subnet-hyperparams-sync-secret";
const IDENTITY_SECRET = "test-account-identity-sync-secret";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    ...pgMockEnv(),
    // Both writes run through mirrorFamilyToNeon, which is a no-op unless the
    // lane is named here -- so a suite that left this out would assert an empty
    // table and call it a passing write.
    NEON_DUAL_WRITE_LANES: "subnet-hyperparams,account-identity",
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

/** A ctx with a real `waitUntil`. createPgSql hands the client back through it
 * from a `finally`, so an object without one turns every successful query into
 * a TypeError -- silently, because the rejection replaces the result. */
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

async function call(request: Request, envOverride: Env = env()) {
  return worker.fetch(request, envOverride, ctx);
}

const one = (sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...(params as never[])) as Row;
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const index of NEON_HISTORY_UNIQUE) db.exec(index);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  // Wrapped rather than handed over raw: the sync coerces the nine flag columns
  // to real booleans for Postgres' BOOLEAN type, and node:sqlite refuses a
  // boolean bind outright. See tests/helpers/pg-sqlite.ts.
  pg.control.db = sqliteBackedPg(db);
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
  await nextObservedAt();
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
  const revisions = db
    .prepare("SELECT observed_at, tempo FROM subnet_hyperparams_history")
    .all() as Row[];
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
    one("SELECT tempo FROM subnet_hyperparams WHERE netuid = 8").tempo,
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
  db.exec("DROP TABLE subnet_hyperparams");
  const broken = await postHyperparams([hyperparamsSyncRow()]);
  assert.equal(broken.status, 502);
  assert.equal(((await broken.json()) as Row).error, "neon write failed");
});

test("a failed history read is its OWN 502, never a silent empty diff", async () => {
  // The diff is computed against the latest hash per netuid, so a history read
  // that fails and is treated as "no prior hashes" would append a revision for
  // every netuid on every sync -- growing the audit trail without a single
  // value having changed. It has to decline instead.
  db.exec("DROP TABLE subnet_hyperparams_history");
  const res = await postHyperparams([hyperparamsSyncRow()]);
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as Row).error, "history read failed");
  assert.equal(count("subnet_hyperparams"), 0, "nothing was written first");
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
    one("SELECT discord FROM account_identity WHERE account = '5Alice'")
      .discord,
    "abcdef",
    "Postgres TEXT rejects an embedded NUL outright, so the strip is what " +
      "keeps one real chain identity from failing the whole batch",
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
// NEON_READ_ROUTE_TABLES, asserted below.

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

test("a read route declines unless its OWN table is read-enabled", async () => {
  // routeStore consults neonServesRoute, which requires every table the route
  // reads to be named in NEON_READ_LANES. That gate is what stopped an
  // un-migrated table being served from a store that did not hold it, and with
  // D1 gone it is the ONLY thing between a route and a 503 -- an unmapped or
  // un-enabled route no longer quietly stays on an older store, it declines.
  await postIdentity([identitySyncRow()]);
  const res = await call(
    req("/api/v1/accounts/5Alice/identity"),
    env({ NEON_READ_LANES: "subnet_hyperparams" }),
  );
  assert.equal(res.status, 503);
  assert.equal(
    ((await res.json()) as Row).error,
    "no store bound for this route",
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
// The gate these routes answer 503 on is neonOwnsFamily: the latest-only table
// AND its history, both named in NEON_SOLE_STORE_TABLES. It survived the D1
// teardown because it was never really about which store -- it is about the
// sync deriving its history rows by reading the CURRENT latest hash out of the
// history table. A family split across stores would diff against the wrong
// one and append revisions that already exist, or miss ones that do not.
//
// The three tests this replaces asserted the same property from the other
// side, in the era when the alternative to Neon was a D1 write: "owning only
// one table still writes D1" is now "owning only one table is refused", which
// is the same rule with the fallback removed.

test("hyperparams: a family not declared Neon's has no store, and says so", async () => {
  const res = await postHyperparams(
    [hyperparamsSyncRow({ netuid: 7 })],
    env({ NEON_SOLE_STORE_TABLES: "" }),
  );
  assert.equal(res.status, 503);
  assert.equal(
    ((await res.json()) as Row).error,
    "no store bound for this route",
  );
});

test("hyperparams: declaring only ONE table of the family is refused, not half-written", async () => {
  const res = await postHyperparams(
    [hyperparamsSyncRow({ netuid: 8, tempo: 42 })],
    env({ NEON_SOLE_STORE_TABLES: "subnet_hyperparams" }),
  );
  assert.equal(res.status, 503);
  assert.equal(
    count("subnet_hyperparams"),
    0,
    "refused before the write, so the card cannot outrun its own history",
  );
});

test("identity: a family not declared Neon's has no store, and says so", async () => {
  const res = await postIdentity(
    [identitySyncRow({ account: "5Inversion" })],
    env({ NEON_SOLE_STORE_TABLES: "" }),
  );
  assert.equal(res.status, 503);
});

test("identity: declaring only ONE table of the family is refused, not half-written", async () => {
  const res = await postIdentity(
    [identitySyncRow({ account: "5Partial", name: "y" })],
    env({ NEON_SOLE_STORE_TABLES: "account_identity" }),
  );
  assert.equal(res.status, 503);
  assert.equal(count("account_identity"), 0);
});
