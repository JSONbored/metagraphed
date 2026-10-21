import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Footer company attribution", () => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    for (const theme of ["light", "dark"]) {
      test(`stays visible at ${viewport.width}px in ${theme} mode`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.addInitScript((value) => localStorage.setItem("mg-theme", value), theme);
        await gotoThroughRestart(page, "/");

        const attribution = page
          .getByRole("contentinfo")
          .getByText("Operated by carbonZERO LLC", { exact: true });
        await expect(attribution).toHaveCount(1);
        await attribution.scrollIntoViewIfNeeded();
        await expect(attribution).toBeVisible();
        await expect(attribution).toBeInViewport();

        const bounds = await attribution.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        const contrast = await attribution.evaluate((element) => {
          const luminance = (color: string) => {
            const channels = color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number);
            const linear = channels.map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
          };
          const foreground = luminance(getComputedStyle(element).color);
          const background = luminance(getComputedStyle(document.body).backgroundColor);
          return (
            (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
          );
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        const mutedColor = await attribution.evaluate((element) => getComputedStyle(element).color);
        for (const name of ["GitHub repository", "Discord community"]) {
          await expect(page.getByRole("contentinfo").getByRole("link", { name })).toHaveCSS(
            "color",
            mutedColor,
          );
        }
        // The local fixture API URL is intentionally rejected by ExternalLink,
        // which renders the RSS icon in a safe span rather than a link.
        const rssFallback = page
          .getByRole("contentinfo")
          .locator("span")
          .filter({ has: page.locator("svg.lucide-rss") });
        await expect(rssFallback).toHaveCount(1);
        await expect(rssFallback).not.toHaveAttribute("href");
        await expect(rssFallback).toHaveCSS("color", mutedColor);
        await page.screenshot({
          path: testInfo.outputPath(`footer-after-${viewport.width}-${theme}.png`),
        });
      });
    }
  }

  for (const route of ["/about", "/docs", "/this-page-does-not-exist"]) {
    test(`appears in the shared footer on ${route}`, async ({ page }) => {
      await gotoThroughRestart(page, route);
      await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
      if (route === "/this-page-does-not-exist") {
        await expect(page.getByRole("heading", { name: "Nothing at this URL" })).toBeVisible();
      }
      const attribution = page
        .getByRole("contentinfo")
        .getByText("Operated by carbonZERO LLC", { exact: true });
      await expect(attribution).toHaveCount(1);
      await attribution.scrollIntoViewIfNeeded();
      await expect(attribution).toBeVisible();
      await expect(attribution).toBeInViewport();
    });
  }

  for (const theme of ["light", "dark"]) {
    test(`remains readable at 200% zoom on mobile in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.addInitScript((value) => localStorage.setItem("mg-theme", value), theme);
      await gotoThroughRestart(page, "/about");
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      const attribution = page
        .getByRole("contentinfo")
        .getByText("Operated by carbonZERO LLC", { exact: true });
      await attribution.scrollIntoViewIfNeeded();
      await expect(attribution).toBeVisible();
      await expect(attribution).toBeInViewport();
      const bounds = await attribution.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
      await page.screenshot({
        path: testInfo.outputPath(`footer-after-mobile-${theme}-200pct.png`),
      });
    });
  }
});

test.describe("Deferred footer freshness", () => {
  test("keeps source provenance unknown until its lazy reading settles", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/freshness*", async (route) => {
      await continueRead;
      await route.continue();
    });

    await gotoThroughRestart(page, "/subnets/19");

    const footer = page.getByRole("contentinfo");
    await footer.scrollIntoViewIfNeeded();
    const freshness = footer.locator('[aria-live="polite"]');
    await expect(freshness).toHaveAttribute("aria-busy", "true");
    await expect(freshness).toContainText("sources —");
    await expect(freshness).toContainText("stale —");
    await expect(freshness).not.toContainText("sources 0");
    await expect(freshness).not.toContainText("stale 0");

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(freshness).not.toHaveAttribute("aria-busy", "true");
    await expect(freshness).toContainText(/sources \d+/);
    await expect(freshness).toContainText(/stale \d+/);
  });
});
