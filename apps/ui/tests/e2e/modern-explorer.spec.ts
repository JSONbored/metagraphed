import { expect, test, type Page } from "@playwright/test";
import {
  modernExplorerFixture,
  modernBalanceFixture,
  modernStakeFixture,
  MODERN_EXPLORER_HASH,
  MODERN_EXPLORER_HEIGHT,
  MODERN_EXPLORER_PARTICIPANT,
  MODERN_EXPLORER_PUBLICATION,
  MODERN_EXPLORER_ACCOUNT,
} from "./modern-explorer-fixture";
import { decodeAccountEventCursor } from "../../../../src/v2/account-event-cursor.ts";
import { decodeAccountStakeCursor } from "../../../../src/v2/account-stake-cursor.ts";
import { ss58AccountId } from "../../src/lib/metagraphed/accounts";
import { gotoThroughRestart } from "./server-restart";

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ context, page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  await context.routeWebSocket("**/*", (socket) => socket.close());
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
});

function recordApiReads(page: Page) {
  const reads: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) reads.push(url);
  });
  return reads;
}

async function substitutePublication(page: Page, continuation: string) {
  let substitute = true;
  await page.route("**/api/v2/**", async (route) => {
    const url = new URL(route.request().url());
    const response = modernExplorerFixture(url, route.request().method());
    if (!response) throw new Error("Unexpected explorer read");
    if (substitute && url.searchParams.has(continuation)) {
      const body = JSON.parse(response.body);
      body.snapshot.publication_id = "f".repeat(64);
      response.body = JSON.stringify(body);
    }
    await route.fulfill(response);
  });
  return () => {
    substitute = false;
  };
}

