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
});
