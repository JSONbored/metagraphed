import { expect, test, type Page } from "@playwright/test";
import { DATED_ENDPOINT_PATTERNS, findHarFixture, harPathForRoute } from "./har-path.ts";
import { gotoThroughRestart } from "./server-restart.ts";

// #11520: /subnets used to answer browsing, researching and integrating all at
// once, which meant it answered none of them — the default carried every
// column, export, density and compare control. These pin the three task modes
// and, just as importantly, that the focused default is genuinely focused.

const ROUTE = "/subnets";
const HAR_PATH = harPathForRoute(ROUTE);

async function openSubnets(page: Page, search = "", width = 1280, height = 900) {
  await page.routeFromHAR(HAR_PATH, {
    url: "**/api.metagraph.sh/**",
    notFound: "fallback",
    update: false,
  });
  for (const pattern of DATED_ENDPOINT_PATTERNS) {
    const fixture = findHarFixture(HAR_PATH, pattern);
    if (fixture) await page.route(pattern, (route) => route.fulfill(fixture));
  }
  await page.setViewportSize({ width, height });
  await gotoThroughRestart(page, `${ROUTE}${search}`);
  await page.waitForSelector(".mg-directory-mode-tab", { timeout: 20_000 });
  // The strip is server-rendered, so its presence proves nothing about
  // hydration — a click landing before the handler attaches is silently
  // swallowed. Settling the network first is what the sibling directory spec
  // does, and it is the difference between this passing alone and passing in
  // a saturated run.
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    await page.waitForTimeout(1_500);
  }
  await page.evaluate(() => document.fonts.ready);
}

const headers = (page: Page) =>
  page
    .locator("table thead th")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.textContent?.trim() ?? "").filter((label) => label.length > 0),
    );

test.describe("#11520 subnet discovery modes", () => {
  test("opens in Browse without putting a mode in the URL", async ({ page }) => {
    await openSubnets(page);

    const browse = page.getByRole("tab", { name: "Browse" });
    await expect(browse).toHaveAttribute("aria-selected", "true");
    // The default is stripped from the URL, so every existing deep link to
    // /subnets keeps working and lands on the focused view.
    expect(new URL(page.url()).searchParams.get("mode")).toBeNull();
  });

  test("renders a directory of rows, not a spreadsheet", async ({ page }) => {
    await openSubnets(page);

    // Browse is a listing at every width — the table belongs to Research.
    expect(await page.locator(".mg-directory-row").count()).toBeGreaterThan(5);
    await expect(page.locator("table thead")).toHaveCount(0);
  });

  test("makes every row explain itself", async ({ page }) => {
    await openSubnets(page);
    const row = page.locator(".mg-directory-row").first();
    const text = (await row.innerText()).replace(/\s+/g, " ");

    // A real sentence saying what this is.
    await expect(row.locator(".mg-directory-row-purpose")).toHaveCount(1);
    const purpose = (await row.locator(".mg-directory-row-purpose").innerText()).trim();
    expect(purpose.length).toBeGreaterThan(8);
    expect(purpose).not.toBe("—");

    // A health verdict a reader can check, not a bare adjective.
    expect(text).toMatch(/\d+\/\d+ probed surfaces up/);
    // A labelled count, not an unscaled bar.
    expect(text).toMatch(/(\d[\d,]* public interfaces?|No public interfaces yet)/);
    // A date, not "N days old" — which read as stale data next to a live price.
    expect(text).toMatch(/Registered [A-Z][a-z]{2} \d{4}/);
    expect(text).not.toMatch(/days old/);
  });

  test("withholds the research instrument from the default view", async ({ page }) => {
    await openSubnets(page);
    // No column customizer, no density switch, no CSV export at the default.
    await expect(page.getByRole("button", { name: /columns/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Row density" })).toHaveCount(0);
  });

  test("Research restores every measure the default withholds", async ({ page }) => {
    await openSubnets(page, "?mode=research");

    await expect(page.getByRole("tab", { name: "Research" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const researchHeaders = await headers(page);
    expect(researchHeaders).toContain("Emission");
    expect(researchHeaders).toContain("Total stake");
    expect(researchHeaders.length).toBeGreaterThan(5);
    // Research is the measurement view: a table, and no directory rows.
    await expect(page.locator(".mg-directory-row")).toHaveCount(0);
  });

  test("keeps the mode in the URL so a view can be shared", async ({ page }) => {
    await openSubnets(page);
    // Selecting the same mode twice is a no-op, so retrying the click is safe
    // and removes the last hydration race without weakening the assertion.
    await expect
      .poll(
        async () => {
          await page.getByRole("tab", { name: "Research" }).click();
          return new URL(page.url()).searchParams.get("mode");
        },
        { timeout: 15_000 },
      )
      .toBe("research");
    await expect(page.getByRole("tab", { name: "Research" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("names the current task in one line, not all three at once", async ({ page }) => {
    await openSubnets(page);
    const hint = page.locator(".mg-directory-mode-hint");
    await expect(hint).toHaveCount(1);
    const browseHint = await hint.textContent();
    await expect
      .poll(
        async () => {
          await page.getByRole("tab", { name: "Compare" }).click();
          return (await hint.textContent()) !== browseHint;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test("carries the purpose line onto the phone's cards", async ({ page }) => {
    // A card is the phone's primary row, so it must not be the terse version
    // of the page — that is how "mobile-first" quietly becomes "mobile-less".
    await openSubnets(page, "", 375, 812);
    expect(await page.locator(".mg-directory-row").count()).toBeGreaterThan(3);
    expect(
      await page.locator(".mg-directory-row .mg-directory-row-purpose").count(),
    ).toBeGreaterThan(3);
  });

  test("offers the four tasks as ONE strip, rankings included", async ({ page }) => {
    await openSubnets(page, "");

    // Rankings used to be its own tablist stacked above this one, so the page
    // opened with two nested rows of tabs both answering "what am I doing".
    // Exactly one task strip, and it carries all four.
    const strips = page.locator("main [role=tablist][aria-label='Subnet directory task']");
    await expect(strips).toHaveCount(1);
    const labels = await strips
      .getByRole("tab")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
    expect(labels).toEqual(["Browse", "Research", "Compare", "Rankings"]);

    // No second task tablist anywhere on the page.
    await expect(page.locator("main [role=tablist][aria-label='Subnets sections']")).toHaveCount(0);
  });

  test("switches to rankings from the same strip", async ({ page }) => {
    await openSubnets(page, "");

    // The four tabs write two different search params — three set the
    // directory's task, the fourth switches section — and that split is
    // exactly what a reader should never have to see.
    await expect
      .poll(
        async () => {
          await page.getByRole("tab", { name: "Rankings" }).click();
          return new URL(page.url()).searchParams.get("section");
        },
        { timeout: 15_000 },
      )
      .toBe("rankings");
    await expect(page.getByRole("tab", { name: "Rankings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // And back, without leaving the strip. Asserted on what a reader sees
    // rather than on the query string: `section` is stripped once it returns
    // to its default, so checking for "registry" in the URL tests the router's
    // default-encoding, not whether the tab works.
    await expect
      .poll(
        async () => {
          await page.getByRole("tab", { name: "Browse" }).click();
          return page.locator(".mg-directory-row").count();
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(3);
    await expect(page.getByRole("tab", { name: "Browse" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("leaves existing directory deep links working", async ({ page }) => {
    await openSubnets(page, "?view=grid&q=chain");
    const url = new URL(page.url());
    expect(url.searchParams.get("view")).toBe("grid");
    expect(url.searchParams.get("q")).toBe("chain");
    await expect(page.getByRole("tab", { name: "Browse" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
