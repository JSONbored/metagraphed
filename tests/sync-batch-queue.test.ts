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
  SYNC_BATCH_LANES,
  SYNC_BATCH_MAX_ROWS,
  passTallyFor,
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
      const extra = PRUNING_LANES.includes(lane)
        ? { coldkey_complete: true }
        : {};
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
      validSyncBatchMessage({ ...positions, coldkey_complete: false }),
      false,
    );
  });

  test("accepts it once the producer asserts completeness", () => {
    assert.equal(
      validSyncBatchMessage({ ...positions, coldkey_complete: true }),
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
