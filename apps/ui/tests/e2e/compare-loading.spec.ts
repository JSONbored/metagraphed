import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

test.describe("comparison mode", () => {
  for (const width of [375, 1280]) {
    test(`preserves an empty validator comparison through reload and browser history at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 812 });
      const requests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/v1/compare")) {
          requests.push(request.url());
        }
      });
      await gotoThroughRestart(page, "/compare");
      const subnets = page.getByRole("radio", { name: "Subnets", exact: true });
      const validators = page.getByRole("radio", { name: "Validators", exact: true });

      await validators.click();
      await expect(validators).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/\?kind=validators$/);
      await expect(page.getByText("Pick two validators", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Browse validators" })).toHaveAttribute(
        "href",
        "/validators",
      );

      await page.reload();
      await expect(validators).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("Pick two validators", { exact: true })).toBeVisible();

      // The shared radio control's keyboard path must persist the same URL state.
      await validators.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(subnets).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/\?kind=subnets$/);
      await expect(page.getByText("Pick two subnets", { exact: true })).toBeVisible();

      await page.goBack();
      await expect(validators).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/\?kind=validators$/);
      await page.goBack();
      await expect(subnets).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/\/compare$/);
      await page.goForward();
      await expect(validators).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("Pick two validators", { exact: true })).toBeVisible();
      expect(requests).toEqual([]);
    });
  }

  for (const scenario of [
    { query: "subnets=19", kind: "Subnets", entity: "subnet" },
    { query: "subnets=0", kind: "Subnets", entity: "subnet" },
    { query: `validators=${ALICE}`, kind: "Validators", entity: "validator" },
    {
      query: `kind=unknown&validators=${ALICE}`,
      kind: "Validators",
      entity: "validator",
    },
  ]) {
    test(`keeps the one-selection handoff for ${scenario.query}`, async ({ page }) => {
      await gotoThroughRestart(page, `/compare?${scenario.query}`);
      await expect(page.getByRole("radio", { name: scenario.kind, exact: true })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(
        page.getByText(`Add one more ${scenario.entity}`, { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: `Browse ${scenario.entity}s` })).toBeVisible();
      await page.reload();
      await expect(
        page.getByText(`Add one more ${scenario.entity}`, { exact: true }),
      ).toBeVisible();
    });
  }

  test("loads both validators from an existing comparison link without an explicit kind", async ({
    page,
  }) => {
    let requestedHotkeys: string | null = null;
    await page.route("**/api/v1/compare/validators?**", async (route) => {
      requestedHotkeys = new URL(route.request().url()).searchParams.get("hotkeys");
      await route.fulfill({
        json: {
          ok: true,
          data: {
            validator_count: 2,
            validators: [
              { hotkey: ALICE, coldkey_identity: { name: "Alice" } },
              { hotkey: BOB, coldkey_identity: { name: "Bob" } },
            ],
          },
          meta: {},
        },
      });
    });
    await gotoThroughRestart(page, `/compare?validators=${ALICE},${BOB}`);
    await expect(page.getByRole("radio", { name: "Validators", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("table", { name: "Comparison of Alice, Bob" })).toBeVisible();
    expect(requestedHotkeys).toBe(`${ALICE},${BOB}`);
  });
});

test.describe("comparison ledger loading", () => {
  test("keeps the selected columns and metric rows visible on a delayed mobile response", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route("**/api/v1/compare**", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.fulfill({ response });
    });

    await gotoThroughRestart(page, "/compare?subnets=1,19");

    const loadingLedger = page.getByRole("table", {
      name: "Loading comparison of Subnet 1, Subnet 19",
    });
    await expect(loadingLedger).toBeVisible();
    await expect(loadingLedger).toHaveAttribute("aria-busy", "true");
    await expect(loadingLedger.getByText("Economics", { exact: true })).toBeVisible();
    await expect(loadingLedger.getByText("Emission share", { exact: true })).toBeVisible();
    await expect(loadingLedger.locator(".animate-pulse")).toHaveCount(24);

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    await expect(loadingLedger).toHaveCount(0);
    const loadedLedger = page.getByRole("table", {
      name: /^Comparison of /,
    });
    await expect(loadedLedger).toBeVisible();
    await expect(loadedLedger).not.toHaveAttribute("aria-busy", "true");
  });
});
