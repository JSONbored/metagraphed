import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { reconcileRollups } from "../scripts/smoke-live-api.mjs";

// Offline unit coverage for the rollup/detail self-consistency check added for
// #4503 -- a real, once-live bug had summary.by_status silently drift from the
// endpoints[] rows in the SAME /api/v1/endpoints response (schema-valid on
// both sides, the values just didn't reconcile). The live-network assertion
// itself lives in smoke-live-api.mjs's runLiveSmoke() (only runs against
// production, not in CI); this covers reconcileRollups' own logic against
// fixed, offline inputs.
describe("reconcileRollups", () => {
  const detail = [
    { status: "ok", kind: "docs" },
    { status: "ok", kind: "docs" },
    { status: "degraded", kind: "dashboard" },
  ];
  const consistentSummary = {
    by_status: { ok: 2, degraded: 1 },
    by_kind: { docs: 2, dashboard: 1 },
  };

  test("reports no mismatches when the rollup matches the detail array", () => {
    const mismatches = reconcileRollups(consistentSummary, detail, {
      by_status: "status",
      by_kind: "kind",
    });
    assert.deepEqual(mismatches, []);
  });

  test("catches a count drift (rollup says one more than the detail array has)", () => {
    const drifted = {
      ...consistentSummary,
      by_status: { ...consistentSummary.by_status, ok: 3 },
    };
    const mismatches = reconcileRollups(drifted, detail, {
      by_status: "status",
    });
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].rollupKey, "by_status");
    assert.deepEqual(mismatches[0].expected, { ok: 3, degraded: 1 });
    assert.deepEqual(mismatches[0].actual, { ok: 2, degraded: 1 });
  });

  test("catches a rollup key with no matching rows in the detail array", () => {
    const withPhantomKey = {
      by_status: { ...consistentSummary.by_status, unknown: 1 },
    };
    const mismatches = reconcileRollups(withPhantomKey, detail, {
      by_status: "status",
    });
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].rollupKey, "by_status");
  });

  test("catches a detail-array value missing from the rollup entirely", () => {
    const missingKey = { by_kind: { docs: 2 } }; // dashboard row exists in detail but not here
    const mismatches = reconcileRollups(missingKey, detail, {
      by_kind: "kind",
    });
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].rollupKey, "by_kind");
  });

  test("skips a rollup field the summary doesn't carry, rather than failing", () => {
    const mismatches = reconcileRollups(consistentSummary, detail, {
      by_status: "status",
      by_provider: "provider", // not present in consistentSummary
    });
    assert.deepEqual(mismatches, []);
  });

  test("ignores detail rows where the field is null/undefined instead of miscounting them", () => {
    const withGaps = [...detail, { status: null, kind: undefined }];
    const mismatches = reconcileRollups(consistentSummary, withGaps, {
      by_status: "status",
      by_kind: "kind",
    });
    assert.deepEqual(mismatches, []);
  });

  test("counts rollup keys that collide with Object prototype properties", () => {
    const mismatches = reconcileRollups(
      { by_provider: { constructor: 1, "has-own-property": 1 } },
      [{ provider: "constructor" }, { provider: "has-own-property" }],
      { by_provider: "provider" },
    );

    assert.deepEqual(mismatches, []);
  });
});
