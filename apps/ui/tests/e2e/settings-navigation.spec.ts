import { expect, test, type Page } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const envelope = (data: unknown) => JSON.stringify({ ok: true, data });

async function signedInFixture(page: Page) {
  await page.addInitScript((address) => {
    if (location.origin === "null") return;
    const expiresAtMs = Date.now() + 3_600_000;
    window.injectedWeb3 = {
      fixture: {
        enable: async () => ({
          accounts: { get: async () => [{ address, name: "Fixture account" }] },
        }),
      },
    };
    localStorage.setItem("metagraphed:wallet", JSON.stringify({ address, source: "fixture" }));
    localStorage.setItem(
      "metagraphed:watch-token",
      JSON.stringify({ token: "fixture-watch-token", ss58: address, expiresAtMs }),
    );
    sessionStorage.setItem(
      "metagraphed:api-session",
      JSON.stringify({ token: "fixture-api-token", ss58: address, tier: "pro", expiresAtMs }),
    );
  }, OWNER);
  await page.route("**/api/v1/keys", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: envelope(
        route.request().method() === "POST"
          ? {
              key: "fixture-revealed-once",
              key_id: "key_fixture_navigation",
              tier: "pro",
              created_at: 1_784_000_000_000,
            }
          : { keys: [] },
      ),
    }),
  );
  await page.route("**/api/v1/keys/status", (route) =>
    route.fulfill({ contentType: "application/json", body: envelope({ blocked: false }) }),
  );
  await page.route("**/api/v1/watch/triggers", (route) =>
    route.fulfill({ contentType: "application/json", body: envelope({ triggers: [] }) }),
  );
  await page.route("**/api/v1/watch/push-subscriptions", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: envelope({ subscriptions: [], max_devices: 3 }),
    }),
  );
}

for (const width of [375, 768, 1280]) {
  test(`Settings destinations stay in the URL and browser history (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await gotoThroughRestart(page, "/settings");
    const appearance = page.getByRole("link", { name: "Appearance", exact: true });
    const watched = page.getByRole("link", { name: "Watchlists & alerts", exact: true });
    const developer = page.getByRole("link", { name: "Developer access", exact: true });
    await expect(appearance).toHaveAttribute("aria-current", "page");
    await expect(page.locator('.mg-section-nav a[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('[data-settings-group="appearance"]')).toBeVisible();
    for (const link of [appearance, watched, developer]) {
      const bounds = await link.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await developer.click();
    await expect(page).toHaveURL(/\/settings#keys$/);
    await expect(developer).toHaveAttribute("aria-current", "page");
    await expect(page.locator('.mg-section-nav a[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator("#keys")).toBeVisible();
    await expect(page.locator('[data-settings-group="appearance"]')).toBeHidden();
    await watched.click();
    await expect(page).toHaveURL(/\/settings#wallet$/);
    await expect(page.locator("#wallet")).toBeVisible();
    await page.goBack();
    await expect(developer).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#keys")).toBeVisible();
    await page.goForward();
    await expect(watched).toHaveAttribute("aria-current", "page");
    await page.reload();
    await expect(watched).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#wallet")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const [hash, label] of [
  ["preferences", "Appearance"],
  ["wallet", "Watchlists & alerts"],
  ["portability", "Watchlists & alerts"],
  ["alerts", "Watchlists & alerts"],
  ["keys", "Developer access"],
  ["webhooks", "Developer access"],
]) {
  test(`existing #${hash} links reveal the intended group below navigation`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, `/settings#${hash}`);
    await expect(page.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator('.mg-section-nav a[aria-current="page"]')).toHaveCount(1);
    const target = page.locator(`#${hash}`);
    await expect(target).toBeVisible();
    await expect
      .poll(async () => {
        const nav = await page
          .getByRole("navigation", { name: "Sections", exact: true })
          .boundingBox();
        const box = await target.boundingBox();
        return box!.y >= nav!.y + nav!.height - 1;
      })
      .toBe(true);
  });
}

