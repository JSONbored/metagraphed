import { describe, expect, it } from "vitest";
import { DAY_MS, formatUptime, sevenDayUptime, uptimeToneClass } from "./endpoint-uptime";
import type { EndpointIncident } from "./types";

const NOW = Date.UTC(2026, 7, 22, 12);
const iso = (ms: number) => new Date(ms).toISOString();

function incident(
  endpoint_id: string,
  startMs: number,
  endMs: number | null,
  state: EndpointIncident["state"] = "down",
): EndpointIncident {
  return {
    id: `${endpoint_id}-${startMs}`,
    endpoint_id,
    state,
    started_at: iso(startMs),
    ended_at: endMs === null ? null : iso(endMs),
  };
}

describe("sevenDayUptime", () => {
  it("is null when the feed has no incident for the endpoint", () => {
    expect(sevenDayUptime("a", [incident("b", NOW - DAY_MS, NOW)], NOW)).toBeNull();
    expect(sevenDayUptime("a", [], NOW)).toBeNull();
  });

  it("is 100 when the endpoint's incidents are not outages", () => {
    const warn = incident("a", NOW - 2 * DAY_MS, NOW - DAY_MS, "warn");
    expect(sevenDayUptime("a", [warn], NOW)).toBe(100);
  });

  it("subtracts a resolved outage as its share of the 7-day window", () => {
    const oneDay = incident("a", NOW - 3 * DAY_MS, NOW - 2 * DAY_MS);
    expect(sevenDayUptime("a", [oneDay], NOW)).toBeCloseTo((6 / 7) * 100, 6);
  });

  it("runs an open outage to now and clips one that began before the window", () => {
    const open = incident("a", NOW - DAY_MS / 2, null);
    expect(sevenDayUptime("a", [open], NOW)).toBeCloseTo((1 - 0.5 / 7) * 100, 6);
    const ancient = incident("a", NOW - 30 * DAY_MS, NOW - 6 * DAY_MS);
    expect(sevenDayUptime("a", [ancient], NOW)).toBeCloseTo((6 / 7) * 100, 6);
  });

  it("does not double-count overlapping outages", () => {
    const first = incident("a", NOW - 2 * DAY_MS, NOW - DAY_MS);
    const overlapping = incident("a", NOW - 1.5 * DAY_MS, NOW - 0.5 * DAY_MS);
    expect(sevenDayUptime("a", [first, overlapping], NOW)).toBeCloseTo((5.5 / 7) * 100, 6);
  });

  it("ignores an outage with no parseable start and one entirely outside the window", () => {
    const noStart: EndpointIncident = { id: "x", endpoint_id: "a", state: "down", ended_at: null };
    const old = incident("a", NOW - 20 * DAY_MS, NOW - 10 * DAY_MS);
    expect(sevenDayUptime("a", [noStart, old], NOW)).toBe(100);
  });
});

describe("formatUptime / uptimeToneClass", () => {
  it("formats one decimal and an em dash for unknown", () => {
    expect(formatUptime(98.64)).toBe("98.6%");
    expect(formatUptime(null)).toBe("—");
  });

  it("maps the 99 / 95 bands onto the health text tokens", () => {
    expect(uptimeToneClass(null)).toBe("text-ink-muted");
    expect(uptimeToneClass(99)).toBe("text-health-ok");
    expect(uptimeToneClass(97)).toBe("text-health-warn");
    expect(uptimeToneClass(80)).toBe("text-health-down");
  });
});
