import { describe, expect, it } from "vitest";
import {
  coerceNetuid,
  healthSummaryToState,
  netuidFromPathname,
  resolveSubnetProbeHealth,
  sameNetuid,
  worstActiveIncidentHealth,
} from "./subnet-probe-health";
import type { EndpointIncident } from "./types";

describe("healthSummaryToState", () => {
  it("prefers down over warn/ok/unknown", () => {
    expect(healthSummaryToState({ down: 1, warn: 2, ok: 3, unknown: 1 })).toBe("down");
  });

  it("prefers warn over ok/unknown when nothing is down", () => {
    expect(healthSummaryToState({ down: 0, warn: 1, ok: 5, unknown: 0 })).toBe("warn");
  });

  it("returns ok when only ok surfaces are probed", () => {
    expect(healthSummaryToState({ ok: 4, warn: 0, down: 0, unknown: 0 })).toBe("ok");
  });

  it("returns unknown for empty / missing counts", () => {
    expect(healthSummaryToState(undefined)).toBe("unknown");
    expect(healthSummaryToState({})).toBe("unknown");
    expect(healthSummaryToState({ unknown: 2 })).toBe("unknown");
  });
});

describe("resolveSubnetProbeHealth", () => {
  it("prefers a concrete map health over the summary rollup", () => {
    expect(
      resolveSubnetProbeHealth({
        mapHealth: "warn",
        summary: { ok: 10, warn: 0, down: 0 },
      }),
    ).toBe("warn");
  });

  it("falls back to summary when the map has no entry", () => {
    expect(
      resolveSubnetProbeHealth({
        mapHealth: undefined,
        summary: { ok: 0, warn: 2, down: 0 },
      }),
    ).toBe("warn");
  });

  it("lets summary override a map 'unknown' when probes show a concrete state", () => {
    expect(
      resolveSubnetProbeHealth({
        mapHealth: "unknown",
        summary: { ok: 0, warn: 0, down: 1 },
      }),
    ).toBe("down");
  });

  it("falls back to active incident health when map+summary are unknown (#5332)", () => {
    expect(
      resolveSubnetProbeHealth({
        mapHealth: "unknown",
        summary: { ok: 0, warn: 0, down: 0 },
        incidentHealth: "warn",
      }),
    ).toBe("warn");
    expect(
      resolveSubnetProbeHealth({
        mapHealth: undefined,
        incidentHealth: "down",
      }),
    ).toBe("down");
  });

  it("stays unknown when neither source has a concrete status", () => {
    expect(resolveSubnetProbeHealth({})).toBe("unknown");
    expect(resolveSubnetProbeHealth({ mapHealth: "unknown", summary: {} })).toBe("unknown");
  });
});

describe("worstActiveIncidentHealth", () => {
  const rows: EndpointIncident[] = [
    { id: "a", netuid: 0, state: "warn", ended_at: null },
    { id: "b", netuid: 0, state: "down", ended_at: null },
    { id: "c", netuid: 1, state: "warn", ended_at: "2026-01-01T00:00:00Z" },
    { id: "d", netuid: "43" as unknown as number, state: "warn", ended_at: null },
  ];

  it("returns the worst active incident for the asked netuid", () => {
    expect(worstActiveIncidentHealth(rows, 0)).toBe("down");
    expect(worstActiveIncidentHealth(rows, 1)).toBeUndefined();
    expect(worstActiveIncidentHealth(rows, 43)).toBe("warn");
  });
});

describe("sameNetuid / coerceNetuid", () => {
  it("treats string and number netuids as equal", () => {
    expect(sameNetuid(1, "1")).toBe(true);
    expect(sameNetuid("0", 0)).toBe(true);
    expect(sameNetuid(1, 2)).toBe(false);
    expect(coerceNetuid("01")).toBe(1);
  });
});

describe("netuidFromPathname", () => {
  it("extracts the subnet id from a detail path", () => {
    expect(netuidFromPathname("/subnets/1")).toBe(1);
    expect(netuidFromPathname("/subnets/74")).toBe(74);
  });

  it("returns null off subnet detail routes", () => {
    expect(netuidFromPathname("/subnets")).toBeNull();
    expect(netuidFromPathname("/endpoints")).toBeNull();
    expect(netuidFromPathname("/")).toBeNull();
  });
});
