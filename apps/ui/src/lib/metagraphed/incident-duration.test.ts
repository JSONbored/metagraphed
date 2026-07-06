import { describe, expect, it } from "vitest";

import { incidentDurationLabel } from "./incident-duration";

describe("incidentDurationLabel", () => {
  it("returns null when startedAt is missing", () => {
    expect(incidentDurationLabel(undefined)).toBeNull();
    expect(incidentDurationLabel(null)).toBeNull();
    expect(incidentDurationLabel(undefined, "2024-01-01T00:01:00.000Z")).toBeNull();
  });

  it("returns a resolved duration for closed incidents", () => {
    expect(incidentDurationLabel("2024-01-01T00:00:00.000Z", "2024-01-01T00:01:30.000Z")).toBe(
      "1m 30s",
    );
  });

  it("returns a live elapsed label for open incidents", () => {
    const start = new Date(Date.now() - 5_000).toISOString();
    expect(incidentDurationLabel(start, null)).toMatch(/^\d+s$/);
  });
});
