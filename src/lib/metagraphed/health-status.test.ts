import { describe, expect, it } from "vitest";

import { healthStatusToState, statusToHealth } from "./queries";
import type { HealthState, HealthStatus } from "./types";

// The canonical contract enum. Kept as an explicit literal list (not derived)
// so a backend member rename forces this list — and therefore the exhaustive
// coverage check below — to be updated deliberately.
const ALL_HEALTH_STATUSES: HealthStatus[] = ["ok", "degraded", "failed", "unknown"];

describe("healthStatusToState (canonical HealthStatus → UI HealthState)", () => {
  // The documented drift fix (#1758): degraded→warn, failed→down.
  const cases: Array<[HealthStatus, HealthState]> = [
    ["ok", "ok"],
    ["degraded", "warn"],
    ["failed", "down"],
    ["unknown", "unknown"],
  ];

  it.each(cases)("maps %s → %s", (status, expected) => {
    expect(healthStatusToState(status)).toBe(expected);
  });

  it("covers every canonical HealthStatus member (exhaustive)", () => {
    for (const status of ALL_HEALTH_STATUSES) {
      const mapped = healthStatusToState(status);
      expect(["ok", "warn", "down", "unknown"]).toContain(mapped);
    }
    // Every case in the table corresponds to a real enum member, and the table
    // length equals the enum size — so the mapping is total.
    expect(cases.map((c) => c[0]).sort()).toEqual([...ALL_HEALTH_STATUSES].sort());
  });

  it("collapses the degraded/failed tier away from raw 'ok'", () => {
    // Regression guard for the prior drift where backend `degraded`/`failed`
    // fell through to "unknown" instead of warn/down.
    expect(healthStatusToState("degraded")).not.toBe("unknown");
    expect(healthStatusToState("failed")).not.toBe("unknown");
  });
});

describe("statusToHealth (tolerant raw-payload variant)", () => {
  it("routes every canonical HealthStatus through healthStatusToState", () => {
    for (const status of ALL_HEALTH_STATUSES) {
      expect(statusToHealth(status)).toBe(healthStatusToState(status));
    }
  });

  it("maps the live-probe classification strings still emitted by legacy routes", () => {
    expect(statusToHealth("live")).toBe("ok");
    expect(statusToHealth("redirected")).toBe("warn");
    expect(statusToHealth("transient")).toBe("warn");
    expect(statusToHealth("unsupported")).toBe("down");
  });

  it("passes through already-mapped UI HealthState values", () => {
    expect(statusToHealth("ok")).toBe("ok");
    expect(statusToHealth("warn")).toBe("warn");
    expect(statusToHealth("down")).toBe("down");
    expect(statusToHealth("unknown")).toBe("unknown");
  });

  it("returns undefined for non-strings and 'unknown' for unrecognized strings", () => {
    expect(statusToHealth(undefined)).toBeUndefined();
    expect(statusToHealth(null)).toBeUndefined();
    expect(statusToHealth(42)).toBeUndefined();
    expect(statusToHealth("something-else")).toBe("unknown");
  });
});
