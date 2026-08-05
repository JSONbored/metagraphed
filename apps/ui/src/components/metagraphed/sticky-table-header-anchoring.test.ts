import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The geometry this protects is asserted for real, in a real browser, by
// tests/e2e/sticky-table-header.spec.ts -- that spec is the one that can tell
// a pinned header from an inert one, and neither of these bugs was visible in
// source. This file covers what that spec cannot reach: /subnets has no HAR
// fixture (the overflow sweep covers /subnets/1, not the index), and it is
// the route where the bug was reported.
//
// The rule: a <thead>/<th> pinned inside a bounded scroll container offsets by
// 0. --mg-sticky-offset is the app-header stack height, published by AppShell
// for things that stick against the PAGE (the hub tab strip, the filter bar).
// Applying it inside a bounded box does not push the header below the app
// header -- it pushes it that far down INSIDE the table, floating it over the
// first rows. Measured on /subnets before the fix: container top 559px,
// header top 690px, in a 504px-tall scrollport.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const appStyles = read("../../styles.css");
const subnetsPage = read("../../routes/-subnets-index-page.tsx");
const kitStyles = read("../../../../../packages/ui-kit/src/styles.css");
const listShell = read("../../../../../packages/ui-kit/src/components/metagraphed/list-shell.tsx");

const pinnedRule = /\.mg-table-head-pinned\s*\{([^}]*)\}/g;

describe("sticky table header anchoring", () => {
  it("keeps the subnets table header inside a bounded scroll container", () => {
    // The premise of every assertion below. If the bounded viewport is ever
    // removed (back to page scroll), `top: 0` becomes the WRONG answer and
    // this whole file should be revisited rather than made to pass.
    //
    // The viewport is ListShell's, not this page's: the page used to declare
    // a second `max-h` div of its own purely to own the virtualizer's ref,
    // which nested two bounded scrollers and left the outer one inert. It now
    // hands that ref to the shell instead, so the element the virtualizer
    // measures and the element the header pins to are the same one.
    expect(subnetsPage).toContain("viewportRef={tableScrollRef}");
    expect(subnetsPage).not.toContain("mg-list-viewport");
    // ONE element carries both classes: .mg-table-scroll for the edge-fade and
    // thin scrollbar, .mg-list-viewport for the height cap, both overflow axes
    // and overscroll containment. Nesting them does not work -- `overflow-y:
    // auto` coerces `overflow-x` to `auto`, so an inner vertical scroller
    // steals the horizontal axis and strands the affordance on an element that
    // can no longer scroll.
    expect(listShell).toContain('"mg-table-scroll mg-list-viewport"');
    // `stickyHeader={false}` drops the bounded box along with the pin.
    expect(listShell).toContain('"mg-table-scroll overflow-x-auto"');
    // The cap must carry a literal fallback. A bare var() that fails to
    // resolve computes `max-height: none`, which silently unbounds the
    // viewport and makes every sticky header in the app inert again --
    // observed once, in this repo, mid-fix.
    expect(kitStyles).toContain("max-height: var(--mg-list-viewport-max, 70vh)");
    expect(kitStyles).toContain("--mg-list-viewport-max: 70vh");
  });

  it("pins every table header to its scrollport, not to the app-header offset", () => {
    const rules = [...kitStyles.matchAll(pinnedRule)];
    expect(rules.length, "no .mg-table-head-pinned rule found").toBeGreaterThan(0);

    for (const [, body] of rules) {
      expect(body).toContain("position: sticky");
      expect(body).toMatch(/top:\s*0;/);
      // The specific regression: the page-scroll offset used inside the box.
      expect(body).not.toContain("--mg-sticky-offset");
      // And the second one: a translucent header lets the row passing
      // underneath read through the column labels.
      expect(body).toContain("background: var(--card)");
    }
  });

  it("routes every sticky table header through that one class", () => {
    // /subnets carried its own `.mg-subnets-sticky-head` copy of the same
    // idea, and that copy is what drifted -- wrong offset, and gated to
    // >=1024px while the table renders from 768px. Two definitions of "how a
    // table header sticks" is the actual root cause; one is the fix.
    expect(appStyles).not.toContain(".mg-subnets-sticky-head {");
    expect(subnetsPage).not.toContain("mg-subnets-sticky-head");
    expect(subnetsPage).toContain("mg-table-head-pinned");
  });

  it("does not gate that stickiness above the width where the table renders", () => {
    // ListShell swaps to cards below `md` (768px), so the table is on screen
    // from 768px up. The old rule sat inside `@media (min-width: 1024px)`,
    // leaving 768-1023px with a static header that scrolled out of the
    // bounded box entirely -- a full-height table of unlabelled columns.
    // Assert the declaration sits at the top level of the sheet: count the
    // media queries opened before it against the block-closing braces.
    const ruleAt = kitStyles.indexOf(".mg-table-head-pinned {");
    expect(ruleAt).toBeGreaterThan(-1);
    const before = kitStyles.slice(0, ruleAt);
    const opens = (before.match(/@media/g) ?? []).length;
    const closes = (before.match(/^}/gm) ?? []).length;
    expect(
      opens,
      "the .mg-table-head-pinned rule is nested inside an unclosed @media block",
    ).toBeLessThanOrEqual(closes);
  });
});
