import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeBlockFeedCursor as decode,
  encodeBlockFeedCursor as encode,
  blockFeedSeek as seek,
} from "../src/block-feed-cursor.ts";

test("height tokens are explicit, nullable and preserve physical identity", () => {
  for (const height of [10, null])
    for (const observed of [20, null]) {
      const row = {
        block_number: height,
        observed_at: observed,
        _source_id: 1,
        _ordinal: 0,
      };
      const token = encode(row, null)!;
      assert.match(token, /^bh1\./);
      assert.deepEqual(decode(token), {
        mode: "height",
        height,
        observed,
        source: 1,
        ordinal: 0,
      });
      const predicate = seek(decode(token)!);
      assert.match(predicate, /b.source_id,b.ordinal/);
      assert.match(
        predicate,
        height === null ? /block_number IS NULL AND/ : /block_number < 10/,
      );
      assert.match(
        predicate,
        observed === null ? /observed_at IS NOT NULL/ : /observed_at > 20/,
      );
    }
  assert.equal(encode({ block_number: 10 }, null), "bh1.10.n.n.n");
  assert.equal(
    seek(decode("bh1.10.n.n.n")!),
    "(block_number < 10 OR block_number IS NULL)",
  );
});

test("old tokens retain their exact sort and seek meaning", () => {
  const pair = decode("20.10")!;
  assert.equal(pair.mode, "observed");
  assert.equal(encode({ block_number: 9, observed_at: 19 }, pair), "19.9");
  assert.equal(seek(pair), "(observed_at, block_number) < (20, 10)");
  const single = decode("10")!;
  assert.equal(single.mode, "legacy-height");
  assert.equal(encode({ block_number: 9 }, single), "9");
  assert.equal(seek(single), "(block_number < 10 OR block_number IS NULL)");
});

test("malformed or unsafe cursor parts never become SQL literals", () => {
  for (const token of [
    undefined,
    null,
    10,
    "",
    "junk",
    "bh1.1.2.3",
    "bh1.1.2.3.4.5",
    "bh1.1.2.n.4",
    "bh1.1.2.3.n",
    "bh1.n.2.n.n",
    "bh1.-1.2.3.4",
    "bh1.9007199254740992.2.3.4",
    "bh1.1.x.3.4",
    "bh1.1.2.3;DROP.4",
  ])
    assert.equal(decode(token), null);
  for (const row of [
    {},
    { block_number: null },
    { block_number: 10, _source_id: 1 },
    { block_number: 10, _ordinal: 1 },
    { block_number: -1 },
    { block_number: "bad" },
    { block_number: 10, observed_at: -1 },
    { block_number: 10, _source_id: -1, _ordinal: 0 },
  ])
    assert.equal(encode(row, null), null);
});
