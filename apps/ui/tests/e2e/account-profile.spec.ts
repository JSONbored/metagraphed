import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

// #11523: the account profile asks for a readable hierarchy — Summary,
// Portfolio, Activity, Validator role, Advanced. It had seven tabs, three of
// which (Transfers, Activity, Extrinsics) were the same question asked three
// ways, and none of the names the issue calls for.

const ACCOUNT = "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9";
const TABS = ".mg-profile-tabs button";

async function openAccount(page: Page, query = "", width = 1280, height = 1000) {
  await page.setViewportSize({ width, height });
  await gotoThroughRestart(page, `/accounts/${ACCOUNT}${query}`);
  await page.waitForSelector(TABS, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function activeTab(page: Page): Promise<string> {
  return page
    .locator(`${TABS}[aria-current="page"]`)
    .first()
    .evaluate((n) => (n.textContent ?? "").trim().replace(/\s+/g, " "));
}

test.describe("#11523 account profile hierarchy", () => {
  test("offers the five sections the issue names", async ({ page }) => {
    await openAccount(page);
    const labels = await page.locator(TABS).evaluateAll((nodes) =>
      // The count badge lives inside the button, so strip trailing digits.
      nodes.map((n) =>
        (n.textContent ?? "").trim().replace(/\s+/g, " ").replace(/\d+$/, "").trim(),
      ),
    );
    expect(labels).toEqual(["Summary", "Portfolio", "Activity", "Validator role", "Advanced"]);
  });

  test("keeps every retired tab id working as a deep link", async ({ page }) => {
    // These have been written into shareable URLs by every section anchor on
    // the page since #8358. A regroup that silently 'lands on the default' is
    // a broken link that looks like a working one.
    const cases: Array<[string, string]> = [
      ["?tab=positions", "Portfolio"],
      ["?tab=holdings", "Portfolio"],
      ["?tab=transfers", "Activity"],
      ["?tab=extrinsics", "Activity"],
      ["?tab=api", "Advanced"],
      ["?tab=overview", "Summary"],
    ];
    for (const [query, expected] of cases) {
      await openAccount(page, query);
      expect(await activeTab(page), `${query} should land on ${expected}`).toContain(expected);
    }
  });

  test("falls back to Summary for an id that never existed", async ({ page }) => {
    await openAccount(page, "?tab=nonsense");
    expect(await activeTab(page)).toContain("Summary");
  });

  test("carries no oversized card radius", async ({ page }) => {
    await openAccount(page);
    // The page shipped with eleven `rounded-2xl` panels — 16px against a 4px
    // system radius — which is what made it read as a card wall. Circles are
    // exempt: a status dot is supposed to be round.
    const oversized = await page.locator("main *").evaluateAll(
      (nodes) =>
        nodes.filter((n) => {
          const r = Number.parseFloat(getComputedStyle(n).borderRadius);
          return Number.isFinite(r) && r > 8 && r < 100;
        }).length,
    );
    expect(oversized).toBe(0);
  });

  test("keeps the section strip usable on a phone", async ({ page }) => {
    await openAccount(page, "", 375, 812);
    const strip = await page.locator(".mg-profile-tabs").boundingBox();
    expect(strip).not.toBeNull();
    expect(strip!.x).toBeGreaterThanOrEqual(0);
    expect(strip!.x + strip!.width).toBeLessThanOrEqual(375);
    // Five labels must still be reachable, not clipped away.
    expect(await page.locator(TABS).count()).toBe(5);
  });
});
