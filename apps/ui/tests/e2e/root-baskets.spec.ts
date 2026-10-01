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

for (const generation of ["legacy", "weighted"] as const) {
  test(`${generation} runtime retains holdings and weights without inventing later features`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const data = BASKET_DETAIL.data.data;
    if (data.kind !== "fund") throw new Error("Expected fund fixture");
    const summary = {
      ...data.summary,
      target_weights: [{ netuid: 19, weight_u16: 32767 }],
    };
    await page.route("**/api/v1/root-baskets*", (route) =>
      route.fulfill({
        json: new URL(route.request().url()).searchParams.has("hotkey")
          ? basketResponse(
              {
                ...data,
                summary,
                trading: null,
                pricing: generation === "legacy" ? null : data.pricing,
                baseline: generation === "legacy" ? null : data.baseline,
              },
              generation,
            )
          : basketResponse(
              generation === "legacy"
                ? {
                    kind: "legacy-directory",
                    summaries: [summary],
                    next_after: null,
                    limit: 64,
                  }
                : {
                    kind: "directory",
                    pricing: [BASKET_PRICING],
                    next_after: null,
                    limit: 64,
                  },
              generation,
            ),
      }),
    );
    await gotoThroughRestart(page, `/validators?basket=${BASKET_KEY}`);
    const section = page.locator("section#baskets");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByText("3 alpha_atomic", { exact: true })).toBeVisible();
    await expect(section.getByText("32767", { exact: true })).toBeVisible();
    await expect(section.getByText("Not published by this runtime", { exact: true })).toHaveCount(
      generation === "legacy" ? 3 : 2,
    );
    await expect(section.getByRole("columnheader", { name: "Exact u16 weight" })).toBeVisible();
    if (generation === "legacy") {
      await expect(
        section.getByRole("columnheader", {
          name: "Display price (TAO/β, 4 d.p.)",
        }),
      ).toHaveCount(0);
      await expect(
        section.getByText(/Display pricing and beta indexes were introduced/),
      ).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("API 1 account entitlement remains a marked payout without a dust-aware preview", async ({
  page,
}) => {
  await page.route(`**/api/v1/accounts/${BASKET_ACCOUNT}/root-baskets*`, (route) =>
    route.fulfill({
      json: basketResponse(
        {
          kind: "account",
          ss58: BASKET_ACCOUNT,
          entries: [
            {
              hotkey: BASKET_KEY,
              position: null,
              claim: null,
              entitlement: {
                hotkey: BASKET_KEY,
                owed_shares_atomic: "9007199254740993",
                payout_rao: "9007199254740993",
              },
            },
          ],
          total_relationships: 1,
          next_offset: null,
          offset: 0,
          limit: 16,
        },
        "legacy",
      ),
    }),
  );
  await gotoThroughRestart(page, `/accounts/${BASKET_ACCOUNT}`);
  const section = page.locator("section#root-baskets");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("9007199254740993", { exact: true })).toBeVisible();
  await expect(section.getByText("9007199.254740993 TAO", { exact: true })).toBeVisible();
  await expect(section.getByRole("columnheader", { name: "Exact β atoms" })).toHaveCount(0);
  await expect(section.getByRole("columnheader", { name: "Claim estimate" })).toHaveCount(0);
  await expect(section.getByText(/Marked values are not execution quotes/)).toBeVisible();
});

for (const width of [375, 768, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`native basket values remain readable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => window.localStorage.setItem("mg-theme", value), theme);
      await page.route("**/api/v1/root-baskets*", (route) =>
        route.fulfill({
          json: new URL(route.request().url()).searchParams.has("hotkey")
            ? BASKET_DETAIL
            : basketResponse({
                kind: "directory",
                pricing: [BASKET_PRICING],
                next_after: null,
                limit: 64,
              }),
        }),
      );
      await gotoThroughRestart(page, `/validators?basket=${BASKET_KEY}`);
      const section = page.locator("section#baskets");
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByText("3 alpha_atomic", { exact: true })).toBeVisible();
      await expect(section.getByText("9007199.254740993 TAO", { exact: true })).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.route(`**/api/v1/accounts/${BASKET_ACCOUNT}/root-baskets*`, (route) =>
        route.fulfill({
          json: basketResponse({
            kind: "account",
            ss58: BASKET_ACCOUNT,
            entries: [BASKET_RETAINED_CLAIM],
            total_relationships: 1,
            next_offset: null,
            offset: 0,
            limit: 16,
          }),
        }),
      );
      await gotoThroughRestart(page, `/accounts/${BASKET_ACCOUNT}`);
      const account = page.locator("section#root-baskets");
      await account.scrollIntoViewIfNeeded();
      await expect(account.getByText("9007199.254740993 TAO", { exact: true })).toBeVisible();
      await expect(account.getByRole("link", { name: BASKET_KEY })).toHaveAttribute(
        "href",
        `/validators?basket=${BASKET_KEY}#baskets`,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }
}

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
  const inspect = section.getByRole("button", {
    name: `Inspect basket ${BASKET_KEY}`,
  });
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
