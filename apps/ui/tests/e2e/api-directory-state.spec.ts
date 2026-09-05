import { expect, test, type Page } from "@playwright/test";
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

    await expect(page.getByRole("alert")).toHaveCount(5);
    await expect(page.getByText("Couldn't load managed RPC pools")).toBeVisible();
    await expect(page.getByText("Couldn't load endpoint latency")).toBeVisible();
    await expect(page.getByText("Couldn't load tracked endpoints")).toBeVisible();
    await expect(page.getByText("Couldn't load endpoint fleet observations")).toBeVisible();
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

const EXACT_ENDPOINT = "https://rpc.example/finney/archive?network=main&method=chain%2Bstate";
const DISCOVERY_ROWS = [
  {
    id: "required",
    provider: "fixture-a",
    kind: "rpc",
    url: EXACT_ENDPOINT,
    status: "unknown",
    auth_required: true,
    archive_support: false,
    pool_eligible: false,
  },
  {
    id: "open",
    provider: "fixture-b",
    kind: "rpc",
    url: "https://open.example/rpc",
    status: "ok",
    auth_required: false,
    archive_support: true,
    pool_eligible: true,
    latency_ms: 321,
    last_checked: "2026-09-01T10:00:00Z",
    last_ok: "2026-09-01T10:00:00Z",
  },
  {
    id: "unknown",
    provider: "fixture-c",
    kind: "openapi",
    url: "https://unknown.example/api",
    status: "unknown",
  },
];

async function discoveryFixture(page: Page, waitForFeed?: Promise<void>) {
  const state = { failFeed: false, failSecondary: false, reads: [] as string[] };
  await page.route("**/api/v1/endpoints?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("limit") === "200") {
      state.reads.push(url.search);
      await waitForFeed;
      if (state.failFeed) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_unavailable", message: "Endpoint fixture unavailable" },
          }),
        });
        return;
      }
    }
    const rows = DISCOVERY_ROWS.filter(
      (row) =>
        (url.searchParams.get("q") ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((term) =>
            `${row.id} ${row.provider} ${row.kind} ${row.url}`.toLowerCase().includes(term),
          ) &&
        ["status", "kind", "provider"].every(
          (key) =>
            !url.searchParams.get(key) ||
            row[key as "status" | "kind" | "provider"] === url.searchParams.get(key),
        ),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          endpoints: rows,
          summary: { endpoint_count: 3, monitored_count: 1, by_status: { ok: 1, unknown: 2 } },
          operational_observed_at: "2026-09-01T10:00:00Z",
        },
        meta: { pagination: { total: rows.length, next_cursor: null } },
      }),
    });
  });
  for (const pattern of ["**/api/v1/rpc/pools*", "**/api/v1/endpoint-incidents*"]) {
    await page.route(pattern, async (route) => {
      if (!state.failSecondary) return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "fixture_unavailable", message: "Supporting fixture unavailable" },
        }),
      });
    });
  }
  return state;
}

