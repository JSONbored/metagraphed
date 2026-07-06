import { describe, expect, it } from "vitest";
import { subnetIncidentDurationText } from "./incident-timeline";

describe("subnetIncidentDurationText", () => {
  it("returns null when started_at is missing", () => {
    expect(subnetIncidentDurationText(null, "2024-01-01T00:01:00.000Z")).toBeNull();
    expect(subnetIncidentDurationText(undefined, "2024-01-01T00:01:00.000Z")).toBeNull();
    expect(subnetIncidentDurationText("", "2024-01-01T00:01:00.000Z")).toBeNull();
  });

  it("returns null for unparseable started_at (no bare em dash in the row)", () => {
    expect(subnetIncidentDurationText("nonsense", "2024-01-01T00:01:00.000Z")).toBeNull();
  });

  it("labels a resolved incident from ISO start/end", () => {
    expect(
      subnetIncidentDurationText("2024-01-01T00:00:00.000Z", "2024-01-01T00:01:30.000Z"),
    ).toBe("1m 30s");
  });

  it("returns live elapsed text for open incidents (ended_at omitted)", () => {
    const start = new Date(Date.now() - 2000).toISOString();
    expect(subnetIncidentDurationText(start, null)).toMatch(/^\d+s$/);
    expect(subnetIncidentDurationText(start, undefined)).toMatch(/^\d+s$/);
  });
});
