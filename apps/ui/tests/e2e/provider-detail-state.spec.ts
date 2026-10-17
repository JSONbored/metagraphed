import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";
import {
  attachOrdinaryFixtureDiagnostics,
  recordOrdinaryFixturePhase,
  startOrdinaryFixtureDiagnostics,
} from "./native-runtime-diagnostics.ts";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page, baseURL }, testInfo) => {
  if (testInfo.title === "keeps registered services visible when probes fail and retries independently")
    await startOrdinaryFixtureDiagnostics(page, baseURL);
});
test.afterEach(async ({ page }, testInfo) => {
  await attachOrdinaryFixtureDiagnostics(page, testInfo);
});
const url = "https://example.test/v1/run?model=a%2Fb&mode=fast#sample";
const service = (id: string, auth?: boolean) => ({
  id,
  name: `Service ${id}`,
  url,
  key: `srf-${id}`,
  provider: "lium",
  netuid: 0,
  kind: "subnet-api",
  auth_required: auth,
});
const response = (rows: unknown[], next: string | null = null, total = rows.length) => ({
  ok: true,
  data: { surfaces: rows },
  meta: { pagination: { total, next_cursor: next } },
});
async function loaded(page: Page) {
  recordOrdinaryFixturePhase(page, "provider-navigation-start");
  await gotoThroughRestart(page, "/providers/lium");
  recordOrdinaryFixturePhase(page, "provider-navigation-returned");
  await page.waitForFunction(
    () => (window as unknown as { __MG_HYDRATED__: boolean }).__MG_HYDRATED__,
  );
  recordOrdinaryFixturePhase(page, "provider-hydrated");
  await expect(page.locator("#surfaces .mg-dt-row:not(.mg-dt-skeleton)").first()).toBeVisible();
  recordOrdinaryFixturePhase(page, "provider-rows-visible");
}