test.describe("endpoint discovery", () => {
  test.use({ hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });

  for (const width of [375, 768, 1280]) {
    test(`puts usable records first and copies their exact URL by keyboard and touch (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 812 });
      await discoveryFixture(page);
      const endpointRequests: string[] = [];
      page.on("request", (request) => {
        if (
          ["rpc.example", "open.example", "unknown.example"].includes(
            new URL(request.url()).hostname,
          )
        )
          endpointRequests.push(request.url());
      });
      await gotoThroughRestart(page, "/apis/endpoints");
      const directory = page.locator("section#directory");
      const rows = directory.locator(".mg-dt-row");
      await expect(rows).toHaveCount(3);
      const positions = await page.evaluate(() => ({
        directory:
          document.querySelector("section#directory")!.getBoundingClientRect().top + scrollY,
        firstRow:
          document.querySelector("section#directory .mg-dt-row")!.getBoundingClientRect().top +
          scrollY,
        secondary: ["fleet", "pools", "latency", "incidents"].map(
          (id) => document.querySelector("section#" + id)!.getBoundingClientRect().top + scrollY,
        ),
        width: document.documentElement.scrollWidth,
      }));
      expect(positions.firstRow).toBeLessThan(812);
      expect(positions.secondary.every((top) => top > positions.directory)).toBe(true);
      expect(positions.width).toBeLessThanOrEqual(width);
      await expect(directory.locator("thead")).toContainText("Latency");
      await expect(directory.locator("thead")).not.toContainText("p50");
      await expect(page.locator("section#latency .mg-rails-head")).toContainText("Latency");
      const expand = rows.first().getByRole("button", { name: "Expand row", exact: true });
      expect((await expand.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expand.focus();
      await page.keyboard.press("Enter");
      const detail = directory.locator(".mg-dt-expansion");
      await expect(detail).toContainText("a key is required");
      await expect(detail).toContainText("archive not supported");
      await expect(detail).toContainText("not eligible");
      await expect(detail).toContainText("no probe recorded");
      await expect(detail).toContainText("no successful probe recorded");
      const copy = detail.getByRole("button", { name: "Copy endpoint URL", exact: true });
      expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await copy.boundingBox())!.height).toBeLessThan(120);
      expect((await copy.locator("code").boundingBox())!.width).toBeGreaterThan(100);
      await expect(copy.locator("code")).toHaveText(EXACT_ENDPOINT);
      await copy.focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(EXACT_ENDPOINT);
      await rows.nth(1).getByRole("button", { name: "Expand row", exact: true }).tap();
      await expect(
        detail.locator(".mg-raw-row").filter({ has: page.locator("dt", { hasText: /^Auth$/ }) }),
      ).toHaveText("Authopen");
      await expect(detail).toContainText("serves archive state");
      await rows.nth(2).getByRole("button", { name: "Expand row", exact: true }).tap();
      await expect(detail).toContainText("requirement unknown");
      await expect(detail).toContainText("support unknown");
      await expect(detail).toContainText("eligibility unknown");
      await detail.getByRole("button", { name: "Copy endpoint URL", exact: true }).tap();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("https://unknown.example/api");
      expect(endpointRequests).toEqual([]);
    });
  }

  test("keeps a saved provider-first mobile row expandable when the host column is hidden", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript(() => {
      localStorage.setItem(
        "mg-columns:mg-endpoints-columns",
        JSON.stringify(["provider", "status", "latency"]),
      );
    });
    await discoveryFixture(page);
    await gotoThroughRestart(page, "/apis/endpoints");
    const directory = page.locator("section#directory");
    const firstRow = directory.locator(".mg-dt-row").first();
    await expect(firstRow.locator('td[data-label="Endpoint"]')).toHaveCount(0);
    const lead = firstRow.locator('td[data-mobile-lead="true"]');
    await expect(lead).toHaveAttribute("data-label", "Provider");
    await expect(lead).toBeVisible();
    await expect(lead).toContainText("fixture-a");
    const expand = lead.getByRole("button", { name: "Expand row", exact: true });
    expect((await expand.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expand.tap();
    const copy = directory
      .locator(".mg-dt-expansion")
      .getByRole("button", { name: "Copy endpoint URL", exact: true });
    await expect(copy).toBeVisible();
    await expect(copy.locator("code")).toHaveText(EXACT_ENDPOINT);
    await copy.tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(EXACT_ENDPOINT);
  });

  test("preserves selected URL filters through loading, empty results and mobile history", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    let release: () => void = () => {};
    await discoveryFixture(
      page,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await gotoThroughRestart(
      page,
      "/endpoints?provider=unlisted&kind=custom-kind&status=unknown&latency=archive&incidents=all#directory",
    );
    await expect(page).toHaveURL(/\/apis\/endpoints\?.*#directory$/);
    const trigger = page.getByRole("button", { name: "Filter endpoints, filters active" });
    expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await trigger.tap();
    const sheet = page.getByRole("dialog", { name: "Filter endpoints" });
    await expect(sheet.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue(
      "unlisted",
    );
    await expect(sheet.getByRole("combobox", { name: "Kind", exact: true })).toHaveValue(
      "custom-kind",
    );
    await expect(sheet.getByRole("combobox", { name: "Status", exact: true })).toHaveValue(
      "unknown",
    );
    // A translated sheet can report 43.99994px for a 44px control.
    for (const label of ["Provider", "Kind", "Status"])
      expect(
        Number(
          (await sheet
            .getByRole("combobox", { name: label, exact: true })
            .boundingBox())!.height.toFixed(2),
        ),
      ).toBeGreaterThanOrEqual(44);
    expect(
      (await sheet.getByRole("button", { name: "Close", exact: true }).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    release();
    await expect(page.locator("section#directory")).toContainText(
      "No endpoints match these filters.",
    );
    await expect(sheet.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue(
      "unlisted",
    );
    await sheet.getByRole("button", { name: "Reset filters" }).tap();
    await expect(
      sheet
        .getByRole("combobox", { name: "Provider", exact: true })
        .locator('option[value="fixture-b"]'),
    ).toHaveCount(1);
    await sheet.getByRole("combobox", { name: "Provider", exact: true }).selectOption("fixture-b");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const url = new URL(page.url());
    expect(url.searchParams.get("provider")).toBe("fixture-b");
    expect(url.searchParams.get("latency")).toBe("archive");
    expect(url.searchParams.get("incidents")).toBe("all");
    expect(url.hash).toBe("#directory");
    await page.getByRole("searchbox", { name: "Search endpoints" }).fill("missing endpoint");
    await expect(page.locator("section#directory")).toContainText(
      "No endpoints match this search.",
    );
    await page.goBack();
    await expect(page.getByRole("searchbox", { name: "Search endpoints" })).toHaveValue("");
    await expect(page.locator("section#directory .mg-dt-row")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("provider")).toBe("fixture-b");
    expect(new URL(page.url()).hash).toBe("#directory");
  });

  test("scopes an empty monitored view to loaded records", async ({ page }) => {
    const state = await discoveryFixture(page);
    await gotoThroughRestart(page, "/apis/endpoints?provider=fixture-a&status=monitored");
    const directory = page.locator("section#directory");
    await expect(directory).toContainText("No loaded endpoints match this view.");
    await expect(directory).toContainText("monitored status matches loaded rows");
    expect(state.reads.every((search) => !new URLSearchParams(search).has("status"))).toBe(true);
  });

  test("recovers a failed refresh with retained rows and no next page while supporting reads fail", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const state = await discoveryFixture(page);
    state.failSecondary = true;
    await gotoThroughRestart(page, "/apis/endpoints");
    const directory = page.locator("section#directory");
    await expect(directory.locator(".mg-dt-row")).toHaveCount(3);
    await expect(page.getByText("Couldn't load managed RPC pools")).toBeVisible();
    await expect(page.getByText("Couldn't load endpoint incidents")).toBeVisible();
    await expect(directory.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    state.failFeed = true;
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    const error = directory.getByRole("alert").filter({ hasText: "endpoint refresh" });
    await expect(error).toBeVisible();
    await expect(directory.locator(".mg-dt-row")).toHaveCount(3);
    await expect(page.getByRole("group", { name: "Endpoint latency" })).toBeVisible();
    await expect(page.locator("section#latency")).toContainText(
      "previous measured endpoints remain visible",
    );
    const beforeRetry = state.reads.length;
    state.failFeed = false;
    await error.getByRole("button", { name: "Retry", exact: true }).tap();
    await expect(error).toHaveCount(0);
    await expect.poll(() => state.reads.length).toBeGreaterThan(beforeRetry);
    expect(state.reads.every((search) => !new URLSearchParams(search).has("cursor"))).toBe(true);
    await expect(directory.locator(".mg-dt-row")).toHaveCount(3);
    await expect(directory).not.toContainText("Refresh failed");
  });

  test("marks one API section active through sibling navigation", async ({ page }) => {
    await gotoThroughRestart(page, "/apis/endpoints");
    const nav = page.locator("nav[data-mg-section-nav]").first();
    for (const [name, href] of [
      ["Endpoints", "/apis/endpoints"],
      ["Catalog", "/apis"],
      ["Schemas", "/apis/schemas"],
      ["Providers", "/apis/providers"],
    ]) {
      await nav.getByRole("link", { name, exact: true }).click();
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(nav.locator('[data-status="active"]')).toHaveCount(1);
      await expect(nav.locator('[aria-current="page"]')).toHaveAttribute("href", href);
    }
  });
});
