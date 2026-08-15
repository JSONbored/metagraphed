// POST /api/v1/internal/subnet-identity-sync, end to end against a REAL
// Postgres through the real Worker fetch handler -- same harness and rationale
// as tests/data-api-hyperparams-identity.test.ts.
//
// WHAT THIS ROUTE IS. `subnet_identity_history` was D1-primary with a Postgres
// mirror that was never written -- `syncSubnetIdentityToPostgres` is named as
// "the sole writer now" in four places and does not exist. D1 went away, so the
// table has had no writer since, and the reads never broke: a Postgres miss
// degrades to a schema-stable empty feed rather than a 404, which is how a
// store with no writer read as a healthy, permanently frozen one (#10710).
//
// THE PROPERTY WORTH THE MOST HERE is append-on-CHANGE. The producer re-reads
// every subnet's identity on every pass, so the same revision arrives again and
// again at different timestamps. The history conflicts on
// (netuid, identity_hash) rather than (netuid, observed_at) like its siblings
// precisely so that repetition writes nothing -- conflicting on the timestamp
// would append a duplicate row every pass and bury the provenance the table
// exists for. `an unchanged identity appends nothing on a second pass` is that
// claim, measured rather than asserted.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, test, vi } from "vitest";
import type { Row } from "./row-type.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { DataApiWorkerEnv } from "../workers/types.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

const { default: worker } = await import("../workers/data-api.ts");

const SECRET = "test-subnet-identity-sync-secret";
const TOKEN_HEADER = "x-subnet-identity-sync-token";
const PATH = "/api/v1/internal/subnet-identity-sync";

// The REAL Neon DDL for this family, applied verbatim. 0021 carries the unique
// index the history's ON CONFLICT names; an ON CONFLICT over columns with no
// unique index behind them is a runtime error, not a slower query, so a
// hand-written fixture that omitted it would pass tests production could not.
const MIGRATIONS = [
  "migrations/neon/0021_subnet_identity_history.sql",
  "migrations/neon/0023_subnet_identity_latest.sql",
].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));

let db: PGlite;

function env(overrides: Record<string, unknown> = {}) {
  return dataApiEnv({
    HYPERDRIVE: { connectionString: "postgres://stub" },
    SUBNET_IDENTITY_SYNC_SECRET: SECRET,
    ...overrides,
  });
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://d${PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TOKEN_HEADER]: SECRET,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const call = (request: Request, e: DataApiWorkerEnv = env()) =>
  worker.fetch(request, e, ctx);
const count = async (table: string) =>
  Number(
    (await db.query<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)).rows[0]!
      .n,
  );

/** One identity row in the producer's own shape. */
function row(overrides: Row = {}): Row {
  return {
    netuid: 1,
    block_number: 8_800_000,
    captured_at: 1_780_000_000_000,
    subnet_name: "Apex",
    symbol: "α",
    description: "Open competitions",
    github_repo: "https://github.com/macrocosm-os/apex",
    subnet_url: "https://apex.macrocosmos.ai/",
    discord: "macrocrux",
    logo_url: "https://example.invalid/logo.png",
    ...overrides,
  };
}

beforeAll(async () => {
  db = new PGlite();
});

beforeEach(async () => {
  // Re-applied rather than truncated: one test DROPs a table on purpose to
  // reach the 502 path, so the next test needs the DDL back.
  await db.exec("DROP TABLE IF EXISTS subnet_identity");
  await db.exec("DROP TABLE IF EXISTS subnet_identity_history");
  for (const sql of MIGRATIONS) await db.exec(sql);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  // Handed over VERBATIM, so the ON CONFLICT finds 0021's real unique index
  // rather than one a fixture patched in.
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
});

test("an unprovisioned deployment answers 503, not 401", async () => {
  // The distinction matters to the producer: 503 means "this deployment has no
  // secret", which is a config problem, and 401 means "your token is wrong",
  // which is not. Collapsing them sends an operator to the wrong place.
  const res = await call(
    req([row()]),
    env({ SUBNET_IDENTITY_SYNC_SECRET: "" }),
  );
  assert.equal(res.status, 503);
});

