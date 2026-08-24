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
// #11613 split the page into a hero and four section components; the
// directory's DataTable lives in its own module, and the page itself now
// declares no table at all. Both halves are read, because the property is
// about the pair: the section owns the one table, and the page owns no
// scroll container that could nest a second bounded scroller inside it.
const subnetsPage = read("../../routes/-subnets-index-page.tsx");
const subnetsDirectory = read("./subnets-index/directory.tsx");
const kitStyles = read("../../../../../packages/ui-kit/src/styles.css");

// #11610: there is now exactly ONE way a table header sticks -- DataTable's
// own <th> rule. `.mg-table-head-pinned` and the ListShell that applied it
// are gone, so this file holds that single rule to what the class used to
// promise.
const dataTableHeadRule = /\.mg-dt-viewport-bounded thead th\s*\{([^}]*)\}/g;

describe("sticky table header anchoring", () => {
  it("keeps the subnets table header inside a bounded scroll container", () => {
    // The premise of every assertion below. If the bounded viewport is ever
    // removed (back to page scroll), `top: 0` becomes the WRONG answer and
    // this whole file should be revisited rather than made to pass.
    //
    // The viewport is the table component's, not this page's: the page used
    // to declare a `max-h` div of its own purely to own the virtualizer's
    // ref, which nested two bounded scrollers and left the outer one inert.
    // #11610 retired both the virtualizer and ListShell here -- /subnets is a
    // DataTable, which owns its one bounded scrollport. The property to hold
    // is unchanged: the page declares no scroll container of its own, so
    // there is exactly one element for the header to pin to.
    expect(subnetsDirectory).toContain("<DataTable");
    for (const [name, src] of [
      ["the page", subnetsPage],
      ["the directory section", subnetsDirectory],
    ] as const) {
      expect(src, `${name} declares a scroll container of its own`).not.toContain(
        "mg-list-viewport",
      );
      expect(src, `${name} declares a height cap of its own`).not.toContain("max-h-");
    }
    // DataTable bounds its viewport the same way, off the same token, and
    // contains scroll chaining -- without that, scrolling past the last row
    // drags the viewport (and the header pinned to its top) up under the app
    // header while the reader is still looking at rows.
    const dtBounded = kitStyles.slice(
      kitStyles.indexOf(".mg-dt-viewport-bounded {"),
      kitStyles.indexOf("}", kitStyles.indexOf(".mg-dt-viewport-bounded {")),
    );
    expect(dtBounded).toContain("max-height: var(--mg-list-viewport-max, 70vh)");
    expect(dtBounded).toContain("overscroll-behavior: contain");
    // ONE element carries both axes. Nesting them does not work -- `overflow-y:
    // auto` coerces `overflow-x` to `auto`, so an inner vertical scroller
    // steals the horizontal axis and strands the affordance on an element that
    // can no longer scroll.
    const dtViewport = kitStyles.slice(
      kitStyles.indexOf(".mg-dt-viewport {"),
      kitStyles.indexOf("}", kitStyles.indexOf(".mg-dt-viewport {")),
    );
    expect(dtViewport).toContain("overflow: auto");
    // The cap must carry a literal fallback. A bare var() that fails to
    // resolve computes `max-height: none`, which silently unbounds the
    // viewport and makes every sticky header in the app inert again --
    // observed once, in this repo, mid-fix.
    expect(kitStyles).toContain("max-height: var(--mg-list-viewport-max, 70vh)");
    expect(kitStyles).toContain("--mg-list-viewport-max: 70vh");
  });

  it("pins every table header to its scrollport, not to the app-header offset", () => {
    const rules = [...kitStyles.matchAll(dataTableHeadRule)];
    expect(rules.length, ".mg-dt-viewport-bounded thead th declares no pin").toBe(1);

    for (const [, body] of rules) {
      expect(body).toContain("position: sticky");
      expect(body).toMatch(/top:\s*0;/);
      // The specific regression: the page-scroll offset used inside the box.
      expect(body).not.toContain("--mg-sticky-offset");
    }
  });

  it("routes every sticky table header through the kit, never a page's own copy", () => {
    // /subnets carried its own `.mg-subnets-sticky-head` copy of the same
    // idea, and that copy is what drifted -- wrong offset, and gated to
    // >=1024px while the table renders from 768px. A page-local definition of
    // "how a table header sticks" is the actual root cause; keeping every one
    // of them in the kit is the fix.
    expect(appStyles).not.toContain(".mg-subnets-sticky-head {");
    expect(subnetsPage).not.toContain("mg-subnets-sticky-head");
    expect(subnetsPage).not.toContain("position: sticky");
    // The one kit-owned pin exists and is held to the rules above.
    expect(kitStyles).toContain(".mg-dt-viewport-bounded thead th {");
    // A third regression the e2e gate catches and source cannot: a sticky
    // header in an UNBOUNDED viewport never moves. The pin is scoped to the
    // bounded viewport so it is never declared where it would be inert.
    expect(kitStyles).not.toMatch(/^ *\.mg-dt thead th \{[^}]*position: sticky/m);
    // And it stays opaque, so a row passing underneath cannot read through.
    // Compared against the CARD's own background rather than a named token:
    // #11695 moved the table onto `--surface-card` so it reads as a surface
    // rather than as a border drawn on the page, and a literal `--canvas` here
    // would have failed for a change that kept the property it guards intact.
    const bgOf = (selector: string) => {
      const rule = new RegExp(`\\n *\\${selector} \\{([^}]*)\\}`).exec(kitStyles);
      return /background:\s*(var\([^)]*\)|#[0-9a-f]+)/i.exec(rule?.[1] ?? "")?.[1] ?? null;
    };
    const headerBg = bgOf(".mg-dt thead th");
    expect(headerBg, "the sticky header must declare a background").not.toBeNull();
    expect(headerBg, "an opaque header, matching the card it sits in").toBe(bgOf(".mg-dt"));
    // And the retired one really is retired, not merely unused.
    expect(kitStyles).not.toContain(".mg-table-head-pinned");
  });

  it("does not gate that stickiness above the width where the table renders", () => {
    // DataTable swaps to cards below 640px, so the table is on screen from
    // there up. The old rule sat inside `@media (min-width: 1024px)`,
    // leaving 768-1023px with a static header that scrolled out of the
    // bounded box entirely -- a full-height table of unlabelled columns.
    // Assert the declaration is not inside a media query, by MATCHING braces
    // rather than counting two different things.
    //
    // This counted every `@media` before the rule against every `}` that
    // began a line at column 0, and passed only because those two numbers
    // happened to be equal. They measure different sets: the rules live
    // inside `@layer components`, so their closing braces are indented and
    // never counted, and the balance was an accident of the sheet's shape.
    // Adding one indented media query anywhere earlier in the file -- for a
    // rule with nothing to do with tables -- turned it red (#11612).
    for (const selector of [".mg-dt-viewport-bounded thead th {"]) {
      const ruleAt = kitStyles.indexOf(selector);
      expect(ruleAt, `${selector} is not in the kit stylesheet`).toBeGreaterThan(-1);
      expect(
        enclosingBlocks(kitStyles, ruleAt).filter((header) => header.includes("@media")),
        `the ${selector} rule is nested inside an @media block`,
      ).toEqual([]);
    }
  });
});

/**
 * The headers of every block still open at `index`, outermost first.
 *
 * A real brace walk: text between the previous block boundary and a `{` is
 * that block's header, and a `}` pops one. Comments and strings are the two
 * places a brace can appear without opening a block, so both are skipped.
 */
function enclosingBlocks(css: string, index: number): string[] {
  const stack: string[] = [];
  let headerStart = 0;
  for (let i = 0; i < index; i += 1) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === "{") {
      stack.push(css.slice(headerStart, i).trim());
      headerStart = i + 1;
    } else if (ch === "}") {
      stack.pop();
      headerStart = i + 1;
    } else if (ch === ";") {
      headerStart = i + 1;
    }
  }
  return stack;
}
