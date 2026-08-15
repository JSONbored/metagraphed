// The hotkey-alpha sync lane (#9502), exercised END TO END against a REAL
// SQLite database through the real Worker fetch handler -- same harness and
// rationale as tests/data-api-account-balances.test.ts.
//
// This table is the input `delegated_tao` could not be computed without. A
// coldkey's `nominator_positions.share_fraction` is a dimensionless slice of a
// (hotkey, netuid) alpha POOL, and the only stake figure in D1 --
// `neurons.stake_tao` -- exists solely for hotkeys registered on that exact
// subnet: 512 of the 13,724 pairs the positions actually name, so 22.8% of
// position rows priced. Recomputing the leaderboard from that join ranks an
// account the frozen snapshot puts at 81,185 TAO at 0, which is why the column
// waited for this rather than shipping a per-row label on a ranking.
//
// What matters here is the write CONTRACT, and it differs from the balances
// lane in exactly one structural way: the key is COMPOSITE. A hotkey holds a
// separate pool on every subnet it is staked to, so (hotkey, netuid) is the
// identity and a same-hotkey/different-netuid row must INSERT rather than
// overwrite. The sibling Alpha scan is ~762,577 entries, past any single
// request body, so a pass arrives across many requests -- which is why there is
// no prune and why the captured_at guard, not request ordering, is what keeps a
// replay safe.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import type { Row } from "./row-type.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { DataApiWorkerEnv } from "../workers/types.ts";

// The store is Postgres now (#10179), reached through `new Client(...)` inside
// src/neon-write.ts -- which nothing here can inject into, because the route is
// reached as `worker.fetch(request, env, ctx)`. Mocking the module is the seam;
// see tests/helpers/pg-mock.ts for why it is a module mock and not a production
// export, and why the controller is built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

const { default: worker } = await import("../workers/data-api.ts");
const { QUEUE_MESSAGE_MAX_BYTES } = await import("../src/sync-batch-queue.ts");

/**
 * The REAL Neon DDL for every table this route touches (#10328).
 *
 * Applied verbatim rather than transliterated into a SQLite fixture. The
 * fixture could only ever be a second schema to maintain, and it failed
 * silently in the direction that matters: `hotkey_alpha.netuid` is INTEGER
 * here, which is the entire reason this lane's upsert carries `::int` casts --
 * and the SQLite path deleted those casts before the engine saw them.
 *
 * 0007 also brings `nominator_positions`, which the write FILTERS against
 * (#9557): only pools some position actually references are stored, so the
 * sink's statement reads that table and it has to exist.
 */
const MIGRATIONS = [
  "migrations/neon/0005_remaining_d1_tables.sql",
  "migrations/neon/0007_hand_created_tables.sql",
  "migrations/neon/0008_hotkey_alpha.sql",
].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));

/** Tables a test may write, emptied between tests. Named rather than
 * discovered, so a table added to the migrations without a seed here is a
 * visible omission rather than silently-shared rows. */
const SEEDED_TABLES = [
  "hotkey_alpha",
  "hotkey_alpha_passes",
  "nominator_positions",
];

/** Make (hotkey, netuid) referenced, so a pool for it is stored. */
async function reference(hotkey: string, netuid: number) {
  await db.query(
    "INSERT INTO nominator_positions" +
      " (coldkey, hotkey, netuid, share_fraction, captured_at)" +
      " VALUES ($1, $2, $3, 1.0, 1) ON CONFLICT DO NOTHING",
    [`5Cold${hotkey}${netuid}`, hotkey, netuid],
  );
}

const PATH = "/api/v1/internal/hotkey-alpha-sync";
const SECRET = "test-hotkey-alpha-sync-secret";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const HOTKEY_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

let db: PGlite;

function env(overrides: Record<string, unknown> = {}): DataApiWorkerEnv {
  return dataApiEnv({
    ...pgMockEnv(),
    // The inline write runs through mirrorLedgerToNeon, which is a no-op unless
    // the lane is named here -- so a suite that left this out would assert an
    // empty table and call it a passing write.
    HOTKEY_ALPHA_SYNC_SECRET: SECRET,
    ...overrides,
  });
}

