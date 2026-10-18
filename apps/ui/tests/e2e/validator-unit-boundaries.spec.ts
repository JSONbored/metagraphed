import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const ROUTE = "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

test("validator detail exposes voting-weight provenance without claiming capital or APY", async ({
  page,
}) => {
  await gotoThroughRestart(page, ROUTE);

  await expect(page.getByText("Capital value", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Voting weight", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Native emission", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/does not establish delegated principal/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Sort by Voting weight/ })).toHaveCount(0);
  await expect(page.locator("#momentum, #peers, #stake")).toHaveCount(0);
  await expect(page.getByText(/hero total is TAO-valued/)).toHaveCount(0);

  // All 116 recorded memberships remain reachable through the bounded table.
  const memberships = page.locator("#memberships");
  const table = memberships.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await memberships.getByRole("button", { name: "Page 5", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(16);
  await expect(table.locator('a[href="/subnets/128"]')).toBeVisible();
  await expect(memberships.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await memberships.getByRole("button", { name: "Page 1", exact: true }).click();
  await expect(table.locator('a[href="/subnets/0"]')).toBeVisible();
});
