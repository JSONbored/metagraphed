import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DATED_ENDPOINT_PATTERNS, findHarFixture, harPathForRoute } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

// This is an interaction contract for #11521, separate from the general
// overflow sweep: a profile must keep the five intentional paths usable at
// the two narrow breakpoints, and an incoming pre-dossier tab name must land
// on a mounted view instead of a blank body.
const ROUTE = "/subnets/1";
const harPath = harPathForRoute(ROUTE);

// This contract records API responses with `routeFromHAR`. A service worker
// can otherwise answer a document navigation itself (or emit the offline
// fallback while the supervised Worker restarts), bypassing the route and
// making URL assertions test PWA cache state instead of dossier navigation.
// The dedicated offline suite owns that behaviour.
test.use({ serviceWorkers: "block" });

if (!existsSync(harPath)) {
  throw new Error(
    `Missing HAR fixture for ${ROUTE}: ${harPath}. Run ` +
      "`npm run test:e2e:record-har --workspace=apps/ui` against a live dev server first.",
  );
}

async function openWithHar(page: import("@playwright/test").Page, url: string) {
  await page.routeFromHAR(harPath, {
    url: "**/api.metagraph.sh/**",
    notFound: "fallback",
    update: false,
  });
  for (const pattern of DATED_ENDPOINT_PATTERNS) {
    const fixture = findHarFixture(harPath, pattern);
    if (fixture) await page.route(pattern, (route) => route.fulfill(fixture));
  }
  await gotoThroughRestart(page, url);
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    await page.waitForTimeout(2000);
  }
}

test.describe("subnet dossier navigation", () => {
  test("a retired validator link becomes a canonical participation destination", async ({
    page,
  }) => {
    await openWithHar(page, `${ROUTE}?tab=validators`);

    await expect(page).toHaveURL(/\/subnets\/1\?tab=participate#validator-detail$/);
    const navigation = page.getByRole("navigation", { name: "Profile sections" });
    await expect(navigation.getByRole("button", { name: "Participate" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByRole("heading", { name: /Start with the validator context/ }),
    ).toBeVisible();
    await expect(page.locator("#validator-detail")).toHaveAttribute("open", "");
  });

  test("legacy tabs preserve exact record and build destinations", async ({ page }) => {
    await openWithHar(page, `${ROUTE}?tab=metagraph&uid=7`);
    await expect(page).toHaveURL(/\/subnets\/1\?tab=records&uid=7#neuron$/);
    await expect(page.getByRole("heading", { name: "Neuron UID 7" })).toBeVisible();
    await expect(page.locator("#metagraph-record-detail")).toHaveAttribute("open", "");

    await openWithHar(page, `${ROUTE}?tab=services`);
    await expect(page).toHaveURL(/\/subnets\/1\?tab=build#services$/);
    await expect(page.getByRole("button", { name: "Build" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#build-artifacts-detail")).toHaveAttribute("open", "");
    await expect(page.locator("#services")).toBeVisible();

    await openWithHar(page, `${ROUTE}?tab=api`);
    await expect(page).toHaveURL(/\/subnets\/1\?tab=build#api$/);
    await expect(page.locator("#build-artifacts-detail")).toHaveAttribute("open", "");
    await expect(page.locator("#api")).toBeVisible();

    await openWithHar(page, `${ROUTE}?tab=evidence`);
    await expect(page).toHaveURL(/\/subnets\/1\?tab=records#evidence$/);
    await expect(page.getByRole("button", { name: "Records" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#profile-record-detail")).toHaveAttribute("open", "");
    await expect(page.locator("#evidence")).toBeVisible();

    await openWithHar(page, `${ROUTE}#concentration`);
    await expect(page).toHaveURL(/\/subnets\/1\?tab=participate#concentration$/);
    await expect(page.getByRole("button", { name: "Participate" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#participation-detail")).toHaveAttribute("open", "");
    await expect(page.locator("#concentration")).toBeVisible();

    await openWithHar(page, `${ROUTE}#watch`);
    await expect(page).toHaveURL(/\/subnets\/1\?tab=records#profile-tools-detail$/);
    await expect(page.locator("#profile-tools-detail")).toHaveAttribute("open", "");
  });

  test("legacy resource links canonicalize their lens and clear sticky navigation", async ({
    page,
  }) => {
    await openWithHar(page, `${ROUTE}#schema-drift`);

    await expect(page).toHaveURL(/\/subnets\/1\?tab=build&resource=schemas#resources$/);
    await expect(page.getByRole("button", { name: "Build" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("tab", { name: "Schemas" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(() =>
        page.locator("#resources").evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeGreaterThan(48);
  });

  test("an explicit fragment overrides a retired tab's default content", async ({ page }) => {
    await openWithHar(page, `${ROUTE}?tab=api#evidence`);

    await expect(page).toHaveURL(/\/subnets\/1\?tab=records#evidence$/);
    await expect(page.getByRole("button", { name: "Records" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#profile-record-detail")).toHaveAttribute("open", "");
    await expect(page.locator("#evidence")).toBeVisible();
  });

  test("a stale neuron fragment falls back to the visible metagraph record", async ({ page }) => {
    await openWithHar(page, `${ROUTE}#neuron`);

    await expect(page).toHaveURL(/\/subnets\/1\?tab=records#metagraph$/);
    await expect(page.locator("#metagraph-record-detail")).toHaveAttribute("open", "");
    await expect(page.locator("#metagraph")).toBeVisible();
  });

  test("a validator UID still hands off to the selected neuron record", async ({ page }) => {
    await openWithHar(page, `${ROUTE}?tab=validators`);

    const uid = page
      .locator("#validator-detail tbody tr")
      .first()
      .locator("td")
      .first()
      .getByRole("button");
    await expect(uid).toBeVisible();
    const value = (await uid.textContent())?.trim();
    await uid.click();

    await expect(page).toHaveURL(/\/subnets\/1\?tab=records&uid=\d+#neuron$/);
    await expect(page.getByRole("heading", { name: `Neuron UID ${value}` })).toBeVisible();
    await expect(page.locator("#metagraph-record-detail")).toHaveAttribute("open", "");
  });

  for (const viewport of [
    { name: "mobile", width: 375, height: 812 },
    { name: "tablet", width: 768, height: 1024 },
  ]) {
    test(`all five paths remain reachable without page overflow on ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openWithHar(page, ROUTE);

      const tabs = page.getByRole("navigation", { name: "Profile sections" }).getByRole("button");
      await expect(tabs).toHaveCount(5);
      await expect(tabs).toHaveText(["Overview", "Build", "Research", "Participate", "Records"]);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);

      await page.getByRole("button", { name: "Research" }).click();
      await expect(page.getByRole("heading", { name: "Price history." })).toBeVisible();
    });
  }
});