/** A ctx with a real `waitUntil`. createPgSql hands the client back through it
 * from a `finally`, so an object without one turns every successful write into
 * a TypeError -- silently, because the rejection replaces the result. */
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function post(
  body: unknown,
  token: string | null = SECRET,
  envOverride?: DataApiWorkerEnv,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null) headers["x-hotkey-alpha-sync-token"] = token;
  return worker.fetch(
    new Request(`https://d${PATH}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    envOverride ?? env(),
    ctx,
  );
}

function alphaRow(overrides: Row = {}): Row {
  return {
    hotkey: HOTKEY,
    netuid: 7,
    total_alpha: 1234.5,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

const rows = async () =>
  (await db.query<Row>("SELECT * FROM hotkey_alpha ORDER BY hotkey, netuid"))
    .rows;

const passes = async () =>
  (
    await db.query<Row>(
      "SELECT * FROM hotkey_alpha_passes ORDER BY captured_at",
    )
  ).rows;

// ONE instance for the file, TRUNCATE between tests. Booting pglite is ~470ms
// and the schema never varies, so a fresh instance per test would spend the
// whole run re-applying identical DDL.
beforeAll(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE ${SEEDED_TABLES.join(", ")}`);
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  // Handed over VERBATIM -- no placeholder rewrite, no cast stripping. This
  // lane's upsert is the one that carries a FILTER, so its statement is the
  // `(VALUES ...) AS src (cols)` form with `::int` casts, and both of those
  // are exactly what the SQLite path could not represent.
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
  // The fixtures below use HOTKEY/HOTKEY_B on the netuids alphaRow() defaults
  // to; referencing them keeps every pre-existing assertion about what lands
  // testing what it was written to test.
  for (const hk of [HOTKEY, HOTKEY_B]) {
    for (const n of [7, 8, 9, 83]) await reference(hk, n);
  }
});

