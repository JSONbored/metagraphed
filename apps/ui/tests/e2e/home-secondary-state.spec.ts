import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("homepage secondary analytics", () => {
  test("keeps global search and a working MCP install handoff in the first viewport", async ({
    context,
    page,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoThroughRestart(page, "/");

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

    const emission = page.getByRole("group", {
      name: "Daily subnet emission at the end of the 30d comparison",
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
    await expect(page.getByText("Loading 30d emission comparison · chain-direct")).toBeVisible();
    await expect(
      page.getByText("Loading 30d complete-day chain activity · chain-direct"),
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
});
