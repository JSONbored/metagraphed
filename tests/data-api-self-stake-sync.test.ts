// POST /api/v1/internal/self-stake-sync (#10845), end to end against a REAL
// Postgres through the real Worker fetch handler.
//
// THE ONE PROPERTY THIS FILE EXISTS FOR is `a self-stake row survives a
// validator-nominators pass over the same coldkey`. Everything else here is
// ordinary route hygiene; that test is the reason the route exists at all.
//
// `nominator_positions` now has two producers. `validator-nominators` scans
// SubtensorModule::Alpha and prunes per `coldkey` -- every row for a posted
// coldkey older than that `coldkey`'s newest captured_at in the request.
// `self-stake` exists precisely for the pairs that scan MISSES: an owner's own
// stake on their own hotkey frequently has no Alpha entry at all. So its rows
// are, from the other lane's point of view, always "older than this pass" --
// and before 0027's `source` column an unscoped prune deleted them within a day
// of them being written. Written weekly, deleted daily, with partial survival
// depending on whether the owner also nominated elsewhere.
//
// The fix is a prune DOMAIN, and the test below is the measurement of it.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, test, vi } from "vitest";
import type { Row } from "./row-type.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

const { default: worker } = await import("../workers/data-api.ts");

const SECRET = "test-self-stake-sync-secret";
const TOKEN_HEADER = "x-self-stake-sync-token";
const PATH = "/api/v1/internal/self-stake-sync";
const POSITIONS_PATH = "/api/v1/internal/nominator-positions-sync";
const POSITIONS_HEADER = "x-nominator-positions-sync-token";
const POSITIONS_SECRET = "test-nominator-positions-sync-secret";

// The table as production has it, then 0027's source column, applied verbatim
// -- the prune's whole correctness rests on that column existing with its
// default, so a hand-written fixture would prove nothing.
const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS nominator_positions (
  coldkey        TEXT    NOT NULL,
  hotkey         TEXT    NOT NULL,
  netuid         INTEGER NOT NULL,
  share_fraction DOUBLE PRECISION,
  shares         NUMERIC,
  captured_at    BIGINT  NOT NULL,
  PRIMARY KEY (coldkey, hotkey, netuid)
);`;
const MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    "migrations/neon/0027_nominator_positions_source.sql",
  ),
  "utf8",
);

let db: PGlite;

function env(overrides: Record<string, unknown> = {}) {
  return {
    HYPERDRIVE: { connectionString: "postgres://stub" },
    SELF_STAKE_SYNC_SECRET: SECRET,
    NOMINATOR_POSITIONS_SYNC_SECRET: POSITIONS_SECRET,
    ...overrides,
  } as unknown as Env;
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

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

const call = (request: Request, e: Env = env()) =>
  worker.fetch(request, e, ctx);

const OWNER = "5DvTpiniW9s3APmHRYn8FroUWyfnLtrsid5Mtn5EwMXHN2ed";
const OWN_HOTKEY = "5FTsvUZk3aoFdaAKAvWr1XVLmnEnEs5MoTM4nXtCUCu7yPQ7";
const OTHER_HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function row(overrides: Row = {}): Row {
  return {
    coldkey: OWNER,
    hotkey: OWN_HOTKEY,
    netuid: 1,
    share_fraction: 0.42,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

const rowsOf = async (where = "") =>
  (
    await db.query<Row>(
      `SELECT coldkey, hotkey, netuid, source, captured_at FROM nominator_positions ${where} ORDER BY hotkey, netuid`,
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
});

beforeEach(async () => {
  await db.exec("DROP TABLE IF EXISTS nominator_positions");
  await db.exec(TABLE_DDL);
  await db.exec(MIGRATION);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
});

test("a self-stake row SURVIVES a validator-nominators pass over the same coldkey", async () => {
  // THE REGRESSION THIS ROUTE EXISTS TO PREVENT.
  //
  // The owner self-stakes on their own hotkey (no Alpha entry, so
  // validator-nominators will never carry this row) AND nominates a different
  // hotkey (which it will). Before 0027 the second lane's per-coldkey prune
  // deleted the first row, because it is older than that lane's pass and the
  // prune could not tell the two producers apart.
  const selfStake = await call(req([row({ captured_at: 1_780_000_000_000 })]));
  assert.equal(selfStake.status, 200);
  assert.equal((await rowsOf()).length, 1);

  // A LATER validator-nominators pass for the same coldkey, carrying only the
  // position its Alpha scan can see.
  const alpha = await worker.fetch(
    new Request(`https://d${POSITIONS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [POSITIONS_HEADER]: POSITIONS_SECRET,
      },
      body: JSON.stringify([
        {
          coldkey: OWNER,
          hotkey: OTHER_HOTKEY,
          netuid: 1,
          share_fraction: 0.1,
          captured_at: 1_780_009_999_000,
        },
      ]),
    }),
    env(),
    ctx,
  );
  assert.equal(alpha.status, 200);

  const remaining = await rowsOf();
  assert.deepEqual(
    remaining.map((r) => `${r.hotkey}:${r.source}`),
    [`${OWN_HOTKEY}:self-stake`, `${OTHER_HOTKEY}:alpha`],
    "the self-stake row must survive the other producer's prune",
  );
});

