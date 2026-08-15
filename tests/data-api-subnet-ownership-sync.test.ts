// POST /api/v1/internal/subnet-ownership-sync, end to end against a REAL
// Postgres through the real Worker fetch handler -- same harness and rationale
// as tests/data-api-subnet-identity-sync.test.ts.
//
// WHAT THIS ROUTE IS. `subnet-ownership` was the last poller lane writing
// Postgres from inside the container over a raw DATABASE_URL. The container
// cannot use Hyperdrive -- it is a Linux process, not a Worker isolate -- so
// that write bypassed the pool Neon's compute is protected by, and shipped a
// Neon credential in a container image. This route is the Worker half (#10836).
//
// THE TWO PROPERTIES WORTH THE MOST HERE are the ones that moved OUT of Rust:
//
//   1. APPEND-ON-CHANGE. The producer used to SELECT the whole card, diff each
//      owner in application code, and INSERT into the history only on a change.
//      That read-then-write is a race between overlapping passes, so it does
//      not come along; the route posts everything and 0026's unique index on
//      (netuid, owner_hotkey, owner_coldkey) decides what is new.
//   2. THE PRUNE. The producer ended each pass with `DELETE FROM
//      subnet_ownership WHERE netuid <> ALL($1)`. Without it a deregistered
//      subnet's card would survive forever in a latest-only table.
//
// Both are measured below rather than asserted in prose, because both are
// invisible in a row count taken at the wrong moment -- which is exactly how
// the sibling table's first-seen bug survived its own "appends nothing" test.
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

const SECRET = "test-subnet-ownership-sync-secret";
const TOKEN_HEADER = "x-subnet-ownership-sync-token";
const PATH = "/api/v1/internal/subnet-ownership-sync";

// The REAL Neon DDL, applied verbatim. 0026 carries the unique index the
// history's ON CONFLICT names -- an ON CONFLICT over columns with no unique
// index behind them is a runtime ERROR, not a slower query, so a hand-written
// fixture that omitted it would pass a test production could not.
const MIGRATIONS = [
  "migrations/neon/0024_subnet_ownership.sql",
  "migrations/neon/0026_subnet_ownership_history_revision.sql",
].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));

let db: PGlite;

