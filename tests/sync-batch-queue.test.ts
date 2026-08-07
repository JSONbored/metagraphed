// The bulk sync path's queue contract (metagraphed-infra#347).
//
// The rule worth testing here is the DISPOSITION one: retry the transient,
// reject the impossible. A DLQ is only useful if it holds messages that might
// yet succeed; filling it with messages that could never parse turns it into a
// second log nobody reads.
//
// The validator is also the last line before a WRITE, which is why its lane
// field is an allowlist -- unlike the health sink's, which is deliberately
// permissive so a brand-new lane can report on its first run. An unrecognised
// lane here means an unrecognised table, and guessing is worse than
// dead-lettering.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifySyncBatch,
  enqueueSyncBatch,
  packMultiFamilyMessage,
  packSyncBatchMessages,
  syncBatchRowCount,
  syncBatchRows,
  QUEUE_MESSAGE_MAX_BYTES,
  SYNC_BATCH_LANES,
  SYNC_BATCH_MAX_BYTES,
  SYNC_BATCH_MAX_ROWS,
  passTallyFor,
  PRUNING_LANE_KEYS,
  PRUNING_LANES,
  syncLaneUsesQueue,
  validSyncBatchMessage,
  writeSyncBatch,
} from "../src/sync-batch-queue.ts";

const OK = {
  lane: "hotkey-alpha",
  captured_at: 1_785_970_245_474,
  pass_total: 46_998,
  rows: [{ hotkey: "5A", netuid: 7, total_alpha: 1.5, captured_at: 1 }],
};

describe("validSyncBatchMessage", () => {
  test("accepts a well-formed chunk, with or without a declared pass", () => {
    assert.equal(validSyncBatchMessage(OK), true);
    const { pass_total: _drop, ...noDeclaration } = OK;
    assert.equal(validSyncBatchMessage(noDeclaration), true);
  });

  test("rejects a lane it would not know where to write", () => {
    // An allowlist on purpose: this validator guards a WRITE. An unrecognised
    // lane means an unrecognised table, and a guess is worse than a DLQ entry.
    assert.equal(validSyncBatchMessage({ ...OK, lane: "brand-new" }), false);
    for (const lane of SYNC_BATCH_LANES) {
      // A pruning lane additionally has to assert key-completeness; see below.
      const extra = PRUNING_LANES.includes(lane) ? { key_complete: true } : {};
      assert.equal(
        validSyncBatchMessage({ ...OK, ...extra, lane }),
        true,
        lane,
      );
    }
  });

  test("rejects a pass_total smaller than the chunk it arrived with", () => {
    // Same check the HTTP sink makes. A declaration under the delivered count
    // is incoherent, and trusting it would mark a pass complete early.
    assert.equal(
      validSyncBatchMessage({ ...OK, pass_total: 0, rows: OK.rows }),
      false,
    );
    assert.equal(
      validSyncBatchMessage({
        ...OK,
        pass_total: 1,
        rows: [OK.rows[0]!, OK.rows[0]!],
      }),
      false,
    );
  });

  test("rejects empty and oversized batches", () => {
    assert.equal(validSyncBatchMessage({ ...OK, rows: [] }), false);
    assert.equal(
      validSyncBatchMessage({
        ...OK,
        pass_total: SYNC_BATCH_MAX_ROWS + 1,
        rows: Array.from({ length: SYNC_BATCH_MAX_ROWS + 1 }, () => ({})),
      }),
      false,
    );
  });

  test("rejects a captured_at that could not key a pass", () => {
    // The completeness contract keys on this stamp. A zero or fractional value
    // would create a pass nothing can ever close.
    for (const bad of [0, -1, 1.5, "now", null, undefined]) {
      assert.equal(
        validSyncBatchMessage({ ...OK, captured_at: bad }),
        false,
        String(bad),
      );
    }
  });

  test("rejects shapes that are not messages at all", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "msg",
      [],
      { lane: "hotkey-alpha" },
    ]) {
      assert.equal(validSyncBatchMessage(bad), false, JSON.stringify(bad));
    }
  });

  test("rejects rows that are not objects", () => {
    assert.equal(validSyncBatchMessage({ ...OK, rows: [1, 2] }), false);
    assert.equal(validSyncBatchMessage({ ...OK, rows: [null] }), false);
  });
});

