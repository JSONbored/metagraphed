import { describe, expect, it } from "vitest";
import { MEGA_MENU_HOVER_DEFAULTS } from "./entity-hover-placement";
import type { MegaMenuLivePreviewItem } from "./mega-menu-live-preview-link";

/**
 * Structural contract for mega-menu live rows (#5337). Vitest here is limited
 * to `.test.ts` (no RTL), so we pin the placement wiring the component relies
 * on rather than mounting React.
 */
describe("MegaMenuLivePreviewLink contract", () => {
  it("accepts subnet and provider live items with a numeric/string preview id", () => {
    const subnet: MegaMenuLivePreviewItem = {
      kind: "subnet",
      to: "/subnets/$netuid",
      params: { netuid: "1" },
      label: "Root",
      sub: "SN1",
      previewId: 1,
    };
    const provider: MegaMenuLivePreviewItem = {
      kind: "provider",
      to: "/providers/$slug",
      params: { slug: "opentensor" },
      label: "OpenTensor",
      sub: "opentensor",
      previewId: "opentensor",
    };
    expect(subnet.kind).toBe("subnet");
    expect(provider.kind).toBe("provider");
    expect(typeof subnet.previewId).toBe("number");
    expect(typeof provider.previewId).toBe("string");
  });

  it("uses mega-menu placement that enables EntityHoverCard's right-side preview", () => {
    expect(MEGA_MENU_HOVER_DEFAULTS.side).toBe("right");
    expect(MEGA_MENU_HOVER_DEFAULTS.align).toBe("start");
  });
});
