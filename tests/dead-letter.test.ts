// Reading the dead-letter queues (metagraphed-infra#354/#363).
//
// The property worth testing here is not the summary string. It is that a
// dead-lettered message is ACKED AND NEVER RE-PROCESSED — both DLQs are bound
// to the same `queue()` export as their live queue, so the branch that tells
// them apart is the only thing standing between "record the loss" and "attempt
// the failing write a sixth time".
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEAD_LETTER_LANES,
  handleDeadLetterBatch,
  isDeadLetterQueue,
  summarizeDeadLetterBatch,
} from "../src/dead-letter.ts";

function message(body: unknown) {
  const calls: string[] = [];
  return { body, calls, ack: () => calls.push("ack") };
}

/** A LaneHealthDb that records what was bound, so the verdict is inspectable.
 * `inserts` filters out recordLaneVerdict's own retention DELETE, which runs on
 * the same connection and is not what these tests are about. */
function db() {
  const statements: { sql: string; values: unknown[] }[] = [];
  return {
    statements,
    get inserts() {
      return statements
        .filter((s) => s.sql.startsWith("INSERT INTO lane_health"))
        .map((s) => s.values);
    },
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              statements.push({ sql, values });
              return {};
            },
          };
        },
      };
    },
  };
}

describe("isDeadLetterQueue", () => {
  test("recognises both dead-letter queues and nothing else", () => {
    assert.equal(isDeadLetterQueue("sync-batches-dlq"), true);
    assert.equal(isDeadLetterQueue("webhook-deliveries-dlq"), true);
    // THE FAILURE THAT MATTERS. A live queue name matching here would route a
    // real batch to the reader, which acks without writing -- silently
    // discarding every row on the queue.
    assert.equal(isDeadLetterQueue("sync-batches"), false);
    assert.equal(isDeadLetterQueue("webhook-deliveries"), false);
  });

  test("is safe on the shapes a runtime could hand it", () => {
    for (const bad of [undefined, null, 7, {}, [], ""]) {
      assert.equal(isDeadLetterQueue(bad), false, String(bad));
    }
  });

  test("every declared lane is recognised, so the two lists cannot drift", () => {
    for (const queue of Object.keys(DEAD_LETTER_LANES)) {
      assert.equal(isDeadLetterQueue(queue), true, queue);
    }
  });
});

describe("summarizeDeadLetterBatch", () => {
  test("names the lanes a sync-batches dead letter came from", () => {
    assert.equal(
      summarizeDeadLetterBatch("sync-batches-dlq", [
        message({ lane: "account-balances", rows: [] }),
        message({ lane: "hotkey-alpha", rows: [] }),
        message({ lane: "account-balances", rows: [] }),
      ]),
      "3 dead-lettered message(s) on sync-batches-dlq (account-balances,hotkey-alpha)",
    );
  });

  test("names the subscriptions a webhook dead letter came from", () => {
    // One reader for both queues, so it reads whichever identity the message
    // has rather than two near-identical modules that drift apart.
    assert.equal(
      summarizeDeadLetterBatch("webhook-deliveries-dlq", [
        message({ subscription_id: "sub_a", event_id: "evt", body: "{}" }),
      ]),
      "1 dead-lettered message(s) on webhook-deliveries-dlq (sub_a)",
    );
  });

  test("does not dump the payload", () => {
    // A sync message can carry 5,000 rows and a webhook message a whole event
    // body. Neither belongs in a log line or a lane_health.detail column.
    const detail = summarizeDeadLetterBatch("sync-batches-dlq", [
      message({
        lane: "account-balances",
        rows: Array.from({ length: 5000 }, (_, i) => ({ ss58: `5${i}` })),
      }),
    ]);
    assert.equal(detail.includes("ss58"), false);
    assert.equal(detail.length < 120, true, detail);
  });

  test("reports an unreadable message rather than throwing on it", () => {
    // A message reaching a DLQ is one whose processing already failed; assuming
    // it parses is exactly the assumption that put it here.
    assert.equal(
      summarizeDeadLetterBatch("sync-batches-dlq", [
        message(null),
        message("not an object"),
        message({ no: "identity" }),
      ]),
      "3 dead-lettered message(s) on sync-batches-dlq (unidentified,unparseable)",
    );
  });
});

describe("handleDeadLetterBatch", () => {
  const batch = (queue: string, messages: ReturnType<typeof message>[]) => ({
    queue,
    messages,
  });

  test("acks every message and records one stale verdict for the batch", async () => {
    const store = db();
    const a = message({ lane: "account-balances", rows: [] });
    const b = message({ lane: "hotkey-alpha", rows: [] });

    await handleDeadLetterBatch(
      batch("sync-batches-dlq", [a, b]),
      store,
      1_780_000_000_000,
    );

    assert.deepEqual(a.calls, ["ack"]);
    assert.deepEqual(b.calls, ["ack"]);
    assert.equal(
      store.inserts.length,
      1,
      "one verdict per batch, not per message",
    );
    const [lane, verdict, ageMs, detail, checkedAt] = store.inserts[0]!;
    assert.equal(lane, "sync-batches-dlq");
    assert.equal(verdict, "stale");
    // NOT a number. Nothing here is behind; something here is gone, and any
    // value would be read as lag by every consumer of this table.
    assert.equal(ageMs, null);
    assert.equal(
      detail,
      "2 dead-lettered message(s) on sync-batches-dlq (account-balances,hotkey-alpha)",
    );
    assert.equal(checkedAt, 1_780_000_000_000);
  });

  test("acks even when the record cannot be written", async () => {
    // The message is already lost. Refusing to ack would cycle it through this
    // handler's own budget and change nothing -- reporting must never be able
    // to make the loss worse.
    const m = message({ lane: "account-balances", rows: [] });
    await handleDeadLetterBatch(batch("sync-batches-dlq", [m]), {
      prepare() {
        throw new Error("D1 DB is overloaded");
      },
    } as never);
    assert.deepEqual(m.calls, ["ack"]);
  });

  test("acks with no database bound at all", async () => {
    const m = message({ subscription_id: "sub_a" });
    await handleDeadLetterBatch(
      batch("webhook-deliveries-dlq", [m]),
      undefined,
    );
    assert.deepEqual(m.calls, ["ack"]);
  });

  test("records under the queue's own lane, so the two DLQs alarm separately", async () => {
    const store = db();
    await handleDeadLetterBatch(
      batch("webhook-deliveries-dlq", [message({ subscription_id: "sub_a" })]),
      store,
      1,
    );
    assert.equal(store.inserts[0]![0], "webhook-deliveries-dlq");
  });

  test("an empty dead-letter batch writes a verdict rather than nothing", async () => {
    // Queues can deliver an empty batch on a timeout boundary. Recording it is
    // harmless and keeps the lane's cadence honest for lane-alarm, which
    // measures silence against a lane's OWN observed interval.
    const store = db();
    const detail = await handleDeadLetterBatch(
      batch("sync-batches-dlq", []),
      store,
      1,
    );
    assert.equal(detail, "0 dead-lettered message(s) on sync-batches-dlq ()");
    assert.equal(store.inserts.length, 1);
  });
});
