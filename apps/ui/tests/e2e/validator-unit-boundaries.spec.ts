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