test("published blocks open a pinned record and paginate both decoded collections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const reads = recordApiReads(page);
  const html = await (await page.request.get("/chain/blocks")).text();
  expect(html).toContain("Choose your network and API source");
  expect(html).not.toContain(MODERN_EXPLORER_HEIGHT);
  await gotoThroughRestart(page, "/chain/blocks");
  const blocks = page.locator("#published-blocks");
  await expect(blocks).toContainText(MODERN_EXPLORER_HEIGHT);
  await page.getByRole("button", { name: "Load older blocks", exact: true }).click();
  await expect(blocks.locator(".mg-dt-row:not(.mg-dt-skeleton)")).toHaveCount(30);
  const older = reads.find((url) => url.searchParams.has("before"))!;
  expect(older.searchParams.get("anchor_height")).toBe(MODERN_EXPLORER_HEIGHT);
  expect(older.searchParams.get("anchor_publication_id")).toBe(MODERN_EXPLORER_PUBLICATION);
  await blocks.getByRole("link", { name: MODERN_EXPLORER_HEIGHT, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/blocks/${MODERN_EXPLORER_HEIGHT}\\?`));
  expect(new URL(page.url()).searchParams.get("publication_id")).toBe(MODERN_EXPLORER_PUBLICATION);
  await expect(page.locator("#events")).toContainText("ApplyExtrinsic");
  await expect(page.locator("#events")).toContainText("Originating extrinsic #0");
  await expect(page.locator("#events")).toContainText(MODERN_EXPLORER_PARTICIPANT);
  await expect(page.locator("#events")).toContainText("18446744073709551615");
  await expect(page.locator("[data-event-index]")).toHaveCount(25);
  await expect(page.locator("[data-extrinsic-index]")).toHaveCount(25);
  await page.getByRole("button", { name: "Load more extrinsics", exact: true }).click();
  await expect(page.locator("[data-extrinsic-index]")).toHaveCount(27);
  await expect(page.locator("[data-event-index]")).toHaveCount(25);
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect(page.locator("[data-event-index]")).toHaveCount(27);
  const continuations = reads.filter(
    (url) =>
      url.searchParams.has("after_event_index") || url.searchParams.has("after_extrinsic_index"),
  );
  expect(continuations).toHaveLength(2);
  for (const url of continuations) {
    expect(url.searchParams.get("block_hash")).toBe(MODERN_EXPLORER_HASH);
    expect(url.searchParams.get("publication_id")).toBe(MODERN_EXPLORER_PUBLICATION);
    expect(
      url.searchParams.has("after_event_index") && url.searchParams.has("after_extrinsic_index"),
    ).toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(reads.every((url) => !url.pathname.includes("/api/v1/"))).toBe(true);
});

test("retains accepted blocks after a changed continuation and restarts explicitly", async ({
  page,
}) => {
  const reads = recordApiReads(page);
  const restore = await substitutePublication(page, "before");
  await gotoThroughRestart(page, "/chain/blocks");
  const blocks = page.locator("#published-blocks");
  await expect(blocks.locator(".mg-dt-row:not(.mg-dt-skeleton)")).toHaveCount(25);
  await page.getByRole("button", { name: "Load older blocks", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Published block evidence is unavailable");
  await expect(page.getByRole("status")).toContainText("Previously accepted blocks retained");
  await expect(blocks.locator(".mg-dt-row:not(.mg-dt-skeleton)")).toHaveCount(25);
  restore();
  const retry = reads.length;
  await page.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(blocks.locator(".mg-dt-row:not(.mg-dt-skeleton)")).toHaveCount(30);
  expect(reads[retry].searchParams.get("anchor_publication_id")).toBe(MODERN_EXPLORER_PUBLICATION);
  expect(reads[retry].searchParams.has("before")).toBe(true);
  const before = reads.length;
  await page.getByRole("button", { name: "Load latest publication", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(blocks.locator(".mg-dt-row:not(.mg-dt-skeleton)")).toHaveCount(25);
  expect(reads[before].searchParams.has("anchor_publication_id")).toBe(false);
  expect(reads[before].searchParams.has("before")).toBe(false);
});

test("keeps the two accepted collections independent after a changed publication", async ({
  page,
}) => {
  const restore = await substitutePublication(page, "after_event_index");
  await gotoThroughRestart(
    page,
    `/blocks/${MODERN_EXPLORER_HEIGHT}?block_hash=${MODERN_EXPLORER_HASH}&publication_id=${MODERN_EXPLORER_PUBLICATION}`,
  );
  await expect(page.locator("[data-event-index]")).toHaveCount(25);
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect(page.locator("#events").getByRole("alert")).toBeVisible();
  await expect(page.locator("#events")).toContainText("Accepted rows retained");
  await expect(page.locator("[data-event-index]")).toHaveCount(25);
  await page.getByRole("button", { name: "Load more extrinsics", exact: true }).click();
  await expect(page.locator("[data-extrinsic-index]")).toHaveCount(27);
  await expect(page.locator("[data-event-index]")).toHaveCount(25);
  restore();
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect(page.locator("[data-event-index]")).toHaveCount(27);
  await expect(page.locator("#events").getByRole("alert")).toHaveCount(0);
});

test("distinguishes missing blocks, unavailable pins, and invalid selections", async ({ page }) => {
  const reads = recordApiReads(page);
  await gotoThroughRestart(page, "/blocks/100");
  await expect(page.getByRole("status")).toContainText("No published block matches this height");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await gotoThroughRestart(
    page,
    `/blocks/${MODERN_EXPLORER_HEIGHT}?block_hash=${MODERN_EXPLORER_HASH}&publication_id=${"f".repeat(64)}`,
  );
  await expect(page.getByRole("alert")).toContainText("Published block evidence is unavailable");
  await expect(
    page.getByText("No published block matches this height.", { exact: true }),
  ).toHaveCount(0);
  const before = reads.length;
  await gotoThroughRestart(
    page,
    `/blocks/${MODERN_EXPLORER_HEIGHT}?publication_id=${MODERN_EXPLORER_PUBLICATION}`,
  );
  await expect(page.getByRole("status")).toContainText("complete hash/publication pin");
  expect(reads).toHaveLength(before);
});

test("rejects a saved source path before any read and provides source recovery", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("metagraphed:api-base", "https://example.test/path"),
  );
  const reads = recordApiReads(page);
  await gotoThroughRestart(page, "/chain/blocks");
  await expect(page.getByRole("status")).toContainText("must be a public HTTPS origin");
  expect(reads).toEqual([]);
  await page.getByRole("button", { name: "Reset API source", exact: true }).click();
  await expect(page.locator("#published-blocks")).toContainText(MODERN_EXPLORER_HEIGHT);
  expect(reads[0].pathname).toBe("/api/v2/networks/finney/blocks");
});

test("unsupported testnet performs no modern read", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("metagraphed:network", "testnet"));
  const reads = recordApiReads(page);
  await gotoThroughRestart(page, "/chain/blocks");
  await expect(page.getByRole("status")).toContainText("not published for this selected network");
  expect(reads).toEqual([]);
});

const existingAccount = "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9";
const activityRows = (page: Page) => page.locator("#activity .mg-dt-row:not(.mg-dt-skeleton)");
const balanceCell = (page: Page) =>
  page.locator(".mg-fact").filter({ hasText: "Balance (free + reserved)" });

test("account balance preserves exact subtotal and dated provenance without a legacy balance read", async ({
  page,
}) => {
  const reads = recordApiReads(page);
  const html = await (await page.request.get(`/accounts/${existingAccount}`)).text();
  expect(html).not.toContain("9007199.254741τ");
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  await expect(balanceCell(page)).toContainText("9007199.254741τ");
  await expect(page.locator("main")).toContainText("9007199254740993");
  await expect(page.locator("main")).toContainText("stale");
  const balances = reads.filter((url) => url.pathname.endsWith("/balance"));
  expect(balances).toHaveLength(1);
  expect(balances[0].pathname).toBe(
    `/api/v2/networks/finney/accounts/${ss58AccountId(existingAccount)}/balance`,
  );
  const source = page.locator("a").filter({ hasText: balances[0].pathname });
  await expect(source.first()).toHaveAttribute("href", balances[0].href);
});

test("account balance distinguishes stored zero runtime defaults and a failed cached refresh", async ({
  page,
}) => {
  let state: "zero" | "default" | "dust" | "failed" = "zero";
  await page.route("**/api/v2/**/accounts/*/balance*", async (route) => {
    if (state === "failed")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          api_version: "2",
          error: { code: "data_unavailable", message: "Controlled balance withdrawn" },
        }),
      });
    const accountId = /\/accounts\/([^/]+)\/balance$/.exec(
      new URL(route.request().url()).pathname,
    )![1];
    const value = modernBalanceFixture(accountId, state === "default" ? "not_stored" : "stored");
    if (value.result.status === "stored") {
      value.result.account.free_rao = state === "dust" ? "1" : "0";
      value.result.account.reserved_rao = "0";
      value.result.account.frozen_rao = "0";
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  await expect(balanceCell(page)).toContainText("0τ");
  state = "default";
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(balanceCell(page)).toContainText("—");
  await expect(balanceCell(page)).not.toContainText("0τ");
  await expect(page.locator("main")).toContainText("not_stored");
  state = "dust";
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(balanceCell(page)).toContainText("0.000000001τ");
  state = "failed";
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(balanceCell(page)).toContainText("—");
  await expect(balanceCell(page)).not.toContainText("0.000000001τ");
  await expect(page.locator("main")).toContainText(/refresh failed/i);
});

async function revealAccountSection(
  page: Page,
  family: "events" | "stake",
  account = existingAccount,
) {
  await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true })).toContainText(
    `${account.slice(0, 6)}…${account.slice(-6)}`,
  );
  const section = page.locator(family === "events" ? "#activity" : "#positions");
  // The SSR placeholder is replaced after source/network configuration loads.
  // Its published control exists before viewport-gated data acquisition.
  await expect(
    section.getByRole("button", {
      name: family === "events" ? "Restart from latest activity" : "Restart from latest census",
      exact: true,
    }),
  ).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  return section;
}

test("account activity continues, retains accepted rows on refusal, and restarts without its old cursor", async ({
  page,
}) => {
  const reads = recordApiReads(page);
  let refuseContinuation = true;
  await page.route("**/api/v2/**/accounts/*/events*", async (route) => {
    const url = new URL(route.request().url());
    if (refuseContinuation && url.searchParams.has("cursor")) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          api_version: "2",
          error: { code: "data_unavailable", message: "Controlled replay changed the interval" },
        }),
      });
    } else await route.fulfill(modernExplorerFixture(url, route.request().method())!);
  });
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  const activity = await revealAccountSection(page, "events");
  await expect(activityRows(page)).toHaveCount(25);
  await expect(activity).toContainText("Published coverage blocks");
  await expect(activity).not.toContainText("chain-direct");
  await activity.getByRole("button", { name: "Load older account events", exact: true }).click();
  await expect(activity.getByRole("alert")).toContainText(
    "Published account activity is unavailable",
  );
  await expect(activity).toContainText("Previously accepted account events retained");
  await expect(activityRows(page)).toHaveCount(25);
  refuseContinuation = false;
  await activity.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(activityRows(page)).toHaveCount(50);
  await expect(activity.getByRole("alert")).toHaveCount(0);
  const before = reads.length;
  await activity.getByRole("button", { name: "Restart from latest activity", exact: true }).click();
  await expect(activityRows(page)).toHaveCount(25);
  const restarted = reads
    .slice(before)
    .filter((url) => url.pathname.endsWith("/events") && url.pathname.startsWith("/api/v2/"));
  expect(restarted).toHaveLength(1);
  expect(restarted[0].searchParams.has("cursor")).toBe(false);
  expect(reads.some((url) => url.pathname === `/api/v1/accounts/${existingAccount}/events`)).toBe(
    false,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("account activity follows pinned blocks and canonical typed participant accounts", async ({
  page,
}) => {
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  await revealAccountSection(page, "events");
  await expect(activityRows(page)).toHaveCount(25);
  await page
    .locator("#activity")
    .getByRole("link", { name: MODERN_EXPLORER_HEIGHT, exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/blocks/${MODERN_EXPLORER_HEIGHT}\\?`));
  expect(new URL(page.url()).searchParams.get("publication_id")).toBe(MODERN_EXPLORER_PUBLICATION);
  const participant = page
    .locator("#events")
    .getByRole("link", { name: MODERN_EXPLORER_PARTICIPANT, exact: true })
    .first();
  await expect(participant).toHaveAttribute("href", `/accounts/${MODERN_EXPLORER_ACCOUNT}`);
  await participant.click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${MODERN_EXPLORER_ACCOUNT}$`));
  const activity = await revealAccountSection(page, "events", MODERN_EXPLORER_ACCOUNT);
  await expect(activityRows(page)).toHaveCount(25);
  await expect(activity).toContainText("#0 field_0");
  await expect(activity).toContainText("#2 field_2");
  await expect(activity).not.toContainText("#1 field_1");
  await activity.locator("summary").filter({ hasText: "Event #26 decoded fields" }).click();
  await expect(activity.getByLabel("Event #26 decoded fields", { exact: true })).toContainText(
    "18446744073709551615",
  );
});

test("account activity keeps eight pages while advancing the original interval", async ({
  page,
}) => {
  const reads = recordApiReads(page);
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  const activity = await revealAccountSection(page, "events");
  await expect(activityRows(page)).toHaveCount(25);
  for (let pageNumber = 2; pageNumber <= 9; pageNumber++) {
    await activity.getByRole("button", { name: "Load older account events", exact: true }).click();
    await expect(activityRows(page)).toHaveCount(Math.min(pageNumber, 8) * 25);
  }
  await expect(activityRows(page).first()).toContainText("#1 Balances.Transfer");
  const cursors = reads.filter(
    (url) =>
      url.pathname.startsWith("/api/v2/") &&
      url.pathname.endsWith("/events") &&
      url.searchParams.has("cursor"),
  );
  expect(cursors).toHaveLength(8);
  for (const url of cursors) {
    const cursor = decodeAccountEventCursor(url.searchParams.get("cursor")!);
    expect(cursor.anchor_height).toBe(MODERN_EXPLORER_HEIGHT);
    expect(cursor.anchor_publication_id).toBe(MODERN_EXPLORER_PUBLICATION);
  }
});

for (const family of ["events", "stake", "balance"] as const)
  test(`changing network cancels old account ${family} and cannot render its late response`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let release!: () => void;
    let completed!: () => void;
    let first = true;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const requests: string[] = [];
    const aborted: string[] = [];
    page.on("requestfailed", (request) => {
      if (
        new URL(request.url()).pathname.startsWith("/api/v2/") &&
        new URL(request.url()).pathname.endsWith("/" + family)
      )
        aborted.push(request.failure()?.errorText ?? "missing failure reason");
    });
    await page.route(`**/api/v2/**/accounts/*/${family}*`, async (route) => {
      requests.push(route.request().url());
      if (first) {
        first = false;
        await pending;
        try {
          await route.fulfill(modernExplorerFixture(new URL(route.request().url()))!);
        } catch {
          expect(route.request().failure()?.errorText).toMatch(/abort|cancel/i);
        } finally {
          completed();
        }
      } else await route.fulfill(modernExplorerFixture(new URL(route.request().url()))!);
    });
    try {
      await gotoThroughRestart(page, `/accounts/${existingAccount}`);
      const activity =
        family === "balance" ? balanceCell(page) : await revealAccountSection(page, family);
      const rows = activity.locator(".mg-dt-row:not(.mg-dt-skeleton)");
      await expect.poll(() => requests.length).toBe(1);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Testnet", exact: true }).click();
      if (family === "balance") await expect(activity).toContainText("—");
      else await expect(activity).toContainText("No other network was queried");
      release();
      await finished;
      await expect.poll(() => aborted).toHaveLength(1);
      expect(aborted[0]).toMatch(/abort|cancel/i);
      await expect(rows).toHaveCount(0);
      expect(requests).toHaveLength(1);
      await page.getByRole("button", { name: "Mainnet", exact: true }).click();
      await page.keyboard.press("Escape");
      if (family === "balance") await expect(activity).toContainText("9007199.254741τ");
      else {
        await revealAccountSection(page, family);
        await expect(rows).toHaveCount(family === "events" ? 25 : 10);
      }
      expect(requests).toHaveLength(2);
      expect(
        requests.every((url) => new URL(url).pathname.startsWith("/api/v2/networks/finney/")),
      ).toBe(true);
    } finally {
      release();
    }
  });

test("account navigation cancels balances and saved-source reload isolates late results", async ({
  page,
}) => {
  const selectedOrigin = "https://balance-source.example";
  const makeHeld = () => {
    let release!: () => void;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    return { pending, finished, release, complete };
  };
  let held = makeHeld();
  let holdNext = true;
  const requests: URL[] = [];
  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v2/") && url.pathname.endsWith("/balance"))
      aborted.push(request.failure()?.errorText ?? "missing failure reason");
  });
  await page.route("**/api/v2/**/accounts/*/balance*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const accountId = /\/accounts\/([^/]+)\/balance$/.exec(url.pathname)![1];
    const value = modernBalanceFixture(accountId);
    if (value.result.status === "stored" && accountId === MODERN_EXPLORER_PARTICIPANT) {
      value.result.account.free_rao = url.origin === selectedOrigin ? "2" : "1";
      value.result.account.reserved_rao = "0";
      value.result.account.frozen_rao = "0";
    }
    const response = {
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      contentType: "application/json",
      body: JSON.stringify(value),
    };
    if (!holdNext) return route.fulfill(response);
    holdNext = false;
    const controlled = held;
    await controlled.pending;
    try {
      await route.fulfill(response);
    } catch {
      expect(route.request().failure()?.errorText).toMatch(/abort|cancel/i);
    } finally {
      controlled.complete();
    }
  });
  try {
    await gotoThroughRestart(page, `/accounts/${existingAccount}`);
    await expect.poll(() => requests.length).toBe(1);
    await revealAccountSection(page, "events");
    await page
      .locator("#activity")
      .getByRole("link", { name: MODERN_EXPLORER_HEIGHT, exact: true })
      .first()
      .click();
    await page
      .locator("#events")
      .getByRole("link", { name: MODERN_EXPLORER_PARTICIPANT, exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/accounts/${MODERN_EXPLORER_ACCOUNT}$`));
    await expect(balanceCell(page)).toContainText("0.000000001τ");
    held.release();
    await held.finished;
    await expect.poll(() => aborted.length).toBe(1);
    await expect(balanceCell(page)).not.toContainText("9007199.254741τ");

    held = makeHeld();
    holdNext = true;
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await expect.poll(() => requests.length).toBe(3);
    await page.evaluate((origin) => {
      localStorage.setItem("metagraphed:api-base", origin);
    }, selectedOrigin);
    const previousDocument = await page.evaluate(() => performance.timeOrigin);
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(previousDocument);
    await expect(balanceCell(page)).toContainText("0.000000002τ");
    expect(requests[2].origin).not.toBe(selectedOrigin);
    expect(requests[3].origin).toBe(selectedOrigin);
    held.release();
    await held.finished;
    expect(aborted.every((reason) => /abort|cancel/i.test(reason))).toBe(true);
    await expect(balanceCell(page)).toContainText("0.000000002τ");
    await expect(balanceCell(page)).not.toContainText("0.000000001τ");
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)?.origin).toBe(selectedOrigin);
    const selectedPath = `/api/v2/networks/finney/accounts/${MODERN_EXPLORER_PARTICIPANT}/balance`;
    await expect(page.locator(`a[href="${selectedOrigin}${selectedPath}"]`).first()).toBeAttached();
  } finally {
    held.release();
  }
});

test("account stake pages exact units and root rights, retains accepted records and restarts explicitly", async ({
  page,
}) => {
  const reads = recordApiReads(page);
  let refuse = true;
  await page.route("**/api/v2/**/accounts/*/stake*", async (route) => {
    const url = new URL(route.request().url());
    if (refuse && url.searchParams.has("cursor"))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          api_version: "2",
          error: { code: "data_unavailable", message: "Controlled stake census withdrawn" },
        }),
      });
    return route.fulfill(modernExplorerFixture(url, route.request().method())!);
  });
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  const positions = await revealAccountSection(page, "stake");
  const rows = positions.locator(".mg-dt-row:not(.mg-dt-skeleton)");
  await expect(rows).toHaveCount(10);
  await expect(positions).toContainText("18446744073709551615 rao");
  await expect(positions).toContainText("Root entitlement");
  await expect(positions).toContainText("freshness stale");
  await positions.getByRole("button", { name: "Load more stake records", exact: true }).click();
  await expect(positions.getByRole("alert")).toContainText(
    "Published account stake is unavailable",
  );
  await expect(rows).toHaveCount(10);
  await expect(positions).toContainText("Previously accepted stake records retained");
  refuse = false;
  await positions.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(rows).toHaveCount(15);
  await expect(positions.getByRole("alert")).toHaveCount(0);
  await expect(positions).toContainText("No current position · retired");
  const before = reads.length;
  await positions.getByRole("button", { name: "Restart from latest census", exact: true }).click();
  await expect(rows).toHaveCount(10);
  const restarted = reads
    .slice(before)
    .filter((url) => url.pathname.endsWith("/stake") && url.pathname.startsWith("/api/v2/"));
  expect(restarted).toHaveLength(1);
  expect(restarted[0].searchParams.has("cursor")).toBe(false);
  await expect(positions).toContainText(
    "Liquid balances and combined TAO valuation are not supplied",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("account stake retains eight pages while continuing its original census", async ({ page }) => {
  const reads = recordApiReads(page);
  await page.route("**/api/v2/**/accounts/*/stake*", async (route) => {
    const url = new URL(route.request().url());
    const owner = /\/accounts\/([^/]+)\/stake$/.exec(url.pathname)![1];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        modernStakeFixture(owner, url.searchParams.get("cursor") ?? undefined, 10, 95),
      ),
    });
  });
  await gotoThroughRestart(page, `/accounts/${existingAccount}`);
  const positions = await revealAccountSection(page, "stake");
  const rows = positions.locator(".mg-dt-row:not(.mg-dt-skeleton)");
  await expect(rows).toHaveCount(10);
  for (let i = 2; i <= 9; i++) {
    await positions.getByRole("button", { name: "Load more stake records", exact: true }).click();
    await expect(rows).toHaveCount(Math.min(i, 8) * 10);
  }
  const continuations = reads.filter(
    (url) => url.pathname.endsWith("/stake") && url.searchParams.has("cursor"),
  );
  expect(continuations).toHaveLength(8);
  for (const url of continuations)
    expect(decodeAccountStakeCursor(url.searchParams.get("cursor")!).publication_id).toBe(
      "e".repeat(64),
    );
  await expect(positions).toContainText("Up to 8 loaded pages are retained");
  await expect(positions).toContainText(
    "Loaded 80 position records and 0 root entitlement records",
  );
});
