import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const HOTKEY = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const NOMINATORS = `**/api/v1/validators/${HOTKEY}/nominators*`;

async function scrollSectionIntoView(page: Page, id: string) {
  await page.locator(`section#${id}`).evaluate((element) => {
    element.scrollIntoView({ block: "center" });
    window.dispatchEvent(new Event("scroll"));
  });
}

test.describe("Validator detail secondary query states", () => {
  test("defers movement evidence and omits unsupported capital-history and peer reads", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nominatorReads = 0;
    let unsupportedReads = 0;
    await page.route(NOMINATORS, async (route) => {
      nominatorReads += 1;
      await continueReads;
      await route.continue();
    });
    for (const pattern of [
      `**/api/v1/validators/${HOTKEY}/history*`,
      "**/api/v1/validators/operators*",
    ]) {
      await page.route(pattern, async (route) => {
        unsupportedReads += 1;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, `/validators/${HOTKEY}`);
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    const nominators = page.getByRole("group", { name: "Nominators by stake moved" });
    await expect(nominators).toHaveAttribute("aria-busy", "true");
    expect(nominatorReads).toBe(0);
    await scrollSectionIntoView(page, "nominators");
    await expect.poll(() => nominatorReads, { timeout: 15_000 }).toBe(1);
    await expect(nominators.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(page.getByText("Loading nominator movement · chain-direct")).toBeVisible();
    const completedRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/nominators"),
    );
    release?.();
    await completedRead;
    await expect(nominators).not.toHaveAttribute("aria-busy", "true");
    expect(unsupportedReads).toBe(0);
    await expect(page.locator("#momentum, #peers")).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("keeps failed movement evidence scoped and retryable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    let failReads = true;
    await page.route(NOMINATORS, async (route) => {
      if (!failReads) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_failure", message: "Secondary record fixture failed" },
        }),
      });
    });
    await gotoThroughRestart(page, `/validators/${HOTKEY}`);
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await scrollSectionIntoView(page, "nominators");
    const error = page.locator("#nominators").getByRole("alert");
    await expect(error).toContainText("Couldn't load nominator movement", { timeout: 15_000 });
    await expect(page.getByText(/does not establish delegated principal/)).toBeVisible();
    failReads = false;
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(error).toHaveCount(0);
  });
});