test("appearance and public saved items work without activating private tools", async ({
  page,
}) => {
  await signedInFixture(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      "metagraphed:watchlist:subnet",
      JSON.stringify({ version: 2, ids: Array.from({ length: 26 }, (_, i) => String(i + 1)) }),
    ),
  );
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/(keys|watch\/)/.test(new URL(request.url()).pathname))
      privateRequests.push(request.url());
  });
  await gotoThroughRestart(page, "/settings#unsupported-old-section");
  await expect(page.getByRole("link", { name: "Appearance", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
  expect(privateRequests).toEqual([]);
  await page.getByRole("link", { name: "Watchlists & alerts", exact: true }).click();
  await expect(
    page.locator("#wallet").getByText("showing 24 of 26 saved items", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("#wallet").getByRole("link", { name: /SN1/ }).first()).toBeVisible();
  expect(privateRequests.some((url) => new URL(url).pathname.startsWith("/api/v1/keys"))).toBe(
    false,
  );
});

test("visited forms and masked one-time keys survive switching while inactive controls stay inert", async ({
  page,
}) => {
  await signedInFixture(page);
  await gotoThroughRestart(page, "/settings#keys");
  const keys = page.locator("#keys");
  await keys.getByRole("button", { name: "Generate new key", exact: true }).click();
  const secret = keys.getByText("fixture-revealed-once", { exact: true });
  await expect(secret).toBeVisible();
  expect(await secret.evaluate((element) => Boolean(element.closest(".ph-no-capture")))).toBe(true);
  const url = page.locator("#webhooks").getByLabel("Webhook URL", { exact: false });
  await url.fill("https://example.test/draft");
  const appearance = page.getByRole("link", { name: "Appearance", exact: true });
  await appearance.click();
  const inactive = page.locator('[data-settings-group="developer"]');
  await expect(inactive).toBeHidden();
  await expect(inactive).toHaveAttribute("inert", "");
  await appearance.focus();
  await inactive
    .locator("input")
    .first()
    .evaluate((element) => (element as HTMLElement).focus());
  await expect(appearance).toBeFocused();
  await page.getByRole("link", { name: "Developer access", exact: true }).click();
  await expect(secret).toBeVisible();
  await expect(url).toHaveValue("https://example.test/draft");
});

test("group navigation works by keyboard and preserves stored preferences", async ({ page }) => {
  await gotoThroughRestart(page, "/settings");
  await page.locator("#preferences").getByRole("radio", { name: "Dark", exact: true }).click();
  await page.locator("#preferences").getByRole("radio", { name: "USD", exact: true }).click();
  const developer = page.getByRole("link", { name: "Developer access", exact: true });
  await developer.focus();
  await page.keyboard.press("Enter");
  await expect(developer).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Tab");
  await expect(
    page.locator("#keys").getByRole("button", { name: "Connect wallet", exact: true }),
  ).toBeFocused();
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.locator("#preferences").getByRole("radio", { name: "USD", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});

test("browser history closes a wallet menu from an inactive group", async ({ page }) => {
  await gotoThroughRestart(page, "/settings");
  await page.getByRole("link", { name: "Developer access", exact: true }).click();
  await page.locator("#keys").getByRole("button", { name: "Connect wallet", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-settings-group="appearance"]')).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[inert]")))).toBe(
    false,
  );
  await page.goForward();
  await expect(page.locator("#keys")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("#keys").getByRole("button", { name: "Connect wallet", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator("#keys").getByRole("button", { name: "Connect wallet", exact: true }),
  ).toBeFocused();
});

test("browser history closes the private label editor without saving an inactive form", async ({
  page,
}) => {
  await signedInFixture(page);
  await gotoThroughRestart(page, "/settings");
  await page.getByRole("link", { name: "Watchlists & alerts", exact: true }).click();
  await page
    .locator("#wallet")
    .getByRole("button", { name: "Label this as mine", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved private label");
  await page.goBack();
  await expect(page.locator('[data-settings-group="appearance"]')).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("#wallet")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator("#wallet").getByRole("button", { name: "Label this as mine", exact: true }),
  ).toBeVisible();
});

test("phone touch scrolling uses the document and keeps group navigation reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoThroughRestart(page, "/settings#keys");
  await expect(page.locator("#keys")).toBeVisible();
  const before = await page.evaluate(() => window.scrollY);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 24, y: 690 }],
  });
  for (let y = 640; y >= 290; y -= 50) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 24, y }],
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);
  await expect(page.getByRole("link", { name: "Appearance", exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(page.getByRole("link", { name: "Watchlists & alerts", exact: true })).toBeInViewport(
    { ratio: 1 },
  );
  expect(
    await page
      .locator('[data-settings-group="developer"]')
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  await expect(page.locator("#preferences")).toBeVisible();
});