describe("POST /api/v1/internal/hotkey-alpha-sync", () => {
  test("writes a batch to the store and reports what it did", async () => {
    const response = await post({
      rows: [alphaRow(), alphaRow({ hotkey: HOTKEY_B, total_alpha: 0 })],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      hotkey_alpha_written: 2,
      stores: ["neon"],
      pass_total: null,
    });
    assert.equal((await rows()).length, 2);
    // A zero pool IS stored. The producer skips an unread pool, so a zero that
    // arrives is a measured emptiness, not a placeholder -- the distinction
    // the NOT NULL column exists to preserve.
    assert.equal((await rows())[1]!.total_alpha, 0);
  });

  test("the same hotkey on two subnets is two rows, not an overwrite", async () => {
    // The whole reason this table exists: a delegate accrues alpha on every
    // subnet it is staked to. A single-column key would collapse those pools
    // into one and misprice every position on all but the last-written subnet.
    await post({
      rows: [
        alphaRow({ netuid: 7, total_alpha: 100 }),
        alphaRow({ netuid: 83, total_alpha: 250 }),
      ],
    });
    assert.equal((await rows()).length, 2);
    assert.deepEqual(
      (await rows()).map((r) => [r.netuid, r.total_alpha]),
      [
        [7, 100],
        [83, 250],
      ],
    );
  });

  test("a newer capture updates in place; an older one is ignored", async () => {
    // Real epoch-ms throughout: validSyncCapturedAt rejects a toy value like
    // 2000 outright, which is the guard #9382 exists for -- a seconds-scale
    // number read as ms lands in 1970 and pins the row permanently.
    const older = 1_780_000_000_000;
    const newer = 1_781_000_000_000;
    await post({ rows: [alphaRow({ total_alpha: 100, captured_at: older })] });
    await post({ rows: [alphaRow({ total_alpha: 300, captured_at: newer })] });
    assert.equal((await rows())[0]!.total_alpha, 300);
    // A pass arrives across many requests and the producer re-sends on
    // failure, so a replayed or out-of-order batch must be a no-op rather than
    // a regression to an older pool size.
    await post({ rows: [alphaRow({ total_alpha: 999, captured_at: older })] });
    assert.equal((await rows())[0]!.total_alpha, 300);
    assert.equal((await rows())[0]!.captured_at, newer);
  });

  test("accepts a bare array as well as {rows:[...]}", async () => {
    const response = await post([alphaRow()]);
    assert.equal(response.status, 200);
    assert.equal((await rows()).length, 1);
  });

  test("rejects a missing or wrong token before reading the body", async () => {
    assert.equal((await post({ rows: [alphaRow()] }, null)).status, 401);
    assert.equal((await post({ rows: [alphaRow()] }, "wrong")).status, 401);
    assert.equal((await rows()).length, 0);
  });

  test("503s when the route is not provisioned", async () => {
    const response = await post(
      { rows: [alphaRow()] },
      SECRET,
      env({ HOTKEY_ALPHA_SYNC_SECRET: undefined }),
    );
    assert.equal(response.status, 503);
  });

  test("400s on a body that is not JSON or not a row list", async () => {
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ nope: 1 })).status, 400);
    assert.equal((await post({ rows: [] })).status, 400);
  });

  test("rejects a row carrying a key outside the writer's column list", async () => {
    // An unknown key means the producer and the writer disagree about the
    // shape; accepting it would silently drop the field.
    const response = await post({ rows: [alphaRow({ extra: 1 })] });
    assert.equal(response.status, 400);
    assert.equal((await rows()).length, 0);
  });

  test("rejects a negative, non-finite or non-numeric alpha", async () => {
    // A NaN or Infinity arriving as null would bind as NULL against a NOT NULL
    // column and fail the whole batch at the database rather than here.
    for (const bad of [-1, "1234.5", null, undefined]) {
      const response = await post({ rows: [alphaRow({ total_alpha: bad })] });
      assert.equal(response.status, 400, String(bad));
    }
    assert.equal(
      (
        await post(
          `{"rows":[{"hotkey":"${HOTKEY}","netuid":7,"total_alpha":1e999,"captured_at":1780000000000}]}`,
        )
      ).status,
      400,
      "Infinity",
    );
    assert.equal((await rows()).length, 0);
  });

  test("rejects a junk netuid rather than creating a parallel row", async () => {
    // netuid is half the primary key, so a non-integer or negative value
    // silently creates a second row for the same pool instead of updating it.
    for (const bad of [-1, 1.5, "7", null]) {
      const response = await post({ rows: [alphaRow({ netuid: bad })] });
      assert.equal(response.status, 400, String(bad));
    }
    assert.equal((await rows()).length, 0);
  });

  test("rejects an empty or oversized hotkey", async () => {
    assert.equal(
      (await post({ rows: [alphaRow({ hotkey: "" })] })).status,
      400,
    );
    assert.equal(
      (await post({ rows: [alphaRow({ hotkey: "5".repeat(200) })] })).status,
      400,
    );
    assert.equal((await rows()).length, 0);
  });

  test("rejects a captured_at the staleness guard cannot trust", async () => {
    for (const bad of [0, -1, "1780000000000", null]) {
      const response = await post({ rows: [alphaRow({ captured_at: bad })] });
      assert.equal(response.status, 400, String(bad));
    }
    assert.equal((await rows()).length, 0);
  });

  test("503s when no store is bound, and only AFTER validating the body", async () => {
    // A malformed body is a 400 whether or not a store happens to be bound.
    const unbound = env({ HYPERDRIVE: undefined });
    assert.equal((await post({ nope: 1 }, SECRET, unbound)).status, 400);
    assert.equal(
      (await post({ rows: [alphaRow()] }, SECRET, unbound)).status,
      503,
    );
  });

  // This test's flag-declared premise retired with NEON_SOLE_STORE_TABLES
  // (#10051): Neon is the only store, so an undeclared/partial state cannot
  // exist. "A reader names a table no migration creates" is owned by
  // tests/neon-sole-store-tables-exist.test.ts, derived from the code.

  test("502s when the write throws", async () => {
    pg.control.failNext = new Error("neon exploded");
    const response = await post({ rows: [alphaRow()] }, SECRET);
    assert.equal(response.status, 502);
    // Neon IS the store now, so a failed write is the pass's failure rather
    // than a lost mirror: ok:true here would tell the producer its pools are
    // durable when nothing holds them.
    assert.equal(((await response.json()) as Row).error, "neon write failed");
    assert.equal((await rows()).length, 0);
  });
});