function env(overrides: Record<string, unknown> = {}) {
  return dataApiEnv({
    HYPERDRIVE: { connectionString: "postgres://stub" },
    SUBNET_OWNERSHIP_SYNC_SECRET: SECRET,
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

const HOTKEY = "5FTsvUZk3aoFdaAKAvWr1XVLmnEnEs5MoTM4nXtCUCu7yPQ7";
const COLDKEY = "5DvTpiniW9s3APmHRYn8FroUWyfnLtrsid5Mtn5EwMXHN2ed";

/** One ownership row in the producer's own shape -- the four columns its
 * INSERT binds, no more. */
function row(overrides: Row = {}): Row {
  return {
    netuid: 1,
    owner_hotkey: HOTKEY,
    owner_coldkey: COLDKEY,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

beforeAll(async () => {
  db = new PGlite();
});

beforeEach(async () => {
  // Re-applied rather than truncated: one test DROPs a table on purpose to
  // reach the 502 path, so the next test needs the DDL back.
  await db.exec("DROP TABLE IF EXISTS subnet_ownership");
  await db.exec("DROP TABLE IF EXISTS subnet_ownership_history");
  for (const sql of MIGRATIONS) await db.exec(sql);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
});

test("an unprovisioned deployment answers 503, not 401", async () => {
  // 503 means "this deployment has no secret" -- a config problem. 401 means
  // "your token is wrong", which is not. Collapsing them sends an operator to
  // the wrong place, and this producer's stdout is unreachable.
  const res = await call(
    req([row()]),
    env({ SUBNET_OWNERSHIP_SYNC_SECRET: "" }),
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
  assert.equal(await count("subnet_ownership"), 0);
});

test("a non-JSON body is a 400", async () => {
  const res = await call(req("not json at all"));
  assert.equal(res.status, 400);
});

test("a body that is neither an array nor {rows} is a 400", async () => {
  const res = await call(req({ owners: [row()] }));
  assert.equal(res.status, 400);
});

test("a row the schema rejects fails the whole request", async () => {
  const res = await call(req([row(), row({ netuid: -1 })]));
  assert.equal(res.status, 400);
  assert.equal(await count("subnet_ownership"), 0);
});

test("a null owner key is rejected rather than written", async () => {
  // 0024 made both key columns NOT NULL, on the grounds that the Rust producer
  // binds String rather than Option<String> and drops a zero-account owner
  // from the snapshot entirely. Accepting null here would turn a clean 400
  // into a 502 from the database.
  const res = await call(req([row({ owner_coldkey: null })]));
  assert.equal(res.status, 400);
  assert.equal(await count("subnet_ownership"), 0);
});

test("a seconds-precision captured_at is rejected as a unit error", async () => {
  // Read as milliseconds a seconds stamp lands in 1970, and because the card
  // upserts under `captured_at < EXCLUDED.captured_at` it is permanently
  // "older" than any correct one -- the bad row could never be corrected in
  // place by a later capture.
  const res = await call(req([row({ captured_at: 1_780_000_000 })]));
  assert.equal(res.status, 400);
});

test("a column the route does not write is rejected", async () => {
  const res = await call(req([row({ block_number: 8_800_000 })]));
  assert.equal(res.status, 400);
});

test("an over-long owner key is rejected", async () => {
  const res = await call(req([row({ owner_hotkey: "5".repeat(129) })]));
  assert.equal(res.status, 400);
  assert.equal(await count("subnet_ownership"), 0);
});

test("the same netuid twice in one request is a 400 naming it", async () => {
  // Refused HERE rather than left to Postgres, which would raise "ON CONFLICT
  // DO UPDATE command cannot affect row a second time" and fail the pass with
  // a 502 whose text names no netuid.
  const res = await call(req([row({ netuid: 7 }), row({ netuid: 7 })]));
  assert.equal(res.status, 400);
  assert.match((await res.json<{ error: string }>()).error, /netuid 7/);
  assert.equal(await count("subnet_ownership"), 0);
});

test("a pass writes the card and the history, and reports what landed", async () => {
  const res = await call(req({ rows: [row(), row({ netuid: 2 })] }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, true);
  assert.equal(body.subnet_ownership_written, 2);
  assert.deepEqual(body.stores, ["neon"]);
  assert.equal(await count("subnet_ownership"), 2);
  assert.equal(await count("subnet_ownership_history"), 2);
});

test("an unchanged owner appends nothing on a second pass", async () => {
  // The whole reason the history conflicts on the owner PAIR. The producer
  // re-reads every owner every 300s; if repetition appended, one unchanged
  // subnet would add 288 identical rows a day.
  await call(req([row()]));
  assert.equal(await count("subnet_ownership_history"), 1);

  await call(req([row({ captured_at: 1_780_000_300_000 })]));
  assert.equal(await count("subnet_ownership_history"), 1);
  assert.equal(await count("subnet_ownership"), 1);
});

test("a repeated owner keeps its FIRST captured_at, not its latest", async () => {
  // The row count above cannot see this, and that blind spot is not
  // hypothetical -- it is how the identical bug survived in
  // subnet_identity_history until #10836 measured production and found 124 of
  // 125 rows sitting at the newest pass. A history whose timestamp tracks
  // "last seen" reports an ownership change every tick.
  await call(req([row({ captured_at: 1_780_000_000_000 })]));
  await call(req([row({ captured_at: 1_780_009_999_000 })]));

  const history = (
    await db.query<Row>("SELECT captured_at FROM subnet_ownership_history")
  ).rows[0]!;
  assert.equal(
    Number(history.captured_at),
    1_780_000_000_000,
    "a later sighting of the same owner must not move its first-seen stamp",
  );

  // The CARD tracks the latest -- the two guards point in opposite directions
  // on purpose.
  const card = (await db.query<Row>("SELECT captured_at FROM subnet_ownership"))
    .rows[0]!;
  assert.equal(Number(card.captured_at), 1_780_009_999_000);
});

test("a CHANGED owner appends a second history row and moves the card", async () => {
  await call(req([row()]));
  const NEW_COLDKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  await call(
    req([row({ owner_coldkey: NEW_COLDKEY, captured_at: 1_780_001_000_000 })]),
  );

  assert.equal(await count("subnet_ownership_history"), 2);
  // Latest-only: one row per netuid, carrying the new owner.
  assert.equal(await count("subnet_ownership"), 1);
  const card = (
    await db.query<Row>(
      "SELECT owner_coldkey FROM subnet_ownership WHERE netuid = 1",
    )
  ).rows[0]!;
  assert.equal(card.owner_coldkey, NEW_COLDKEY);
});

test("a netuid absent from a pass loses its card but keeps its history", async () => {
  // THE PRUNE, moved here from the producer. A deregistered subnet must leave
  // the latest-only card -- and must NOT lose the trail of who owned it, which
  // is the distinction between the two tables.
  await call(req([row({ netuid: 1 }), row({ netuid: 2 })]));
  assert.equal(await count("subnet_ownership"), 2);

  await call(req([row({ netuid: 1, captured_at: 1_780_000_300_000 })]));
  assert.equal(await count("subnet_ownership"), 1);
  const remaining = (await db.query<Row>("SELECT netuid FROM subnet_ownership"))
    .rows[0]!;
  assert.equal(remaining.netuid, 1);
  // Both trails survive the prune.
  assert.equal(await count("subnet_ownership_history"), 2);
});

test("the prune runs AFTER the upsert, so a re-registered netuid survives", async () => {
  // Order matters and the producer said so: upsert-before-prune means an
  // active subnet is never even transiently missing from the card. Reversed,
  // this pass would delete netuid 2 and then re-insert it -- same end state,
  // but a reader between the two statements sees a subnet with no owner.
  await call(req([row({ netuid: 1 }), row({ netuid: 2 })]));
  await call(
    req([
      row({ netuid: 2, captured_at: 1_780_000_300_000 }),
      row({ netuid: 3, captured_at: 1_780_000_300_000 }),
    ]),
  );
  const netuids = (
    await db.query<Row>("SELECT netuid FROM subnet_ownership ORDER BY netuid")
  ).rows.map((r) => r.netuid);
  assert.deepEqual(netuids, [2, 3]);
});

test("more rows than the cap is a 413", async () => {
  const many = Array.from({ length: 2_001 }, (_, i) => row({ netuid: i }));
  const res = await call(req(many));
  assert.equal(res.status, 413);
});

test("an oversized body is a 413 before any parsing", async () => {
  // Checked on the RAW text, so the body is refused without being parsed into
  // objects first.
  const huge = "x".repeat(500_001);
  const res = await call(req(`{"rows":[],"pad":"${huge}"}`));
  assert.equal(res.status, 413);
});

test("an empty row set is refused rather than pruning the whole card", async () => {
  // A pass that resolved nothing is a BROKEN pass, not an instruction to empty
  // the table -- and `netuid <> ALL('{}')` is true for every row, so an
  // unguarded prune would delete all of it. Measured against production while
  // designing this: the empty set would have deleted all 128 rows.
  await call(req([row()]));
  assert.equal(await count("subnet_ownership"), 1);

  const res = await call(req([]));
  assert.equal(res.status, 400);
  assert.equal(await count("subnet_ownership"), 1);
});

test("a write failure is the request's failure, not a silent success", async () => {
  // Neon is the only store, so swallowing a failure here would report a pass
  // that wrote nothing.
  await db.exec("DROP TABLE subnet_ownership_history");
  const res = await call(req([row()]));
  assert.equal(res.status, 502);
});

// "a lane absent from NEON_DUAL_WRITE_LANES fails rather than silently
// no-ops" lived here until #10051: the flag is gone and the write is
// unconditional, so the absent-lane state cannot exist. What that test
// was really protecting -- an ack must never claim durability nothing
// holds -- is pinned harder now: the mirrors report an unbound store
// IN-BAND (per-table failures), asserted in their own suites, and this
// route's failing-write and dropped-table 502s stay pinned below.
