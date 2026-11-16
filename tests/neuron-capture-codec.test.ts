import assert from "node:assert/strict";
import { test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";

test("capture codec preserves strict binary JSON and applies source timestamp merges", () => {
  const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 });
  try {
    const first = decoder.encode(
      '{"1":{"netuid":1,"uid":1,"captured_at":100,"hotkey":"first"},"2":{"uid":2,"captured_at":200}}',
    );
    const equal = decoder.encode(
      '{"1":{"uid":1,"captured_at":100,"hotkey":"ignored"}}',
    );
    assert.equal(decoder.mergeCapture(first, equal, 200n), null);
    const mixed = decoder.encode(
      '{"1":{"uid":1,"captured_at":101},"2":{"uid":2,"captured_at":199},"3":{"uid":3,"captured_at":99}}',
    );
    const merged = decoder.mergeCapture(first, mixed, 200n)!;
    assert.deepEqual(JSON.parse(decoder.decode(merged)), {
      "1": { netuid: 1, uid: 1, captured_at: 101, hotkey: "first" },
      "2": { uid: 2, captured_at: 200 },
      "3": { uid: 3, captured_at: 99 },
    });
    const newer = decoder.mergeCapture(
      first,
      decoder.encode('{"1":{"uid":1,"captured_at":300}}'),
      200n,
    )!;
    assert.equal(decoder.extract(newer, '$."1".captured_at'), 300n);
    const pruned = decoder.pruneCapture(merged, 102)!;
    assert.deepEqual(pruned.uids, [1n, 3n]);
    assert.deepEqual(JSON.parse(decoder.decode(pruned.payload)), {
      "2": { uid: 2, captured_at: 200 },
    });
    assert.equal(decoder.pruneCapture(pruned.payload, 102), null);
    assert.equal(
      decoder.decode(decoder.pruneCapture(pruned.payload, 201)!.payload),
      "{}",
    );
  } finally {
    decoder.close();
  }
});

test("capture codec handles TEXT affinity without truncating NUL and refuses malformed or oversized inputs", () => {
  const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 });
  assert.equal(decoder.textAffinity(null), null);
  assert.equal(decoder.textAffinity(12n), "12");
  assert.equal(decoder.textAffinity(1.5), "1.5");
  assert.equal(decoder.textAffinity("a\0b"), "a\0b");
  assert.equal(
    decoder.textAffinity(new TextEncoder().encode("bytes")),
    "bytes",
  );
  assert.equal(decoder.numericAffinity(null), null);
  assert.equal(decoder.numericAffinity(12n), 12n);
  assert.equal(decoder.numericAffinity("123e5"), 12300000);
  assert.equal(decoder.integerAffinity("123e5"), 123n);
  assert.equal(decoder.integerAffinity(null), null);
  assert.equal(decoder.numericAffinity(new TextEncoder().encode("2.5")), 2.5);
  assert.throws(() => decoder.numericAffinity("x".repeat(524289)), /budget/);
  assert.throws(
    () => decoder.integerAffinity(new Uint8Array(524289)),
    /budget/,
  );
  assert.throws(
    () => decoder.numericAffinity(new Uint8Array(524289)),
    /budget/,
  );
  assert.throws(() => decoder.integerAffinity("x".repeat(524289)), /budget/);
  assert.throws(() => decoder.encode(3 as never), /budget/);
  assert.throws(() => decoder.encode("{bad"), /Malformed/);
  assert.throws(() => decoder.encode(" ".repeat(1048577)), /budget/);
  assert.throws(
    () => decoder.encode(JSON.stringify({ large: "x".repeat(524288) })),
    /budget/,
  );
  assert.throws(() => decoder.textAffinity("x".repeat(524289)), /budget/);
  assert.throws(() => decoder.textAffinity(new Uint8Array(524289)), /budget/);
  const first = decoder.encode('{"1":{"captured_at":1,"text":"a"}}');
  const incoming = decoder.encode(
    JSON.stringify({
      "1": { captured_at: 2, text: "x".repeat(524200) },
      "2": { captured_at: 1 },
    }),
  );
  assert.ok(decoder.mergeCapture(first, incoming, 1n));
  const largeOld = decoder.encode(
    JSON.stringify({ "1": { captured_at: 1, text: "x".repeat(300000) } }),
  );
  const largeNew = decoder.encode(
    JSON.stringify({ "2": { captured_at: 2, text: "x".repeat(300000) } }),
  );
  assert.throws(() => decoder.mergeCapture(largeOld, largeNew, 1n), /budget/);
  decoder.close();
  assert.throws(() => decoder.encode("{}"), /closed/);
  assert.throws(() => decoder.textAffinity("x"), /closed/);
  assert.throws(() => decoder.numericAffinity(1), /closed/);
  assert.throws(() => decoder.integerAffinity(1), /closed/);
  assert.throws(() => decoder.mergeCapture(first, incoming, 1n), /closed/);
  assert.throws(() => decoder.pruneCapture(first, 1), /closed/);
});
