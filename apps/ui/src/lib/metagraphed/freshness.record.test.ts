import { describe, expect, it } from "vitest";
import { isoTimestamp, recordModifiedAt } from "./freshness";

describe("isoTimestamp", () => {
  it("normalises a real API timestamp to W3C Datetime", () => {
    expect(isoTimestamp("2026-08-14T12:14:17.177Z")).toBe("2026-08-14T12:14:17.177Z");
    expect(isoTimestamp("2026-08-14T12:15:22Z")).toBe("2026-08-14T12:15:22.000Z");
  });

  it("emits NOTHING rather than a fabricated date", () => {
    // The property that matters, and the reason this rule is shared rather
    // than copied: Google discounts `lastmod` site-wide once it catches a site
    // stamping "now" on URLs that did not change, so one synthesised value
    // costs every honest one. Absent beats wrong.
    for (const bad of [undefined, null, "", "not-a-date", 1785000000000, {}, [], NaN, true]) {
      expect(isoTimestamp(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("recordModifiedAt", () => {
  it("takes the publish timestamp, not the probe observation", () => {
    // The distinction is the whole point. `operational_observed_at` is when we
    // last LOOKED — it advances every 15 minutes whether or not the record
    // changed, so publishing it as dateModified would be indistinguishable
    // from stamping "now" on every request.
    expect(
      recordModifiedAt({
        published_at: "2026-08-14T12:14:17.177Z",
        generated_at: "2026-08-14T12:14:17.177Z",
        operational_observed_at: "2026-08-15T12:01:00.777Z",
      }),
    ).toBe("2026-08-14T12:14:17.177Z");
  });

  it("falls back to generated_at, which some artifacts carry alone", () => {
    expect(recordModifiedAt({ generated_at: "2026-08-14T12:14:17.177Z" })).toBe(
      "2026-08-14T12:14:17.177Z",
    );
  });

  it("never reaches for the observation when neither publish field is usable", () => {
    // Explicitly NOT "fall back to whatever timestamp is present". A record we
    // cannot date honestly is one we publish undated.
    expect(
      recordModifiedAt({
        published_at: "not-a-date",
        operational_observed_at: "2026-08-15T12:01:00.777Z",
      }),
    ).toBeUndefined();
  });

  it("returns nothing for a meta that is not an object", () => {
    for (const bad of [undefined, null, "2026-08-14T12:14:17.177Z", 42]) {
      expect(recordModifiedAt(bad), String(bad)).toBeUndefined();
    }
  });
});
