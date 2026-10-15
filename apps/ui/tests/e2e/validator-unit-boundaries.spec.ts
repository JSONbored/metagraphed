import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const ROUTE = "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

test("validator detail separates voting weight from native holdings and subnet rewards", async ({
  page,
}) => {
  await gotoThroughRestart(page, ROUTE);

  await expect(page.getByRole("button", { name: "What is Stake value (τ)" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Voting weight" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Stake (α)" })).toHaveCount(0);
  const stakeValue = page.locator(".mg-fact").filter({ hasText: "Stake value (τ)" });
  await expect(stakeValue.getByRole("definition")).toHaveText("—");
  const apy = page.locator(".mg-fact").filter({ hasText: "Est. APY" });
  await expect(apy.getByRole("definition")).toHaveText("—");
  await expect(page.getByRole("columnheader", { name: "Emission (α)" })).toBeVisible();
  await expect(
    page.getByText(/Native holdings and a priced portfolio total are unavailable from this source/),
  ).toBeVisible();
  await expect(page.getByText(/units vary by subnet; the hero total is TAO-valued/i)).toHaveCount(
    0,
  );
});
