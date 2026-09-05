import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const QUERY = "needle operator";
const RESERVED = "?x=1&y=two+three#fragment%_";
const ROWS = Array.from({ length: 450 }, (_, i) => ({
  id: `endpoint-${i}`,
  provider: i % 2 ? "fixture-b" : "fixture-a",
  kind: "rpc",
  url: `https://node${i}.example/rpc`,
  status: i === 401 ? "unknown" : "ok",
  latency_ms: i,
}));

async function searchFixture(page: Page) {
  let releaseSlow = () => {};
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const state = {
    reads: [] as {
      q: string;
      cursor: string | null;
      provider: string | null;
      status: string | null;
    }[],
    failed: new Set<string>(),
    releaseSlow,
    slowFinished: false,
    omitTotal: false,
  };
  await page.route("**/api/v1/endpoints?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const q = params.get("q") ?? "";
    const cursor = params.get("cursor");
    const summary = params.get("limit") === "1";
    if (!summary) {
      state.reads.push({
        q,
        cursor,
        provider: params.get("provider"),
        status: params.get("status"),
      });
      if (q === "slow") await slow;
      if (state.failed.has(q)) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_unavailable", message: "Search fixture unavailable" },
          }),
        });
        return;
      }
    }
    // These are API response fixtures, not an implementation of server search.
    // The matching aliases are deliberately absent from the projected rows.
    let matched =
      !q.trim() || summary
        ? ROWS
        : q === QUERY || q === "slow"
          ? ROWS.slice(200)
          : q === "second"
            ? [ROWS[401]]
            : q === RESERVED
              ? [ROWS[402]]
              : [];
    matched = matched.filter(
      (row) =>
        (!params.get("provider") || params.get("provider") === row.provider) &&
        (!params.get("status") || params.get("status") === row.status),
    );
    const offset = Number(cursor ?? 0);
    const limit = Number(params.get("limit") ?? 200);
    const endpoints = matched.slice(offset, offset + limit);
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            endpoints,
            summary: {
              endpoint_count: ROWS.length,
              monitored_count: 449,
              by_status: { ok: 449, unknown: 1 },
            },
            operational_observed_at: "2026-09-01T10:00:00Z",
          },
          meta: {
            pagination: {
              ...(state.omitTotal ? {} : { total: matched.length }),
              next_cursor: offset + limit < matched.length ? offset + limit : null,
            },
          },
        }),
      });
    } finally {
      if (q === "slow") state.slowFinished = true;
    }
  });
  return state;
}

