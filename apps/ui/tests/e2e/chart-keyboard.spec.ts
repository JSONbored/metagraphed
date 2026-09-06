import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const FIXTURE = "/__test/chart-keyboard";
let fixtureScript: string;
let fixtureCss: string;

test.use({ serviceWorkers: "block" });

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [new URL("./chart-keyboard-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  fixtureScript = result.outputFiles[0]!.text;
  fixtureCss = await readFile(
    new URL("../../../../packages/ui-kit/dist/index.css", import.meta.url),
    "utf8",
  );
});

async function openFixture(page: Page) {
  await page.route(`**${FIXTURE}`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/__test/chart-keyboard.css"></head><body><div id="root"></div><script src="/__test/chart-keyboard.js"></script></body></html>',
    }),
  );
  await page.route("**/__test/chart-keyboard.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: fixtureScript }),
  );
  await page.route("**/__test/chart-keyboard.css", (route) =>
    route.fulfill({ contentType: "text/css", body: fixtureCss }),
  );
  await page.route("**/__test/chart-destination?*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Destination</h1>" }),
  );
  await page.goto(FIXTURE);
  await expect(page.getByTestId("activated")).toHaveText("0");
}

test.describe("native chart keyboard navigation", () => {
  test("Enter follows a chart href without a pointer click", async ({ page }) => {
    await openFixture(page);
    await page.getByTestId("ranks").getByRole("link").first().focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/chart-destination\?record=1$/);
  });

  for (const kind of ["rails", "markers", "ranks", "leaders"] as const) {
    test(`${kind} links keep native semantics, arrow traversal and Enter navigation`, async ({
      page,
    }) => {
      await openFixture(page);
      const group = page.getByTestId(kind);
      const links = group.getByRole("link");
      await expect(links).toHaveCount(3);
      await expect(group.locator('a[tabindex="0"]')).toHaveCount(1);
      await links.nth(0).focus();
      await page.keyboard.press("ArrowRight");
      await expect(links.nth(1)).toBeFocused();
      await page.keyboard.press("End");
      await expect(links.nth(2)).toBeFocused();
      await page.keyboard.press("Home");
      await expect(links.nth(0)).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(links.nth(2)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/chart-destination\?record=3$/);
    });
  }

  test("mixed groups skip disabled, decorative and nested marks, and buttons activate once", async ({
    page,
  }) => {
    await openFixture(page);
    const controls = page.getByTestId("controls");
    const first = controls.getByRole("link", { name: "first-link", exact: true });
    const action = controls.getByRole("button", { name: "action-button", exact: true });
    const last = controls.getByRole("link", { name: "last-link", exact: true });
    await page.getByTestId("before-controls").focus();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("activated")).toHaveText("1");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("activated")).toHaveText("2");
    await page.keyboard.press("ArrowRight");
    await expect(last).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(first).toBeFocused();
    await first.press("Space");
    await expect(page).toHaveURL(new RegExp(`${FIXTURE}$`));
    for (const id of ["disabled-link", "disabled-button"]) {
      const disabled = controls.locator(`[data-entity="${id}"]`);
      await expect(disabled).toHaveAttribute("tabindex", "-1");
      await disabled.focus();
      await disabled.press("Enter");
      await disabled.press("Space");
      await expect(page).toHaveURL(new RegExp(`${FIXTURE}$`));
      await expect(page.getByTestId("activated")).toHaveText("2");
    }
    const nested = page.getByTestId("nested-controls");
    await nested.getByRole("link").focus();
    await page.keyboard.press("ArrowRight");
    await expect(nested.getByRole("button")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(nested.getByRole("link")).toBeFocused();
  });

  test("table child links, inputs and disclosure controls keep their native keys", async ({
    page,
  }) => {
    await openFixture(page);
    const row = page.getByTestId("table").locator("tbody tr").first();
    const disclosure = row.getByRole("button", { name: "Expand row" });
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Expanded Record 1", { exact: true })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByText("Expanded Record 1", { exact: true })).toHaveCount(0);
    const input = row.getByRole("textbox");
    await input.fill("note");
    await input.press("Home");
    await input.press("Space");
    await expect(input).toHaveValue(" note");
    await expect(page.getByText("Expanded Record 1", { exact: true })).toHaveCount(0);
    await row.getByRole("link", { name: "Open details" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/chart-destination\?record=1$/);
  });

  test("modifier-click keeps the native link new-tab behavior", async ({ page, context }) => {
    await openFixture(page);
    await context.route("**/__test/chart-destination?*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Destination</h1>" }),
    );
    const popup = context.waitForEvent("page");
    await page
      .getByTestId("ranks")
      .getByRole("link")
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    const opened = await popup;
    await expect(opened).toHaveURL(/chart-destination\?record=1$/);
    await expect(page).toHaveURL(new RegExp(`${FIXTURE}$`));
    await opened.close();
  });

  test("the built site's linked rank specimen navigates by Enter", async ({ page }) => {
    await gotoThroughRestart(page, "/design/primitives");
    const link = page
      .getByRole("group", { name: "Peers by emission (specimen)", exact: true })
      .getByRole("link")
      .first();
    await expect(link).toHaveAttribute("href", "/subnets/1");
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/subnets\/1$/);
  });
});

test.describe("chart links on touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

  test("first tap pins a link, outside tap or Escape clears, and second tap follows it", async ({
    page,
  }) => {
    await openFixture(page);
    const link = page.getByTestId("rails").getByRole("link").first();
    await link.tap();
    await expect(link).toHaveAttribute("data-active", "true");
    await expect(page).toHaveURL(new RegExp(`${FIXTURE}$`));
    await expect(page.getByTestId("rails").locator("[data-mg-tooltip]")).toBeVisible();
    await page.getByTestId("before-controls").tap();
    await expect(link).not.toHaveAttribute("data-active", "true");
    await link.tap();
    await page.keyboard.press("Escape");
    await expect(link).not.toHaveAttribute("data-active", "true");
    await link.tap();
    await link.tap();
    await expect(page).toHaveURL(/chart-destination\?record=1$/);
  });

  test("a table child link follows on its first tap", async ({ page }) => {
    await openFixture(page);
    await page.getByTestId("table").getByRole("link", { name: "Open details" }).first().tap();
    await expect(page).toHaveURL(/chart-destination\?record=1$/);
  });

  test("Enter still follows a link after a touch selection is dismissed", async ({ page }) => {
    await openFixture(page);
    const link = page.getByTestId("rails").getByRole("link").first();
    await link.tap();
    await page.keyboard.press("Escape");
    await expect(link).not.toHaveAttribute("data-active", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/chart-destination\?record=1$/);
  });
});
