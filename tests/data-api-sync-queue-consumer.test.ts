// The sync queue's consumer (metagraphed-infra#347/#348/#355).
//
// This handler WRITES, which is why it is worth a test of its own: everything
// above it -- the validator, the classifier, the dispatch -- is pure and tested
// in sync-batch-queue.test.ts, but the ack/retry decision is only observable
// here, and getting it backwards is expensive in both directions. Retrying an
// unparseable message burns five attempts and dead-letters anyway; acking a
// failed WRITE loses rows nothing else is producing, because a cut-over lane
// has no second path.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";

import { pgMockEnv } from "./helpers/pg-mock.ts";

// The store is Postgres now (#10170). The consumer reaches it through
// `new Client(...)` several layers down, so the module is the only injectable
// seam -- see tests/helpers/pg-mock.ts.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

const { default: worker } = await import("../workers/data-api.ts");

const SCHEMA =
  fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0011_nominator_positions.sql"),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0017_account_balances.sql"),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0020_account_balances_passes.sql"),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0010_chain_detail.sql"),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(
      process.cwd(),
      "migrations/d1/0012_validator_nominator_counts.sql",
    ),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(
      process.cwd(),
      "migrations/d1/0029_nominator_positions_passes.sql",
    ),
    "utf8",
  ) +
  // The vehicle lane (#10131). These tests are about the CONSUMER -- ack vs
  // retry, per-message disposal, decompression -- not about any lane's SQL, so
  // any lane with a real writer will do.
  //
  // The schema is still read from migrations/d1: node:sqlite is the engine
  // behind the pg double, and these DDL files are the closest executable
  // description of the tables. What is under test here is the consumer's
  // disposal decision, not the dialect.
  fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0019_hotkey_alpha.sql"),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0021_hotkey_alpha_passes.sql"),
    "utf8",
  );

const COLDKEY = "5CXRfP2ekFhYQ6BCwEy5V8YyxgLmUmTNzHZTKAfTHKhKPBqE";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";

let db: InstanceType<typeof DatabaseSync>;

/** Make the next statement fail, so the retry path is reachable. */
function failNextWrite() {
  pg.control.failNext = new Error("connection terminated");
}

function message(body: unknown) {
  const calls: string[] = [];
  return {
    body,
    calls,
    ack: () => calls.push("ack"),
    retry: () => calls.push("retry"),
  };
}

function positionMessage(overrides: Record<string, unknown> = {}) {
  return message({
    lane: "hotkey-alpha",
    captured_at: 1_780_000_000_000,
    key_complete: true,
    rows: [
      {
        hotkey: HOTKEY,
        netuid: 18,
        total_alpha: 12.5,
        captured_at: 1_780_000_000_000,
      },
    ],
    ...overrides,
  });
}

async function consume(
  messages: ReturnType<typeof message>[],
  envOverrides: Record<string, unknown> = {},
) {
  await worker.queue!(
    { messages } as never,
    { ...pgMockEnv(), ...envOverrides } as never,
    { waitUntil: () => {} } as never,
  );
}

beforeEach(() => {
  // The double is module state and outlives a test; a leftover queue log or a
  // primed failure would leak into the next one.
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // THE #9558 FILTER needs a referencing position, or hotkey_alpha stores
  // nothing: D1 keeps only pools a nominator_positions row actually names, so
  // an unseeded fixture makes every "the row was written" assertion fail for a
  // reason that has nothing to do with the consumer.
  db.prepare(
    "INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)" +
      " VALUES (?, ?, ?, ?, ?)",
  ).run(COLDKEY, HOTKEY, 18, 0.25, 1_780_000_000_000);
});

// WHAT COUNTS AS "THE ROWS LANDED", now that the store is Postgres.
//
// These used to read the fixture table back. They cannot any more, and not for
// a reason worth working around: the Neon writers emit `(VALUES ...) AS src
// (cols)` and `::type` casts, and node:sqlite parses NEITHER -- verified, both
// are hard syntax errors on SQLite 3.53. Translating those shapes in the double
// would mean testing the translator.
//
// So the evidence moves from the table to the STATEMENT LOG. That is the right
// level for this file anyway: what is under test here is the consumer's
// ack/retry disposal, never a lane's SQL, and "an INSERT for this table was
// issued with these rows bound" is exactly the claim each of these assertions
// was making. Lane SQL is asserted where it belongs, in the per-writer suites.
function inserts(table: string) {
  return pg.control.queries.filter((q) =>
    new RegExp(`INSERT INTO ${table}\\b`).test(q.text),
  );
}

const rows = () => inserts("hotkey_alpha");
const balances = () => inserts("account_balances");

