import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8254: the subnets index rendered 129 watchlist stars at 24x24 CSS px (p-1
// around a size-4 icon) -- well under the 44px touch minimum, and the single
// biggest source of undersized targets on any rebuilt route. The icons are
// deliberately small so they don't dominate a dense card, so the fix is hit
// slop, not a bigger button.
const css = readFileSync(
  fileURLToPath(new URL("../../../../../packages/ui-kit/src/styles.css", import.meta.url)),
  "utf8",
);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const subnets = read("../../routes/-subnets-index-page.tsx");
const validators = read("../../routes/-validators-index-page.tsx");

describe("mg-tap-target (#8254)", () => {
  it("expands the hit area to 44px without changing the painted size", () => {
    const util = css.slice(css.indexOf(".mg-tap-target {"), css.indexOf(".mg-tap-target {") + 800);
    expect(util).toContain("min-width: 44px");
    expect(util).toContain("min-height: 44px");
    // An absolutely-positioned ::after, so the control's own box -- and
    // therefore the surrounding layout -- is untouched.
    expect(util).toContain("position: absolute");
    expect(util).toContain('content: ""');
  });

  it("is gated to coarse pointers so dense desktop rows don't get overlapping hit boxes", () => {
    // On a mouse-driven table the invisible 44px boxes would overlap each
    // other and swallow clicks meant for the neighbouring row.
    expect(css).toContain(
      "@media (pointer: fine) {\n  .mg-tap-target::after {\n    display: none;",
    );
  });

  it("is applied to every watchlist star, the densest undersized control we ship", () => {
    // Both index pages render a star in the card view and again in the table
    // row; all of them carry the utility.
    const stars = (src: string) => (src.match(/mg-tap-target/g) ?? []).length;
    expect(stars(subnets)).toBeGreaterThanOrEqual(3);
    expect(stars(validators)).toBeGreaterThanOrEqual(1);
  });
});
