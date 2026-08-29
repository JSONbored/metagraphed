import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const DELAYED_READS = [
  "**/api/v1/endpoints*",
  "**/api/v1/rpc/pools*",
  "**/api/v1/endpoint-incidents*",
];

test.describe("API directory query states", () => {
  test("keeps the catalog hero and coverage geometry stable while coverage resolves", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });

    let release: (() => void) | undefined;
    const continueRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/coverage*", async (route) => {
      await continueRead;
      await route.continue();
    });

    await gotoThroughRestart(page, "/apis");
    await page.evaluate(() => document.fonts.ready);

    const hero = page.locator(".mg-hero").first();
    const coverage = page.getByRole("group", {
      name: "Subnet coverage by public interface type",
    });
    const catalog = page.locator("section#catalog");
    await expect(hero.locator(".mg-fact")).toHaveCount(5);
    await expect(hero.locator(".mg-fact dt")).toHaveText([
      "Surfaces",
      "Across subnets",
      "Coverage dimensions",
      "Probed",
      "First-party",
    ]);
    await expect(hero.locator(".mg-fact-loading")).toHaveCount(5);
    await expect(coverage.locator(".mg-rails-row--skeleton")).toHaveCount(7);
    const coverageLayoutBefore = await page.locator("section#coverage").evaluate((section) => ({
      height: section.getBoundingClientRect().height,
      head: section.querySelector(".mg-rails-head")?.getBoundingClientRect().height,
      rows: Array.from(
        section.querySelectorAll(".mg-rails-row"),
        (row) => row.getBoundingClientRect().height,
      ),
      footnote: section.querySelector(".mg-section-note")?.getBoundingClientRect().height,
    }));
    const catalogTopBefore = await catalog.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );

    release?.();
    await expect(hero.locator(".mg-fact-loading")).toHaveCount(0);
    await expect(coverage).not.toHaveAttribute("aria-busy", "true");
    const coverageLayoutAfter = await page.locator("section#coverage").evaluate((section) => ({
      height: section.getBoundingClientRect().height,
      head: section.querySelector(".mg-rails-head")?.getBoundingClientRect().height,
      rows: Array.from(
        section.querySelectorAll(".mg-rails-row"),
        (row) => row.getBoundingClientRect().height,
      ),
      footnote: section.querySelector(".mg-section-note")?.getBoundingClientRect().height,
    }));
    const catalogTopAfter = await catalog.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );
    expect(
      Math.abs(catalogTopAfter - catalogTopBefore),
      JSON.stringify({ coverageLayoutBefore, coverageLayoutAfter }),
    ).toBeLessThanOrEqual(1);
  });

  test("starts the catalog page only when a reader reaches its rows", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let surfaceRequests = 0;
    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/surfaces*", async (route) => {
      surfaceRequests += 1;
      await continueReads;
      await route.continue();
    });

    await gotoThroughRestart(page, "/apis");

    const catalog = page.getByRole("table", { name: "Every verified surface" });
    await expect(catalog.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(page.getByText("verified interface catalog · registry")).toBeVisible();
    expect(surfaceRequests).toBe(0);

    await page.locator("section#catalog").scrollIntoViewIfNeeded();
    await expect.poll(() => surfaceRequests).toBe(1);
    await expect(page.getByText("Loading verified interfaces · registry")).toBeVisible();

    release?.();
    await expect(page.getByText("Loading verified interfaces · registry")).toHaveCount(0);
    const catalogSection = page.locator("section#catalog");
    await expect(catalog).toBeVisible();
    await expect(catalogSection).toContainText("Every verified surface (");
  });

  test("keeps endpoint instruments structured during a delayed mobile read", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let endpointFields: string | null = null;
    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const pattern of DELAYED_READS) {
      await page.route(pattern, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/v1/endpoints" && url.searchParams.get("limit") === "200") {
          endpointFields = url.searchParams.get("fields");
        }
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, "/apis/endpoints");

    await expect
      .poll(() => endpointFields)
      .toBe(
        "id,provider,operator,kind,url,netuid,subnet_name,subnet_slug,status,latency_ms,last_checked,last_ok,observed_at,archive_support,pool_eligible,auth_required",
      );

    const pools = page.getByRole("group", { name: "RPC pool readiness" });
    const latency = page.getByRole("group", { name: "Endpoint latency" });
    await expect(pools).toHaveAttribute("aria-busy", "true");
    await expect(latency).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".mg-marker-rail .mg-rails-row--skeleton")).toHaveCount(5);
    await expect(
      page.locator(".mg-rails:not(.mg-marker-rail) .mg-rails-row--skeleton"),
    ).toHaveCount(8);
    await expect(page.getByText("No managed RPC pools are published.")).toHaveCount(0);
    await expect(page.getByText("No endpoints reported latency for this view.")).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(pools).not.toHaveAttribute("aria-busy", "true");
    await expect(latency).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("finney-archive", { exact: true })).toBeVisible();
  });

  test("keeps failed infrastructure reads actionable instead of presenting empty directories", async ({
    page,
  }) => {
    let shouldFail = true;
    const failures = [
      "**/api/v1/endpoints?*",
      "**/api/v1/rpc/pools*",
      "**/api/v1/endpoint-incidents*",
    ];
    for (const pattern of failures) {
      await page.route(pattern, async (route) => {
        if (!shouldFail) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Endpoint fixture failed" },
          }),
        });
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/apis/endpoints");

    await expect(page.getByRole("alert")).toHaveCount(4);
    await expect(page.getByText("Couldn't load managed RPC pools")).toBeVisible();
    await expect(page.getByText("Couldn't load endpoint latency")).toBeVisible();
    await expect(page.getByText("Couldn't load tracked endpoints")).toBeVisible();
    await expect(page.getByText("Couldn't load endpoint incidents")).toBeVisible();
    await expect(page.getByText("No managed RPC pools are published.")).toHaveCount(0);
    await expect(page.getByText("No endpoints match these filters.")).toHaveCount(0);
    await expect(page.getByText("No endpoint incidents are open.")).toHaveCount(0);

    shouldFail = false;
    const poolsError = page.getByRole("alert").filter({ hasText: "managed RPC pools" });
    await poolsError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("group", { name: "RPC pool readiness" })).toBeVisible();
    await expect(poolsError).toHaveCount(0);
  });

  test("keeps interface coverage separate from a failed surface directory", async ({ page }) => {
    let shouldFail = true;
    for (const pattern of ["**/api/v1/coverage*", "**/api/v1/surfaces*"]) {
      await page.route(pattern, async (route) => {
        if (!shouldFail) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Catalog fixture failed" },
          }),
        });
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/apis");

    await expect(page.getByText("Couldn't load published interface coverage")).toBeVisible();
    const hero = page.locator(".mg-hero").first();
    await expect(hero.locator(".mg-fact")).toHaveCount(5);
    await expect(hero.locator(".mg-fact-loading")).toHaveCount(0);
    await page.locator("section#catalog").scrollIntoViewIfNeeded();
    await expect(page.getByText("Couldn't load verified interfaces")).toBeVisible();
    await expect(page.getByText("No public interface coverage is published.")).toHaveCount(0);
    await expect(page.getByText("No surfaces match these filters.")).toHaveCount(0);

    shouldFail = false;
    const coverageError = page
      .getByRole("alert")
      .filter({ hasText: "published interface coverage" });
    await coverageError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("group", { name: "Subnet coverage by public interface type" }),
    ).toBeVisible();
    await expect(coverageError).toHaveCount(0);
  });
});