describe("the sync queue consumer", () => {
  test("writes account-balances and credits its declared pass", async () => {
    // The lane whose truncation started all of this. The tally has to survive
    // the transport: a queue knows a message arrived, not whether the whole
    // scan did, and only the second fact catches a short pass.
    const m = message({
      lane: "account-balances",
      captured_at: 1_780_000_000_000,
      pass_total: 2,
      rows: [
        {
          ss58: COLDKEY,
          free_tao: 1000.5,
          reserved_tao: 25.25,
          captured_at: 1_780_000_000_000,
        },
      ],
    });
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
    assert.equal(balances().length, 1);
    const tally = inserts("account_balances_passes");
    assert.equal(tally.length, 1, "no tally statement was issued");
    assert.ok(
      tally[0]!.values.includes(2),
      `the declared total did not reach the tally: ${JSON.stringify(tally[0]!.values)}`,
    );
  });

  test("writes a valid message and acks it", async () => {
    const m = positionMessage();
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
    assert.equal(rows().length, 1);
  });

  test("acks an unparseable message rather than retrying it", async () => {
    // It will not parse on the fifth attempt either. Acking keeps the DLQ
    // holding things that might yet succeed rather than things that never could.
    const m = message({ lane: "not-a-lane", captured_at: 1, rows: [{}] });
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
  });

  test("acks a pruning message that failed to assert completeness", async () => {
    // THE DATA-LOSS GUARD, end to end. Without `key_complete` the write
    // would prune a coldkey against a chunk that may not carry all its rows.
    // The consumer refuses instead, and nothing is written.
    // Asserted on the lane that PRUNES. nominator-positions is Neon's now, so
    // "nothing was written" can no longer be read out of this sqlite fixture --
    // the disposition is the assertion: refused messages are ACKED, never
    // retried, because a message that cannot assert completeness never will.
    const m = message({
      lane: "nominator-positions",
      captured_at: 1_780_000_000_000,
      rows: [
        {
          coldkey: COLDKEY,
          hotkey: HOTKEY,
          netuid: 18,
          share_fraction: 0.25,
          captured_at: 1_780_000_000_000,
        },
      ],
    });
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
    // And the D1 lane's table is untouched, so the refusal did not leak into
    // the fixture by another route.
    assert.equal(rows().length, 0);
  });

  test("retries a message whose WRITE failed", async () => {
    // `D1_ERROR: D1 DB is overloaded` is the exact failure the producer's
    // one-second inter-chunk sleep stood in for, and the reason deleting that
    // sleep was safe: the queue's backoff now owns it.
    const m = positionMessage();
    failNextWrite();
    await consume([m]);
    assert.deepEqual(m.calls, ["retry"]);
  });

  test("disposes of each message on its own merits", async () => {
    // Per message, not per batch: one bad chunk must not drag its nine
    // neighbours through the retry budget with it.
    const good = positionMessage();
    const bad = message(null);
    await consume([good, bad]);
    assert.deepEqual(good.calls, ["ack"]);
    assert.deepEqual(bad.calls, ["ack"]);
    assert.equal(rows().length, 1);
  });

  test("retries rather than dropping when no store is bound", async () => {
    // An unbound store is transient-looking from here, and a cut-over lane has
    // no other writer -- acking would lose the rows outright.
    //
    // THIS IS THE ASSERTION THE TEARDOWN NEARLY BROKE (#10170). Both writer
    // maps in the consumer used to be built as `env.METAGRAPH_HEALTH_DB ? {...}
    // : {}`, so an absent binding did not mean "no writer available" -- it
    // meant an EMPTY writer map, and an empty map acks every message for every
    // lane and drops the rows. The Neon writers never needed that binding.
    const m = positionMessage();
    await consume([m], { HYPERDRIVE: undefined });
    assert.deepEqual(m.calls, ["retry"]);
  });

  test("an empty batch is not an error", async () => {
    await consume([]);
    assert.equal(rows().length, 0);
  });

  test("decompresses a compressed message before anything reads it", async () => {
    // THE SILENT-LOSS PATH THIS CLOSES (metagraphed#9759). A compressed message
    // arrives as BYTES, and validSyncBatchMessage calls bytes unparseable --
    // which this consumer ACKS, on the reasoning that something which cannot
    // parse now will not parse on the fifth attempt. For a compressed body that
    // reasoning is wrong and the message is simply gone, so decompression has
    // to happen above the validator, not inside the loop.
    const { compressSyncBatchMessage } =
      await import("../src/sync-batch-compress.ts");
    const { SYNC_BATCH_MAX_BYTES } = await import("../src/sync-batch-queue.ts");
    const packed = await compressSyncBatchMessage(
      {
        lane: "chain-detail",
        captured_at: 1_780_000_000_000,
        families: {
          blockRows: [
            {
              block_number: 6_100_001,
              block_hash: `0x${"ef".repeat(32)}`,
              spec_version: 441,
              extrinsic_count: 0,
              chain_event_count: 0,
              account_event_count: 0,
              observed_at: 1_780_000_000_000,
              synced_at: 1_780_000_000_000,
            },
          ],
        },
      },
      SYNC_BATCH_MAX_BYTES,
    );
    const m = message(packed.buffer);
    const neighbour = positionMessage();

    await consume([m, neighbour]);

    assert.deepEqual(m.calls, ["ack"]);
    assert.deepEqual(neighbour.calls, ["ack"], "and its batch-mate is fine");
    const blocks = inserts("chain_detail_blocks");
    assert.equal(blocks.length, 1, "written, not acked into the void");
    assert.ok(
      blocks[0]!.values.includes(6_100_001),
      `the decompressed block did not reach the write: ${JSON.stringify(blocks[0]!.values)}`,
    );
  });

  test("a compressed body that will not inflate is acked, not retried", async () => {
    // Same rule the unparseable JSON path follows: truncated or corrupted bytes
    // will not inflate on the fifth attempt either, so retrying only burns the
    // budget and dead-letters anyway.
    const m = message(new Uint8Array([0x1f, 0x8b, 0x00, 0x01]).buffer);
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
  });

  test("carries a declared pass through the queue to a tally write (metagraphed#9783)", async () => {
    // The declaration has to survive the queue: a queue knows a message
    // arrived, not whether the whole scan did.
    //
    // What this proves is that the QUEUE carries `pass_total` through to a
    // tally write -- not what the tally statement itself computes, which is
    // tests/pass-tally-neon's job. So the evidence is the statement and its
    // bound values, for the reason `inserts` explains.
    const m = positionMessage({ pass_total: 2 });
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
    const tally = inserts("hotkey_alpha_passes");
    assert.equal(tally.length, 1, "no tally statement was issued");
    assert.ok(
      tally[0]!.values.includes(2),
      `the declared total did not survive the queue: ${JSON.stringify(tally[0]!.values)}`,
    );
  });

  test("a dead-letter batch is acked and NOT written (metagraphed-infra#363)", async () => {
    // sync-batches-dlq is bound to this same handler, so the branch on
    // batch.queue is the only thing standing between recording the loss and
    // attempting -- for the sixth time -- the write that caused it. A message
    // reaches the DLQ having already failed five times; re-running the writer
    // here would be that same failure with a different label.
    const m = positionMessage();
    await worker.queue!(
      { queue: "sync-batches-dlq", messages: [m] } as never,
      { ...pgMockEnv() } as never,
      { waitUntil: () => {} } as never,
    );
    assert.deepEqual(m.calls, ["ack"]);
    assert.equal(rows().length, 0, "recorded, not re-written");
  });

  test("a live batch is still written, so the branch cannot swallow one", async () => {
    // The mirror of the test above, and the more dangerous direction: a branch
    // that matched the LIVE queue name would ack every real message without
    // writing it, silently discarding the lane.
    const m = positionMessage();
    await worker.queue!(
      { queue: "sync-batches", messages: [m] } as never,
      { ...pgMockEnv() } as never,
      { waitUntil: () => {} } as never,
    );
    assert.deepEqual(m.calls, ["ack"]);
    assert.equal(rows().length, 1);
  });

  test("writes a multi-family message, and does not fail its batch-mates", async () => {
    // THE REGRESSION (metagraphed-infra#359). The handler's opening log line
    // summed `m.rows.length` over every valid message. A chain-detail message
    // carries `families` and no `rows` at all, so that read threw a TypeError
    // ABOVE the per-message try/catch -- taking the whole batch, every lane
    // co-batched with it, five retries, into the dead-letter queue. Nothing
    // caught it because `rows` was declared required on a shape that omits it.
    //
    // So this drives the families message through the REAL handler alongside a
    // single-family neighbour, and asserts the neighbour survives.
    const neighbour = positionMessage();
    const chainDetail = message({
      lane: "chain-detail",
      captured_at: 1_780_000_000_000,
      families: {
        blockRows: [
          {
            block_number: 6_100_000,
            block_hash: `0x${"ab".repeat(32)}`,
            spec_version: 441,
            extrinsic_count: 1,
            chain_event_count: 0,
            account_event_count: 0,
            observed_at: 1_780_000_000_000,
            synced_at: 1_780_000_000_000,
          },
        ],
        extrinsicRows: [
          {
            block_number: 6_100_000,
            extrinsic_index: 0,
            extrinsic_hash: `0x${"cd".repeat(32)}`,
            signer: COLDKEY,
            call_module: "SubtensorModule",
            call_function: "set_weights",
            success: 1,
            fee_tao: 0,
            observed_at: 1_780_000_000_000,
            synced_at: 1_780_000_000_000,
          },
        ],
      },
    });

    await consume([chainDetail, neighbour]);

    assert.deepEqual(chainDetail.calls, ["ack"]);
    assert.deepEqual(neighbour.calls, ["ack"], "the batch-mate still landed");
    assert.equal(rows().length, 1, "and its rows were written");
    const blocks = inserts("chain_detail_blocks");
    assert.equal(blocks.length, 1);
    assert.ok(
      blocks[0]!.values.includes(6_100_000),
      `the block did not reach the write: ${JSON.stringify(blocks[0]!.values)}`,
    );
    assert.equal(
      inserts("chain_detail_extrinsics").length,
      1,
      "both families landed, which is why they travel together",
    );
  });
});
