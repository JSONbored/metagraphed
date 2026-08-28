import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("MCP directory query states", () => {
  test("keeps connection and tool geometry truthful during a delayed mobile server-card read", async ({
    page,
  }) => {
    let releaseRead: (() => void) | undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route("**/api/v1/agent-resources", async (route) => {
      await readReleased;
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/agents");

    const connection = page.locator(".mg-agent-connection");
    const tools = page.getByRole("table", { name: "MCP tools" });
    await expect(connection).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("Loading connection details", { exact: true })).toBeVisible();
    await expect(tools).toHaveAttribute("aria-busy", "true");
    await expect(tools.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(
      page.getByText("Loading MCP tools · families are derived from tool names · server card", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/0 of 0 .*families derived/, { exact: false })).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    releaseRead?.();
    await expect(connection).not.toHaveAttribute("aria-busy", "true");
    await expect(tools).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("get_account", { exact: true })).toBeVisible();
  });
});
