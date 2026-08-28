import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const DELAYED_READS = [
  "**/api/v1/subnets/19/ohlc*",
  "**/api/v1/subnets/19/history*",
  "**/api/v1/subnets/19/event-summary*",
  "**/api/v1/subnets/19/validators*",
  "**/api/v1/subnets/19/surfaces*",
  "**/api/v1/subnets/19/uptime*",
  "**/api/v1/subnets/19/emission-split/history*",
  "**/api/v1/subnets/19/registrations*",
  "**/api/v1/subnets/19/deregistrations*",
  "**/api/v1/economics*",
  "**/api/v1/domains*",
];

test.describe("Subnet detail secondary query states", () => {
  test("keeps below-fold evidence off the cold first read", async ({ page }) => {
    const deferredPaths = new Set([
      "/api/v1/subnets/19/surfaces",
      "/api/v1/subnets/19/event-summary",
      "/api/v1/subnets/19/cost-to-participate",
      "/api/v1/subnets/19/registrations",
      "/api/v1/subnets/19/deregistrations",
      "/api/v1/domains",
      "/api/v1/subnets/19/ownership-history",
    ]);
    const prematureReads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (deferredPaths.has(path)) prematureReads.push(path);
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets/19");

    await expect(
      page.getByText("Surface evidence loads as this section approaches.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Activity evidence loads as this section approaches.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Participation evidence loads as this section approaches.", { exact: true }),
    ).toBeVisible();
    expect(prematureReads).toEqual([]);
  });

  test("defers below-fold evidence without losing its structured pending instruments", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const pattern of DELAYED_READS) {
      await page.route(pattern, async (route) => {
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, "/subnets/19");

    await expect(
      page.getByText("Surface evidence loads as this section approaches.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Activity evidence loads as this section approaches.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Participation evidence loads as this section approaches.", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator("#peers .mg-section-visual")
        .getByText("Peer context loads as this section approaches.", { exact: true }),
    ).toBeVisible();

    for (const section of ["#surfaces", "#activity", "#participation", "#peers"]) {
      await page.locator(section).scrollIntoViewIfNeeded();
    }

    const activity = page.getByRole("group", { name: "Subnet 19 events by kind, 30 days" });
    const activityCategories = page.getByRole("group", { name: "Events by category" });
    const momentum = page.locator("#sn-19-price .mg-line-plot");
    const emission = page.getByRole("group", { name: "Subnet 19 daily emission by recipient" });
    const emissionLegend = page.getByRole("group", { name: "Emission by recipient class" });
    const validators = page.getByRole("group", { name: "Subnet 19 validators by stake" });
    const surfaces = page.getByRole("group", { name: "Subnet 19 surface uptime over 90 days" });
    const churn = page.getByRole("group", { name: "Subnet 19 slot movement over 30 days" });
    const peers = page.getByRole("group", { name: "Loading subnet peer comparison" });
    const comparable = page.getByRole("group", { name: "Loading comparable subnets" });

    await expect(activity).toHaveAttribute("aria-busy", "true");
    await expect(activityCategories).toHaveAttribute("aria-busy", "true");
    await expect(momentum).toHaveAttribute("aria-busy", "true");
    await expect(emission).toHaveAttribute("aria-busy", "true");
    await expect(emissionLegend).toHaveAttribute("aria-busy", "true");
    await expect(validators).toHaveAttribute("aria-busy", "true");
    await expect(surfaces).toHaveAttribute("aria-busy", "true");
    await expect(churn).toHaveAttribute("aria-busy", "true");
    await expect(peers).toHaveAttribute("aria-busy", "true");
    await expect(comparable).toHaveAttribute("aria-busy", "true");
    await expect(activity.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(activityCategories.locator(".mg-rank-grid-row--skeleton")).toHaveCount(4);
    await expect(emission.locator(".mg-stack-col--skeleton")).toHaveCount(30);
    await expect(emissionLegend.locator(".mg-rank-grid-row--skeleton")).toHaveCount(4);
    await expect(validators.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(surfaces.locator(".mg-rails-row--skeleton")).toHaveCount(8);
    await expect(churn.locator(".mg-rails-row--skeleton")).toHaveCount(3);
    await expect(peers.locator(".mg-rank-grid-row--skeleton")).toHaveCount(5);
    await expect(comparable.locator("li[aria-hidden='true']")).toHaveCount(4);
    await expect(page.getByText("Loading 30d event activity · chain-direct")).toBeVisible();
    await expect(
      page.getByText("Loading 30d price and stake readings · chain-direct"),
    ).toBeVisible();
    await expect(page.getByText("Loading 30d emission recipients · chain-direct")).toBeVisible();
    await expect(page.getByText("Loading validator records · chain-direct")).toBeVisible();
    await expect(page.getByText("Loading surfaces and 90d uptime · registry")).toBeVisible();
    await expect(page.getByText("Loading 30d registration activity · chain-direct")).toBeVisible();
    await expect(page.getByText("loading subnet peer context", { exact: true })).toBeVisible();
    await expect(page.getByText(/0 events across 0 kinds/)).toHaveCount(0);
    await expect(page.getByText(/0 with a permit/)).toHaveCount(0);
    await expect(page.getByText(/0 of 0 probed/)).toHaveCount(0);
    await expect(page.getByText("no registry domain · ranked by emission share")).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    release?.();
    await expect(activity).not.toHaveAttribute("aria-busy", "true");
    await expect(activityCategories).not.toHaveAttribute("aria-busy", "true");
    await expect(momentum).not.toHaveAttribute("aria-busy", "true");
    await expect(emission).not.toHaveAttribute("aria-busy", "true");
    await expect(emissionLegend).not.toHaveAttribute("aria-busy", "true");
    await expect(validators).not.toHaveAttribute("aria-busy", "true");
    await expect(surfaces).not.toHaveAttribute("aria-busy", "true");
    await expect(churn).not.toHaveAttribute("aria-busy", "true");
    await expect(peers).toHaveCount(0);
    await expect(comparable).toHaveCount(0);
    await expect(page.locator("#peers .mg-rank-grid")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#peers .mg-leaders")).not.toHaveAttribute("aria-busy", "true");
  });

  test("keeps a peer-data failure actionable and reserves emission fallback for a domain failure", async ({
    page,
  }) => {
    let economicsFails = true;
    let domainsFail = true;
    await page.route("**/api/v1/economics*", async (route) => {
      if (economicsFails) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Peer economics fixture failed" },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/domains*", async (route) => {
      if (domainsFail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Domain fixture failed" },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets/19");

    const peerSection = page.locator("#peers");
    await peerSection.scrollIntoViewIfNeeded();
    const peerError = peerSection.getByRole("alert");
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await expect(peerError).toContainText("Couldn't load the subnet peer comparison");
    await expect(peerSection.getByRole("group", { name: "Emission neighbours" })).toHaveCount(0);

    economicsFails = false;
    domainsFail = false;
    await peerError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(peerError).toHaveCount(0);
    await expect(peerSection.getByRole("group", { name: "Emission neighbours" })).toBeVisible();
    await expect(
      peerSection.getByText("registry domain unavailable · ranked by emission share", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("keeps failed activity, validator, and emission records scoped and retryable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let failReads = true;
    const failedRecords = [
      "**/api/v1/subnets/19/event-summary*",
      "**/api/v1/subnets/19/validators*",
      "**/api/v1/subnets/19/emission-split/history*",
    ];
    for (const pattern of failedRecords) {
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
            error: { code: "fixture_failure", message: "Subnet record fixture failed" },
          }),
        });
      });
    }

    await gotoThroughRestart(page, "/subnets/19");

    await page.locator("#activity").scrollIntoViewIfNeeded();

    const activityError = page.locator("#activity").getByRole("alert");
    const validatorsError = page.locator("#validators").getByRole("alert");
    const emissionError = page.locator("#emission-split").getByRole("alert");
    await expect(activityError).toContainText("Couldn't load 30-day subnet event activity");
    await expect(validatorsError).toContainText("Couldn't load subnet validator records");
    await expect(emissionError).toContainText("Couldn't load 30d emission recipients");
    await expect(page.getByText(/temporarily unavailable · (chain-direct|registry)/)).toHaveCount(
      0,
    );

    failReads = false;
    await activityError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(activityError).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Subnet 19 events by kind, 30 days" }),
    ).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("keeps independent surface, participation, and momentum failures distinguishable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let failReads = true;
    const failedRecords = [
      "**/api/v1/subnets/19/surfaces*",
      "**/api/v1/subnets/19/uptime*",
      "**/api/v1/subnets/19/cost-to-participate*",
      "**/api/v1/subnets/19/registrations*",
      "**/api/v1/subnets/19/deregistrations*",
      "**/api/v1/subnets/19/ohlc*",
      "**/api/v1/subnets/19/history*",
    ];
    for (const pattern of failedRecords) {
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
            error: { code: "fixture_failure", message: "Subnet record fixture failed" },
          }),
        });
      });
    }

    await gotoThroughRestart(page, "/subnets/19");

    await page.locator("#surfaces").scrollIntoViewIfNeeded();
    await page.locator("#participation").scrollIntoViewIfNeeded();

    const surfaceError = page.locator("#surfaces").getByRole("alert");
    const participationErrors = page.locator("#participation").getByRole("alert");
    const priceError = page.locator("#momentum").getByRole("alert").first();
    const historyError = page.locator("#momentum").getByRole("alert").last();
    await expect(surfaceError).toContainText("Couldn't load published subnet surfaces");
    await expect(participationErrors).toHaveCount(2);
    await expect(participationErrors.first()).toContainText(
      "Couldn't load subnet participation floors",
    );
    await expect(participationErrors.last()).toContainText(
      "Couldn't load 30-day registration activity",
    );
    await expect(priceError).toContainText("Couldn't load 30d alpha price history");
    await expect(historyError).toContainText("Couldn't load 30d subnet stake and emission history");

    failReads = false;
    await participationErrors.first().getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page
        .locator("#participation")
        .getByRole("alert")
        .filter({ hasText: "Couldn't load subnet participation floors" }),
    ).toHaveCount(0);
    await expect(page.locator("#participation .mg-facts")).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });
});
