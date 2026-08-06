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
  validSyncBatchMessage,
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
      assert.equal(validSyncBatchMessage({ ...OK, lane }), true, lane);
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
