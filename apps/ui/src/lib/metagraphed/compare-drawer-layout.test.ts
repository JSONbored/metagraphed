import { describe, expect, it } from "vitest";
import {
  COMPARE_BODY_CLASS,
  COMPARE_SCRIM_CLASS,
  COMPARE_SHEET_CARD_CLASS,
  COMPARE_SHEET_ROOT_CLASS,
  COMPARE_SHEET_WRAPPER_CLASS,
} from "./compare-drawer-layout";

const ALL = [
  COMPARE_BODY_CLASS,
  COMPARE_SCRIM_CLASS,
  COMPARE_SHEET_CARD_CLASS,
  COMPARE_SHEET_ROOT_CLASS,
  COMPARE_SHEET_WRAPPER_CLASS,
];

describe("compare drawer layout tokens (#6885)", () => {
  it("stays mobile-first — no max-* variants, which this codebase never uses", () => {
    for (const cls of ALL) expect(cls).not.toMatch(/\bmax-(sm|md|lg|xl):/);
  });

  it("lets the body take leftover sheet height on mobile and caps it from md up", () => {
    // Without min-h-0 a flex child refuses to shrink below its content, which is
    // what pushes a sheet's card past the viewport.
    expect(COMPARE_BODY_CLASS).toContain("min-h-0");
    expect(COMPARE_BODY_CLASS).toContain("flex-1");
    expect(COMPARE_BODY_CLASS).toContain("overflow-auto");
    // Desktop keeps exactly the behaviour it shipped with.
    expect(COMPARE_BODY_CLASS).toContain("md:max-h-[55vh]");
    expect(COMPARE_BODY_CLASS).toContain("md:flex-none");
  });

  it("makes the card a flex column on mobile and restores block flow from md up", () => {
    expect(COMPARE_SHEET_CARD_CLASS).toContain("flex");
    expect(COMPARE_SHEET_CARD_CLASS).toContain("min-h-0");
    expect(COMPARE_SHEET_CARD_CLASS).toContain("md:block");
    expect(COMPARE_SHEET_CARD_CLASS).toContain("md:max-h-none");
  });

  it("expands the root to full screen on mobile only", () => {
    expect(COMPARE_SHEET_ROOT_CLASS).toContain("top-0");
    expect(COMPARE_SHEET_ROOT_CLASS).toContain("md:top-auto");
  });

  it("anchors the sheet to the bottom without changing desktop flow", () => {
    expect(COMPARE_SHEET_WRAPPER_CLASS).toContain("justify-end");
    expect(COMPARE_SHEET_WRAPPER_CLASS).toContain("h-full");
    expect(COMPARE_SHEET_WRAPPER_CLASS).toContain("md:h-auto");
    expect(COMPARE_SHEET_WRAPPER_CLASS).toContain("md:block");
  });

  it("keeps the scrim mobile-only and clickable", () => {
    expect(COMPARE_SCRIM_CLASS).toContain("md:hidden");
    expect(COMPARE_SCRIM_CLASS).toContain("pointer-events-auto");
    expect(COMPARE_SCRIM_CLASS).toContain("inset-0");
  });
});
