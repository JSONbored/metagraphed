// #5546: the webhook dispatcher capped its per-run fan-out with a fixed
// `keys.slice(0, max)`, so once registered subscriptions exceeded the cap every
// subscription whose id sorted after the cap received zero dispatches forever.
// selectDispatchKeys rotates the selected window by a per-run seed so every
// subscription is eventually dispatched, while preserving the cap and the
// within-cap behavior exactly.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { selectDispatchKeys } from "../scripts/lib/webhook-dispatch-selection.ts";

// Realistic subscription keys: WEBHOOK_KV_PREFIX + a v4-uuid-ish id.
function makeKeys(n) {
  return Array.from(
    { length: n },
    (_, i) =>
      `webhooks:sub:${String(i).padStart(6, "0")}-${(i * 2654435761) >>> 0}`,
  );
}

describe("selectDispatchKeys (#5546)", () => {
  test("returns the input unchanged when the total is within the cap", () => {
    const keys = makeKeys(100);
    const out = selectDispatchKeys(keys, { max: 128, seed: 12345 });
    assert.deepEqual(out, keys); // same keys, same order — no rotation
  });

  test("selects exactly `max` keys when the total exceeds the cap", () => {
    const keys = makeKeys(200);
    const out = selectDispatchKeys(keys, { max: 128, seed: 1 });
    assert.equal(out.length, 128);
    // Every selected key is a real registered key, with no duplicates.
    assert.equal(new Set(out).size, 128);
    for (const k of out) assert.ok(keys.includes(k));
  });

  test("is deterministic for a given seed", () => {
    const keys = makeKeys(200);
    assert.deepEqual(
      selectDispatchKeys(keys, { max: 128, seed: 42 }),
      selectDispatchKeys(keys, { max: 128, seed: 42 }),
    );
  });

  test("a different seed rotates the window (not always the same 128)", () => {
    const keys = makeKeys(200);
    const a = selectDispatchKeys(keys, { max: 128, seed: 1 });
    const b = selectDispatchKeys(keys, { max: 128, seed: 2 });
    assert.notDeepEqual(a, b);
  });

  test("every subscription past the cap is eventually dispatched across runs (no permanent starvation)", () => {
    const keys = makeKeys(200);
    const max = 128;
    // The lexicographically-last key is exactly what the old slice(0, 128)
    // could never reach; it must appear for at least one seed.
    const lastKey = [...keys].sort().at(-1);

    const everSelected = new Set();
    let lastKeySeen = false;
    for (let seed = 0; seed < 60; seed += 1) {
      const selected = selectDispatchKeys(keys, { max, seed });
      for (const k of selected) everSelected.add(k);
      if (selected.includes(lastKey)) lastKeySeen = true;
    }
    assert.ok(
      lastKeySeen,
      "the lexicographically-last subscription must be dispatched within a bounded number of runs",
    );
    assert.equal(
      everSelected.size,
      keys.length,
      "every registered subscription must be dispatched at least once across runs",
    );
  });

  test("rejects invalid arguments", () => {
    assert.throws(() => selectDispatchKeys("nope", { max: 1 }), TypeError);
    assert.throws(() => selectDispatchKeys([], { max: -1 }), RangeError);
  });
});
