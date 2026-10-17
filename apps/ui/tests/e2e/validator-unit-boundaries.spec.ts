import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const ROUTE = "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

test("validator detail exposes voting-weight provenance without claiming capital or APY", async ({ page }) => {
  await gotoThroughRestart(page, ROUTE);

  await expect(page.getByText("Capital value", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Voting weight", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Native emission", exact: true })).toBeVisible();
  await expect(page.getByText(/does not establish delegated principal/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Sort by Voting weight/ })).toHaveCount(0);
  await expect(page.locator("#momentum, #peers, #stake")).toHaveCount(0);
  await expect(page.getByText(/hero total is TAO-valued/)).toHaveCount(0);
});
