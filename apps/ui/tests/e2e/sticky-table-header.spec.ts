import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { harPathForRoute, DATED_ENDPOINT_PATTERNS, findHarFixture } from "./har-path.ts";

// A sticky <thead> pins against ITS OWN scroll container, and nothing else.
// Every regression in this area has come from getting that one sentence
// wrong, in one of two directions -- both of which shipped simultaneously:
//
//   1. Wrong offset. /subnets pinned its header with
//      `top: var(--mg-sticky-offset)` -- the app-header stack height, which
//      is only meaningful when the PAGE is the scroller. Its real container
//      was a `max-h-[70vh] overflow-y-auto` box, so sticky held the header
//      131px BELOW that box's top edge forever, floating the column labels
//      over the first three rows. That is the screenshot users reported.
//
//   2. Right offset, no container. ListShell's tables declared
//      `sticky top-0` against an `overflow-x-auto` wrapper. Per CSS
//      Overflow 3 §3 a non-`visible` value on one axis coerces the other to
//      `auto`, so that wrapper WAS the container -- but with no max-height
//      it never scrolled, and the declaration was a no-op. The header read
//      as sticky in the markup and scrolled away in the browser.
//
// Case 2 is why this test lives in a browser and not in a source-grep unit
// test: `sticky top-0` is textually perfect in both the broken and the fixed
// tree. Only real layout tells them apart. It is also why the assertions
// below check that the container ACTUALLY SCROLLS before checking where the
// header landed -- an inert sticky header trivially satisfies
// "header top === container top" at rest, so measuring alone would have
// called the broken tree green.
const ROUTES = ["/subnets", "/chain/blocks", "/chain/extrinsics", "/validators"];

// Both sides of the `md` breakpoint where ListShell swaps cards for a table.
// 768 is not decoration: /subnets shipped with its sticky rule gated to
// `@media (min-width: 1024px)` while the table itself renders from 768px, so
// tablet had a `position: static` header that scrolled out of the bounded box
// and left the reader 129 rows of unlabelled numbers.
const VIEWPORTS = [
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

// Playwright's default is 30s per test, and these do not fit in it: the
// settle sequence (goto, up to 5s for networkidle or a 2s fallback, fonts)
// runs before a table wait that has to tolerate /chain/extrinsics taking
// ~10s to paint. Under load that total exceeded 30s and reported as
// "Test timeout of 30000ms exceeded" pointing at the toBeVisible line --
// which reads like the table never rendered, when the budget simply ran out.
// The waits are all for conditions, so fast routes still finish fast.
test.describe.configure({ timeout: 60_000 });

/** Runs in the page. Scrolls every sticky <thead>'s container and reports where it landed. */
function measureStickyHeaders() {
  const results: {
    container: string;
    scrollRange: number;
    headerHeight: number;
    containerScrolls: boolean;
    overscroll: string;
    scrolledBy: number;
    drift: number;
  }[] = [];

  for (const head of Array.from(document.querySelectorAll("thead"))) {
    // Which element carries `position: sticky` differs by table: ListShell
    // routes put it on the <thead>, /subnets puts it on each <th> (the class
    // is applied per column cell). Measure whichever one actually sticks --
    // reading only <thead> reported /subnets as having no sticky header at
    // all, which is a false negative, not a pass.
    const thead: HTMLElement =
      getComputedStyle(head).position === "sticky"
        ? head
        : ((head.querySelector("th") as HTMLElement | null) ?? head);
    if (getComputedStyle(thead).position !== "sticky") continue;

    let node = thead.parentElement;
    let container: HTMLElement | null = null;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY)) {
        container = node;
        break;
      }
      node = node.parentElement;
    }
    // No bounded ancestor at all means the page is the scroller. That is a
    // legitimate arrangement elsewhere in the app (the filter bar, the hub
    // tab strip), but not one any table in these routes uses -- so record it
    // as a container-less entry and let the assertions reject it rather than
    // silently skipping and passing on nothing.
    if (!container) {
      results.push({
        container: "PAGE",
        scrollRange: 0,
        headerHeight: 0,
        containerScrolls: false,
        overscroll: "",
        scrolledBy: 0,
        drift: 0,
      });
      continue;
    }

    const headerHeight = thead.getBoundingClientRect().height;
    const scrollRange = container.scrollHeight - container.clientHeight;
    // Threshold is the header's OWN height, not a constant and not 1px. An
    // unbounded wrapper is not always exactly zero-range: /chain/extrinsics
    // reported scrollHeight 1962 vs clientHeight 1959 -- three sub-pixel
    // rows of slack, enough for a `> clientHeight` check to call the broken
    // tree a real scroller, and enough for the header to "stay pinned"
    // across a 3px scroll. Requiring the container to be able to scroll the
    // header entirely out of view is what makes the pin observable, and it
    // scales with density/font settings instead of guessing a pixel budget.
    const containerScrolls = scrollRange >= headerHeight;
    // Scroll far enough that a non-sticky header is unambiguously gone, but
    // clamp to what the container can actually travel.
    container.scrollTop = Math.min(400, scrollRange);

    results.push({
      container: container.className || container.tagName,
      overscroll: getComputedStyle(container).overscrollBehaviorY,
      scrollRange: Math.round(scrollRange),
      headerHeight: Math.round(headerHeight),
      containerScrolls,
      scrolledBy: container.scrollTop,
      // getBoundingClientRect().top is the border edge; clientTop is the
      // border width, so this compares against the scrollport's top.
      drift: Math.round(
        thead.getBoundingClientRect().top -
          (container.getBoundingClientRect().top + container.clientTop),
      ),
    });
  }
  return results;
}