test.describe("Provider services and independent probe states", () => {
  test("starts services first and keeps them usable while probe readings wait", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/providers/lium/endpoints*", async (route) => {
      await pending;
      await route.continue();
    });
    try {
      await loaded(page);
      expect(
        await page
          .locator("section#surfaces,section#latency")
          .evaluateAll((nodes) => nodes.map((node) => node.id)),
      ).toEqual(["surfaces", "latency"]);
      await expect(page.locator("#surfaces .mg-dt-skeleton")).toHaveCount(0);
      await expect(page.getByText(/services loaded.*probe readings loading/)).toBeVisible();
      await expect(page.getByRole("group", { name: "lium.io endpoint latency" })).toHaveAttribute(
        "aria-busy",
        "true",
      );
    } finally {
      release();
    }
    await expect(page.getByRole("group", { name: "lium.io endpoint latency" })).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.locator("#surfaces").getByText("p50", { exact: true })).toHaveCount(0);
  });

  test("keeps registered services visible when probes fail and retries independently", async ({
    page,
  }) => {
    let fail = true;
    await page.route("**/api/v1/providers/lium/endpoints*", async (route) => {
      const failing = fail;
      recordOrdinaryFixturePhase(page, "provider-probe-route-matched", { failing });
      try {
        if (failing) await route.fulfill({ status: 503, json: { error: "fixture failure" } });
        else await route.continue();
        recordOrdinaryFixturePhase(page, "provider-probe-route-completed", { failing });
      } catch (error) {
        recordOrdinaryFixturePhase(page, "provider-probe-route-error", {
          error_type: error instanceof Error ? error.name.slice(0, 60) : typeof error,
        });
        throw error;
      }
    });
    await loaded(page);
    const error = page
      .locator("#surfaces")
      .getByRole("alert")
      .filter({ hasText: "provider endpoint probes" });
    await expect(error).toBeVisible();
    recordOrdinaryFixturePhase(page, "provider-probe-error-visible");
    await expect(page.locator("#surfaces .mg-dt-row").first()).toBeVisible();
    fail = false;
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    recordOrdinaryFixturePhase(page, "provider-retry-clicked");
    await expect(error).toHaveCount(0);
    recordOrdinaryFixturePhase(page, "provider-recovered");
  });

  test("follows the supplied cursor, retries a failed next page and keeps published counts", async ({
    page,
  }) => {
    let failNext = true;
    const cursors: (string | null)[] = [];
    await page.route("**/api/v1/surfaces**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      expect(params.get("provider")).toBe("lium");
      expect(params.get("limit")).toBe("500");
      const cursor = params.get("cursor");
      cursors.push(cursor);
      return cursor && failNext
        ? route.fulfill({ status: 503, json: { error: "next page failure" } })
        : route.fulfill({
            json: cursor
              ? response([service("last")], null, 3)
              : response([service("a", false), service("b", true)], "opaque-next-page", 3),
          });
    });
    await loaded(page);
    const published = page
      .locator(".mg-fact")
      .filter({ has: page.getByText("Published surfaces", { exact: true }) });
    await expect(published).toContainText("156");
    await expect(
      page.getByText("2 services loaded of 3 catalog results", { exact: false }),
    ).toBeVisible();
    const more = page.getByRole("button", { name: "Load more", exact: true });
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await more.click();
    await expect(page.getByText(/Couldn.t load more/)).toBeVisible();
    await expect(page.locator("#surfaces .mg-dt-row")).toHaveCount(2);
    failNext = false;
    await page.locator("#surfaces").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#surfaces .mg-dt-row")).toHaveCount(3);
    await expect(
      page.getByText("3 services loaded of 3 catalog results", { exact: false }),
    ).toBeVisible();
    await expect(published).toContainText("156");
    await expect(more).toHaveCount(0);
    expect(cursors).toEqual([null, "opaque-next-page", "opaque-next-page"]);
  });

  test("retains cached services after a failed refresh and distinguishes initial failure from empty", async ({
    page,
  }) => {
    let fail = true;
    await page.route("**/api/v1/surfaces**", (route) =>
      fail
        ? route.fulfill({ status: 503, json: { error: "services failure" } })
        : route.fulfill({ json: response([service("a")]) }),
    );
    await gotoThroughRestart(page, "/providers/lium");
    const error = page
      .locator("#surfaces")
      .getByRole("alert")
      .filter({ hasText: "provider surfaces" });
    await expect(error).toBeVisible();
    await expect(page.getByText("No surfaces are registered for this provider.")).toHaveCount(0);
    fail = false;
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#surfaces .mg-dt-row")).toHaveCount(1);
    fail = true;
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await expect(error).toBeVisible();
    await expect(page.locator("#surfaces .mg-dt-row")).toHaveCount(1);
    await expect(page.getByText(/previously loaded rows remain visible/)).toBeVisible();
  });

  test("stops on an invalid cursor without inventing an empty catalog", async ({ page }) => {
    await page.route("**/api/v1/surfaces**", (route) =>
      route.fulfill({
        json: { ...response([service("a")]), meta: { pagination: { total: 3, next_cursor: {} } } },
      }),
    );
    await loaded(page);
    await expect(page.getByText(/Pagination stopped/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  });

  test("shows explicit auth states and copies the exact service URL by keyboard on mobile", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route("**/api/v1/surfaces**", (route) =>
      route.fulfill({ json: response([service("a"), service("b", true), service("c", false)]) }),
    );
    await loaded(page);
    await expect(page.locator('#surfaces td[data-label="Auth"]')).toHaveText([
      "Unknown",
      "Required",
      "Open",
    ]);
    const expand = page
      .locator("#surfaces .mg-dt-row")
      .first()
      .getByRole("button", { name: "Expand row", exact: true });
    expect((await expand.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expand.focus();
    await page.keyboard.press("Enter");
    const copy = page.getByRole("button", { name: "Copy service URL", exact: true });
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await copy.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await expect(page.getByText("no verification recorded", { exact: true })).toBeVisible();
    expect((await copy.locator("code").boundingBox())!.width).toBeGreaterThan(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  });
});
