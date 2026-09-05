import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("operator identity compatibility", () => {
  test.use({ serviceWorkers: "block" });

  for (const width of [375, 1280]) {
    test(`equal-name owners expand independently at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await gotoThroughRestart(page, "/settings");
      await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
      await page.route("**/api/v1/validators/operators*", async (route) => {
        await route.fulfill({
          json: {
            ok: true,
            data: {
              validator_count: 4,
              operators: ["first", "second"].map((owner) => ({
                operator_id: `coldkey:${owner}`,
                ownership_basis: "single_coldkey",
                identity_name: "Shared Name",
                primary_hotkey: `${owner}-primary`,
                coldkey: owner,
                hotkey_count: 2,
                hotkeys: ["primary", "secondary"].map((member) => ({
                  hotkey: `${owner}-${member}`,
                  total_stake_tao: 5,
                  take: null,
                })),
                total_stake_tao: 10,
                total_emission_tao: 0,
                membership_count: 2,
                uid_count: 2,
                nominator_count: null,
              })),
            },
          },
        });
      });
      if (width < 768) {
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Site navigation" })
          .getByRole("link", { name: "Validators", exact: true })
          .click();
      } else {
        await page.getByRole("link", { name: "Validators", exact: true }).first().click();
      }

      const table = page.locator("section#operators table");
      await expect(
        page.getByText("4 validator hotkeys · chain-direct", { exact: true }),
      ).toBeVisible();
      const rows = table.locator("tbody > tr.mg-dt-row");
      await expect(rows).toHaveCount(2);
      await rows.nth(0).getByRole("button", { name: "Expand row", exact: true }).click();
      await expect(table.locator('tr[data-expanded="true"]')).toHaveCount(1);
      await expect(
        rows.nth(1).getByRole("button", { name: "Expand row", exact: true }),
      ).toHaveAttribute("aria-expanded", "false");
      await expect(table.locator('a[href="/validators/first-secondary"]')).toBeVisible();
      await expect(table.locator('a[href="/validators/second-secondary"]')).toHaveCount(0);

      await rows.nth(1).getByRole("button", { name: "Expand row", exact: true }).click();
      await expect(table.locator('tr[data-expanded="true"]')).toHaveCount(1);
      await expect(table.locator('a[href="/validators/first-secondary"]')).toHaveCount(0);
      await expect(table.locator('a[href="/validators/second-secondary"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    });
  }
});

test.describe("directory secondary analytics", () => {
  test("keeps account holders immediate while deferring the separate activity ledger", async ({
    page,
  }) => {
    let signerRequests = 0;
    let releaseRead: (() => void) | undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route("**/api/v1/chain/signers*", async (route) => {
      signerRequests += 1;
      await readReleased;
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/accounts");

    const active = page.locator("section#active");
    await expect(active.getByRole("table", { name: "Signing accounts" })).toBeVisible();
    await expect(active.locator(".mg-dt-skeleton")).toHaveCount(8);
    await expect(
      active.getByText("7d signing activity · chain-direct", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[href="#concentration"]')).toHaveCount(0);
    expect(signerRequests).toBe(0);

    await active.scrollIntoViewIfNeeded();
    await expect.poll(() => signerRequests).toBe(1);
    await expect(active.getByText("loading 7d signing activity", { exact: true })).toBeVisible();

    releaseRead?.();
    await expect(active.getByRole("table", { name: "Signing accounts" })).toBeVisible();

    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  });

  test("keeps validator permit costs structurally legible while the economics read is pending", async ({
    page,
  }) => {
    let releaseRead: (() => void) | undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route("**/api/v1/validators/economics*", async (route) => {
      await readReleased;
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/validators");

    const rails = page.getByRole("group", {
      name: "Cheapest subnets to hold a validator permit on",
      exact: true,
    });
    await expect(rails).toBeVisible();
    await expect(rails).toHaveAttribute("aria-busy", "true");
    await expect(rails.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(
      page.getByText("permit and earning floors by subnet · chain-direct"),
    ).toBeVisible();

    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    await page
      .locator("section#cost")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(
      page.getByText("loading validator permit-cost readings", { exact: true }),
    ).toBeVisible();
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);

    releaseRead?.();
    await expect(rails).not.toHaveAttribute("aria-busy", "true");
  });

  test("keeps subnet analytics deferred until their distinct evidence regions are reached", async ({
    page,
  }) => {
    let releaseReads: (() => void) | undefined;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let moversRequests = 0;
    let lifecycleRequests = 0;
    await page.route("**/api/v1/subnets/movers*", async (route) => {
      moversRequests += 1;
      await readsReleased;
      await route.continue();
    });
    await page.route("**/api/v1/chain/subnet-lifecycle*", async (route) => {
      lifecycleRequests += 1;
      await readsReleased;
      await route.continue();
    });
    for (const path of ["**/api/v1/economics*", "**/api/v1/domains*"]) {
      await page.route(path, async (route) => {
        await readsReleased;
        await route.continue();
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets");

    const rankings = page.getByRole("group", {
      name: "Subnets ranked by emission over 30d",
      exact: true,
    });
    const domains = page.getByRole("group", {
      name: "Emission share by capability domain",
      exact: true,
    });
    const churn = page.getByRole("group", {
      name: "Subnet registrations and deregistrations by day",
      exact: true,
    });
    const transitions = page.getByRole("group", {
      name: "The ten most recent lifecycle transitions",
      exact: true,
    });
    await expect(domains).toBeVisible();
    await expect(domains).toHaveAttribute("aria-busy", "true");
    await expect(rankings).toHaveAttribute("aria-busy", "true");
    await expect(churn).toHaveAttribute("aria-busy", "true");
    await expect(transitions).toHaveAttribute("aria-busy", "true");
    await expect(rankings.locator("li[aria-hidden='true']")).toHaveCount(3);
    await expect(churn.locator(".mg-stack-col--skeleton")).toHaveCount(14);
    await expect(transitions.locator(".mg-rank-grid-row--skeleton")).toHaveCount(5);
    await expect(
      page.getByText("registration and deregistration history · chain-direct"),
    ).toBeVisible();
    await expect(
      page.getByText("loading capability-domain coverage", { exact: true }),
    ).toBeVisible();
    expect(moversRequests).toBe(0);
    expect(lifecycleRequests).toBe(0);

    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    await page
      .locator("section#rankings")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(() => moversRequests).toBe(1);
    await expect(rankings).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText("loading 30d subnet rankings by emission", { exact: true }),
    ).toBeVisible();

    await page
      .locator("section#churn")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(() => lifecycleRequests).toBe(1);
    await expect(churn).toHaveAttribute("aria-busy", "true");
    await expect(transitions).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText("loading captured subnet lifecycle history", { exact: true }),
    ).toBeVisible();
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);

    releaseReads?.();
    for (const instrument of [rankings, domains, churn, transitions]) {
      await expect(instrument).not.toHaveAttribute("aria-busy", "true");
    }

    // The crawlable directory emits its repeated card labels once in a
    // table-scoped rule. Confirm those labels still paint on phone rather
    // than merely checking their source markup.
    const mobileLeadLabel = await page
      .locator(".mg-directory-section .mg-dt tbody .mg-dt-row")
      .first()
      .locator('td[data-mobile-lead="true"]')
      .evaluate((cell) => getComputedStyle(cell, "::before").content);
    expect(mobileLeadLabel).toContain("Name");
  });
});

test("subnet directory withholds weighted stake and old ranking links recover honestly", async ({
  page,
}) => {
  let moversRequests = 0;
  await page.route("**/api/v1/subnets/movers*", async (route) => {
    moversRequests += 1;
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoThroughRestart(page, "/subnets?metric=stake");

  const directory = page.locator("section#directory");
  await expect(directory.getByRole("columnheader", { name: /stake/i })).toHaveCount(0);
  await expect(page.locator(".mg-hero").getByText("Total stake", { exact: true })).toHaveCount(0);
  const root = directory.getByRole("row").filter({ has: page.locator('a[href="/subnets/0"]') });
  await expect(root).toHaveCount(1);
  await expect(directory.getByRole("columnheader", { name: "Price", exact: true })).toBeVisible();

  const rankings = page.locator("section#rankings");
  await rankings.scrollIntoViewIfNeeded();
  await expect(rankings.getByText("Stake ranking is unavailable", { exact: true })).toBeVisible();
  await expect(rankings.getByRole("group", { name: "Window", exact: true })).toHaveCount(0);
  expect(moversRequests).toBe(0);
  await rankings.getByRole("radio", { name: "Emission", exact: true }).click();
  await expect(rankings.getByText("Stake ranking is unavailable", { exact: true })).toHaveCount(0);
  await expect(
    rankings.getByRole("group", { name: "Subnets ranked by emission over 30d", exact: true }),
  ).toBeVisible();
  await expect.poll(() => moversRequests).toBeGreaterThan(0);
});