for (const route of ROUTES) {
  test.describe(route, () => {
    const harPath = harPathForRoute(route);
    if (!existsSync(harPath)) {
      throw new Error(
        `Missing HAR fixture for ${route}: ${harPath}. Run ` +
          `\`npm run test:e2e:record-har --workspace=apps/ui\` against a live dev server first.`,
      );
    }

    for (const viewport of VIEWPORTS) {
      test(`table header pins to its own scrollport at ${viewport.name} (${viewport.width}px)`, async ({
        page,
      }) => {
        // Same replay contract as responsive-overflow.spec.ts -- see the long
        // rationale there for `notFound: "fallback"` and the dated-endpoint
        // re-registration.
        await page.routeFromHAR(harPath, {
          url: "**/api.metagraph.sh/**",
          notFound: "fallback",
          update: false,
        });
        for (const pattern of DATED_ENDPOINT_PATTERNS) {
          const fixture = findHarFixture(harPath, pattern);
          if (fixture) await page.route(pattern, (r) => r.fulfill(fixture));
        }
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route);
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          await page.waitForTimeout(2000);
        }
        await page.evaluate(() => document.fonts.ready);
        // Generous, and measured: /chain/extrinsics needs ~10s to paint its
        // table even on an idle machine, and the default 5s failed only that
        // route, only under 4 parallel workers -- the classic self-inflicted
        // sweep failure. The wait is for the element, so fast routes don't
        // pay it.
        await expect(page.locator("table thead").first()).toBeVisible({ timeout: 20_000 });

        const headers = await page.evaluate(measureStickyHeaders);

        // Guard the guard: if the table stopped rendering, or the <thead>
        // stopped being sticky, every per-header assertion below would pass
        // vacuously and this file would quietly stop testing anything.
        expect(
          headers.length,
          `${route} at ${viewport.width}px rendered no sticky <thead>. Either the ` +
            `table did not render (fixture drift) or the sticky declaration was dropped.`,
        ).toBeGreaterThan(0);

        for (const h of headers) {
          expect(
            h.containerScrolls,
            `${route} at ${viewport.width}px: sticky <thead> inside "${h.container}", which can ` +
              `only scroll ${h.scrollRange}px against a ${h.headerHeight}px header -- the ` +
              `header can never be scrolled out of view, so the sticky declaration does ` +
              `nothing and the labels scroll away with the page. Give the wrapper a ` +
              `max-height, or drop the sticky declaration instead of leaving it inert.`,
          ).toBe(true);

          expect(
            h.overscroll,
            `${route} at ${viewport.width}px: the table viewport ("${h.container}") has ` +
              `overscroll-behavior-y: ${h.overscroll}. On \`auto\`, scrolling past the last ` +
              `row chains to the PAGE, which drags the viewport -- and the header pinned to ` +
              `its top -- up under the app header while the reader is still looking at rows. ` +
              `The header is still correctly pinned; it is just off-screen with its own ` +
              `scrollport. Use \`contain\`.`,
          ).toBe("contain");

          expect(
            h.drift,
            `${route} at ${viewport.width}px: sticky <thead> settled ${h.drift}px from the top ` +
              `of its scrollport ("${h.container}") after scrolling it ${h.scrolledBy}px. ` +
              `A positive drift means the header is floating down over the rows -- almost ` +
              `always a page-chrome offset (--mg-sticky-offset) applied inside a bounded box, ` +
              `where the only correct value is 0.`,
          ).toBe(0);
        }
      });
    }
  });
}
