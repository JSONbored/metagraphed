import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("MCP documentation connection summary", () => {
  test("keeps both published endpoints readable without horizontal code scrolling on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/docs/mcp");

    const endpoints = page.locator(".mg-prose pre").first();
    await expect(endpoints).toContainText("https://api.metagraph.sh/mcp");
    await expect(endpoints).toContainText("https://api.metagraph.sh/mcp/core");

    const dimensions = await endpoints.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  });
});
