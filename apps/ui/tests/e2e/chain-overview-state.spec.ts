import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const DELAYED_READS = [
  "**/api/v1/chain/calls*",
  "**/api/v1/chain/fees*",
  "**/api/v1/chain/stake-flow*",
  "**/api/v1/chain/concentration*",
  "**/api/v1/chain/emission-pipeline*",
  "**/api/v1/runtime*",
  "**/api/v1/sudo*",
  "**/api/v1/governance/config-changes*",
];

test.describe("Chain overview secondary query states", () => {
  test("starts only the opening throughput reading and keeps later analytics structured", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: string[] = [];
    for (const pattern of DELAYED_READS) {
      await page.route(pattern, async (route) => {
        requested.push(new URL(route.request().url()).pathname);
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, "/chain");
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);

    const throughput = page.locator("#throughput .mg-composition");
    const fees = page.locator("#chain-fees .mg-line-plot");
    const flow = page.getByRole("group", { name: "Stake moved per subnet" });
    const concentration = page.getByRole("group", { name: "Stake concentration measures" });
    const emission = page.getByRole("group", {
      name: "Subnets by the share of emission they receive",
    });
    const governance = page.getByRole("table", {
      name: "Runtime upgrades, sudo calls and config changes",
    });

    await expect(throughput).toHaveAttribute("data-loading", "true");
    await expect(fees).toHaveAttribute("aria-busy", "true");
    await expect(flow).toHaveAttribute("aria-busy", "true");
    await expect(concentration).toHaveAttribute("aria-busy", "true");
    await expect(emission).toHaveAttribute("aria-busy", "true");
    await expect(governance.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(page.getByText("7d · signed extrinsic fees · chain-direct")).toBeVisible();
    await expect.poll(() => requested).toContain("/api/v1/chain/calls");
    for (const path of [
      "/api/v1/chain/fees",
      "/api/v1/chain/stake-flow",
      "/api/v1/chain/concentration",
      "/api/v1/chain/emission-pipeline",
      "/api/v1/runtime",
      "/api/v1/sudo",
      "/api/v1/governance/config-changes",
    ]) {
      expect(requested).not.toContain(path);
    }

    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    for (const [section, path] of [
      ["fees", "/api/v1/chain/fees"],
      ["stake-flow", "/api/v1/chain/stake-flow"],
      ["concentration", "/api/v1/chain/concentration"],
      ["emission", "/api/v1/chain/emission-pipeline"],
      ["governance", "/api/v1/runtime"],
    ] as const) {
      await page
        .locator(`section#${section}`)
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect.poll(() => requested.includes(path)).toBe(true);
    }
    await expect.poll(() => requested.includes("/api/v1/sudo")).toBe(true);
    await expect.poll(() => requested.includes("/api/v1/governance/config-changes")).toBe(true);
    await expect(fees).toHaveAttribute("aria-busy", "true");
    await expect(flow).toHaveAttribute("aria-busy", "true");
    await expect(concentration).toHaveAttribute("aria-busy", "true");
    await expect(emission).toHaveAttribute("aria-busy", "true");
    await expect(governance.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(flow.locator(".mg-rails-row--skeleton")).toHaveCount(12);
    await expect(emission.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(page.getByText("Loading 7d call mix · chain-direct · row by row:")).toBeVisible();
    await expect(page.getByText("Loading live emission state · chain-direct")).toBeVisible();
    await expect(page.getByText(/0 extrinsics across 0 modules/)).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    const completedReads = [...new Set(requested)].map((path) =>
      page.waitForResponse((response) => new URL(response.url()).pathname === path),
    );
    release?.();
    await Promise.all(completedReads);
    await expect(throughput).not.toHaveAttribute("data-loading", "true");
    await expect(fees).not.toHaveAttribute("aria-busy", "true");
    await expect(flow).not.toHaveAttribute("aria-busy", "true");
    await expect(concentration).not.toHaveAttribute("aria-busy", "true");
    await expect(emission).not.toHaveAttribute("aria-busy", "true");
    await expect(governance.locator(".mg-dt-skeleton")).toHaveCount(0);
  });

  test("keeps an unavailable governance history actionable rather than calling it empty", async ({
    page,
  }) => {
    for (const pattern of [
      "**/api/v1/runtime*",
      "**/api/v1/sudo*",
      "**/api/v1/governance/config-changes*",
    ]) {
      await page.route(pattern, async (route) => {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Governance fixture failed" },
          }),
        });
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/chain");
    await page.locator("section#governance").scrollIntoViewIfNeeded();

    await expect(page.getByRole("alert")).toContainText("Couldn't load governance changes");
    await expect(
      page.getByText("No governance changes were indexed for this history."),
    ).toHaveCount(0);
  });
});
