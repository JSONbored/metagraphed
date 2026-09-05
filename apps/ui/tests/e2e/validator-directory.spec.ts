import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

// This spec supplies synthetic operator responses through page.route. Keep
// service-worker-controlled navigation outside that fixture boundary.
test.use({ serviceWorkers: "block" });

const KNOWN_HOTKEY = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const LONG_OPERATOR_NAME = `Operator 00${"X".repeat(180)}`;
const member = (index: number) => `synthetic-hotkey-${String(index).padStart(3, "0")}`;
const operators = Array.from({ length: 56 }, (_, index) => {
  const hotkeys =
    index === 0
      ? [KNOWN_HOTKEY, ...Array.from({ length: 8 }, (_, n) => member(n))]
      : [member(index + 8)];
  return {
    operator_id: `coldkey:synthetic-owner-${index}`,
    ownership_basis: "single_coldkey",
    identity_name: index === 55 ? null : `Operator ${String(index).padStart(2, "0")}`,
    primary_hotkey: hotkeys[0],
    coldkey: `synthetic-owner-${index}`,
    hotkey_count: hotkeys.length,
    hotkeys:
      hotkeys.length > 1
        ? hotkeys.map((hotkey, n) => ({
            hotkey,
            total_stake_tao: 9000000 - n,
            take: n === 0 ? 0 : null,
          }))
        : [],
    total_stake_tao: 9000000 - index,
    total_emission_tao: 100,
    stake_dominance: 0.5,
    apy_estimate: 0.9,
    membership_count: 56 - index,
    uid_count: 56 - index,
    take_min: index === 0 ? 0 : 0.18,
    take_max: index === 0 ? 0 : 0.18,
    nominator_count: index === 0 ? null : 0,
  };
});

async function openDirectory(page: Page, captured_at?: string, firstName?: string) {
  await gotoThroughRestart(page, "/settings");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
  let operatorRequests = 0;
  await page.route("**/api/v1/validators/operators*", async (route) => {
    operatorRequests += 1;
    await route.fulfill({
      json: {
        ok: true,
        data: {
          validator_count: 64,
          operators: operators.map((operator, index) =>
            index === 0 && firstName ? { ...operator, identity_name: firstName } : operator,
          ),
          captured_at,
        },
        meta: { generated_at: new Date().toISOString() },
      },
    });
  });
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Site navigation" })
      .getByRole("link", { name: "Validators", exact: true })
      .click();
  } else await page.getByRole("link", { name: "Validators", exact: true }).first().click();
  await expect.poll(() => operatorRequests).toBeGreaterThan(0);
  const table = page.locator("#operators .mg-dt");
  await expect(table.locator(".mg-dt-row").first()).toContainText("Operator 00");
  return table;
}

