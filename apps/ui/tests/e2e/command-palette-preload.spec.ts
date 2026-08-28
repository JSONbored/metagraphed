import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Command palette intent preload", () => {
  test("keeps the palette out of startup, then warms it before a mobile search tap", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const paletteLoads = new Set<string>();
    page.on("request", (request) => {
      if (request.url().includes("/assets/command-palette-body-")) {
        paletteLoads.add(request.url());
      }
    });

    await gotoThroughRestart(page, "/subnets");
    expect(paletteLoads.size, "the optional search body stays out of first paint").toBe(0);

    const trigger = page.getByRole("button", { name: "Open search" });
    await trigger.hover();
    await expect.poll(() => paletteLoads.size).toBe(1);

    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(paletteLoads.size, "opening joins the reader-intent preload").toBe(1);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("does not report an index outage as a zero-result search", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let indexAvailable = false;
    await page.route("**/api/v1/search-index*", async (route) => {
      if (!indexAvailable) {
        await route.fulfill({ status: 503, body: "registry search unavailable" });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      });
    });

    await gotoThroughRestart(page, "/subnets");
    await page.getByRole("button", { name: "Open search" }).click();
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await palette
      .getByPlaceholder("Search subnets, surfaces, endpoints, providers, docs…")
      .fill("zzzx");

    await expect(
      palette
        .getByRole("status")
        .filter({ hasText: "Registry suggestions are temporarily unavailable." }),
    ).toBeVisible();
    await expect(palette.getByText('No matches for "zzzx"')).toBeHidden();

    indexAvailable = true;
    await palette.getByRole("button", { name: "Retry" }).click();
    await expect(palette.getByText('No matches for "zzzx"')).toBeVisible();
  });
});