test("a missing or wrong token is refused", async () => {
  const missing = await call(
    new Request(`https://d${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([row()]),
    }),
  );
  assert.equal(missing.status, 401);

  const wrong = await call(req([row()], { [TOKEN_HEADER]: "nope" }));
  assert.equal(wrong.status, 401);
  assert.equal(await count("subnet_identity"), 0);
});

test("a non-JSON body is a 400", async () => {
  const res = await call(req("not json at all"));
  assert.equal(res.status, 400);
});

test("a body that is neither an array nor {rows} is a 400", async () => {
  const res = await call(req({ identities: [row()] }));
  assert.equal(res.status, 400);
});

test("a row the schema rejects fails the whole request", async () => {
  // Whole-request, not per-row: a partially-applied identity set is worse than
  // a rejected one, because the rows that did land carry a fresh timestamp and
  // make the set look complete.
  const res = await call(req([row(), row({ netuid: -1 })]));
  assert.equal(res.status, 400);
  assert.equal(await count("subnet_identity"), 0);
});

test("a non-string identity field is rejected", async () => {
  const res = await call(req([row({ subnet_name: 42 })]));
  assert.equal(res.status, 400);
});

test("a null identity field is accepted and stored as null", async () => {
  // An owner who never set an identity has no name. Null must survive as null
  // rather than becoming "", which a consumer could use to overwrite a
  // curated fallback with nothing.
  const res = await call(req([row({ subnet_name: null, discord: null })]));
  assert.equal(res.status, 200);
  const stored = (
    await db.query<Row>("SELECT subnet_name, discord FROM subnet_identity")
  ).rows[0]!;
  assert.equal(stored.subnet_name, null);
  assert.equal(stored.discord, null);
});

test("a pass writes the card and one history row, and reports both", async () => {
  const res = await call(req({ rows: [row(), row({ netuid: 2 })] }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, true);
  assert.equal(body.subnet_identity_written, 2);
  assert.deepEqual(body.stores, ["neon"]);
  assert.equal(await count("subnet_identity"), 2);
  assert.equal(await count("subnet_identity_history"), 2);
});

test("an unchanged identity appends nothing on a second pass", async () => {
  // The reason the history conflicts on the HASH. The producer re-reads every
  // identity every pass; if repetition appended, a 1h lane would add 24
  // identical rows a day per subnet.
  await call(req([row()]));
  assert.equal(await count("subnet_identity_history"), 1);

  await call(
    req([row({ captured_at: 1_780_000_999_000, block_number: 8_800_500 })]),
  );
  assert.equal(await count("subnet_identity_history"), 1);
  assert.equal(await count("subnet_identity"), 1);
});

test("a repeated identity keeps its FIRST observed_at, not its latest", async () => {
  // THE BUG THE ROW COUNT ABOVE COULD NOT SEE (#10836). Counting rows proved
  // repetition appended nothing; it said nothing about the row that was
  // already there. `buildPgUpsert` emits a DO UPDATE for every non-key column,
  // so the hourly re-send rewrote observed_at every pass and an
  // append-on-CHANGE table published "changed an hour ago" for every subnet
  // that had not changed at all.
  //
  // Measured on production before the fix: 125 rows across 7 landed passes,
  // 124 of them sitting at the single newest pass. That is what
  // /chain/identity-history was serving.
  await call(req([row({ captured_at: 1_780_000_000_000 })]));
  const first = (
    await db.query<Row>("SELECT observed_at FROM subnet_identity_history")
  ).rows[0]!.observed_at;
  assert.equal(Number(first), 1_780_000_000_000);

  await call(req([row({ captured_at: 1_780_009_999_000 })]));
  const after = (
    await db.query<Row>("SELECT observed_at FROM subnet_identity_history")
  ).rows[0]!.observed_at;
  assert.equal(
    Number(after),
    1_780_000_000_000,
    "a later sighting of the same revision must not move its first-seen stamp",
  );

  // The CARD still tracks the latest, which is the direction that guard runs.
  const card = (await db.query<Row>("SELECT captured_at FROM subnet_identity"))
    .rows[0]!;
  assert.equal(Number(card.captured_at), 1_780_009_999_000);
});

test("an EARLIER sighting of a revision moves its observed_at back", async () => {
  // The guard is `>` rather than DO NOTHING on purpose: a backfill supplying
  // an older observation of the same revision is a BETTER first-seen, so it
  // wins. Only a later one is refused.
  await call(req([row({ captured_at: 1_780_005_000_000 })]));
  await call(req([row({ captured_at: 1_780_000_000_000 })]));
  const stored = (
    await db.query<Row>("SELECT observed_at FROM subnet_identity_history")
  ).rows[0]!;
  assert.equal(Number(stored.observed_at), 1_780_000_000_000);
  assert.equal(await count("subnet_identity_history"), 1);
});

test("a CHANGED identity appends a second history row", async () => {
  await call(req([row()]));
  await call(
    req([row({ subnet_name: "Apex Reborn", captured_at: 1_780_001_000_000 })]),
  );
  assert.equal(await count("subnet_identity_history"), 2);
  // The card is latest-only: one row per netuid, carrying the new name.
  assert.equal(await count("subnet_identity"), 1);
  const card = (
    await db.query<Row>(
      "SELECT subnet_name FROM subnet_identity WHERE netuid = 1",
    )
  ).rows[0]!;
  assert.equal(card.subnet_name, "Apex Reborn");
});

test("more rows than the cap is a 413", async () => {
  const many = Array.from({ length: 2_001 }, (_, i) => row({ netuid: i }));
  const res = await call(req(many));
  assert.equal(res.status, 413);
});

test("a write failure is the request's failure, not a silent success", async () => {
  // Neon is the only store for this family, so swallowing a failure here would
  // report a pass that wrote nothing -- the exact shape of the bug this route
  // exists to end.
  await db.exec("DROP TABLE subnet_identity_history");
  const res = await call(req([row()]));
  assert.equal(res.status, 502);
});

test("an oversized body is a 413 before any parsing", async () => {
  // Checked on the RAW text, so a 2 MB body is refused without being parsed
  // into objects first -- the producer buffers a whole pass into one request,
  // and a Worker that parses before measuring is one growth spurt from an OOM.
  const huge = "x".repeat(2_000_001);
  const res = await call(req(`{"rows":[],"pad":"${huge}"}`));
  assert.equal(res.status, 413);
});

// "a lane absent from NEON_DUAL_WRITE_LANES fails rather than silently
// no-ops" lived here until #10051: the flag is gone, the write is
// unconditional, and the mirrors report an unbound store IN-BAND --
// this route's other failure pins stand below.

test("an over-long identity string is rejected", async () => {
  // These are owner-supplied strings from the chain and they land in TEXT
  // columns the serving routes render. Bounded here rather than trusted,
  // because nothing upstream of the chain constrains what an owner writes.
  const res = await call(req([row({ description: "d".repeat(4_097) })]));
  assert.equal(res.status, 400);
  assert.equal(await count("subnet_identity"), 0);
});