describe("classifySyncBatch", () => {
  test("splits a mixed batch without losing a message", () => {
    const { valid, invalid } = classifySyncBatch([
      { body: OK },
      { body: { ...OK, lane: "nonsense" } },
      { body: OK },
      { body: null },
    ]);
    assert.equal(valid.length, 2);
    assert.equal(invalid, 2);
    assert.equal(valid.length + invalid, 4, "every message is accounted for");
  });

  test("an all-valid batch reports no rejects", () => {
    const { valid, invalid } = classifySyncBatch([{ body: OK }, { body: OK }]);
    assert.equal(valid.length, 2);
    assert.equal(invalid, 0);
  });

  test("an empty batch is not an error", () => {
    // Queues can deliver an empty batch on a timeout boundary; treating that as
    // a failure would retry nothing, forever.
    assert.deepEqual(classifySyncBatch([]), { valid: [], invalid: 0 });
  });

  test("accepts a readonly batch, as the runtime delivers it", () => {
    // MessageBatch.messages is readonly; a signature requiring a mutable array
    // forces a cast at the call site, which is where a real type error would
    // then hide.
    const frozen = Object.freeze([Object.freeze({ body: OK })]);
    assert.equal(classifySyncBatch(frozen).valid.length, 1);
  });
});

describe("syncLaneUsesQueue", () => {
  const bound = { SYNC_BATCHES: {} };

  test("off without the binding, whatever the flag says", () => {
    // A lane cannot be routed to a queue that is not bound, and reading the
    // flag alone would send it nowhere.
    assert.equal(
      syncLaneUsesQueue({ SYNC_QUEUE_LANES: "hotkey-alpha" }, "hotkey-alpha"),
      false,
    );
  });

  test("off when the flag is absent, so an un-opted deployment is unchanged", () => {
    assert.equal(syncLaneUsesQueue(bound, "hotkey-alpha"), false);
  });

  test("selects per lane, so a cutover is one lane at a time", () => {
    const env = { ...bound, SYNC_QUEUE_LANES: "hotkey-alpha" };
    assert.equal(syncLaneUsesQueue(env, "hotkey-alpha"), true);
    assert.equal(syncLaneUsesQueue(env, "account-balances"), false);
  });

  test("tolerates spacing in the list", () => {
    const env = { ...bound, SYNC_QUEUE_LANES: " hotkey-alpha , neurons " };
    assert.equal(syncLaneUsesQueue(env, "hotkey-alpha"), true);
    assert.equal(syncLaneUsesQueue(env, "neurons"), true);
  });
});

describe("passTallyFor", () => {
  test("is null when the producer declared nothing", () => {
    // Inventing a total would mark an unproven load complete -- the exact lie
    // the completeness gate exists to prevent.
    const { pass_total: _d, ...noDecl } = OK;
    assert.equal(passTallyFor(noDecl as never, 1), null);
  });

  test("counts THIS chunk's rows against the whole pass", () => {
    const tally = passTallyFor(OK as never, 12345)!;
    assert.equal(tally.expectedRows, 46_998);
    assert.equal(tally.receivedRows, OK.rows.length);
    assert.equal(tally.capturedAt, OK.captured_at);
    assert.equal(tally.nowMs, 12345);
  });
});

