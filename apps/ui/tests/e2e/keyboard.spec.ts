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

test.describe("mobile navigation access", () => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 375, height: 568 },
    { width: 768, height: 512 },
  ]) {
    for (const theme of ["light", "dark"] as const) {
      test(`scrolls all navigation content and keeps keyboard access at ${viewport.width}×${viewport.height} in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript((choice) => localStorage.setItem("mg-theme", choice), theme);
        await gotoThroughRestart(page, ROUTE);
        await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
        const trigger = page.getByRole("button", { name: "Open menu", exact: true });
        const originalPageScroll = await page.evaluate(() => window.scrollY);
        await trigger.click();
        const navigation = page.getByRole("dialog", { name: "Site navigation" });
        await expect(navigation.getByRole("button", { name: "Light", exact: true })).toBeVisible();
        await navigation.evaluate((el) =>
          Promise.all(el.getAnimations().map((animation) => animation.finished)),
        );
        await navigation.hover({ position: { x: 140, y: viewport.height - 100 } });
        await page.mouse.wheel(0, 1000);
        const helper = navigation.getByText("Preset for ok / warn / down / unknown dots.", {
          exact: true,
        });
        await expect(helper).toBeInViewport({ ratio: 1 });
        expect(await page.evaluate(() => window.scrollY)).toBe(originalPageScroll);
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();

        await trigger.click();
        await expect(navigation.getByRole("button", { name: "Light", exact: true })).toBeVisible();
        await navigation.getByRole("button", { name: "Close", exact: true }).focus();
        const stops = await navigation.locator("a[href], button").count();
        for (let i = 0; i < stops; i += 1) {
          await page.keyboard.press("Tab");
          const focused = navigation.locator(":focus");
          await expect(focused).toBeInViewport({ ratio: 1 });
          expect(await page.evaluate(() => window.scrollY)).toBe(originalPageScroll);
        }
        const close = navigation.getByRole("button", { name: "Close", exact: true });
        await expect(close).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(navigation.locator(":focus")).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        await expect(close).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Enter");
        await expect(navigation).toBeHidden();
        await expect(trigger).toBeFocused();
      });
    }
  }

  test("touch scrolling reaches the final preferences without moving the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 568 });
    await gotoThroughRestart(page, ROUTE);
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const navigation = page.getByRole("dialog", { name: "Site navigation" });
    await expect(navigation.getByRole("button", { name: "Light", exact: true })).toBeVisible();
    await navigation.evaluate((el) =>
      Promise.all(el.getAnimations().map((animation) => animation.finished)),
    );
    const originalPageScroll = await page.evaluate(() => window.scrollY);
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 140, y: 490 }],
    });
    for (let y = 440; y >= 90; y -= 50) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 140, y }],
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(
      navigation.getByText("Preset for ok / warn / down / unknown dots.", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBe(originalPageScroll);
    await navigation.getByRole("button", { name: "Close", exact: true }).click();
    await expect(navigation).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeFocused();
  });
});
