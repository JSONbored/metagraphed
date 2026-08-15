// `recordOrNull` / `recordsOrEmpty` -- the shape half of the read boundary
// (#11339).
//
// The scalar coercions beside them (read-store-coercions.test.ts) answer "is
// this number usable". These answer the question that was previously answered
// by a cast: "is this untrusted thing an object I can read fields off".
//
// The producers are honest -- `readHealthKv` returns `unknown` because
// `KV.get(key, {type:"json"})` genuinely is arbitrary JSON, and
// `StorageReadResult.data` is `unknown` because an R2 object is whatever was
// last written to it. Several consumers DECLARED those as
// `Record<string, unknown> | null` and then read fields off the result, which
// is a claim about untrusted bytes that nothing verified.
//
// So most of these pin the cases a cast silently accepted and a parse must not.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { recordOrNull, recordsOrEmpty } from "../src/read-store.ts";

describe("recordOrNull", () => {
  test("NULL IS NOT AN OBJECT, whatever typeof says", () => {
    // `typeof null === "object"` is the hole every hand-rolled version of this
    // check has fallen through, and the one a cast cannot catch at all: the
    // field read that follows throws rather than declining.
    assert.equal(recordOrNull(null), null);
    assert.equal(recordOrNull(undefined), null);
  });

  test("AN ARRAY IS NOT A RECORD", () => {
    // An array reaching a site that then reads named fields is a producer
    // mismatch. Passing it through would read `undefined` off every field and
    // report that as data -- the failure mode is a silently empty answer, not
    // an error, which is the worst kind here.
    assert.equal(recordOrNull([]), null);
    assert.equal(recordOrNull([{ endpoints: [] }]), null);
  });

  test("scalars decline rather than being wrapped", () => {
    for (const v of ["", "text", 0, 42, true, false]) {
      assert.equal(recordOrNull(v), null, JSON.stringify(v));
    }
  });

  test("a plain object passes through UNCHANGED, same reference", () => {
    // Identity matters: callers overlay onto the result, and a copy would
    // silently drop a later mutation by the producer's own code path.
    const kv = { endpoints: [1], last_run_at: "2026-08-15T00:00:00Z" };
    assert.equal(recordOrNull(kv), kv);
  });

  test("an empty object is a RECORD, not an absence", () => {
    // `{}` from KV means "the cron wrote a snapshot with nothing in it", which
    // is different from "no snapshot". Collapsing them would make a live-tier
    // degradation read as a cold tier.
    assert.deepEqual(recordOrNull({}), {});
  });
});

describe("recordsOrEmpty", () => {
  test("a non-array yields EMPTY, not a one-element list", () => {
    // The tempting alternative -- wrap a lone object -- would invent a row
    // that the producer never published.
    assert.deepEqual(recordsOrEmpty({ netuid: 1 }), []);
    assert.deepEqual(recordsOrEmpty(null), []);
    assert.deepEqual(recordsOrEmpty(undefined), []);
    assert.deepEqual(recordsOrEmpty("[]"), []);
  });

  test("non-object members are DROPPED, not passed through", () => {
    // So a caller that reads a field off every element cannot meet a string.
    assert.deepEqual(recordsOrEmpty([{ a: 1 }, "x", null, 7, { b: 2 }, []]), [
      { a: 1 },
      { b: 2 },
    ]);
  });

  test("an all-invalid array yields empty rather than throwing", () => {
    assert.deepEqual(recordsOrEmpty([null, 1, "x"]), []);
  });

  test("an already-clean array survives intact, in order", () => {
    const rows = [{ netuid: 64 }, { netuid: 51 }, { netuid: 107 }];
    assert.deepEqual(recordsOrEmpty(rows), rows);
  });

  test("EMPTY ARRAY IN, EMPTY ARRAY OUT -- not an error", () => {
    assert.deepEqual(recordsOrEmpty([]), []);
  });
});
