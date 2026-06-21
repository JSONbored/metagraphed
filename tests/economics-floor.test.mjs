import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ECONOMICS_FLOOR_RATIO,
  shouldPublishEconomics,
} from "../scripts/economics-floor.mjs";

const CAPTURED = "2026-06-20T00:00:00.000Z";

describe("shouldPublishEconomics (live-economics content floor)", () => {
  test("zero / non-finite rows never publish (won't clobber the live tier)", () => {
    for (const count of [0, undefined, null, NaN]) {
      const v = shouldPublishEconomics(
        { with_economics_count: count, captured_at: CAPTURED },
        100,
      );
      assert.equal(v.publish, false, `count=${count}`);
      assert.equal(v.reason, "no-economics-rows");
    }
    // Defensive: even a missing summary object must not publish.
    assert.equal(shouldPublishEconomics(undefined, 100).publish, false);
  });

  test("a missing captured_at blocks publish even with rows", () => {
    const v = shouldPublishEconomics(
      { with_economics_count: 80, captured_at: null },
      100,
    );
    assert.equal(v.publish, false);
    assert.equal(v.reason, "missing-captured-at");
  });

  test("just below the floor does not publish", () => {
    const v = shouldPublishEconomics(
      { with_economics_count: 49, captured_at: CAPTURED },
      100,
    );
    assert.equal(v.publish, false);
    assert.match(v.reason, /^below-floor/);
  });

  test("exactly at the floor publishes (the gate is strictly 'below')", () => {
    const at = Math.ceil(100 * ECONOMICS_FLOOR_RATIO); // 50
    const v = shouldPublishEconomics(
      { with_economics_count: at, captured_at: CAPTURED },
      100,
    );
    assert.equal(v.publish, true);
    assert.equal(v.reason, "ok");
  });

  test("above the floor publishes", () => {
    const v = shouldPublishEconomics(
      { with_economics_count: 51, captured_at: CAPTURED },
      100,
    );
    assert.equal(v.publish, true);
    assert.equal(v.reason, "ok");
  });

  test("expectedCount=0 skips the ratio gate (any non-empty captured blob publishes)", () => {
    const v = shouldPublishEconomics(
      { with_economics_count: 1, captured_at: CAPTURED },
      0,
    );
    assert.equal(v.publish, true);
    assert.equal(v.reason, "ok");
  });
});
