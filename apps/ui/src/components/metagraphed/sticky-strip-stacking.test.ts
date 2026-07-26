import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8254: at 390px the app header, the page's sticky tab strip, and the list
// filter bar all pinned to the viewport. The header publishes its height as
// --mg-sticky-offset, but both the tab strip AND the filter bar read that same
// value as their `top` -- so on /chain, /chain/blocks, /chain/extrinsics and
// /surfaces the filter bar sat *on top of* the tab strip on every scroll
// (measured: both at top: 94px). The strips now publish their own measured
// height as --mg-tabs-h and everything below stacks under it.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const hook = read("../../hooks/use-sticky-strip-height.ts");
const hubTabs = read("./hub-tabs.tsx");
const profileTabs = read("./profile-tabs.tsx");
const endpointList = read("./endpoint-operational-list.tsx");

describe("sticky strip stacking (#8254)", () => {
  it("publishes the strip height on the document root and removes it on unmount", () => {
    // Removal is what keeps a page with no strip from inheriting a phantom
    // offset left behind by the previous route.
    expect(hook).toContain('setProperty(\n        "--mg-tabs-h"');
    expect(hook).toContain('removeProperty("--mg-tabs-h")');
    // ResizeObserver, not a one-shot measure: the strip's height changes when
    // tab labels wrap or a count badge appears.
    expect(hook).toContain("new ResizeObserver(publish)");
  });

  it("is used by both sticky tab strips, so neither hand-rolls the measurement", () => {
    for (const [name, src] of [
      ["hub-tabs", hubTabs],
      ["profile-tabs", profileTabs],
    ] as const) {
      expect(src, name).toContain("useStickyStripHeight(");
      // Neither should still be setting the variable itself.
      expect(src, name).not.toContain("setProperty(");
    }
  });

  it("has consumers offset by the strip height rather than pinning to the header alone", () => {
    expect(endpointList).toContain(
      "calc(var(--mg-sticky-offset, 3.5rem) + var(--mg-tabs-h, 3.75rem))",
    );
  });
});
