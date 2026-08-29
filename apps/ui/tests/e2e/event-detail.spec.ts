import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const ROUTE = "/events/8713384/320";

test.describe("addressable event detail", () => {
  test("shows decoded context and full arguments without mobile overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, ROUTE);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Balances.Transfer");
    await expect(page.getByRole("link", { name: "Open extrinsic" })).toHaveAttribute(
      "href",
      "/extrinsics/8713384-11",
    );
    await expect(page.getByText("Transferred 1.27 τ", { exact: false })).toBeVisible();

    const record = page.locator("[data-mg-raw][open]");
    await expect(record).toContainText("arg.from");
    await expect(record).toContainText("arg.to");
    await expect(record).toContainText("arg.amount");
    await expect(record.getByRole("button", { name: "Copy arg.from" })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("renders a real not-found boundary for an absent event index", async ({ page }) => {
    const response = await gotoThroughRestart(page, "/events/8713384/999999");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Event not found" })).toBeVisible();
  });
});
