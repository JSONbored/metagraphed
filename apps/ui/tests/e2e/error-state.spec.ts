import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";
import { ERROR_API_ORIGIN, ERROR_MESSAGE, prepareErrorStateFixture } from "./error-state-fixtures";

for (const width of [375, 768, 1280]) {
  test(`error recovery leads diagnostics and works by keyboard (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    const fixture = await prepareErrorStateFixture(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await gotoThroughRestart(page, "/settings#keys");
    const panel = page
      .locator("#keys")
      .getByRole("alert")
      .filter({ hasText: "Couldn't load API keys" });
    await expect(panel).toBeVisible();
    const retry = panel.getByRole("button", { name: "Retry", exact: true });
    const disclosure = panel.locator("summary");
    await expect(panel.getByText(ERROR_MESSAGE, { exact: true })).toBeHidden();
    await expect(panel.getByText("HTTP 503", { exact: true })).toBeHidden();
    await expect(panel.getByRole("link", { name: "Open API URL", exact: true })).toHaveCount(0);
    for (const target of [retry, disclosure])
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await retry.focus();
    await page.keyboard.press("Tab");
    await expect(disclosure).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel.getByText(ERROR_MESSAGE, { exact: true })).toBeVisible();
    const message = panel.getByText(ERROR_MESSAGE, { exact: true });
    expect(await message.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(panel.getByText(`${ERROR_API_ORIGIN}/api/v1/keys`, { exact: true })).toBeVisible();
    // Local fixture URLs remain text; the public-link/scheme barrier is also
    // checked with renderToStaticMarkup in states.test.tsx.
    await expect(panel.getByRole("link", { name: "Open API URL", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await disclosure.focus();
    await page.keyboard.press("Space");
    await expect(panel.getByText(ERROR_MESSAGE, { exact: true })).toBeHidden();
    fixture.recover();
    const prior = fixture.requests();
    await retry.click();
    await expect(page.locator("#keys").getByText("No active keys", { exact: true })).toBeVisible();
    expect(fixture.requests()).toBeGreaterThan(prior);
    expect(errors).toEqual([]);
  });
}

test("a failed refresh keeps known table rows visible with one recoverable error", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const fixture = await prepareErrorStateFixture(page, { retained: true });
  await gotoThroughRestart(page, "/settings#keys");
  const keys = page.locator("#keys");
  await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  await keys.getByRole("button", { name: "Generate new key", exact: true }).click();
  const error = keys.getByRole("alert").filter({ hasText: "Couldn't load API keys" });
  await expect(error).toBeVisible();
  await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  await expect(keys.getByText("1 active · 0 pending revocation", { exact: true })).toBeVisible();
  await expect(error.getByText(ERROR_MESSAGE, { exact: true })).toBeHidden();
  await error.locator("summary").click();
  await expect(error.getByText(ERROR_MESSAGE, { exact: true })).toBeVisible();
  fixture.recover();
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(keys.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
});

for (const [status, code, message, retry, network] of [
  [0, undefined, "you're offline", false, undefined],
  [429, undefined, "Rate-limited while loading API keys", false, undefined],
  [503, "data_tier_unavailable", "Data source temporarily unavailable", true, undefined],
  [503, "block_detail_unavailable", "Decoded block detail is catching up", true, undefined],
  [404, "not_found", "Not published for Testnet", false, "testnet"],
] as const) {
  test(`preserves the ${code ?? status} informational state and its recovery policy`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await prepareErrorStateFixture(page, { status, code, network });
    await gotoThroughRestart(page, "/settings#keys");
    const keys = page.locator("#keys");
    await expect(keys.getByRole("status").filter({ hasText: message })).toBeVisible();
    await expect(keys.getByRole("alert")).toHaveCount(0);
    await expect(keys.getByText("Technical details", { exact: true })).toHaveCount(0);
    const button = keys.getByRole("button", { name: "Retry", exact: true });
    await expect(button).toHaveCount(retry ? 1 : 0);
    if (retry) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
}