describe("writeSyncBatch", () => {
  test("routes a message to its lane's writer", async () => {
    const seen: { rows: number; expected?: number }[] = [];
    await writeSyncBatch(
      OK as never,
      {
        "hotkey-alpha": async (rows, pass) => {
          seen.push({ rows: rows.length, expected: pass?.expectedRows });
        },
      },
      1,
    );
    assert.deepEqual(seen, [{ rows: 1, expected: 46_998 }]);
  });

  test("throws when a lane has no writer, rather than skipping it", async () => {
    // A silently skipped lane is a pass that never completes -- rows vanish and
    // received_rows never reaches expected_rows, so the gate stays shut forever
    // with nothing explaining why.
    await assert.rejects(
      () => writeSyncBatch(OK as never, {}, 1),
      /no writer for lane hotkey-alpha/,
    );
  });

  test("tally arrival order does not change the outcome", async () => {
    // The queue permits reordering and concurrency guarantees it. received_rows
    // accumulates and completed_at is stamped by whichever write closes the
    // gap, so the accounting is commutative -- which is what made it safe to
    // move off an ordered HTTP sequence at all.
    const totals: number[] = [];
    const writers = {
      "hotkey-alpha": async (rows: Record<string, unknown>[]) => {
        totals.push(rows.length);
      },
    };
    const a = { ...OK, rows: [OK.rows[0]!] };
    const b = { ...OK, rows: [OK.rows[0]!, OK.rows[0]!] };
    await writeSyncBatch(b as never, writers, 1);
    await writeSyncBatch(a as never, writers, 1);
    assert.equal(
      totals.reduce((x, y) => x + y, 0),
      3,
      "the sum is order-independent",
    );
  });
});

describe("pruning lanes must declare key-completeness", () => {
  const positions = {
    lane: "nominator-positions",
    captured_at: 1_785_990_000_000,
    rows: [{ coldkey: "5C", hotkey: "5H", netuid: 7, captured_at: 1 }],
  };

  test("rejects a pruning lane's chunk that does not claim completeness", () => {
    // THE DATA-LOSS CASE. nominator_positions' write DELETES a coldkey's rows
    // older than the max captured_at it just saw for that coldkey. Computed
    // from a partial chunk, that deletes rows the chunk did not carry -- and no
    // retry undoes a delete. Refusing beats pruning on trust.
    assert.equal(validSyncBatchMessage(positions), false);
    assert.equal(
      validSyncBatchMessage({ ...positions, key_complete: false }),
      false,
    );
  });

  test("accepts it once the producer asserts completeness", () => {
    assert.equal(
      validSyncBatchMessage({ ...positions, key_complete: true }),
      true,
    );
  });

  test("non-pruning lanes are unaffected", () => {
    // Only a pruning write can delete what a chunk did not carry, so requiring
    // the flag everywhere would be ceremony that teaches people to set it
    // reflexively -- which is how a real guarantee becomes a habit.
    assert.equal(validSyncBatchMessage(OK), true);
    assert.equal(PRUNING_LANES.includes("hotkey-alpha"), false);
    assert.equal(PRUNING_LANES.includes("nominator-positions"), true);
  });
});

// --- The transport's size cap (metagraphed-infra#360) ------------------------
//
// The bug this section exists for did not look like a bug. `send()` was handed
// the whole posted chunk, the producers chunk at 25,000 rows, and a Queues
// message is capped at 128 KB -- so every enqueue threw, the route returned 502,
// and the producer read that as a transient network fault and retried into it.
// A cut-over lane did not degrade. It stopped, wearing the costume of a flaky
// one, and both lanes sat at zero completed passes until someone compared a
// deploy timestamp against a pass table.
//
// So the tests that matter here are the ones that would have caught it: pack a
// realistically-shaped chunk at the real producer size and assert the RESULT
// fits the real cap.
const ss58 = (n: number) => `5${String(n).padStart(47, "D")}`;

/** A chunk shaped like the real thing: 25,000 rows is `CHUNK_SIZE` in both
 * `hotkey_alpha.rs` and `account_balances.rs`, and the ss58 is what makes a row
 * 127.6 bytes rather than the 30 a toy fixture would be. */
const realisticChunk = (n: number, capturedAt = 1_785_970_245_474) =>
  Array.from({ length: n }, (_, i) => ({
    hotkey: ss58(i),
    netuid: i % 129,
    total_alpha: 1234.56789012 + i,
    captured_at: capturedAt,
  }));