test("source freshness stays older than publication metadata and missing stays unknown", async ({
  page,
}) => {
  await openDirectory(page, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  await expect(page.locator(".mg-live-meta")).toContainText("2h ago");
  await openDirectory(page);
  await expect(page.locator(".mg-live-meta")).toContainText("Updated —");
});

test("search resets pagination and CSV exports every match without unsupported metrics", async ({
  page,
}) => {
  const table = await openDirectory(page);
  const rows = table.locator(".mg-dt-row");
  await expect(rows).toHaveCount(50);
  await table.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows.first()).toContainText("Operator 50");
  const search = page.getByRole("searchbox", { name: "Search operators" });
  await search.fill("Operator 03");
  await expect(search).toBeFocused();
  await expect(rows).toHaveCount(1);
  await expect(table.locator(".mg-dt-title")).toHaveText("1 of 56 operators");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(rows.first()).toContainText("Operator 00");
  await expect(table.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await table.getByRole("button", { name: "Operators options" }).click();
  await expect(page.getByRole("checkbox", { name: /stake|APY|dominance|emission/i })).toHaveCount(
    0,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const csv = await readFile((await (await downloadPromise).path())!, "utf8");
  expect(csv.trim().split(/\r?\n/)).toHaveLength(57);
  expect(csv.split(/\r?\n/)[0]).toBe("Operator,Hotkeys,Observed take,Memberships");
  expect(csv).not.toMatch(/9000000|Total stake|APY|Dominance|TAO/);
  expect(csv).toContain("0.0% (1 of 9 hotkeys)");
});

test("comparison keeps explicitly chosen members within the three-key limit", async ({ page }) => {
  const table = await openDirectory(page);
  await expect(table.locator('.mg-dt-row [role="checkbox"]')).toHaveCount(0);
  await expect(table.locator("button a, button button, button input, button select")).toHaveCount(
    0,
  );
  await table.getByRole("button", { name: "Operators options" }).click();
  const operatorColumn = page.getByRole("checkbox", { name: "Operator", exact: true });
  await operatorColumn.uncheck();
  await expect(table.locator("button a, button button, button input, button select")).toHaveCount(
    0,
  );
  await operatorColumn.check();
  await page.keyboard.press("Escape");
  const visibleKey = table.locator(".mg-dt-row").first().getByRole("link");
  await visibleKey.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/validators/${KNOWN_HOTKEY}(?:\\?|$)`));
  await openDirectory(page);
  await table
    .locator(".mg-dt-row")
    .first()
    .getByRole("button", { name: "Expand row", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const detail = table.locator(".mg-dt-expansion");
  await expect(detail.locator("li")).toHaveCount(8);
  await expect(table.locator(".mg-dt-row").first()).toContainText("1 of 9 hotkeys");
  await detail.getByRole("button", { name: "Show all 9 hotkeys", exact: true }).click();
  await expect(detail.locator("li")).toHaveCount(9);
  const checks = detail.getByRole("checkbox");
  for (const index of [1, 2, 3]) {
    await checks.nth(index).focus();
    await page.keyboard.press("Space");
    await expect(checks.nth(index)).toHaveAttribute("aria-checked", "true");
  }
  await expect(checks.first()).toBeDisabled();
  const dock = page.locator(".mg-compare-dock");
  const compare = dock.getByRole("link", { name: "Compare", exact: true });
  const href = new URL((await compare.getAttribute("href"))!, "http://localhost");
  expect(href.searchParams.get("kind")).toBe("validators");
  expect(href.searchParams.get("validators")?.split(",")).toEqual([
    member(0),
    member(1),
    member(2),
  ]);
  await expect(dock).toContainText("Selected hotkeys");
  await expect(dock).toContainText("Operator 00");
  await dock.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(checks.first()).toBeEnabled();
  await detail.locator(`a[href="/validators/${KNOWN_HOTKEY}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/validators/${KNOWN_HOTKEY}(?:\\?|$)`));
});

test("legacy balance filters are explained and supported sort links survive reload", async ({
  page,
}) => {
  await gotoThroughRestart(page, "/validators?minStake=100000&sort=keys&order=desc");
  await expect(page.getByText("Balance filtering is unavailable.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Clear this saved filter", exact: true }).click();
  await expect(page).not.toHaveURL(/minStake=/);
  await expect(page).toHaveURL(/sort=keys/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toHaveValue(
    "keys:desc",
  );
  await expect(page.locator("section#concentration")).toContainText(
    "Balance, return and holdings-concentration figures are unavailable here.",
  );
});

test.describe("operator directory on phones", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test("one options sheet preserves URL state, focus and page scrolling", async ({ page }) => {
    const table = await openDirectory(page, undefined, LONG_OPERATOR_NAME);
    await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).not.toBeVisible();
    const options = page.getByRole("button", { name: /^Filter and sort operators/ });
    await options.tap();
    const panel = page.getByRole("dialog", { name: "Filter and sort" });
    await panel.getByRole("combobox", { name: "Identity", exact: true }).selectOption("named");
    await panel.getByRole("combobox", { name: "Sort by", exact: true }).selectOption("keys:desc");
    await panel.getByRole("button", { name: "Show 55 operators", exact: true }).tap();
    await expect(panel).not.toBeVisible();
    await expect(options).toBeFocused();
    await expect(page).toHaveURL(/sort=keys/);
    await expect(table.locator(".mg-dt-title")).toHaveText("55 of 56 operators");
    await options.tap();
    await expect(panel.getByRole("combobox", { name: "Sort by", exact: true })).toHaveValue(
      "keys:desc",
    );
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    const firstRow = table.locator(".mg-dt-row").first();
    await firstRow.scrollIntoViewIfNeeded();
    const rowBox = (await firstRow.boundingBox())!;
    const startY = Math.min(720, rowBox.y + rowBox.height - 20);
    const initialScroll = await table.locator(".mg-dt-viewport").evaluate((element) => ({
      page: window.scrollY,
      table: element.scrollTop,
    }));
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 180, y: startY }],
    });
    for (let y = startY - 40; y >= startY - 240; y -= 40) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 180, y }],
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(initialScroll.page + 100);
    expect(await table.locator(".mg-dt-viewport").evaluate((element) => element.scrollTop)).toBe(
      initialScroll.table,
    );
    await table
      .locator(".mg-dt-row")
      .first()
      .getByRole("button", { name: "Expand row", exact: true })
      .tap();
    await expect(table.locator(".mg-dt-expansion")).toBeVisible();
    const detailHeading = table.locator(".mg-dt-expansion h3");
    await expect(detailHeading).toHaveText(LONG_OPERATOR_NAME);
    expect(
      await detailHeading.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.getBoundingClientRect().right <=
            element.closest("td")!.getBoundingClientRect().right - 16,
      ),
    ).toBe(true);
    const memberRow = table.locator(".mg-dt-expansion li").first();
    const keyBox = (await memberRow.getByRole("link").boundingBox())!;
    const takeBox = (await memberRow.getByText("0.0% take", { exact: true }).boundingBox())!;
    const compareBox = (await memberRow.getByRole("checkbox").boundingBox())!;
    expect(keyBox.y + keyBox.height).toBeLessThanOrEqual(takeBox.y);
    expect(takeBox.x + takeBox.width).toBeLessThanOrEqual(compareBox.x);
    await expect(memberRow.getByText("Compare", { exact: true })).toBeVisible();
    const containment = await memberRow.evaluate((element) => {
      const row = element.getBoundingClientRect();
      const key = element.querySelector("a")!;
      const label = element.querySelector("label")!;
      return {
        contentFits: element.scrollWidth <= element.clientWidth,
        keyFits: key.scrollWidth <= key.clientWidth,
        labelFits: label.getBoundingClientRect().right <= row.right,
        rightInset: element.closest("td")!.getBoundingClientRect().right - row.right,
      };
    });
    expect(containment.contentFits).toBe(true);
    expect(containment.keyFits).toBe(true);
    expect(containment.labelFits).toBe(true);
    expect(containment.rightInset).toBeGreaterThanOrEqual(16);
    const geometry = await table.evaluate((element) => ({
      overflow: getComputedStyle(element.querySelector(".mg-dt-viewport")!).overflowY,
      pageFits: document.documentElement.scrollWidth <= innerWidth,
    }));
    expect(geometry.overflow).toBe("visible");
    expect(geometry.pageFits).toBe(true);
    const detail = table.locator(".mg-dt-expansion");
    await detail.locator("li").first().getByText("Compare", { exact: true }).tap();
    await expect(detail.getByRole("checkbox").nth(0)).toHaveAttribute("aria-checked", "true");
    await detail.getByRole("checkbox").nth(1).tap();
    await detail.locator("li").nth(6).scrollIntoViewIfNeeded();
    const dock = page.locator(".mg-compare-dock");
    await expect(dock).toBeInViewport({ ratio: 1 });
    await expect(dock).toContainText(LONG_OPERATOR_NAME);
    for (const remove of await dock.getByRole("button", { name: /^Remove / }).all()) {
      await expect(remove).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(
      page.locator(".mg-compare-dock").getByRole("link", { name: "Compare", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const targets = await dock.locator("button, a").evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    for (const target of targets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    for (let i = 0; i < targets.length; i += 1) {
      for (let j = i + 1; j < targets.length; j += 1) {
        const a = targets[i]!;
        const b = targets[j]!;
        expect(
          Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
            Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y),
        ).toBe(false);
      }
    }
    await dock
      .getByRole("button", { name: /^Remove / })
      .first()
      .tap();
    await expect(dock.locator(".mg-compare-chip")).toHaveCount(1);
    const compare = dock.getByRole("link", { name: "Compare", exact: true });
    const remaining = new URL((await compare.getAttribute("href"))!, "http://localhost");
    expect(remaining.searchParams.get("validators")).toBe(member(0));
    await expect(compare).toBeInViewport({ ratio: 1 });
    await expect(compare).toHaveAttribute("aria-disabled", "true");
    await dock.getByRole("button", { name: "Clear", exact: true }).tap();
    await expect(dock).toHaveCount(0);
    await options.tap();
    await panel.getByRole("button", { name: "Reset", exact: true }).tap();
    await expect(panel.getByRole("combobox", { name: "Sort by", exact: true })).toHaveValue(
      "name:asc",
    );
    await panel.getByRole("button", { name: "Show 56 operators", exact: true }).tap();
    await expect(options).toHaveAccessibleName("Filter and sort operators");
  });
});
