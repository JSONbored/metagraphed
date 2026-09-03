import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const TAO_BOT = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const YUMA = "5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1";

async function openDirectory(page: Page) {
  await gotoThroughRestart(page, "/validators");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
  return page.locator("#operators .mg-dt");
}

test("operator filters reset paging without losing search focus; CSV retains every result", async ({
  page,
}) => {
  const table = await openDirectory(page);
  const rows = table.locator(".mg-dt-row");
  const allCount = Number(
    (await page.getByRole("button", { name: /^All operators/ }).innerText())
      .match(/[\d,]+$/)![0]
      .replaceAll(",", ""),
  );
  await expect(rows).toHaveCount(50);
  await table.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows.first()).not.toContainText("tao.bot");
  const search = page.getByRole("searchbox", { name: "Search operators" });
  await search.fill("Yuma");
  await expect(search).toBeFocused();
  await expect(rows).toHaveCount(1);
  await expect(table.locator(".mg-dt-title")).toHaveText(`1 of ${allCount} operators`);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(rows.first()).toContainText("tao.bot");
  await expect(table.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await table.getByRole("button", { name: "Operators options" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv.trim().split(/\r?\n/)).toHaveLength(allCount + 1);
  expect(csv).toContain("Stake by hotkey");
  expect(csv).toContain(`${TAO_BOT}:`);
  expect(csv).toContain(" TAO");
});

test("expanded operators reveal their keys and keyboard identity links still navigate", async ({
  page,
}) => {
  const table = await openDirectory(page);
  const yuma = table
    .locator(".mg-dt-row")
    .filter({ has: page.locator(`a[href="/validators/${YUMA}"]`) });
  await yuma.getByRole("button", { name: "Expand row", exact: true }).focus();
  await page.keyboard.press("Enter");
  const detail = table.locator(".mg-operator-details");
  await expect(
    detail.getByRole("heading", { name: "Yuma, a DCG Company", exact: true }),
  ).toBeVisible();
  await expect(detail.locator(".mg-operator-keys li")).toHaveCount(8);
  await expect(detail).toContainText("Memberships count registrations across hotkeys");
  const count = Number((await yuma.locator(".mg-op-profile").innerText()).match(/^\d+/)![0]);
  await detail.getByRole("button", { name: `Show all ${count} hotkeys` }).click();
  await expect(detail.locator(".mg-operator-keys li")).toHaveCount(count);
  await yuma.getByRole("button", { name: "Collapse row", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(detail).toHaveCount(0);
  await yuma.locator(".mg-dt-rowlink").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/validators/${YUMA}(?:\\?|$)`));
});

test("named comparison selections respect the comparison page's three-hotkey limit", async ({
  page,
}) => {
  await openDirectory(page);
  for (const name of ["tao.bot", "Yuma, a DCG Company", "Kraken"]) {
    await page.getByRole("checkbox", { name: `Add ${name} to comparison`, exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("button", { name: `Remove ${name} from comparison`, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("checkbox", { name: "Add Taostats to comparison", exact: true }),
  ).toBeDisabled();
  const compare = page.locator(".mg-operator-compare-link");
  await expect(compare).toHaveText("Compare 3");
  const href = new URL((await compare.getAttribute("href"))!, "http://localhost");
  const selected = href.searchParams.get("validators")!.split(",");
  expect(selected).toHaveLength(3);
  expect(selected).toEqual(expect.arrayContaining([TAO_BOT, YUMA]));
  await page.getByRole("button", { name: "Remove Kraken from comparison", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Add Taostats to comparison", exact: true }),
  ).toBeEnabled();
});

test.describe("operator directory on phones", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("visible sort controls, labeled metrics and color profiles use one page scroll", async ({
    page,
  }) => {
    const table = await openDirectory(page);
    await page.getByRole("button", { name: "Sort by Hotkeys", exact: true }).tap();
    await expect(
      page.getByRole("button", { name: "Sort by Hotkeys, high to low", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const first = table.locator(".mg-dt-row").first();
    await first.scrollIntoViewIfNeeded();
    await expect(first.getByRole("button", { name: "Expand row", exact: true })).toBeVisible();
    const layout = await first.evaluate((row) => {
      const profile = row.querySelector(".mg-op-profile")!.getBoundingClientRect();
      const identity = row.querySelector(".mg-op-name")!.getBoundingClientRect();
      const disclosure = row.querySelector(".mg-dt-disclosure")!.getBoundingClientRect();
      const cells = [".mg-op-stake", "em", "td:nth-child(5)"].map((selector) => {
        const element = row.querySelector(selector)!;
        const cell = element.closest("td")!;
        return {
          label: getComputedStyle(cell, "::before").content.replaceAll('"', ""),
          top: cell.getBoundingClientRect().top,
        };
      });
      const viewport = row.closest(".mg-dt-viewport")!;
      return {
        profileWidth: profile.width,
        rowWidth: row.getBoundingClientRect().width,
        profileTop: profile.top,
        cells,
        disclosureFits:
          disclosure.left >= row.getBoundingClientRect().left && disclosure.right <= identity.left,
        overflow: getComputedStyle(viewport).overflowY,
        pageFits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(layout.cells.map((cell) => cell.label)).toEqual(["Total stake", "Est. APY", "Take"]);
    expect(new Set(layout.cells.map((cell) => cell.top)).size).toBe(1);
    expect(layout.profileTop).toBeGreaterThan(layout.cells[0]!.top);
    expect(layout.profileWidth).toBeGreaterThan(layout.rowWidth * 0.8);
    expect(layout.disclosureFits).toBe(true);
    expect(layout.overflow).toBe("visible");
    expect(layout.pageFits).toBe(true);
    await first.getByRole("button", { name: "Expand row", exact: true }).tap();
    await expect(table.locator(".mg-operator-details")).toBeVisible();
  });
});