describe("packSyncBatchMessages", () => {
  test("a real 25,000-row chunk becomes messages that each fit the cap", () => {
    const rows = realisticChunk(25_000);

    // THE FIXTURE MUST BE ABLE TO FAIL. If one message could hold this chunk
    // the rest of the test proves nothing, so assert first that the payload
    // really is over the cap -- this is the measurement the bug turned on.
    const unsplit = JSON.stringify({
      lane: "hotkey-alpha",
      captured_at: 1_785_970_245_474,
      pass_total: 47_032,
      rows,
    }).length;
    assert.equal(unsplit > QUEUE_MESSAGE_MAX_BYTES * 20, true);

    const messages = packSyncBatchMessages({
      lane: "hotkey-alpha",
      capturedAt: 1_785_970_245_474,
      passTotal: 47_032,
      rows,
    });

    assert.equal(messages.length > 1, true);
    for (const message of messages) {
      assert.equal(
        JSON.stringify(message).length <= QUEUE_MESSAGE_MAX_BYTES,
        true,
      );
      // Every message is independently valid, or the consumer acks it and the
      // rows vanish -- a malformed message is not retried.
      assert.equal(validSyncBatchMessage(message), true);
    }
  });

  test("loses no row and reorders none, so the tally still sums", () => {
    const rows = realisticChunk(5_000);
    const messages = packSyncBatchMessages({
      lane: "hotkey-alpha",
      capturedAt: 1_785_970_245_474,
      passTotal: 47_032,
      rows,
    });
    const flat = messages.flatMap((m) => m.rows);
    assert.equal(flat.length, rows.length);
    assert.deepEqual(flat, rows);
    // The declaration rides on every message, exactly as it rides on every
    // POSTed chunk -- `received_rows` accumulates against one `pass_total`.
    for (const m of messages) assert.equal(m.pass_total, 47_032);
  });

  test("carries no pass declaration when the producer made none", () => {
    const messages = packSyncBatchMessages({
      lane: "validator-nominator-counts",
      capturedAt: 1_785_970_245_474,
      rows: realisticChunk(10),
    });
    assert.equal(messages.length, 1);
    assert.equal("pass_total" in messages[0]!, false);
  });

  test("returns nothing for an empty chunk rather than an empty message", () => {
    // An empty message fails the validator, so emitting one would put a
    // guaranteed reject on the queue.
    assert.deepEqual(
      packSyncBatchMessages({
        lane: "hotkey-alpha",
        capturedAt: 1,
        rows: [],
      }),
      [],
    );
  });

  test("refuses to emit a message over the transport cap", () => {
    // The last line of defence, and the one whose absence cost two stopped
    // lanes. It fires when the budget itself is wrong -- raise
    // SYNC_BATCH_MAX_BYTES above the platform cap and the packer must refuse
    // rather than hand `send()` something it will reject.
    assert.throws(
      () =>
        packSyncBatchMessages({
          lane: "hotkey-alpha",
          capturedAt: 1_785_970_245_474,
          rows: realisticChunk(25_000),
          maxBytes: QUEUE_MESSAGE_MAX_BYTES * 100,
        }),
      /over the \d+-byte transport cap/,
    );
  });

  test("a group over the BUDGET but under the cap goes alone, not thrown", () => {
    // metagraphed-infra#355. `maxBytes` decides when to stop COMBINING groups;
    // a group that exceeds it alone cannot be combined with anything, but can
    // still BE a message -- the only real limit on one message is the transport
    // cap. Conflating the two made nominator-positions' largest coldkey (722
    // positions, ~108 KB against a 96 KB budget) unpackable, and the lane 502'd
    // on its first tick.
    const messages = packSyncBatchMessages({
      lane: "hotkey-alpha",
      capturedAt: 1,
      rows: [{ blob: "x".repeat(5_000) }, { small: 1 }],
      maxBytes: 1_024,
    });
    assert.equal(messages.length, 2, "the big row got its own message");
    assert.equal(messages[0]!.rows.length, 1);
    assert.equal(messages[1]!.rows.length, 1);
    // And it is still a valid, deliverable message.
    assert.equal(
      JSON.stringify(messages[0]).length <= QUEUE_MESSAGE_MAX_BYTES,
      true,
    );
  });

  test("a group over the TRANSPORT CAP still throws, rather than splitting", () => {
    // The cap is the one limit that cannot be negotiated. A group this large
    // is a producer-side problem, and the error says so instead of the packer
    // quietly breaking key_complete to make it fit.
    assert.throws(
      () =>
        packSyncBatchMessages({
          lane: "hotkey-alpha",
          capturedAt: 1,
          rows: [{ blob: "x".repeat(QUEUE_MESSAGE_MAX_BYTES + 1_000) }],
        }),
      /over the \d+-byte transport cap/,
    );
  });

  test("a real 722-position coldkey packs, which is the case that broke", () => {
    // The measured shape: nominator-positions' largest coldkey. Rows carry a
    // coldkey, a hotkey, a netuid, an alpha and a captured_at -- ~150 bytes --
    // so 722 of them is ~108 KB: over the 96 KB budget, under the 128 KB cap.
    const coldkey = `5${"C".repeat(47)}`;
    const rows = Array.from({ length: 722 }, (_, i) => ({
      coldkey,
      hotkey: `5${String(i).padStart(47, "H")}`,
      netuid: i % 129,
      alpha: 1234.56789 + i,
      captured_at: 1_785_970_245_474,
    }));
    // 722 x 200 bytes is ~141 KB -- over the 128 KB cap -- so this only fits
    // because the coldkey is hoisted off the rows.
    const messages = packSyncBatchMessages({
      lane: "nominator-positions",
      capturedAt: 1_785_970_245_474,
      rows,
    });
    assert.equal(messages.length, 1, "one coldkey, one message");
    assert.equal(messages[0]!.rows.length, 722, "not one row dropped");
    assert.equal(messages[0]!.key_complete, true);
    assert.equal(messages[0]!.key_column, "coldkey", "the key was hoisted");
    assert.equal(messages[0]!.key_value, coldkey);
    // Hoisted means ABSENT from the rows -- two copies could disagree.
    assert.equal("coldkey" in messages[0]!.rows[0]!, false);
    assert.equal(
      JSON.stringify(messages[0]).length <= QUEUE_MESSAGE_MAX_BYTES,
      true,
      "and the whole point: it now fits",
    );
    assert.equal(validSyncBatchMessage(messages[0]), true);

    // The consumer sees whole rows again, so the writer and its prune map are
    // untouched by the wire encoding.
    const rebuilt = syncBatchRows(messages[0]!);
    assert.equal(rebuilt.length, 722);
    assert.equal(rebuilt[0]!.coldkey, coldkey);
    assert.deepEqual(rebuilt[0], rows[0]);
  });

  test("a message with no rows reads as no rows, not as a crash", () => {
    // A multi-family message has `families` and no `rows`, and never reaches
    // here -- writeSyncBatch hands it to the family writer first. The fallback
    // exists because the SAME missing field, read directly, crashed the
    // consumer's batch log (metagraphed-infra#359): every read of `rows` now
    // goes through a helper that survives its absence, and empty is the
    // harmless answer -- a writer given nothing writes nothing.
    assert.deepEqual(
      syncBatchRows({ lane: "chain-detail", captured_at: 1, families: {} }),
      [],
    );
  });

  test("a hoisted key is refused if the rows still carry it", () => {
    // Two copies of one value can disagree, and the consumer would have to pick.
    assert.equal(
      validSyncBatchMessage({
        lane: "nominator-positions",
        captured_at: 1,
        key_complete: true,
        key_column: "coldkey",
        key_value: "5A",
        rows: [{ coldkey: "5B", netuid: 1 }],
      }),
      false,
    );
  });

  test("a hoisted key is refused on a lane that does not prune", () => {
    // It is the PRUNE key that is constant across a group. Nothing else is.
    assert.equal(
      validSyncBatchMessage({
        lane: "hotkey-alpha",
        captured_at: 1,
        key_column: "hotkey",
        key_value: "5A",
        rows: [{ netuid: 1 }],
      }),
      false,
    );
  });

  test("a hoisted key must name the lane's OWN prune column", () => {
    assert.equal(
      validSyncBatchMessage({
        lane: "nominator-positions",
        captured_at: 1,
        key_complete: true,
        key_column: "netuid",
        key_value: "7",
        rows: [{ hotkey: "5A" }],
      }),
      false,
    );
  });

  test("splits on the row ceiling too, not only on bytes", () => {
    // Tiny rows: the byte budget would never trigger, so this isolates the
    // row-count bound.
    const rows = Array.from({ length: 20 }, (_, i) => ({ i }));
    const messages = packSyncBatchMessages({
      lane: "hotkey-alpha",
      capturedAt: 1,
      rows,
      maxRows: 7,
    });
    assert.deepEqual(
      messages.map((m) => m.rows.length),
      [7, 7, 6],
    );
  });
});

