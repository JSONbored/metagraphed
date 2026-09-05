import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// Keep chunk latency/failure under Playwright control; the PWA cache is tested separately.
test.use({ serviceWorkers: "block" });

const SETTINGS_CHUNK = "**/assets/settings-panel-*.js";

async function delaySettings(page: Page) {
  let release = () => {};
  let requests = 0;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(SETTINGS_CHUNK, async (route) => {
    requests += 1;
    await ready;
    await route.continue();
  });
  return { release: () => release(), count: () => requests };
}

async function openPage(page: Page, width: number) {
  await page.setViewportSize({ width, height: 812 });
  await gotoThroughRestart(page, "/subnets");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
}

test.describe("Deferred preferences", () => {
  test("loads preferences on demand and preserves desktop keyboard navigation", async ({
    page,
  }) => {
    const chunk = await delaySettings(page);
    await openPage(page, 1280);
    expect(chunk.count()).toBe(0);
    const trigger = page.getByRole("button", { name: "Settings", exact: true });
    await trigger.click();
    await expect(page.getByRole("status").filter({ hasText: "Loading settings…" })).toBeVisible();
    expect(chunk.count()).toBe(1);
    chunk.release();
    const light = page.getByRole("button", { name: "Light", exact: true });
    await expect(light).toBeFocused();
    await light.click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("a late settings chunk does not take focus after the popover closes", async ({ page }) => {
    const chunk = await delaySettings(page);
    await openPage(page, 1280);
    const trigger = page.getByRole("button", { name: "Settings", exact: true });
    await trigger.click();
    await expect(page.getByText("Loading settings…", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const responseReady = page.waitForResponse(SETTINGS_CHUNK);
    chunk.release();
    const response = await responseReady;
    await response.finished();
    await page.evaluate(async (url) => {
      await import(url);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, response.url());
    await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("loading mobile preferences preserves the navigation focus", async ({ page }) => {
    const chunk = await delaySettings(page);
    await openPage(page, 375);
    expect(chunk.count()).toBe(0);
    const trigger = page.getByRole("button", { name: "Open menu", exact: true });
    await trigger.click();
    const navigation = page.getByRole("dialog", { name: "Site navigation" });
    await expect(navigation.getByText("Loading settings…", { exact: true })).toBeVisible();
    const subnetLink = navigation.getByRole("link", { name: "Subnets", exact: true });
    await subnetLink.focus();
    chunk.release();
    await expect(navigation.getByRole("button", { name: "Light", exact: true })).toBeVisible();
    await expect(subnetLink).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("a failed preferences chunk offers a working reload recovery", async ({ page }) => {
    let unavailable = true;
    await page.route(SETTINGS_CHUNK, async (route) => {
      if (unavailable) await route.abort("failed");
      else await route.continue();
    });
    await openPage(page, 1280);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Settings could not load.");
    const reload = page.getByRole("button", { name: "Reload settings", exact: true });
    await expect(reload).toBeFocused();
    unavailable = false;
    await Promise.all([page.waitForEvent("load"), reload.click()]);
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Light", exact: true })).toBeFocused();
    await expect(page.getByText("Settings could not load.", { exact: true })).toHaveCount(0);
  });
});
