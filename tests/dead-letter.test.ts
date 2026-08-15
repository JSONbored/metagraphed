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
  DEAD_LETTER_MAX_NAMED_SUBJECTS,
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
    async query() {
      return [];
    },
    async run(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      return { changes: 1 };
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

// ---- naming the subject (#10777) ----
//
// The summariser read `lane ?? subscription_id`, which covers sync-batches and
// webhook-deliveries and nothing else. #10715/#10739 then added three queues
// whose bodies carry none of them, and all three reported `(unidentified)` --
// a dead-letter verdict that says something was lost and cannot say what.
// Measured in production 2026-08-11: "2 dead-lettered message(s) on
// revenue-probes-dlq (unidentified)", with the two surface_ids sitting unread.
describe("the summary names the subject on every live queue", () => {
  const CASES: [string, string, Record<string, unknown>, string][] = [
    ["sync-batches-dlq", "lane", { lane: "neurons" }, "neurons"],
    [
      "webhook-deliveries-dlq",
      "subscription_id",
      { subscription_id: "sub_a" },
      "sub_a",
    ],
    // ONE DLQ, FOUR PAYLOAD SHAPES (#10894). The probe lanes share a queue, so
    // the same dead letter carries netuids, origins and surface_ids depending
    // on which lane lost the message -- and `summarizeDeadLetterBatch` has to
    // name all of them. Four cases against one queue is stricter than the three
    // separate queues were: each of those only ever had to name its own shape.
    [
      "probe-jobs-dlq",
      "netuid",
      { job_type: "attribution-sweep", netuid: 64 },
      "netuid=64",
    ],
    [
      "probe-jobs-dlq",
      "origin",
      { job_type: "origin-reachability", origin: "https://example.com" },
      "https://example.com",
    ],
    [
      "probe-jobs-dlq",
      "surface_id",
      { job_type: "revenue-probe", surface_id: "sn-64-api" },
      "sn-64-api",
    ],
    [
      "probe-jobs-dlq",
      "netuid (compute)",
      { job_type: "compute-declaration", netuid: 3 },
      "netuid=3",
    ],
  ];

  for (const [queue, key, body, expected] of CASES) {
    test(`${queue} is named by its ${key}`, () => {
      const line = summarizeDeadLetterBatch(queue, [{ body }]);
      assert.match(
        line,
        new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.ok(
        !line.includes("unidentified"),
        `${queue} still reports unidentified, which is the bug`,
      );
    });
  }

  test("EVERY declared dead-letter queue has a case above", () => {
    // The gate. A queue added to DEAD_LETTER_LANES without a subject key would
    // otherwise report `unidentified` in production and pass every test here.
    const covered = new Set(CASES.map(([q]) => q));
    const declared = Object.keys(DEAD_LETTER_LANES);
    assert.deepEqual(
      declared.filter((q) => !covered.has(q)),
      [],
      "a dead-letter queue with no case here is one nobody has checked can " +
        "name its own subject",
    );
  });

  test("netuid 0 is a subject, not a missing one", () => {
    // Root. A falsy-number check would have dropped it, and netuid 0 is the
    // one subnet where a silent drop is least acceptable.
    const line = summarizeDeadLetterBatch("attribution-sweeps-dlq", [
      { body: { netuid: 0 } },
    ]);
    assert.match(line, /netuid=0/);
  });

  test("a non-finite number is not a subject", () => {
    const line = summarizeDeadLetterBatch("attribution-sweeps-dlq", [
      { body: { netuid: Number.NaN } },
    ]);
    assert.match(line, /unidentified/);
  });

  test("a body naming none of the keys is honestly unidentified", () => {
    const line = summarizeDeadLetterBatch("revenue-probes-dlq", [
      { body: { something_else: "x" } },
    ]);
    assert.match(line, /\(unidentified\)/);
  });

  test("the first matching key wins, in declared order", () => {
    const line = summarizeDeadLetterBatch("sync-batches-dlq", [
      { body: { lane: "neurons", surface_id: "sn-1" } },
    ]);
    assert.match(line, /\(neurons\)/);
  });

  test("distinct subjects are capped, and the remainder is counted", () => {
    // The string lands in a log line and lane_health.detail; a batch is up to
    // 100 messages. Naming a hundred netuids there is the dump this function
    // exists to avoid.
    const messages = Array.from({ length: 40 }, (_, i) => ({
      body: { surface_id: `sn-${String(i).padStart(3, "0")}` },
    }));
    const line = summarizeDeadLetterBatch("revenue-probes-dlq", messages);
    assert.match(line, /\+28 more/);
    assert.match(line, /^40 dead-lettered message\(s\)/);
    assert.ok(line.length < 400, "the detail column must stay readable");
  });

  test("exactly the cap names everything, with no remainder clause", () => {
    const messages = Array.from(
      { length: DEAD_LETTER_MAX_NAMED_SUBJECTS },
      (_, i) => ({ body: { surface_id: `sn-${i}` } }),
    );
    const line = summarizeDeadLetterBatch("revenue-probes-dlq", messages);
    assert.ok(!line.includes("more"), "no remainder when nothing remains");
  });

  test("repeated subjects collapse rather than counting toward the cap", () => {
    const messages = Array.from({ length: 30 }, () => ({
      body: { surface_id: "sn-64-api" },
    }));
    const line = summarizeDeadLetterBatch("revenue-probes-dlq", messages);
    assert.equal(
      line,
      "30 dead-lettered message(s) on revenue-probes-dlq (sn-64-api)",
    );
  });
});
