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
    // #11610 removed the hand-written mobile card branch from both index
    // pages -- DataTable renders one DOM in every mode, so there is no longer
    // a second, card-only star for the same row. Counting render paths would
    // now pin a number that says nothing; the bar is per-CONTROL: every
    // watchlist toggle in these files carries the utility, however many the
    // page happens to render.
    //
    // /subnets dropped out of this list in #11613: its directory carries the
    // columns that decide between subnets and nothing else, and following one
    // is an action you take on the subnet's own page. /validators still ships
    // the control, so the assertion still has a subject -- the guard below
    // fails loudly if that stops being true.
    const watchToggles = (src: string) =>
      [...src.matchAll(/<button[\s\S]{0,900}?<\/button>/g)]
        .map((match) => match[0])
        .filter((button) => /aria-label=\{[\s\S]*?watchlist/.test(button));
    for (const [name, src] of [["validators", validators]] as const) {
      const toggles = watchToggles(src);
      // Guard the guard: a rename of the aria-label would otherwise empty the
      // set and pass on nothing.
      expect(toggles.length, `${name} renders no watchlist toggle`).toBeGreaterThan(0);
      for (const toggle of toggles) expect(toggle).toContain("mg-tap-target");
    }
  });
});