// --- the pass tally (#9502, tests/fixtures/sqlite-schema/0021) ------------------------------
//
// The twin of the balances lane's accounting, guarding a quieter failure. A
// short balance ledger visibly drops accounts from a leaderboard; a short POOL
// ledger prices the positions naming it against nothing, so delegated_tao comes
// out merely too LOW. And absence here is AMBIGUOUS by design -- the producer
// skips a genuine zero pool rather than writing a zero row -- so no count over
// the table can recover completeness. Only the declaration can.
describe("pass_total completeness accounting", () => {
  test("a single-request pass completes immediately", async () => {
    const response = await post({ rows: [alphaRow()], pass_total: 1 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      hotkey_alpha_written: 1,
      stores: ["neon"],
      pass_total: 1,
    });
    const [row] = await passes();
    assert.equal(row!.expected_rows, 1);
    assert.equal(row!.received_rows, 1);
    assert.ok(row!.completed_at, "a satisfied pass carries a completion stamp");
  });

  test("a multi-request pass stays incomplete until the last request lands", async () => {
    // THE REGRESSION SHAPE, and production's live state while this was written:
    // 140,000 of a declared 364,284 rows landed, every one correct. Pricing
    // over that underprices every coldkey whose pools had not arrived.
    await post({ rows: [alphaRow()], pass_total: 3 });
    assert.equal((await passes())[0]!.received_rows, 1);
    assert.equal(
      (await passes())[0]!.completed_at,
      null,
      "one of three requests is NOT a complete pass",
    );

    await post({ rows: [alphaRow({ netuid: 8 })], pass_total: 3 });
    assert.equal((await passes())[0]!.received_rows, 2);
    assert.equal((await passes())[0]!.completed_at, null);

    await post({ rows: [alphaRow({ netuid: 9 })], pass_total: 3 });
    assert.equal((await passes())[0]!.received_rows, 3);
    assert.ok(
      (await passes())[0]!.completed_at,
      "the closing request stamps it",
    );
  });

  test("a replayed request never un-completes a finished pass", async () => {
    await post({ rows: [alphaRow()], pass_total: 1 });
    const stamped = (await passes())[0]!.completed_at;
    await post({ rows: [alphaRow()], pass_total: 1 });
    assert.equal(
      (await passes())[0]!.received_rows,
      2,
      "the replay is counted",
    );
    assert.equal(
      (await passes())[0]!.completed_at,
      stamped,
      "and the original completion stamp is preserved",
    );
  });

  test("a second pass is tracked separately from the first", async () => {
    await post({ rows: [alphaRow()], pass_total: 1 });
    await post({
      rows: [alphaRow({ captured_at: 1_790_000_000_000 })],
      pass_total: 2,
    });
    assert.equal((await passes()).length, 2, "one row per captured_at");
    assert.equal(
      (await passes())[1]!.completed_at,
      null,
      "the newer one is partial",
    );
  });

  test("omitting pass_total writes no tally at all -- the bare-array envelope", async () => {
    await post([alphaRow()]);
    assert.equal((await rows()).length, 1);
    assert.deepEqual(
      await passes(),
      [],
      "an undeclared pass is not half-tracked",
    );
  });

  test("rejects a pass_total that is absent-shaped, negative, fractional or absurd", async () => {
    for (const bad of [0, -1, 1.5, "3", null, 10_000_001]) {
      const response = await post({ rows: [alphaRow()], pass_total: bad });
      assert.equal(response.status, 400, `expected 400 for ${bad}`);
    }
    assert.equal(
      (await rows()).length,
      0,
      "no partial write from a rejected batch",
    );
  });

  test("rejects a pass_total smaller than the request it arrived with", async () => {
    const response = await post({
      rows: [alphaRow(), alphaRow({ netuid: 8 })],
      pass_total: 1,
    });
    assert.equal(response.status, 400);
  });

  test("rejects a declared pass carrying two captured_at stamps", async () => {
    // The tally is keyed on captured_at, so two stamps in one request would
    // credit rows to whichever the code happened to pick -- and the reader
    // would trust a total never delivered under that key.
    const response = await post({
      rows: [
        alphaRow(),
        alphaRow({ netuid: 8, captured_at: 1_790_000_000_000 }),
      ],
      pass_total: 5,
    });
    assert.equal(response.status, 400);
    assert.equal((await rows()).length, 0);
  });
});