describe("packSyncBatchMessages: the pruning lanes", () => {
  // `nominator-positions` DELETES rows for a coldkey older than the newest
  // captured_at it saw for that coldkey. Applied to a message holding only some
  // of a coldkey's rows, that deletes rows the message never carried -- and no
  // retry undoes a delete. So the packer may never split a coldkey.
  const positions = (coldkeys: number, per: number) =>
    Array.from({ length: coldkeys * per }, (_, i) => ({
      coldkey: ss58(Math.floor(i / per)),
      hotkey: ss58(1000 + (i % per)),
      netuid: i % 129,
      alpha: 1234.5678 + i,
      captured_at: 1_785_970_245_474,
    }));

  test("never splits a coldkey across messages", () => {
    const rows = positions(400, 30);
    const messages = packSyncBatchMessages({
      lane: "nominator-positions",
      capturedAt: 1_785_970_245_474,
      rows,
    });

    // More than one message, or the grouping was never exercised.
    assert.equal(messages.length > 1, true);

    const seen = new Map<string, number>();
    for (const [index, message] of messages.entries()) {
      for (const row of message.rows) {
        const key = row.coldkey as string;
        const previous = seen.get(key);
        // Every row for a coldkey must sit in the SAME message.
        if (previous !== undefined) assert.equal(previous, index);
        else seen.set(key, index);
      }
    }
    assert.equal(seen.size, 400);
  });

  test("asserts key_complete on every message, because it made it true", () => {
    const messages = packSyncBatchMessages({
      lane: "nominator-positions",
      capturedAt: 1_785_970_245_474,
      rows: positions(50, 10),
    });
    for (const message of messages) {
      assert.equal(message.key_complete, true);
      assert.equal(validSyncBatchMessage(message), true);
    }
  });

  test("does not claim key_complete for a lane that does not prune", () => {
    // The flag is a claim about a property. A lane that never deletes has no
    // such property, and asserting it anyway would make the field meaningless
    // the day a third lane reads it.
    const [message] = packSyncBatchMessages({
      lane: "hotkey-alpha",
      capturedAt: 1,
      rows: realisticChunk(3),
    });
    assert.equal("key_complete" in message!, false);
  });

  test("throws on a coldkey too large to fit, rather than splitting it", () => {
    // Degrading here would silently reintroduce the deletion the guard exists
    // to stop, on a lane whose failure mode is lost rows.
    assert.throws(
      () =>
        packSyncBatchMessages({
          lane: "nominator-positions",
          capturedAt: 1,
          rows: positions(1, 2_000),
          maxBytes: 4_096,
        }),
      /cannot be split without breaking key_complete/,
    );
  });

  test("throws if a pruning lane has no declared key column", () => {
    // Reachable because the two lists are separate on purpose: a lane can have
    // a known prune key before its producer asserts key-completeness (`neurons`
    // today, metagraphed-infra#357), so "in PRUNING_LANES, absent from the key
    // map" is a state the code can really be in. Emitting an unguarded message
    // there would delete rows it never carried.
    assert.throws(
      () =>
        packSyncBatchMessages({
          lane: "nominator-positions",
          capturedAt: 1,
          rows: realisticChunk(2),
          pruningKeys: {},
        }),
      /prunes but declares no key column/,
    );
  });

  test("every pruning lane declares its key, so the guard is never reached", () => {
    // The test above proves the guard works. This one proves it should never
    // fire in production -- a lane added to PRUNING_LANES without a key would
    // throw on its first real chunk.
    for (const lane of PRUNING_LANES) {
      assert.equal(typeof PRUNING_LANE_KEYS[lane], "string");
    }
  });
});