for (const width of [375, 768, 1280]) {
  test(`searches beyond the first loaded page, pages matching results and restores query history (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const state = await searchFixture(page);
    await gotoThroughRestart(page, "/endpoints#directory");
    const directory = page.locator("section#directory");
    await expect(directory.getByRole("link", { name: "node0.example", exact: true })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search endpoints", exact: true });
    await search.fill(QUERY);
    await expect(
      directory.getByRole("link", { name: "node200.example", exact: true }),
    ).toBeVisible();
    await expect(directory).toContainText("200 loaded of 250 matching");
    await expect(directory).toContainText("450 tracked across the fleet");
    await expect(directory.locator(".mg-dt-caption")).toContainText("250");
    expect(state.reads.at(-1)).toMatchObject({ q: QUERY, cursor: null });
    expect(new URL(page.url()).hash).toBe("#directory");
    await directory.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(directory).toContainText("250 loaded of 250 matching");
    expect(state.reads.at(-1)).toMatchObject({ q: QUERY, cursor: "200" });
    await directory
      .locator(".mg-dt-footer")
      .getByRole("button", { name: "Page 5", exact: true })
      .click();
    await expect(
      directory.getByRole("link", { name: "node400.example", exact: true }),
    ).toBeVisible();
    await search.fill("second");
    await expect(
      directory.getByRole("link", { name: "node401.example", exact: true }),
    ).toBeVisible();
    await expect(directory).toContainText("1 loaded of 1 matching");
    expect(state.reads.at(-1)).toMatchObject({ q: "second", cursor: null });
    await page.goBack();
    await expect(search).toHaveValue(QUERY);
    await expect(
      directory.getByRole("link", { name: "node200.example", exact: true }),
    ).toBeVisible();
    await expect(directory).toContainText("250 loaded of 250 matching");
    await page.goForward();
    await expect(search).toHaveValue("second");
    await expect(directory).toContainText("1 loaded of 1 matching");
  });
}

test("keeps text and URL immediate while coalescing rapid search input", async ({ page }) => {
  const state = await searchFixture(page);
  await gotoThroughRestart(page, "/apis/endpoints");
  const directory = page.locator("section#directory");
  await expect(directory).toContainText("200 loaded of 450 matching");
  const search = page.getByRole("searchbox", { name: "Search endpoints", exact: true });
  await search.pressSequentially("second", { delay: 15 });
  await expect(search).toHaveValue("second");
  expect(new URL(page.url()).searchParams.get("q")).toBe("second");
  await expect(directory).toContainText("1 loaded of 1 matching");
  expect(state.reads.filter((read) => read.q).map((read) => read.q)).toEqual(["second"]);
});

test("holds cached pagination and retry controls until the current search settles", async ({
  page,
}) => {
  const state = await searchFixture(page);
  await gotoThroughRestart(page, "/apis/endpoints?" + new URLSearchParams({ q: QUERY }));
  const directory = page.locator("section#directory");
  const search = page.getByRole("searchbox", { name: "Search endpoints", exact: true });
  await expect(directory.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
  await page.clock.install();
  await search.fill("second");
  await expect(directory).toContainText("1 loaded of 1 matching");
  const pause = async () =>
    page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await pause();
  await search.fill(QUERY);
  await expect(directory).toContainText("Waiting for search input");
  await expect(directory.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  const beforeMore = state.reads.length;
  await page.getByRole("button", { name: "refresh", exact: true }).press("Enter");
  expect(state.reads.length).toBe(beforeMore);
  await page.clock.resume();
  await expect(directory.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
  state.failed.add(RESERVED);
  await search.fill(RESERVED);
  await expect(directory.getByRole("alert")).toBeVisible();
  await search.fill("second");
  await expect(directory).toContainText("1 loaded of 1 matching");
  await pause();
  await search.fill(RESERVED);
  await expect(directory).toContainText("Waiting for search input");
  await expect(directory.getByRole("alert")).toHaveCount(0);
  await expect(directory.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  const beforeRetry = state.reads.length;
  await page.getByRole("button", { name: "refresh", exact: true }).press("Enter");
  expect(state.reads.length).toBe(beforeRetry);
  state.failed.delete(RESERVED);
  await page.clock.resume();
  await expect(directory.getByRole("link", { name: "node402.example", exact: true })).toBeVisible();
});

test("keeps old pages and counts out of a new query while a delayed response resolves", async ({
  page,
}) => {
  const state = await searchFixture(page);
  await gotoThroughRestart(page, "/apis/endpoints");
  const directory = page.locator("section#directory");
  const search = page.getByRole("searchbox", { name: "Search endpoints", exact: true });
  await expect(directory).toContainText("200 loaded of 450 matching");
  await search.fill("slow");
  await expect.poll(() => state.reads.some((read) => read.q === "slow")).toBe(true);
  await expect(directory.getByRole("link", { name: "node0.example", exact: true })).toHaveCount(0);
  await expect(directory).not.toContainText("450 matching");
  await expect(directory).toContainText("Searching the endpoint catalog");
  await search.fill("second");
  await expect(directory).toContainText("1 loaded of 1 matching");
  state.releaseSlow();
  await expect.poll(() => state.slowFinished).toBe(true);
  await expect(directory.getByRole("link", { name: "node401.example", exact: true })).toBeVisible();
  await expect(directory).not.toContainText("250 matching");
});

test("preserves literal reserved characters and bounds raw URL searches without silently replacing them", async ({
  page,
}) => {
  const state = await searchFixture(page);
  await gotoThroughRestart(page, "/apis/endpoints");
  const directory = page.locator("section#directory");
  const search = page.getByRole("searchbox", { name: "Search endpoints", exact: true });
  await search.fill(RESERVED);
  await expect(directory.getByRole("link", { name: "node402.example", exact: true })).toBeVisible();
  expect(state.reads.at(-1)?.q).toBe(RESERVED);
  const max = "😀".repeat(100);
  await gotoThroughRestart(page, "/apis/endpoints?" + new URLSearchParams({ q: max }));
  await expect(directory).toContainText("No endpoints match this search.");
  expect(state.reads.at(-1)?.q).toBe(max);
  expect(max.length).toBe(200);
  const beforeInvalid = state.reads.length;
  const tooLong = "😀".repeat(101);
  await gotoThroughRestart(page, "/apis/endpoints?" + new URLSearchParams({ q: tooLong }));
  await expect(search).toHaveValue(tooLong);
  await expect(search).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Search is too long");
  await expect(directory).not.toContainText("No endpoints match");
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  expect(state.reads.length).toBe(beforeInvalid);
  await search.fill("second");
  await expect(directory).toContainText("1 loaded of 1 matching");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("preserves raw typed-looking search links through aliases, reload and history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const state = await searchFixture(page);
  const search = page.getByRole("searchbox", { name: "Search endpoints", exact: true });
  const directory = page.locator("section#directory");
  const values = [
    "404",
    "0",
    "1e3",
    "9007199254740993",
    "true",
    "false",
    "null",
    " [ 1, false, null ] ",
    ' { "b": 2, "a": 1 } ',
  ];
  for (const q of values) {
    await gotoThroughRestart(page, "/endpoints?" + new URLSearchParams({ q }));
    await expect(search).toHaveValue(q);
    await expect(directory).toContainText("No endpoints match this search.");
    expect(state.reads.at(-1)?.q).toBe(q);
  }
  await page.reload();
  await expect(search).toHaveValue(values.at(-1)!);
  await expect(directory).toContainText("0 loaded of 0 matching");
  await search.fill("404");
  await expect.poll(() => state.reads.at(-1)?.q).toBe("404");
  await expect(directory).toContainText("0 loaded of 0 matching");
  await page.goBack();
  await expect(search).toHaveValue(values.at(-1)!);
  await page.goForward();
  await expect(search).toHaveValue("404");
  await expect(directory).toContainText("0 loaded of 0 matching");
  await gotoThroughRestart(page, "/apis/endpoints?q=%22404%22");
  await expect(search).toHaveValue("404");
  await expect(directory).toContainText("0 loaded of 0 matching");
  const beforeInvalid = state.reads.length;
  const tooLong = "9".repeat(201);
  await gotoThroughRestart(page, "/apis/endpoints?q=" + tooLong);
  await expect(search).toHaveValue(tooLong);
  await expect(page.getByRole("alert")).toContainText("Search is too long");
  expect(state.reads.length).toBe(beforeInvalid);
});

test("combines server facets with search and keeps the monitored observation scope explicit", async ({
  page,
}) => {
  const state = await searchFixture(page);
  await gotoThroughRestart(
    page,
    "/apis/endpoints?" + new URLSearchParams({ q: QUERY, provider: "fixture-b", status: "ok" }),
  );
  const directory = page.locator("section#directory");
  await expect(directory).toContainText("124 loaded of 124 matching");
  expect(state.reads.at(-1)).toMatchObject({ q: QUERY, provider: "fixture-b", status: "ok" });
  await gotoThroughRestart(page, "/apis/endpoints?q=second&status=monitored");
  await expect(directory).toContainText("No loaded endpoints match this view.");
  await expect(directory).toContainText("0 observed in 1 loaded of 1 matching");
  await expect(directory).toContainText("monitored status matches loaded rows");
  expect(state.reads.at(-1)).toMatchObject({ q: "second", status: null });
});

test("retains only the current query on refresh failure and retries its first page", async ({
  page,
}) => {
  const state = await searchFixture(page);
  await gotoThroughRestart(page, "/apis/endpoints?q=second");
  const directory = page.locator("section#directory");
  await expect(directory).toContainText("1 loaded of 1 matching");
  state.failed.add("second");
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(directory.getByRole("alert")).toContainText("endpoint refresh");
  await expect(directory.getByRole("link", { name: "node401.example", exact: true })).toBeVisible();
  await expect(directory).toContainText("previously loaded endpoints remain visible");
  state.failed.add(RESERVED);
  await page.getByRole("searchbox", { name: "Search endpoints", exact: true }).fill(RESERVED);
  await expect(directory.getByRole("alert")).toContainText("tracked endpoints");
  await expect(directory.getByRole("link", { name: "node401.example", exact: true })).toHaveCount(
    0,
  );
  await expect(directory).not.toContainText("1 matching");
  state.failed.delete(RESERVED);
  await directory.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(directory).toContainText("1 loaded of 1 matching");
  await expect(directory.getByRole("link", { name: "node402.example", exact: true })).toBeVisible();
  expect(state.reads.at(-1)).toMatchObject({ q: RESERVED, cursor: null });
});

test("does not substitute fleet totals when result metadata is unavailable", async ({ page }) => {
  const state = await searchFixture(page);
  state.omitTotal = true;
  await gotoThroughRestart(page, "/apis/endpoints?q=second");
  const directory = page.locator("section#directory");
  await expect(directory).toContainText("1 loaded · match count unavailable");
  await expect(directory).toContainText("450 tracked across the fleet");
  await expect(directory.locator(".mg-dt-caption")).not.toContainText("450");
});
