import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const HOTKEY = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const DELAYED_READS = [
  `**/api/v1/validators/${HOTKEY}/history*`,
  `**/api/v1/validators/${HOTKEY}/nominators*`,
  "**/api/v1/validators?*",
];

test.describe("Validator detail secondary query states", () => {
  test("defers lower validator evidence until each instrument enters view", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads = { nominators: 0, history: 0, peers: 0 };
    for (const pattern of DELAYED_READS) {
      await page.route(pattern, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/nominators")) reads.nominators += 1;
        else if (path.endsWith("/history")) reads.history += 1;
        else if (path === "/api/v1/validators") reads.peers += 1;
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, `/validators/${HOTKEY}`);

    const nominators = page.getByRole("group", { name: "Nominators by stake moved" });
    const peers = page.getByRole("group", { name: "Operators near this one by stake" });

    await expect(
      page.getByText("Nominator movement loads as this section approaches."),
    ).toBeVisible();
    await expect(
      page.getByText("Stake and yield history loads as this section approaches."),
    ).toBeVisible();
    await expect(
      page.getByText("Nearby operator ranking loads as this section approaches."),
    ).toBeVisible();
    expect(reads).toEqual({ nominators: 0, history: 0, peers: 0 });

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    await page.evaluate(() => document.getElementById("nominators")?.scrollIntoView());
    await expect.poll(() => reads.nominators).toBe(1);
    await expect(nominators).toHaveAttribute("aria-busy", "true");
    await expect(nominators.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(page.getByText("Loading nominator movement · chain-direct")).toBeVisible();

    await page.evaluate(() => document.getElementById("momentum")?.scrollIntoView());
    await expect.poll(() => reads.history).toBe(1);
    const history = page.locator(`#validator-${HOTKEY}-stake .mg-line-plot`);
    await expect(history).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText("Loading 30d stake and yield history · chain-direct"),
    ).toBeVisible();

    await page.evaluate(() => document.getElementById("peers")?.scrollIntoView());
    await expect.poll(() => reads.peers).toBe(1);
    await expect(peers).toHaveAttribute("aria-busy", "true");
    await expect(peers.locator(".mg-rank-grid-row--skeleton")).toHaveCount(4);
    await expect(page.getByText("Loading nearby operators · chain-direct")).toBeVisible();
    await expect(page.getByText(/0 nominators · ranked by stake moved/)).toHaveCount(0);

    release?.();
    await expect(history).not.toHaveAttribute("aria-busy", "true");
    await expect(peers).not.toHaveAttribute("aria-busy", "true");
  });

  test("keeps each failed secondary record scoped and retryable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let failReads = true;
    for (const pattern of DELAYED_READS) {
      await page.route(pattern, async (route) => {
        if (!failReads) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Secondary record fixture failed" },
          }),
        });
      });
    }

    await gotoThroughRestart(page, `/validators/${HOTKEY}`);
    // These sections re-render from their deferred placeholder into the local
    // error state as the intercepted read resolves. Scroll the currently
    // mounted element rather than retaining a locator through that transition.
    for (const id of ["nominators", "momentum", "peers"]) {
      await page.evaluate((sectionId) => document.getElementById(sectionId)?.scrollIntoView(), id);
    }

    const nominatorError = page.locator("#nominators").getByRole("alert");
    const historyError = page.locator("#momentum").getByRole("alert");
    const peerError = page.locator("#peers").getByRole("alert");
    await expect(nominatorError).toContainText("Couldn't load nominator movement");
    await expect(historyError).toContainText("Couldn't load validator stake and yield history");
    await expect(peerError).toContainText("Couldn't load nearby operators");
    await expect(page.getByText(/temporarily unavailable · chain-direct/)).toHaveCount(0);

    failReads = false;
    await peerError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(peerError).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Operators near this one by stake" }),
    ).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });
});