describe("enqueueSyncBatch", () => {
  test("sends every packed message and reports how many", async () => {
    const sent: unknown[] = [];
    const count = await enqueueSyncBatch(
      { send: async (body) => void sent.push(body) },
      {
        lane: "hotkey-alpha",
        capturedAt: 1_785_970_245_474,
        passTotal: 47_032,
        rows: realisticChunk(3_000),
      },
    );
    assert.equal(sent.length > 1, true);
    assert.equal(count, sent.length);
  });

  test("rejects when a send fails, so the producer retries the chunk", async () => {
    // 502, never 200. Reporting success on a chunk the queue never accepted
    // loses it silently, and the pass would sit incomplete forever.
    await assert.rejects(
      enqueueSyncBatch(
        { send: async () => Promise.reject(new Error("over capacity")) },
        {
          lane: "hotkey-alpha",
          capturedAt: 1,
          rows: realisticChunk(10),
        },
      ),
      /over capacity/,
    );
  });
});

describe("packSyncBatchMessages: neurons (metagraphed-infra#357)", () => {
  // neurons prunes per NETUID, and its producer never chunks: metagraph.rs
  // bails rather than truncate a partial snapshot above its 50,000-row ceiling,
  // and a pass is ~33,000 rows. So a POST always carries every row for every
  // netuid it names, and the packer only has to not break that.
  const neuronRows = (netuids: number, perNetuid: number) =>
    Array.from({ length: netuids * perNetuid }, (_, i) => ({
      netuid: Math.floor(i / perNetuid),
      uid: i % perNetuid,
      hotkey: ss58(i),
      coldkey: ss58(100_000 + i),
      stake_tao: 1234.5678 + i,
      captured_at: 1_785_970_245_474,
    }));

  test("never splits a netuid across messages", () => {
    const rows = neuronRows(129, 256);
    const messages = packSyncBatchMessages({
      lane: "neurons",
      capturedAt: 1_785_970_245_474,
      rows,
    });

    assert.equal(messages.length > 1, true, "one message could not hold 33k");

    const seen = new Map<number, number>();
    for (const [index, message] of messages.entries()) {
      for (const row of message.rows) {
        const netuid = row.netuid as number;
        const previous = seen.get(netuid);
        if (previous !== undefined) assert.equal(previous, index);
        else seen.set(netuid, index);
      }
    }
    assert.equal(seen.size, 129, "every netuid accounted for");
  });

  test("every message is accepted by the validator", () => {
    // A neurons message without key_complete is REFUSED, and a refused message
    // is acked rather than retried -- so a packer that forgot the flag would
    // drop the whole snapshot silently.
    for (const message of packSyncBatchMessages({
      lane: "neurons",
      capturedAt: 1_785_970_245_474,
      rows: neuronRows(20, 256),
    })) {
      assert.equal(message.key_complete, true);
      assert.equal(validSyncBatchMessage(message), true);
    }
  });

  test("the validator refuses a neurons chunk that does not claim it", () => {
    // Prove the guard bites: same message, flag removed.
    const [message] = packSyncBatchMessages({
      lane: "neurons",
      capturedAt: 1_785_970_245_474,
      rows: neuronRows(1, 4),
    });
    assert.equal(validSyncBatchMessage(message), true);
    const { key_complete: _drop, ...unclaimed } = message!;
    assert.equal(validSyncBatchMessage(unclaimed), false);
  });
});

