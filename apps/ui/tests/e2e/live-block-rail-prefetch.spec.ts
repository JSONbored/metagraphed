import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Live block rail intent prefetch", () => {
  test("warms only a block record and ledger the reader dwells on before opening it", async ({
    page,
  }) => {
    const blockFixture = await page.request.get("http://127.0.0.1:8081/api/v1/blocks/8713384");
    expect(blockFixture.ok()).toBe(true);
    const blockBody = await blockFixture.body();
    const extrinsicsFixture = await page.request.get(
      "http://127.0.0.1:8081/api/v1/blocks/8713384/extrinsics?limit=100",
    );
    expect(extrinsicsFixture.ok()).toBe(true);
    const extrinsicsBody = await extrinsicsFixture.body();
    let blockRequests = 0;
    let ledgerRequests = 0;
    let release: (() => void) | undefined;
    const continueRead = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route("**/api/v1/blocks/*/extrinsics*", async (route) => {
      ledgerRequests += 1;
      await continueRead;
      await route.fulfill({
        status: extrinsicsFixture.status(),
        contentType: extrinsicsFixture.headers()["content-type"] ?? "application/json",
        body: extrinsicsBody,
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoThroughRestart(page, "/");

    const firstBlock = page.locator("a.mg-live-block").first();
    await expect(firstBlock).toBeVisible();
    const href = await firstBlock.getAttribute("href");
    expect(href).toMatch(/^\/blocks\/\d+$/);
    await page.route("**/api/v1/blocks/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/v1${href}`) {
        blockRequests += 1;
        await route.fulfill({
          status: blockFixture.status(),
          contentType: blockFixture.headers()["content-type"] ?? "application/json",
          body: blockBody,
        });
      } else {
        await route.continue();
      }
    });

    await firstBlock.hover();
    await expect.poll(() => blockRequests).toBe(1);
    await expect.poll(() => ledgerRequests).toBe(1);

    await firstBlock.click();
    await expect(page).toHaveURL(/\/blocks\/\d+$/);
    release?.();
    await expect(page.getByRole("table", { name: "Extrinsics in this block" })).toBeVisible();
    await expect.poll(() => blockRequests).toBe(1);
    await expect.poll(() => ledgerRequests).toBe(1);
  });
});
