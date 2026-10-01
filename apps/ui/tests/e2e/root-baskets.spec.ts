import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";
import {
  BASKET_KEY,
  BASKET_CURSOR,
  BASKET_HASH,
  BASKET_ACCOUNT,
  BASKET_PRICING,
  BASKET_DETAIL,
  BASKET_RETAINED_CLAIM,
  basketResponse,
} from "./root-basket-fixtures";

test.use({ serviceWorkers: "block" });

test("basket discovery is lazy, follows empty pages and loads only the chosen fund", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const requests: URL[] = [];
  await page.route("**/api/v1/root-baskets*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    await route.fulfill({
      json: url.searchParams.has("hotkey")
        ? BASKET_DETAIL
        : basketResponse({
            kind: "directory",
            pricing: url.searchParams.has("cursor") ? [BASKET_PRICING] : [],
            next_after: url.searchParams.has("cursor") ? null : BASKET_CURSOR,
            limit: 64,
          }),
    });
  });
  await gotoThroughRestart(page, "/validators");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
  expect(requests).toHaveLength(0);
  const section = page.locator("section#baskets");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("No active funds on this page.")).toBeVisible();
  await section.getByRole("button", { name: "Next basket page" }).click();
  const inspect = section.getByRole("button", { name: `Inspect basket ${BASKET_KEY}` });
  await expect(inspect).toBeVisible();
  expect(requests[1]!.searchParams.get("cursor")).toBe(BASKET_CURSOR);
  expect(requests[1]!.searchParams.get("as_of")).toBe(BASKET_HASH);
  await expect(section.getByText("9007199.254740993 TAO", { exact: true })).toBeVisible();
  expect(requests.filter((url) => url.searchParams.has("hotkey"))).toHaveLength(0);
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`basket=${BASKET_KEY}`));
  await expect(section.getByText("3 alpha_atomic", { exact: true })).toBeVisible();
  await expect(section.getByText("1 rao", { exact: true })).toBeVisible();
  const details = requests.filter((url) => url.searchParams.has("hotkey"));
  expect(details).toHaveLength(1);
  expect(details[0]!.searchParams.get("as_of")).toBe(BASKET_HASH);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await section.getByRole("button", { name: "Latest first page" }).click();
  await expect
    .poll(
      () =>
        requests.filter((url) => !url.searchParams.has("hotkey") && !url.searchParams.has("cursor"))
          .length,
    )
    .toBe(2);
});

test("selected basket reports unsupported state without inventing a balance", async ({ page }) => {
  await page.route("**/api/v1/root-baskets*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          network: "finney",
          status: "unsupported",
          source: null,
          data: null,
        },
        meta: {},
      },
    }),
  );
  await gotoThroughRestart(page, `/validators?basket=${BASKET_KEY}`);
  const section = page.locator("section#baskets");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText(/not supported/)).toHaveCount(2);
  await expect(section.getByText(/Loading finalized/)).toHaveCount(0);
  await expect(section.getByText("0 TAO", { exact: true })).toHaveCount(0);
});

test("account pages retain claims after exit and keep failed reads distinct from empty positions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const requests: URL[] = [];
  let unavailable = false;
  await page.route(`**/api/v1/accounts/${BASKET_ACCOUNT}/root-baskets*`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    await route.fulfill({
      json: unavailable
        ? {
            ok: true,
            data: {
              schema_version: 1,
              network: "finney",
              status: "unavailable",
              source: null,
              data: null,
            },
            meta: {},
          }
        : basketResponse({
            kind: "account",
            ss58: BASKET_ACCOUNT,
            entries: url.searchParams.has("offset")
              ? [BASKET_RETAINED_CLAIM]
              : [{ hotkey: BASKET_CURSOR, position: null, claim: null }],
            total_relationships: 17,
            next_offset: url.searchParams.has("offset") ? null : 16,
            offset: url.searchParams.has("offset") ? 16 : 0,
            limit: 16,
          }),
    });
  });
  await gotoThroughRestart(page, `/accounts/${BASKET_ACCOUNT}`);
  const section = page.locator("section#root-baskets");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText(/Continue to check the next page/)).toBeVisible();
  await section.getByRole("button", { name: "Next relationship page" }).click();
  await expect(section.getByText("9007199.254740993 TAO", { exact: true })).toBeVisible();
  expect(requests[1]!.searchParams.get("offset")).toBe("16");
  expect(requests[1]!.searchParams.get("as_of")).toBe(BASKET_HASH);
  await expect(section.locator(".mg-dt-row")).toHaveCount(1);
  await expect(section).toContainText("separate from free TAO and root principal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  unavailable = true;
  await section.getByRole("button", { name: "Latest first page" }).click();
  await expect(section.getByText(/temporarily unavailable/)).toBeVisible();
  await expect(section.getByText(/No basket entitlement/)).toHaveCount(0);
  unavailable = false;
  await section.getByRole("button", { name: "Retry native positions" }).click();
  await expect(section.getByText(/Continue to check the next page/)).toBeVisible();
});
