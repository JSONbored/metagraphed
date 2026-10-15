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
  // Browser routing must see the activity request; an installed service
  // worker can otherwise satisfy it before Playwright can inject the degraded
  // contract used by the first regression.
  test.use({ serviceWorkers: "block" });

  test("keeps independent chain sections available when daily activity is unverified", async ({
    page,
  }) => {
    let activityUnavailable = true;
    let activityRouteHits = 0;
    await page.route("**/api/v1/chain/activity*", async (route) => {
      activityRouteHits += 1;
      if (!activityUnavailable) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "x-metagraph-degraded",
          "x-metagraph-degraded": "tier_unavailable",
        },
        body: JSON.stringify({
          ok: true,
          data: {
            schema_version: 1,
            window: "7d",
            observed_at: null,
            day_count: 0,
            days: [],
          },
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/chain");

    await expect(page.getByRole("heading", { level: 1, name: "Chain" })).toBeVisible();
    // The production Worker can stream a fresh dehydrated activity result
    // before browser routing is installed. The hero refresh invalidates that
    // cache and exercises the client-side degraded response deterministically.
    await page.getByRole("button", { name: "refresh" }).click();
    await expect.poll(() => activityRouteHits).toBeGreaterThan(0);
    await expect(page.getByRole("status")).toContainText("Data source temporarily unavailable");
    await expect(page.getByRole("status")).toContainText("no zero or empty result is shown");
    await expect(page.locator("section#throughput")).toBeVisible();
    await expect(page.getByRole("link", { name: "blocks", exact: true })).toBeVisible();
    await expect(page.getByText(/0 extrinsics across 0 modules/)).toHaveCount(0);

    activityUnavailable = false;
    await page.getByRole("status").getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

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

test("compares only closed UTC fee days and keeps missing observations unknown across rollover", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"));
  let observed: string | null = "2026-10-15T10:00:00Z";
  const daily: Array<Record<string, unknown>> = [
    {
      day: "2026-10-13",
      total_fee_tao: 100,
      total_tip_tao: 2,
      signed_extrinsic_count: 100,
      extrinsic_count: 100,
    },
    {
      day: "2026-10-14",
      total_fee_tao: 9,
      total_tip_tao: 1,
      signed_extrinsic_count: 1,
      extrinsic_count: 1,
    },
    {
      day: "2026-10-15",
      total_fee_tao: 0.01,
      total_tip_tao: 99,
      signed_extrinsic_count: 1,
      extrinsic_count: 1,
    },
  ];
  await page.route("**/api/v1/chain/fees*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { daily, observed_at: observed, day_count: 3, top_fee_payers: [] },
      }),
    }),
  );
  await gotoThroughRestart(page, "/chain");
  const section = page.locator("section#fees");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("109.0000τ");
  await expect(section).toContainText("3.0000τ");
  await expect(section).toContainText("1 partial day(s) excluded");
  await expect(section).toContainText("calendar closure does not certify indexed coverage");
  await page.clock.setFixedTime(new Date("2026-10-16T00:00:01Z"));
  // Clock rollover cannot promote yesterday's unfinished reading.
  const staleRefresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/chain/fees",
  );
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await staleRefresh;
  await expect(section).toContainText("109.0000τ");
  observed = "2026-10-16T00:00:01Z";
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(section).toContainText("109.0100τ");
  await expect(section).toContainText("0 partial day(s) excluded");
  daily[0]!.total_tip_tao = null;
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(section.getByText("102.0000τ", { exact: true })).toHaveCount(0);
  await expect(section).toContainText("109.0100τ");
  daily[1]!.total_fee_tao = null;
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(section.getByText("109.0100τ", { exact: true })).toHaveCount(0);
  await expect(section).toContainText(
    "Daily fee chart requires consecutive closed UTC days with known readings.",
  );
  observed = null;
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(section).toContainText("3 unverified date(s) excluded");
  await expect(section).toContainText(
    "Daily fee chart requires consecutive closed UTC days with known readings.",
  );
  await expect(section.getByText("109.0100τ", { exact: true })).toHaveCount(0);
});
