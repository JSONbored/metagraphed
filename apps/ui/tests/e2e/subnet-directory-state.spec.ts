import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

test.use({ serviceWorkers: "block" });

async function fixture(page: Page) {
  const state = {
    healthFails: false,
    catalogFails: false,
    emptyCatalog: false,
    emptyHealth: false,
    malformedCatalog: false,
    noServices: false,
    release: () => {},
  };
  let gate: Promise<void> | undefined;
  const pause = () => {
    gate = new Promise<void>((resolve) => {
      state.release = resolve;
    });
  };
  const envelope = (data: unknown) => ({
    ok: true,
    data,
    meta: { generated_at: "2026-09-05T12:00:00Z" },
  });
  await page.route("**/api/v1/subnets?*", (route) =>
    route.fulfill({
      json: envelope({
        subnets: [
          { netuid: 0, name: "Root", slug: "root", status: "active", subnet_type: "root" },
          {
            netuid: 19,
            name: "Example subnet with a deliberately long identity",
            slug: "example",
            status: "active",
            subnet_type: "application",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/v1/health", async (route) => {
    await gate;
    await route.fulfill(
      state.healthFails
        ? {
            status: 503,
            json: {
              ok: false,
              error: { code: "upstream_error", message: "Health fixture unavailable" },
            },
          }
        : {
            json: envelope({
              subnets: state.emptyHealth
                ? []
                : [
                    { netuid: 0, status: "degraded" },
                    { netuid: 19, status: "failed" },
                  ],
            }),
          },
    );
  });
  await page.route("**/api/v1/agent-catalog", async (route) => {
    await gate;
    await route.fulfill(
      state.catalogFails
        ? {
            status: 503,
            json: {
              ok: false,
              error: { code: "upstream_error", message: "Catalog fixture unavailable" },
            },
          }
        : {
            json: envelope(
              state.malformedCatalog
                ? null
                : {
                    subnets: state.emptyCatalog
                      ? []
                      : [{ netuid: 19, service_count: 1, service_kinds: ["openapi"] }],
                    blocked_subnets: state.emptyCatalog
                      ? []
                      : [
                          {
                            netuid: 0,
                            service_count: state.noServices ? 0 : 2,
                            agent_readiness: { status: "blocked", blockers: [] },
                          },
                        ],
                  },
            ),
          },
    );
  });
  return { state, pause };
}

async function enterDirectory(page: Page, width: number) {
  await gotoThroughRestart(page, "/settings");
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
  if (width < 768) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Site navigation" })
      .getByRole("link", { name: "Subnets", exact: true })
      .click();
  } else await page.getByRole("link", { name: "Subnets", exact: true }).first().click();
}

async function statusCells(page: Page, label: string) {
  const directory = page.locator("section#directory");
  const column = await directory
    .locator("thead th")
    .evaluateAll(
      (headers, name) => headers.findIndex((header) => header.textContent?.trim() === name),
      label,
    );
  expect(column).toBeGreaterThanOrEqual(0);
  return directory.locator(`tbody > tr.mg-dt-row > td:nth-child(${column + 1}) .mg-dt-status`);
}

async function selectFilter(page: Page, width: number, label: string, value: string) {
  const section = page.locator("section#directory");
  if (width < 1024) {
    await section.getByRole("button", { name: /^Filter subnets/ }).click();
    const dialog = page.getByRole("dialog", { name: "Filter subnets" });
    await dialog.getByRole("combobox", { name: label, exact: true }).selectOption(value);
    await dialog.getByRole("button", { name: "Show subnets", exact: true }).click();
  } else await section.getByRole("combobox", { name: label, exact: true }).selectOption(value);
}

for (const width of [375, 1280]) {
  test(`health filter matches normalized states and reset keeps Root reachable at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await fixture(page);
    await enterDirectory(page, width);
    const directory = page.locator("section#directory");
    await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(2);
    await selectFilter(page, width, "Surface health", "warn");
    await expect(page).toHaveURL(/health=warn/);
    await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(1);
    await expect(directory.locator('a[href="/subnets/0"]').first()).toBeVisible();
    await directory.getByRole("button", { name: "Reset all", exact: true }).click();
    await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });

  test(`failed capability reads stay unknown and filter recovery preserves intent at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const { state } = await fixture(page);
    state.catalogFails = true;
    await enterDirectory(page, width);
    const directory = page.locator("section#directory");
    await expect(
      directory.getByText("Couldn't load subnet API specifications", { exact: true }),
    ).toBeVisible();
    await directory.getByRole("button", { name: / options$/ }).click();
    await page.getByRole("checkbox", { name: "API spec", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(await statusCells(page, "API spec")).toHaveText(["unknown", "unknown"]);
    await selectFilter(page, width, "API spec", "yes");
    await expect(
      directory.getByText(/These filters need data that is currently unavailable/),
    ).toBeVisible();
    await expect(directory.getByRole("table")).toHaveCount(0);
    await expect(page).toHaveURL(/api=true/);
    state.catalogFails = false;
    await directory.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(1);
    await expect(directory.locator('a[href="/subnets/19"]').first()).toBeVisible();
    await expect(page).toHaveURL(/api=true/);
    state.catalogFails = true;
    await page
      .getByRole("button", { name: /refresh/i })
      .first()
      .click();
    await expect(directory.getByText(/Previously loaded readings remain visible/)).toBeVisible();
    await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(1);
  });

  test(`pending filters and a successful empty API catalog have distinct states at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const { state, pause } = await fixture(page);
    pause();
    await enterDirectory(page, width);
    const directory = page.locator("section#directory");
    await selectFilter(page, width, "API spec", "yes");
    await expect(
      directory.getByText("Loading the data needed for these filters…", { exact: true }),
    ).toBeVisible();
    await expect(directory.getByRole("table")).toHaveCount(0);
    state.emptyCatalog = true;
    state.release();
    await expect(
      directory.getByText("No subnets match these filters.", { exact: true }),
    ).toBeVisible();
    await directory.getByRole("button", { name: "Reset all", exact: true }).click();
    await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(2);
  });
}

test("legacy degraded and failed URLs select the intended normalized health state after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 812 });
  await fixture(page);
  for (const [legacy, current] of [
    ["degraded", "warn"],
    ["failed", "down"],
  ]) {
    await gotoThroughRestart(page, `/subnets?health=${legacy}`);
    const select = page
      .locator("section#directory")
      .getByRole("combobox", { name: "Surface health", exact: true });
    await expect(select).toHaveValue(current);
    await page.reload();
    await expect(select).toHaveValue(current);
  }
});

test("unknown health stays distinct from an unavailable health read", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 812 });
  const { state } = await fixture(page);
  state.healthFails = true;
  await enterDirectory(page, 1280);
  const directory = page.locator("section#directory");
  await expect(
    directory.getByText("Couldn't load subnet surface health", { exact: true }),
  ).toBeVisible();
  await selectFilter(page, 1280, "Surface health", "unknown");
  await expect(
    directory.getByText(/These filters need data that is currently unavailable/),
  ).toBeVisible();
  state.healthFails = false;
  state.emptyHealth = true;
  await directory.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(directory.locator("tbody > tr.mg-dt-row")).toHaveCount(2);
  await expect(await statusCells(page, "Health")).toHaveText(["unknown", "unknown"]);
});

test("blocked catalog rows retain unknown coverage and malformed refreshes keep the last evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 812 });
  const { state } = await fixture(page);
  await enterDirectory(page, 1280);
  const directory = page.locator("section#directory");
  await expect(
    directory.getByText("API spec coverage is unknown for 1 indexed subnet.", { exact: true }),
  ).toBeVisible();
  await directory.getByRole("button", { name: / options$/ }).click();
  await page.getByRole("checkbox", { name: "API spec", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(await statusCells(page, "API spec")).toHaveText(["unknown", "yes"]);
  state.malformedCatalog = true;
  await page
    .getByRole("button", { name: /refresh/i })
    .first()
    .click();
  await expect(directory.getByText(/Previously loaded readings remain visible/)).toBeVisible();
  await expect(await statusCells(page, "API spec")).toHaveText(["unknown", "yes"]);
  state.malformedCatalog = false;
  state.noServices = true;
  await directory.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(await statusCells(page, "API spec")).toHaveText(["no", "yes"]);
  await expect(directory.getByText(/API spec coverage is unknown/)).toHaveCount(0);
});
