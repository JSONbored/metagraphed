import { describe, expect, it } from "vitest";

import { timeAgoAbsoluteTitle } from "./time-ago";

describe("timeAgoAbsoluteTitle", () => {
  it("returns a locale absolute string for usable timestamps", () => {
    const title = timeAgoAbsoluteTitle("2024-06-15T12:00:00.000Z");
    expect(title).toBeTruthy();
    expect(title).toMatch(/\d/);
  });

  it("returns undefined when at is missing", () => {
    expect(timeAgoAbsoluteTitle(undefined)).toBeUndefined();
    expect(timeAgoAbsoluteTitle(null)).toBeUndefined();
  });

  it("returns undefined for the registry 1970 placeholder", () => {
    expect(timeAgoAbsoluteTitle("1970-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("returns undefined for unparseable values", () => {
    expect(timeAgoAbsoluteTitle("not-a-date")).toBeUndefined();
  });
});
