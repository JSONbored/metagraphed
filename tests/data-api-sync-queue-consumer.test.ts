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
import { beforeEach, describe, test } from "vitest";

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
  );

const COLDKEY = "5CXRfP2ekFhYQ6BCwEy5V8YyxgLmUmTNzHZTKAfTHKhKPBqE";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";

let db: InstanceType<typeof DatabaseSync>;

function d1(failing = false) {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            text,
            values,
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
    async batch(statements: { text: string; values: unknown[] }[]) {
      if (failing) throw new Error("D1 DB is overloaded");
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => ({
          results: db.prepare(s.text).all(...(s.values as never[])),
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
    lane: "nominator-positions",
    captured_at: 1_780_000_000_000,
    key_complete: true,
    rows: [
      {
        coldkey: COLDKEY,
        hotkey: HOTKEY,
        netuid: 18,
        share_fraction: 0.25,
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
    { METAGRAPH_HEALTH_DB: d1(), ...envOverrides } as never,
    { waitUntil: () => {} } as never,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

const rows = () =>
  db.prepare("SELECT * FROM nominator_positions").all() as Record<
    string,
    unknown
  >[];

const balances = () =>
  db.prepare("SELECT * FROM account_balances").all() as Record<
    string,
    unknown
  >[];

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
    const pass = db
      .prepare("SELECT * FROM account_balances_passes")
      .all()[0] as Record<string, unknown>;
    assert.equal(pass.expected_rows, 2);
    assert.equal(pass.received_rows, 1);
    assert.equal(
      pass.completed_at,
      null,
      "one of two rows delivered is not a complete pass",
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
    const m = positionMessage({ key_complete: undefined });
    await consume([m]);
    assert.deepEqual(m.calls, ["ack"]);
    assert.equal(rows().length, 0, "refused, not written");
  });

  test("retries a message whose WRITE failed", async () => {
    // `D1_ERROR: D1 DB is overloaded` is the exact failure the producer's
    // one-second inter-chunk sleep stood in for, and the reason deleting that
    // sleep was safe: the queue's backoff now owns it.
    const m = positionMessage();
    await consume([m], { METAGRAPH_HEALTH_DB: d1(true) });
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

  test("retries rather than dropping when no D1 binding is present", async () => {
    // An unbound database is transient-looking from here, and a lane that is
    // cut over has no other writer -- acking would lose the rows outright.
    const m = positionMessage();
    await consume([m], { METAGRAPH_HEALTH_DB: undefined });
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
    const blocks = db
      .prepare("SELECT block_number FROM chain_detail_blocks")
      .all() as Record<string, unknown>[];
    assert.deepEqual(
      blocks.map((row) => row.block_number),
      [6_100_001],
      "written, not acked into the void",
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

  test("a dead-letter batch is acked and NOT written (metagraphed-infra#363)", async () => {
    // sync-batches-dlq is bound to this same handler, so the branch on
    // batch.queue is the only thing standing between recording the loss and
    // attempting -- for the sixth time -- the write that caused it. A message
    // reaches the DLQ having already failed five times; re-running the writer
    // here would be that same failure with a different label.
    const m = positionMessage();
    await worker.queue!(
      { queue: "sync-batches-dlq", messages: [m] } as never,
      { METAGRAPH_HEALTH_DB: d1() } as never,
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
      { METAGRAPH_HEALTH_DB: d1() } as never,
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
    const blocks = db
      .prepare("SELECT block_number FROM chain_detail_blocks")
      .all() as Record<string, unknown>[];
    assert.deepEqual(
      blocks.map((row) => row.block_number),
      [6_100_000],
    );
    const extrinsics = db
      .prepare("SELECT COUNT(*) AS n FROM chain_detail_extrinsics")
      .all() as Record<string, unknown>[];
    assert.equal(
      extrinsics[0]!.n,
      1,
      "both families landed, which is why they travel together",
    );
  });
});
