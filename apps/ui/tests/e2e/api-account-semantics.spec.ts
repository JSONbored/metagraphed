import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

test("the API coverage visual uses the published network aggregate", async ({ page }) => {
  await gotoThroughRestart(page, "/apis");

  const coverage = page.getByRole("group", {
    name: "Subnet coverage by public interface type",
  });
  await expect(coverage).toBeVisible();
  await expect(coverage).toContainText("129 / 129");
  await expect(page.locator("section#coverage [data-mg-composition]")).toHaveCount(0);
  await page.locator("section#catalog").scrollIntoViewIfNeeded();
  await expect(page.getByRole("textbox", { name: "Surface kind" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Surface provider" })).toBeVisible();
});

test("account lifecycle facts are visibly separated", async ({ page }) => {
  await gotoThroughRestart(page, "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9");

  await expect(page.locator(".mg-fact-sentence")).toContainText(
    /first seen\s+\d+d ago\s+·\s+last active\s+\d+d ago/i,
  );
});
