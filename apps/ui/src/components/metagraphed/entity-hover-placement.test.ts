import { describe, expect, it } from "vitest";
import {
  ENTITY_HOVER_DEFAULTS,
  MEGA_MENU_HOVER_DEFAULTS,
  resolveEntityHoverPlacement,
} from "./entity-hover-placement";

describe("entity hover placement tokens", () => {
  it("defaults entity cells to top-start with a 250ms open delay", () => {
    expect(ENTITY_HOVER_DEFAULTS).toEqual({
      side: "top",
      align: "start",
      openDelayMs: 250,
      closeDelayMs: 120,
      sideOffset: 8,
    });
  });

  it("places mega-menu previews to the right with a faster open delay", () => {
    expect(MEGA_MENU_HOVER_DEFAULTS.side).toBe("right");
    expect(MEGA_MENU_HOVER_DEFAULTS.openDelayMs).toBe(150);
    expect(MEGA_MENU_HOVER_DEFAULTS.closeDelayMs).toBe(80);
  });

  it("merges partial overrides onto entity defaults", () => {
    expect(resolveEntityHoverPlacement({ side: "right", openDelayMs: 150 })).toEqual({
      side: "right",
      align: "start",
      openDelayMs: 150,
      closeDelayMs: 120,
      sideOffset: 8,
    });
  });

  it("can merge onto mega-menu defaults for nested callers", () => {
    expect(resolveEntityHoverPlacement({ openDelayMs: 90 }, MEGA_MENU_HOVER_DEFAULTS)).toEqual({
      ...MEGA_MENU_HOVER_DEFAULTS,
      openDelayMs: 90,
    });
  });
});
