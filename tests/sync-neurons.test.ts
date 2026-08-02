import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { chunkRows, MAX_ROWS_PER_REQUEST } from "../scripts/sync-neurons.ts";
import type { Row } from "./row-type.ts";

function row(uid: number, extra: Row = {}): Row {
  return {
    netuid: 1,
    uid,
    hotkey: `5${"H".repeat(46)}`,
    coldkey: `5${"C".repeat(46)}`,
    stake_tao: 1.5,
    captured_at: 1_785_700_000,
    ...extra,
  };
}

describe("chunkRows", () => {
  test("a snapshot under both caps is a single request", () => {
    const chunks = chunkRows([row(0), row(1), row(2)]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 3);
  });

  test("every row is emitted exactly once, in order", () => {
    const rows = Array.from({ length: MAX_ROWS_PER_REQUEST * 2 + 7 }, (_, i) =>
      row(i),
    );
    const chunks = chunkRows(rows);
    const flattened = chunks.flat();
    assert.equal(
      flattened.length,
      rows.length,
      "no rows dropped or duplicated",
    );
    assert.deepEqual(
      flattened.map((r) => r.uid),
      rows.map((r) => r.uid),
      "order preserved across the chunk boundary",
    );
  });

  test("splits on the row-count cap", () => {
    const rows = Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, (_, i) =>
      row(i),
    );
    const chunks = chunkRows(rows);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX_ROWS_PER_REQUEST);
    assert.equal(chunks[1].length, 1);
  });

  // The cap that actually bites first on a wide snapshot: the route measures
  // the encoded body, so row COUNT alone is not a sufficient guard.
  test("splits on the byte cap even when the row count is small", () => {
    const fat = row(0, { axon: "x".repeat(2_000_000) });
    const chunks = chunkRows([
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
    ]);
    assert.ok(
      chunks.length > 1,
      "13 x ~2MB rows must not be sent as one 26MB body",
    );
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
      assert.ok(
        bytes < 32_000_000,
        `chunk of ${bytes} bytes must stay under the route's 32MB cap`,
      );
    }
  });

  test("a single row larger than the cap is still emitted, not silently dropped", () => {
    // Better to let the route reject one oversized row with a 413 than to
    // drop it here and report a successful sync that lost data.
    const huge = row(0, { axon: "x".repeat(25_000_000) });
    const chunks = chunkRows([huge]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
  });

  test("an empty snapshot yields no requests", () => {
    assert.deepEqual(chunkRows([]), []);
  });
});
