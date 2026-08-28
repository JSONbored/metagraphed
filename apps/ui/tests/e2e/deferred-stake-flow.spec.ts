import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("Deferred delegation flow", () => {
  test("keeps the chain signing surface out of a subnet detail load until the reader asks for it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoThroughRestart(page, "/subnets/19");

    const delegate = page.getByRole("button", { name: "Delegate", exact: true });
    await expect(delegate).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("stake-unstake-modal")),
        ),
      )
      .toBe(false);

    await delegate.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("No wallet extension found")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("stake-unstake-modal")),
        ),
      )
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Delegate", exact: true })).toBeFocused();
  });
});
