import { describe, expect, it } from "vitest";
import { combineSubnetProbeHealth } from "./use-subnet-probe-health";
import type { EndpointIncident } from "@/lib/metagraphed/types";

describe("combineSubnetProbeHealth", () => {
  it("resolves from all three sources when they agree", () => {
    expect(
      combineSubnetProbeHealth(74, true, {
        mapData: { data: { 74: { health: "ok" } } },
        detailData: { data: { ok: 3, warn: 0, down: 0, unknown: 0 } },
        incidentsData: { data: [] },
      }),
    ).toBe("ok");
  });

  it("stays unknown until hydration completes, even with concrete cached data", () => {
    expect(
      combineSubnetProbeHealth(74, false, {
        mapData: { data: { 74: { health: "down" } } },
        detailData: { data: { ok: 0, warn: 0, down: 5, unknown: 0 } },
        incidentsData: {
          data: [{ id: "a", netuid: 74, state: "down", ended_at: null }],
        },
      }),
    ).toBe("unknown");
  });

  it("falls back to the summary rollup when the map has no entry for this netuid", () => {
    expect(
      combineSubnetProbeHealth(74, true, {
        mapData: { data: {} },
        detailData: { data: { ok: 0, warn: 2, down: 0, unknown: 0 } },
        incidentsData: { data: [] },
      }),
    ).toBe("warn");
  });

  it("falls back to active incident health for this netuid when map+summary are unknown", () => {
    const incidents: EndpointIncident[] = [
      { id: "a", netuid: 1, state: "down", ended_at: null },
      { id: "b", netuid: 74, state: "warn", ended_at: null },
    ];
    expect(
      combineSubnetProbeHealth(74, true, {
        mapData: { data: { 74: { health: "unknown" } } },
        detailData: { data: { ok: 0, warn: 0, down: 0, unknown: 0 } },
        incidentsData: { data: incidents },
      }),
    ).toBe("warn");
  });

  it("prefers a concrete map health over a disagreeing summary/incident state", () => {
    const incidents: EndpointIncident[] = [{ id: "a", netuid: 74, state: "down", ended_at: null }];
    expect(
      combineSubnetProbeHealth(74, true, {
        mapData: { data: { 74: { health: "ok" } } },
        detailData: { data: { ok: 0, warn: 0, down: 9, unknown: 0 } },
        incidentsData: { data: incidents },
      }),
    ).toBe("ok");
  });

  it("stays unknown when every source is missing or empty", () => {
    expect(combineSubnetProbeHealth(74, true, {})).toBe("unknown");
    expect(
      combineSubnetProbeHealth(74, true, {
        mapData: { data: {} },
        detailData: { data: {} },
        incidentsData: { data: [] },
      }),
    ).toBe("unknown");
  });
});
