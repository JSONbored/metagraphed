import { describe, expect, it } from "vitest";
import { COARSE_POINTER_MEDIA_QUERY } from "@/lib/metagraphed/coarse-pointer";

/**
 * The hook itself needs a React environment; these tests pin the contract the
 * hook and EntityHoverCard share so the mega-menu can't silently diverge from
 * the touch-safe media query (#5337).
 */
describe("useCoarsePointer contract (#5337)", () => {
  it("shares the coarse-pointer media query constant", () => {
    expect(COARSE_POINTER_MEDIA_QUERY).toContain("hover: none");
    expect(COARSE_POINTER_MEDIA_QUERY).toContain("pointer: coarse");
  });
});