describe("multi-family messages (metagraphed-infra#359)", () => {
  // chain-detail posts four row families in one request because they must land
  // in one write: a block whose drill-down shows no calls is readable and
  // wrong. `rows` cannot express that, and four independent messages would let
  // the families retry apart -- exactly the state the single POST prevents.
  const families = (n: number) => ({
    blockRows: Array.from({ length: n }, (_, i) => ({ number: i })),
    extrinsicRows: Array.from({ length: n }, (_, i) => ({ hash: `0x${i}` })),
    chainEventRows: [{ kind: "x" }],
    accountEventRows: [{ account: "5A" }],
  });

  test("carries families instead of rows, and validates", () => {
    const m = packMultiFamilyMessage({
      lane: "chain-detail",
      capturedAt: 1_785_970_245_474,
      families: families(2),
    });
    assert.equal("rows" in m, false, "families REPLACE rows, never accompany");
    assert.equal(validSyncBatchMessage(m), true);
    assert.deepEqual(Object.keys(m.families!).sort(), [
      "accountEventRows",
      "blockRows",
      "chainEventRows",
      "extrinsicRows",
    ]);
  });

  test("the row count is the SUM, so the pass tally can close", () => {
    // Counting only `rows` would credit zero and a declared pass would never
    // reach its total.
    const m = packMultiFamilyMessage({
      lane: "chain-detail",
      capturedAt: 1,
      passTotal: 6,
      families: families(2),
    });
    assert.equal(syncBatchRowCount(m), 6);
    assert.equal(passTallyFor(m, 0)!.receivedRows, 6);
  });

  test("refuses a message carrying BOTH shapes", () => {
    // Which one is authoritative? Accepting both leaves the writer to guess,
    // and a lane sending both would have one silently dropped.
    assert.equal(
      validSyncBatchMessage({
        lane: "chain-detail",
        captured_at: 1,
        rows: [{ a: 1 }],
        families: families(1),
      }),
      false,
    );
  });

  test("refuses families from a lane that does not declare them", () => {
    assert.equal(
      validSyncBatchMessage({
        lane: "hotkey-alpha",
        captured_at: 1,
        families: { blockRows: [{ a: 1 }] },
      }),
      false,
    );
  });

  test("refuses a family name the consumer would have to guess a table for", () => {
    assert.equal(
      validSyncBatchMessage({
        lane: "chain-detail",
        captured_at: 1,
        families: { mysteryRows: [{ a: 1 }] },
      }),
      false,
    );
  });

  test("refuses an empty family set, and non-array families", () => {
    for (const bad of [{}, { blockRows: "nope" }, { blockRows: [1, 2] }]) {
      assert.equal(
        validSyncBatchMessage({
          lane: "chain-detail",
          captured_at: 1,
          families: bad,
        }),
        false,
        JSON.stringify(bad),
      );
    }
  });

  test("does not measure itself -- the budget moved to the compressor", () => {
    // It used to check JSON.stringify(...) against the budget, and that was
    // measuring the wrong thing once the message started travelling
    // compressed: one chain-detail block is 476.6 KiB of JSON and 40.5 KiB on
    // the wire, so a raw-bytes check refuses messages that fit.
    // compressSyncBatchMessage owns the budget now, because it is the only
    // place that knows the size the transport actually sees.
    const message = packMultiFamilyMessage({
      lane: "chain-detail",
      capturedAt: 1,
      // Well over the byte budget, comfortably under the row ceiling -- which
      // is the combination the old check made unsendable and the new one does
      // not, because these bytes compress.
      families: {
        blockRows: [{ number: 1 }],
        extrinsicRows: Array.from({ length: 900 }, (_unused, i) => ({
          hash: `0x${"ab".repeat(32)}`,
          signer: "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g",
          index: i,
        })),
        chainEventRows: [{ kind: "x" }],
        accountEventRows: [{ account: "5A" }],
      },
    });
    assert.equal(JSON.stringify(message).length > SYNC_BATCH_MAX_BYTES, true);
    assert.equal(validSyncBatchMessage(message), true);
  });

  test("writeSyncBatch routes a family message to the family writer", async () => {
    const seen: Record<string, unknown>[] = [];
    await writeSyncBatch(
      packMultiFamilyMessage({
        lane: "chain-detail",
        capturedAt: 1,
        families: families(1),
      }),
      {},
      1,
      {
        "chain-detail": async (f) => {
          seen.push(f as Record<string, unknown>);
        },
      },
    );
    assert.equal(seen.length, 1, "ONE call -- one D1 batch, not four writes");
    assert.equal((seen[0]!.blockRows as unknown[]).length, 1);
  });

  test("throws when no family writer is wired, rather than skipping", async () => {
    // A silently skipped lane is a pass that never completes.
    await assert.rejects(
      writeSyncBatch(
        packMultiFamilyMessage({
          lane: "chain-detail",
          capturedAt: 1,
          families: families(1),
        }),
        {},
        1,
        {},
      ),
      /no family writer for lane chain-detail/,
    );
  });
});
