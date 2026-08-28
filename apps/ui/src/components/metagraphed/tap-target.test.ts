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
const compareToggles = read("./compare-toggle.tsx");

describe("mg-tap-target (#8254)", () => {
  it("expands the hit area to 44px without changing the painted size", () => {
    // Sliced from the ::after RULE rather than from a literal `.mg-tap-target {`
    // (#11683): the recipe is a selector list now -- the row disclosure, the
    // range option, the table menu, the pager, "Show all" and the section nav
    // share it -- so pinning one spelling made this go blind the moment another
    // control was given the same treatment.
    const start = css.indexOf(".mg-tap-target::after");
    expect(start, "the tap-target recipe is gone").toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf("}", start) + 1);
    expect(rule).toContain("min-width: 44px");
    expect(rule).toContain("min-height: 44px");
    // An absolutely-positioned ::after, so the control's own box -- and
    // therefore the surrounding layout -- is untouched.
    expect(rule).toContain("position: absolute");
    expect(rule).toContain('content: ""');
  });

  it("gives every undersized shared control the same hit area", () => {
    // Measured on a Pixel 5 (#11683): /validators alone rendered 25 row
    // disclosures under 44px, and the pager, range switch, table menu,
    // inline refresh, glossary, "Show all," and the section nav were under it
    // on nearly every route.
    // Named here so removing one from the sheet fails rather than silently
    // shrinking a thumb target back.
    const start = css.indexOf(".mg-tap-target::after");
    const rule = css.slice(start, css.indexOf("{", start));
    for (const selector of [
      ".mg-dt-disclosure::after",
      ".mg-range-option::after",
      ".mg-dt-menu-trigger::after",
      ".mg-dt-pager button::after",
      ".mg-section-more::after",
      ".mg-section-nav a::after",
      ".mg-live-meta-refresh::after",
      ".mg-rails-more::after",
      ".mg-definition-button::after",
      ".mg-definition-trigger::after",
      'button[aria-label="Back to top"]::after',
    ]) {
      expect(rule, `${selector} lost its hit area`).toContain(selector);
    }
  });

  it("is gated to coarse pointers so dense desktop rows don't get overlapping hit boxes", () => {
    // On a mouse-driven table the invisible 44px boxes would overlap each
    // other and swallow clicks meant for the neighbouring row.
    const gate = css.slice(css.indexOf("@media (pointer: fine) {"));
    const body = gate.slice(0, gate.indexOf("\n}"));
    expect(body).toContain(".mg-tap-target::after");
    expect(body).toContain("display: none");
    // Every control that gets the slop must also be released from it on a
    // mouse, or the invisible boxes overlap and swallow neighbouring clicks.
    for (const selector of [
      ".mg-dt-disclosure",
      ".mg-range-option",
      ".mg-dt-pager button",
      ".mg-live-meta-refresh",
      ".mg-rails-more",
      ".mg-definition-button",
      ".mg-definition-trigger",
      'button[aria-label="Back to top"]',
    ]) {
      expect(body, `${selector} keeps its hit slop on a mouse`).toContain(`${selector}::after`);
    }
  });

  it("is applied to every compare checkbox, the densest undersized control we ship", () => {
    // #11610 removed the hand-written mobile card branch from both index
    // pages -- DataTable renders one DOM in every mode, so there is no longer
    // a second, card-only star for the same row. Counting render paths would
    // now pin a number that says nothing; the bar is per-CONTROL: every
    // watchlist toggle in these files carries the utility, however many the
    // page happens to render.
    //
    // Both index pages dropped the star: /subnets in #11613 and /validators in
    // #11616. Watching an entity is an action you take on its own page, where
    // there is room for the affordance and only one of it.
    //
    // The subject moved rather than vanished. The densest undersized control
    // the app still ships is the compare checkbox -- one per row on both index
    // tables -- so that is what this now holds to the 44px rule.
    // Slice from each `<button` rather than regexing to its closing `>`: an
    // attribute value can itself contain a `>` (a ternary, a JSX arrow), and a
    // lazy match stops there and never reaches the className.
    const buttons = [...compareToggles.matchAll(/<button/g)].map((match) =>
      compareToggles.slice(match.index, match.index + 500),
    );
    // Guard the guard: a rewrite that stopped rendering a button would
    // otherwise empty the set and pass on nothing.
    expect(buttons.length, "compare-toggle renders no button").toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toContain("mg-compare-toggle");
      expect(button).toContain("mg-tap-target");
    }
    // And the class carries the hit slop, in the sheet rather than per call site.
    expect(css).toMatch(/\.mg-compare-toggle \{[^}]*width: 16px/);
    expect(css).toContain(".mg-tap-target::after");
  });
});