test("self-stake prunes its OWN superseded rows", async () => {
  // The domain cuts both ways: scoping the prune must not stop this lane
  // cleaning up after itself, or a position it no longer reports would live
  // forever.
  await call(req([row({ netuid: 1 }), row({ netuid: 2 })]));
  assert.equal((await rowsOf()).length, 2);

  await call(req([row({ netuid: 1, captured_at: 1_780_009_999_000 })]));
  const remaining = await rowsOf();
  assert.deepEqual(
    remaining.map((r) => r.netuid),
    [1],
    "netuid 2 was not in the newer pass, so this lane must drop it",
  );
});

test("self-stake does NOT prune the other producer's rows either", async () => {
  // The mirror image of the first test, and not redundant: it proves the
  // scoping is on the WRITER's source rather than a hardcoded exemption for
  // one lane.
  await worker.fetch(
    new Request(`https://d${POSITIONS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [POSITIONS_HEADER]: POSITIONS_SECRET,
      },
      body: JSON.stringify([
        {
          coldkey: OWNER,
          hotkey: OTHER_HOTKEY,
          netuid: 1,
          share_fraction: 0.1,
          captured_at: 1_780_000_000_000,
        },
      ]),
    }),
    env(),
    ctx,
  );
  await call(req([row({ captured_at: 1_780_009_999_000 })]));

  const sources = (await rowsOf()).map((r) => r.source).sort();
  assert.deepEqual(sources, ["alpha", "self-stake"]);
});

test("rows are stamped with this route's source, and the wire cannot name it", async () => {
  // `source` is set by the WRITER. A producer that could name its own source
  // could claim the other lane's prune domain and delete its rows, so the
  // schema rejects it as a column this route does not write.
  const res = await call(req([row({ source: "alpha" })]));
  assert.equal(res.status, 400);
  assert.equal((await rowsOf()).length, 0);

  await call(req([row()]));
  assert.equal((await rowsOf())[0]!.source, "self-stake");
});

test("the {rows:[...]} envelope is accepted, like every sibling route", async () => {
  // The producer posts `{rows:[...]}`; a bare array is the other accepted
  // form. Both branches are real entry points, so both are exercised -- the
  // array form is what every other test here uses.
  const res = await call(req({ rows: [row()] }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.self_stake_positions_written, 1);
  assert.equal((await rowsOf())[0]!.source, "self-stake");
});

test("an unprovisioned deployment answers 503, not 401", async () => {
  const res = await call(req([row()]), env({ SELF_STAKE_SYNC_SECRET: "" }));
  assert.equal(res.status, 503);
});

test("a missing or wrong token is refused", async () => {
  const missing = await worker.fetch(
    new Request(`https://d${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([row()]),
    }),
    env(),
    ctx,
  );
  assert.equal(missing.status, 401);
  const wrong = await call(req([row()], { [TOKEN_HEADER]: "nope" }));
  assert.equal(wrong.status, 401);
  assert.equal((await rowsOf()).length, 0);
});

test("a non-JSON body, a wrong shape, and a bad row are each 400", async () => {
  assert.equal((await call(req("not json"))).status, 400);
  assert.equal((await call(req({ positions: [row()] }))).status, 400);
  assert.equal((await call(req([row({ netuid: -1 })]))).status, 400);
  assert.equal((await rowsOf()).length, 0);
});

test("more rows than the cap is a 413", async () => {
  const many = Array.from({ length: 25_001 }, (_, i) =>
    row({ netuid: i % 65_535 }),
  );
  assert.equal((await call(req(many))).status, 413);
});

test("an oversized body is a 413 before any parsing", async () => {
  const huge = "x".repeat(8_000_001);
  assert.equal((await call(req(`{"rows":[],"pad":"${huge}"}`))).status, 413);
});

test("a write failure is the request's failure", async () => {
  await db.exec("DROP TABLE nominator_positions");
  assert.equal((await call(req([row()]))).status, 502);
});

// "a lane absent from NEON_DUAL_WRITE_LANES fails rather than silently
// no-ops" lived here until #10051: the flag is gone, the write is
// unconditional, and the mirrors report an unbound store IN-BAND --
// this route's other failure pins stand below.
