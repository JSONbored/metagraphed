import { describe, it, expect } from "vitest";

import { TABS, SECTION_TO_TAB } from "./subnet-detail-tabs";

describe("subnet-detail tab routing", () => {
  const tabIds = new Set<string>(TABS.map((t) => t.id));

  it("routes the #activity anchor to the Activity tab", () => {
    // Without this mapping, /subnets/N#activity — including the Activity panel's
    // own "copy link" button — silently fails to switch tabs (#3978).
    expect(SECTION_TO_TAB.activity).toBe("activity");
  });

  it("maps every section anchor to a declared tab", () => {
    // A section anchor pointing at a tab id that isn't in TABS can never be
    // resolved by useHashScroll, so its deep link is dead on arrival.
    for (const [section, tab] of Object.entries(SECTION_TO_TAB)) {
      expect(tabIds.has(tab), `section "${section}" → unknown tab "${tab}"`).toBe(true);
    }
  });
});
