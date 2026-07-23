import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { assessProbeHealth } from "../scripts/assert-published-probe-health.ts";

describe("assessProbeHealth (publish guard)", () => {
  test("passes for a real probe run with ok surfaces", () => {
    const r = assessProbeHealth({
      probe_finished_at: "2026-06-09T22:10:22.771Z",
      surfaces: [{ status: "ok" }, { status: "degraded" }],
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.okCount, 1);
    assert.equal(r.total, 2);
  });

  test("flags the 1970 epoch probe_finished_at placeholder", () => {
    const r = assessProbeHealth({
      probe_finished_at: "1970-01-01T00:00:00.000Z",
      surfaces: [{ status: "ok" }],
    });
    assert.ok(r.problems.some((p) => /epoch/.test(p)));
  });

  test("flags missing probe_finished_at", () => {
    const r = assessProbeHealth({ surfaces: [{ status: "ok" }] });
    assert.ok(r.problems.some((p) => /epoch\/empty/.test(p)));
  });

  test("flags zero ok surfaces (the clobbered all-unknown case)", () => {
    const r = assessProbeHealth({
      probe_finished_at: "2026-06-09T00:00:00.000Z",
      surfaces: [{ status: "unknown" }, { status: "failed" }],
    });
    assert.ok(r.problems.some((p) => /status=ok/.test(p)));
  });

  test("tolerates a missing surfaces array", () => {
    const r = assessProbeHealth({
      probe_finished_at: "2026-06-09T00:00:00.000Z",
    });
    assert.equal(r.total, 0);
    assert.ok(r.problems.length > 0);
  });
});
