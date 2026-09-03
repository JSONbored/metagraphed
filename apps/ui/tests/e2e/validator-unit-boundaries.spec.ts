import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const ROUTE = "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

test("validator detail distinguishes TAO-valued totals from per-subnet alpha", async ({ page }) => {
  await gotoThroughRestart(page, ROUTE);

  await expect(page.getByRole("button", { name: "What is Stake value (τ)" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Stake (α)" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Emission (α)" })).toBeVisible();
  await expect(page.getByText(/units vary by subnet; the hero total is TAO-valued/i)).toBeVisible();
});

test("operator directory leads with results and resets paging after filters and sorting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoThroughRestart(page, "/validators");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);

  const directory = page.locator("section#operators");
  const rows = directory.locator("tbody > .mg-dt-row");
  await expect(page.locator("main section.mg-section").first()).toHaveAttribute("id", "operators");
  await expect(rows).toHaveCount(50);
  await expect(directory.getByRole("columnheader", { name: "Memberships" })).toHaveCount(0);
  await expect(directory.getByRole("columnheader", { name: "Total stake" })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  const firstName = rows.first().getByRole("link");
  await expect(firstName).toContainText("tao.bot");
  expect((await firstName.boundingBox())!.y).toBeLessThan(800);

  await directory.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(directory.locator(".mg-dt-range")).toContainText("51–100");
  await directory.getByRole("searchbox", { name: "Search Operators" }).fill("Yuma");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("86 hotkeys");
  await expect(page).toHaveURL(/q=Yuma/);
  await rows.first().getByRole("button", { name: "Expand row" }).press("Enter");
  await expect(directory.locator(".mg-dt-expansion a")).toHaveCount(86);
  await rows.first().getByRole("button", { name: "Collapse row" }).press("Enter");
  await expect(directory.locator(".mg-dt-expansion")).toHaveCount(0);

  await directory.getByRole("button", { name: "Clear filters" }).click();
  await directory.getByRole("button", { name: "Page 2", exact: true }).click();
  await directory.getByRole("combobox", { name: "Sort by", exact: true }).selectOption("name:asc");
  await expect(directory.locator(".mg-dt-range")).toContainText("1–50");
  await expect(
    directory.getByRole("columnheader", { name: "Operator", exact: true }),
  ).toHaveAttribute("aria-sort", "ascending");

  await directory.getByRole("searchbox", { name: "Search Operators" }).fill("no-such-operator");
  await expect(
    directory.getByText("No operators match these filters", { exact: true }),
  ).toBeVisible();
  await directory.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows).toHaveCount(50);
});

test("mobile comparison keeps operator names and identifies the selected hotkey scope", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoThroughRestart(page, "/validators");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);

  const directory = page.locator("section#operators");
  const firstName = directory.locator("tbody > .mg-dt-row").first().getByRole("link");
  expect((await firstName.boundingBox())!.y).toBeLessThan(812);
  await expect(directory.getByRole("combobox", { name: "Sort by", exact: true })).toBeVisible();

  const tao = directory.getByRole("checkbox", { name: "Add tao.bot to compare", exact: true });
  await tao.focus();
  await page.keyboard.press("Space");
  await expect(
    directory.getByRole("checkbox", { name: "Remove tao.bot from compare", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await directory
    .getByRole("checkbox", { name: "Add Yuma, a DCG Company largest-stake hotkey to compare" })
    .click();

  const dock = directory.locator(".mg-compare-dock");
  await expect(dock).toContainText("Largest hotkeys");
  await expect(dock.getByRole("button", { name: "Remove tao.bot from compare" })).toBeVisible();
  await expect(
    dock.getByRole("button", { name: "Remove Yuma, a DCG Company from compare" }),
  ).toBeVisible();
  const compare = dock.getByRole("link", { name: "Compare 2", exact: true });
  await expect(compare).toHaveAttribute(
    "href",
    /validators=5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u.*5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1/,
  );
  await directory
    .getByRole("checkbox", { name: "Add Kraken largest-stake hotkey to compare" })
    .click();
  await expect(directory.getByRole("checkbox", { name: "Add Taostats to compare" })).toBeDisabled();
  await expect(dock.getByRole("link", { name: "Compare 3", exact: true })).toHaveAttribute(
    "href",
    /5Ckaoft1B1CQ9zBV2FLVju4KPuMQzJVn7QUf3JeTvTq1uUes/,
  );

  await directory.getByRole("searchbox", { name: "Search Operators" }).fill("Kraken");
  await expect(dock).toContainText("tao.bot");
  await expect(dock).toContainText("Yuma, a DCG Company");
  await dock.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(dock).toHaveCount(0);
});
