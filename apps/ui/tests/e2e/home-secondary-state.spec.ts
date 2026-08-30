import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("homepage secondary analytics", () => {
  test("keeps global search and a working MCP install handoff in the first viewport", async ({
    context,
    page,
  }) => {
    let blockFeedRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/blocks" && url.searchParams.get("limit") === "12") {
        blockFeedRequests += 1;
      }
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoThroughRestart(page, "/");

    const preload = page.locator('link[rel="preload"][as="fetch"]');
    await expect(preload).toHaveAttribute("media", "(min-width: 640px)");
    await expect(preload).toHaveAttribute("type", "application/json");
    await expect(page.locator("a.mg-live-block").first()).toBeVisible();
    await expect.poll(() => blockFeedRequests).toBe(1);

    await expect(page.getByRole("combobox", { name: "Search the registry" })).toBeVisible();
    await expect(page.getByText("Bittensor in a box.", { exact: true })).toBeVisible();

    // Stable selector: the button's accessible name intentionally changes to
    // "Copied" for 1.4s, so a role locator filtered by its old name would
    // stop matching at the exact moment this assertion needs to observe it.
    const copy = page.locator(".mg-home-mcp-command");
    await expect(copy).toHaveAccessibleName("Copy Install");
    await expect(copy).toContainText(
      "claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp/core",
    );
    await copy.click();
    await expect(copy).toHaveAccessibleName("Copied");
    await expect(page.getByText("Install copied to clipboard")).toBeAttached();
  });

  test("keeps the three lower instruments structured during delayed mobile reads", async ({
    page,
  }) => {
    let blockFeedRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/blocks" && url.searchParams.get("limit") === "12") {
        blockFeedRequests += 1;
      }
    });
    let releaseReads: (() => void) | undefined;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    for (const path of [
      "**/api/v1/subnets/movers*",
      "**/api/v1/chain/activity*",
      "**/api/v1/health/trends*",
    ]) {
      await page.route(path, async (route) => {
        await readsReleased;
        await route.continue();
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/");
    expect(blockFeedRequests).toBe(0);

    const emission = page.getByRole("group", {
      name: "Subnet daily alpha gains over the 30d comparison",
      exact: true,
    });
    const activity = page.locator("#home-chain .mg-line-plot");
    const health = page.getByRole("group", {
      name: "The ten lowest subnet uptimes over 7 days",
      exact: true,
    });
    for (const instrument of [emission, activity, health]) {
      await expect(instrument).toHaveAttribute("aria-busy", "true");
    }
    await expect(
      page.getByText("Loading 30d emission comparison · chain-derived snapshots"),
    ).toBeVisible();
    await expect(
      page.getByText("Loading complete-day chain activity · indexed chain data"),
    ).toBeVisible();
    await expect(page.getByText("Loading 7d surface health · live prober")).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    releaseReads?.();
    for (const instrument of [emission, activity, health]) {
      await expect(instrument).not.toHaveAttribute("aria-busy", "true");
    }
  });

  test("keeps live readings legible and redraws the selected chain metric", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoThroughRestart(page, "/");

    const economicReading = page.locator(".mg-live-block-value").first();
    await expect(economicReading).toBeVisible();
    const valueLayout = await economicReading.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        overflow: styles.overflow,
        textOverflow: styles.textOverflow,
        whiteSpace: styles.whiteSpace,
      };
    });
    expect(valueLayout).toEqual({
      overflow: "visible",
      textOverflow: "clip",
      whiteSpace: "normal",
    });

    await expect(page.getByText("Emission gains", { exact: true })).toBeVisible();
    await expect(page.getByText("Gain α", { exact: true })).toBeVisible();

    await page.getByRole("radio", { name: "Blocks", exact: true }).click();
    const chart = page.locator("#home-chain");
    await expect(chart).toHaveAttribute("data-animate", "true");
    const activePath = chart.locator(".mg-line-active");
    await expect(activePath).toHaveAttribute("pathLength", "1");
    expect(
      await activePath.evaluate((element) => getComputedStyle(element).animationName),
    ).toContain("mg-line-draw");

    const separation = await chart.evaluate((element) => {
      const range = element.querySelector(".mg-line-range")?.getBoundingClientRect();
      const plot = element.querySelector(".mg-line-plot")?.getBoundingClientRect();
      return range && plot ? plot.top - range.bottom : -1;
    });
    expect(separation).toBeGreaterThanOrEqual(20);
  });
});