// --- writing only what something reads (#9557) -------------------------------
//
// `TotalHotkeyAlpha` has ~762,577 entries; `nominator_positions` names 17,902
// distinct (hotkey, netuid) pairs, and pricing those positions is the only
// reason this table exists. The other 43x was written every pass, read by
// nothing, and measurably harmful: the bulk volume saturated D1
// (`D1 DB is overloaded. Requests queued for too long.`), which aborted the
// passes AND failed unrelated writers on the same database.
describe("only pools some position references are stored", () => {
  test("an unreferenced pool is accepted and NOT written", async () => {
    const orphan = "5OrphanHotkeyNothingDelegatesTo00000000000000000";
    const response = await post({
      rows: [
        alphaRow({ netuid: 7 }),
        alphaRow({ hotkey: orphan, netuid: 7, total_alpha: 999 }),
      ],
    });
    // ACCEPTED, not rejected: the producer walks the whole keyspace and is
    // right to send it. Declining is the sink's judgement about storage, not a
    // complaint about the payload -- a 4xx here would abort a healthy pass.
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Row).hotkey_alpha_written, 2);

    const stored = await rows();
    assert.deepEqual(
      stored.map((r) => r.hotkey),
      [HOTKEY],
      "the referenced pool landed and the orphan did not",
    );
  });

  test("a pool becomes storable once a position references it", async () => {
    const later = "5LaterHotkeyGainsANominator0000000000000000000000";
    await post({ rows: [alphaRow({ hotkey: later, netuid: 7 })] });
    assert.equal((await rows()).length, 0, "nothing references it yet");

    // Both lanes refresh daily, so a pair that gains a position is picked up on
    // the next pass rather than needing a backfill.
    await reference(later, 7);
    await post({ rows: [alphaRow({ hotkey: later, netuid: 7 })] });
    assert.equal((await rows()).length, 1);
    assert.equal((await rows())[0]!.hotkey, later);
  });

  test("the filter is per (hotkey, netuid), not per hotkey", async () => {
    // A hotkey holds a SEPARATE pool on every subnet it is staked to. Filtering
    // on the hotkey alone would store pools for subnets nothing delegates on --
    // and, worse, the composite key means those rows are not overwrites.
    const partial = "5PartialHotkeyOnOneSubnetOnly000000000000000000";
    await reference(partial, 7);
    await post({
      rows: [
        alphaRow({ hotkey: partial, netuid: 7, total_alpha: 10 }),
        alphaRow({ hotkey: partial, netuid: 42, total_alpha: 20 }),
      ],
    });
    const stored = (await rows()).filter((r) => r.hotkey === partial);
    assert.deepEqual(
      stored.map((r) => r.netuid),
      [7],
    );
  });

  test("the pass tally counts what ARRIVED, not what was stored", async () => {
    // Completeness is a fact about the producer's delivery. If it counted
    // stored rows, every pass would look short by exactly the rows the sink
    // chose not to keep, and the gate would never open.
    const orphan = "5AnotherOrphan000000000000000000000000000000000";
    await post({
      rows: [alphaRow({ netuid: 7 }), alphaRow({ hotkey: orphan, netuid: 7 })],
      pass_total: 2,
    });
    assert.equal((await rows()).length, 1, "one stored");
    assert.equal((await passes())[0]!.received_rows, 2, "two received");
    assert.ok((await passes())[0]!.completed_at, "and the pass is complete");
  });
});

describe("routed to the sync queue (metagraphed-infra#348)", () => {
  function queueEnv(send: (m: unknown) => Promise<void>) {
    return env({
      SYNC_BATCHES: { send },
      SYNC_QUEUE_LANES: "hotkey-alpha",
    });
  }

  test("enqueues instead of writing, and never both", async () => {
    // NO DUAL WRITE. The flag SELECTS a path; writing twice would double the
    // D1 load the queue exists to relieve and double-count the tally.
    const sent: Record<string, unknown>[] = [];
    const response = await post(
      { rows: [alphaRow(), alphaRow({ hotkey: HOTKEY_B })], pass_total: 2 },
      SECRET,
      queueEnv(async (m) => {
        sent.push(m as Record<string, unknown>);
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.pass_total, 2, "the declaration rides along");
    assert.equal(
      (await rows()).length,
      0,
      "the store must not also have been written",
    );
  });

  test("a chunk too large for one message is split, not dropped", async () => {
    // metagraphed-infra#360. The route used to hand `send()` the whole posted
    // chunk; at the producer's CHUNK_SIZE of 25,000 that is ~24x the 128 KB
    // transport cap, so every enqueue threw, the route answered 502, and the
    // producer retried six times and abandoned the pass. A cut-over lane did
    // not degrade -- it stopped.
    const big = Array.from({ length: 4_000 }, (_, i) =>
      alphaRow({ hotkey: `5${String(i).padStart(47, "H")}`, netuid: i % 129 }),
    );
    const sent: Record<string, unknown>[] = [];
    const response = await post(
      { rows: big, pass_total: big.length },
      SECRET,
      queueEnv(async (m) => {
        sent.push(m as Record<string, unknown>);
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(sent.length > 1, true, "one message could not have held it");
    for (const m of sent) {
      assert.equal(
        JSON.stringify(m).length <= QUEUE_MESSAGE_MAX_BYTES,
        true,
        "every message must fit the transport",
      );
    }
    // Every row still arrives exactly once -- fanning out must not lose rows,
    // or the tally would never close and the pass would sit incomplete.
    const delivered = sent.flatMap((m) => m.rows as Row[]);
    assert.equal(delivered.length, big.length);
  });

  test("502s when the enqueue fails, so the producer retries the chunk", async () => {
    // Reporting 200 on a chunk the queue never accepted loses it silently.
    const response = await post(
      { rows: [alphaRow()] },
      SECRET,
      queueEnv(async () => Promise.reject(new Error("over capacity"))),
    );
    assert.equal(response.status, 502);
    assert.equal((await rows()).length, 0);
  });
});
