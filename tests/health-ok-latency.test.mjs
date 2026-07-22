import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { okLatencyMs } from "../src/health-probe-core.ts";

describe("okLatencyMs", () => {
  test("returns the latency only for a successful probe with a finite reading", () => {
    assert.equal(okLatencyMs("ok", 42), 42);
    // a genuine zero-latency reading still counts (it is finite).
    assert.equal(okLatencyMs("ok", 0), 0);
  });

  test("drops a non-finite latency even on a successful probe", () => {
    for (const latency of [NaN, Infinity, -Infinity, null, undefined]) {
      assert.equal(okLatencyMs("ok", latency), null, String(latency));
    }
  });

  test("drops the latency for any non-ok status", () => {
    for (const status of ["failed", "degraded", "timeout", "unknown"]) {
      assert.equal(okLatencyMs(status, 42), null, status);
    }
  });
});
