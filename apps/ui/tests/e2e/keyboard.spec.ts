import { test, expect } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// The keyboard path, which nothing measured until #11689. Three defects it
// found, each invisible to the design gates because none of them changes a
// token, a size or a layout:
//
//   - the skip link scrolled but did not move focus, so the next Tab went back
//     into the nav the reader had just asked to skip;
//   - ⌘K discarded the invoking element, so Escape dropped focus to <body> and
//     the next Tab restarted from the top of the document;
//   - the omnibox rendered with no border width in any state, so the site's
//     primary control had nothing to say it was a field.
//
// Driven on /subnets because it carries the full chrome plus a table: the
// header, the omnibox, the palette and a page's worth of links.
const ROUTE = "/subnets";

test.describe("keyboard", () => {
  test("the skip link moves focus into main, not just the scroll", async ({ page }) => {
    await gotoThroughRestart(page, ROUTE);
    await page.keyboard.press("Tab");
    await expect(page.locator("a:focus")).toHaveText(/skip to main content/i);
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.activeElement;
          const main = document.querySelector("main");
          return Boolean(el && main && (el === main || main.contains(el)));
        }),
      )
      .toBe(true);
  });

  test("the palette returns focus to whatever opened it", async ({ page }) => {
    await gotoThroughRestart(page, ROUTE);
    // A real starting point inside the page, so "returned" means something
    // more than "not body".
    const anchor = page.locator("main a").first();
    await anchor.focus();
    const before = await page.evaluate(() => (document.activeElement as HTMLElement).outerHTML);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return Boolean(dialog && dialog.contains(document.activeElement));
        }),
      )
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement).outerHTML))
      .toBe(before);
  });

  test("the omnibox looks like a field before it is focused", async ({ page }) => {
    await gotoThroughRestart(page, ROUTE);
    const box = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>("header.mg-header input")?.parentElement;
      if (!wrap) return null;
      const cs = getComputedStyle(wrap);
      return { width: parseFloat(cs.borderTopWidth), bg: cs.backgroundColor };
    });
    expect(box, "no omnibox in the header").not.toBeNull();
    // The defect was a border COLOUR with no width: computed 0px in every
    // state, so the control rendered as an icon and placeholder text.
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.bg).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("every focus stop in the header is visible", async ({ page }) => {
    await gotoThroughRestart(page, ROUTE);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const header = document.querySelector("header.mg-header");
        if (!header?.contains(el)) return null;
        const shows = (node: HTMLElement | null) => {
          if (!node) return false;
          const cs = getComputedStyle(node);
          const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
          return outline || cs.boxShadow !== "none";
        };
        return {
          visible: shows(el) || shows(el.parentElement),
          what: `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 18)}`,
        };
      });
      if (!state) continue;
      expect(state.visible, `no focus indicator on ${state.what}`).toBe(true);
    }
  });
});
