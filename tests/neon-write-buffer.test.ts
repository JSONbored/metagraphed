// The write-behind buffer (src/neon-write-buffer.ts).
//
// The properties worth asserting are the ones whose failure is SILENT:
//
//   * ORDERING. `storage.list()` sorts lexicographically, so an unpadded
//     sequence replays statement 10 before statement 9 and nothing throws.
//   * CHUNK REJOINING. A payload split by code unit rather than by byte cuts a
//     multi-byte character in half; the rejoin is corrupt, not absent.
//   * THE CEILING. A buffer that grows without bound turns a stalled flush into
//     an outage nobody can see.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  chunkKey,
  CHUNK_BYTES,
  decodeStatement,
  DO_VALUE_LIMIT_BYTES,
  encodeStatement,
  FLUSH_INTERVAL_MS,
  groupChunkKeys,
  joinPayload,
  MAX_BUFFERED_STATEMENTS,
  neonWriteBufferEnabled,
  neonWriteBufferLanes,
  seqFromChunkKey,
  shouldFlushEarly,
  splitPayload,
  STATEMENT_PREFIX,
  SEQ_WIDTH,
} from "../src/neon-write-buffer.ts";

describe("chunkKey", () => {
  test("pads so LEXICAL order is INSERTION order", () => {
    // The whole ordering guarantee. Unpadded, "stmt:10" < "stmt:9" and the
    // backlog replays out of order with nothing to notice it.
    const keys = [chunkKey(9, 0), chunkKey(10, 0), chunkKey(2, 0)];
    assert.deepEqual([...keys].sort(), [
      chunkKey(2, 0),
      chunkKey(9, 0),
      chunkKey(10, 0),
    ]);
  });

  test("pads the PART too, so part 10 cannot precede part 2", () => {
    const parts = [chunkKey(1, 2), chunkKey(1, 10)];
    assert.deepEqual([...parts].sort(), [chunkKey(1, 2), chunkKey(1, 10)]);
  });

  test("the width holds the largest safe integer without widening", () => {
    // If it ever needed a 17th digit the padding would stop working at a round
    // number, which is the worst possible time to discover it.
    assert.ok(String(Number.MAX_SAFE_INTEGER).length <= SEQ_WIDTH);
  });

  test("lives under the prefix the flush lists by", () => {
    assert.ok(chunkKey(1, 0).startsWith(STATEMENT_PREFIX));
  });
});

describe("seqFromChunkKey", () => {
  test("reads the sequence back out", () => {
    assert.equal(seqFromChunkKey(chunkKey(4321, 7)), 4321);
  });

  test("a key outside the prefix is not a statement", () => {
    assert.equal(seqFromChunkKey("seq"), null);
    assert.equal(seqFromChunkKey("other:0001"), null);
  });

  test("a non-numeric or negative sequence is refused", () => {
    assert.equal(seqFromChunkKey(`${STATEMENT_PREFIX}abc:0000`), null);
    assert.equal(seqFromChunkKey(`${STATEMENT_PREFIX}-1:0000`), null);
  });
});

describe("splitPayload / joinPayload", () => {
  test("round-trips a payload that needs no splitting", () => {
    const payload = JSON.stringify({ a: 1 });
    assert.equal(joinPayload(splitPayload(payload)), payload);
  });

  test("round-trips ACROSS a boundary that cuts a multi-byte character", () => {
    // The bug this is aimed at: "τ" is two bytes and appears in real subnet
    // names (see registry/subnets). Split by code unit at the wrong index and
    // each half is invalid UTF-8; split by byte and rejoin, and it is exact.
    const payload = "ττττττττ";
    const parts = splitPayload(payload, 3);
    assert.ok(parts.length > 1, "must actually split");
    assert.equal(joinPayload(parts), payload);
  });

  test("every chunk stays inside the platform's value limit", () => {
    const payload = "x".repeat(CHUNK_BYTES * 2 + 17);
    for (const part of splitPayload(payload)) {
      assert.ok(part.length <= CHUNK_BYTES);
      assert.ok(part.length <= DO_VALUE_LIMIT_BYTES);
    }
  });

  test("headroom is real -- the chunk size is under the platform cap", () => {
    assert.ok(CHUNK_BYTES < DO_VALUE_LIMIT_BYTES);
  });

  test("an empty payload is one empty chunk, not zero chunks", () => {
    // Zero chunks would make the statement invisible to groupChunkKeys and it
    // would never drain -- a row silently lost rather than a row rejected.
    assert.equal(splitPayload("").length, 1);
    assert.equal(joinPayload(splitPayload("")), "");
  });

  test("a chunk size of zero still makes progress", () => {
    // Guards the loop: a zero step would never advance the offset.
    assert.equal(joinPayload(splitPayload("abc", 0)), "abc");
  });
});

describe("encodeStatement / decodeStatement", () => {
  const statement = {
    lane: "blocks-head",
    text: "INSERT INTO blocks_head VALUES ($1)",
    values: [1, null, "τ"],
  };

  test("round-trips a statement verbatim", () => {
    assert.deepEqual(decodeStatement(encodeStatement(statement)), statement);
  });

  test("unparseable JSON decodes to null rather than throwing", () => {
    // The caller is a drain loop: one bad entry must cost that entry, never
    // the backlog behind it.
    assert.equal(decodeStatement("{not json"), null);
  });

  test("a non-object, a missing lane, text or values are all refused", () => {
    assert.equal(decodeStatement("42"), null);
    assert.equal(decodeStatement("null"), null);
    assert.equal(
      decodeStatement(JSON.stringify({ text: "x", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "", text: "x", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", text: "", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", text: "x" })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", text: "x", values: "no" })),
      null,
    );
  });

  test("an empty values array is a VALID statement, not a missing one", () => {
    // A parameterless DELETE is an ordinary shape here. Treating [] as absent
    // would drop it.
    const bare = { lane: "l", text: "DELETE FROM t", values: [] };
    assert.deepEqual(decodeStatement(encodeStatement(bare)), bare);
  });
});

describe("groupChunkKeys", () => {
  test("groups parts by statement, in replay order", () => {
    const keys = [
      chunkKey(2, 0),
      chunkKey(10, 1),
      chunkKey(10, 0),
      chunkKey(1, 0),
    ];
    const groups = groupChunkKeys(keys);
    assert.deepEqual(
      groups.map((g) => g.seq),
      [1, 2, 10],
    );
    // And the parts within a statement are ordered too.
    assert.deepEqual(groups[2].keys, [chunkKey(10, 0), chunkKey(10, 1)]);
  });

  test("ignores keys that are not statements", () => {
    // `seq` lives in the same storage; counting it as a statement would make
    // the buffer look permanently non-empty.
    assert.deepEqual(groupChunkKeys(["seq", "other"]), []);
  });

  test("no keys is no statements", () => {
    assert.deepEqual(groupChunkKeys([]), []);
  });
});

describe("the flush bounds", () => {
  test("the interval clears the suspend timeout it exists to beat", () => {
    // 300s is the configured suspend_timeout_seconds. At or under it the
    // compute would never quite sleep, which is the entire point of the change.
    assert.ok(FLUSH_INTERVAL_MS > 300_000);
  });

  test("and stays well inside the two-hour freshness bound", () => {
    // src/table-freshness-watchdog.ts holds every buffered table to 2 * HOUR.
    assert.ok(FLUSH_INTERVAL_MS * 12 <= 2 * 60 * 60 * 1000);
  });

  test("the ceiling forces a flush rather than growing forever", () => {
    assert.equal(shouldFlushEarly(MAX_BUFFERED_STATEMENTS - 1), false);
    assert.equal(shouldFlushEarly(MAX_BUFFERED_STATEMENTS), true);
    assert.equal(shouldFlushEarly(3, 3), true);
  });
});

describe("neonWriteBufferLanes", () => {
  test("defaults to EMPTY, so the introducing deploy buffers nothing", () => {
    assert.equal(neonWriteBufferLanes({}).size, 0);
    assert.equal(neonWriteBufferLanes(null).size, 0);
    assert.equal(neonWriteBufferLanes({ NEON_WRITE_BUFFER_LANES: "" }).size, 0);
    assert.equal(neonWriteBufferLanes({ NEON_WRITE_BUFFER_LANES: 7 }).size, 0);
  });

  test("trims and drops empties, so a trailing comma is not a lane", () => {
    assert.deepEqual(
      [
        ...neonWriteBufferLanes({
          NEON_WRITE_BUFFER_LANES: " blocks-head , ,chain-detail ",
        }),
      ],
      ["blocks-head", "chain-detail"],
    );
  });

  test("enables exactly the lanes named", () => {
    const env = { NEON_WRITE_BUFFER_LANES: "blocks-head" };
    assert.equal(neonWriteBufferEnabled(env, "blocks-head"), true);
    assert.equal(neonWriteBufferEnabled(env, "chain-detail"), false);
    assert.equal(neonWriteBufferEnabled({}, "blocks-head"), false);
  });
});
