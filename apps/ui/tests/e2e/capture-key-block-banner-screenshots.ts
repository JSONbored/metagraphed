/**
 * Capture the tenant-visible block banner for #8611.
 *
 * The banner only renders for a SIGNED-IN account that is currently blocked,
 * so the standard capture-pr-screenshots.ts run cannot reach it: with no
 * session the API-keys panel shows its sign-in prompt and before/after would
 * be byte-identical. This script seeds a session into sessionStorage (the same
 * key use-api-session.ts writes) and stubs the four account-scoped endpoints
 * the panel calls, so the real component renders its real blocked state
 * against real styles -- not a mock-up pasted into the PR.
 *
 * "before" stubs /keys/status as unblocked, which is exactly what main renders
 * today (main has no such endpoint at all, and the panel simply has no banner).
 * "after" stubs it as blocked.
 *
 * Same viewport/theme contract as capture-address-labels-screenshots.ts.
 *
 * Usage:
 *   UI_BASE_URL=http://127.0.0.1:8080 node tests/e2e/capture-key-block-banner-screenshots.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/key-block-banner-screenshots");
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8080";
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

const WALLET = JSON.stringify({ address: SS58, source: "polkadot-js" });

const SESSION = JSON.stringify({
  token: "session-token-for-screenshots",
  ss58: SS58,
  tier: "paid",
  expiresAtMs: Date.now() + 3_600_000,
});

const KEYS = [
  {
    key_id: "key_screenshot_1",
    prefix: "mg_scr1",
    tier: "paid",
    created_at: Date.parse("2026-07-01T00:00:00Z"),
    revoked_at: null,
    last_used_at: Date.parse("2026-07-29T09:00:00Z"),
  },
];

const USAGE = {
  window_days: 7,
  days: [
    { day: "2026-07-27", count: 1420 },
    { day: "2026-07-28", count: 1633 },
    { day: "2026-07-29", count: 1580 },
  ],
  top_routes: [
    { route: "chain-events", count: 3100 },
    { route: "mcp", count: 1200 },
  ],
};

const BLOCKED = {
  blocked: true,
  reason_code: "abuse_scraping",
  message: "Access pattern consistent with bulk scraping rather than integration use.",
  blocked_at: Date.parse("2026-07-29T11:00:00Z"),
};

async function stub(page, blocked) {
  await page.route("**/api/v1/keys**", async (route) => {
    const url = route.request().url();
    const body = url.includes("/keys/status")
      ? blocked
        ? BLOCKED
        : { blocked: false }
      : url.includes("/keys/usage")
        ? USAGE
        : { keys: KEYS };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, schema_version: 1, data: body }),
    });
  });
}

async function prime(page, theme) {
  await page.goto(`${BASE_URL}/`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.evaluate(
    ({ t, session, wallet }) => {
      localStorage.setItem("mg-theme", t);
      // The panel gates on a CONNECTED wallet before it even looks at the
      // session, so both have to be seeded: lib/metagraphed/wallet.ts reads
      // localStorage `metagraphed:wallet`, use-api-session.ts reads
      // sessionStorage `metagraphed:api-session`.
      localStorage.setItem("metagraphed:wallet", wallet);
      sessionStorage.setItem("metagraphed:api-session", session);
    },
    { t: theme, session: SESSION, wallet: WALLET },
  );
}

async function open(page) {
  await page.goto(`${BASE_URL}/settings`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    await page.waitForTimeout(2500);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      // MUST run before app JS: lib/metagraphed/wallet.ts clears the stored
      // wallet on load when no extension is present (verified -- seeding
      // localStorage alone comes back null after a reload), so a plain
      // page.evaluate can never produce a connected state. hasInjectedWallet()
      // only checks that window.injectedWeb3 has at least one key, and
      // connectWallet() is never called on this path because the stored wallet
      // already satisfies useWallet's initial "connected" state.
      await ctx.addInitScript(() => {
        (window as unknown as { injectedWeb3: Record<string, unknown> }).injectedWeb3 = {
          "polkadot-js": {
            version: "0.0.0-screenshot",
            enable: async () => ({
              accounts: {
                get: async () => [
                  {
                    address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                    name: "Screenshot",
                  },
                ],
              },
            }),
          },
        };
      });
      const page = await ctx.newPage();
      for (const variant of ["before", "after"]) {
        await stub(page, variant === "after");
        await prime(page, theme);
        await open(page);
        // The API-keys panel sits well below the fold on /settings; a
        // page-top capture would show the watchlist and prove nothing.
        const anchor = page
          .locator("text=/API access is currently blocked|Tier:|Connect your wallet/i")
          .first();
        if (await anchor.count()) {
          await anchor.scrollIntoViewIfNeeded();
          await page.waitForTimeout(400);
        }
        await page.screenshot({
          path: path.join(OUT_DIR, `keys-${viewport.name}-${theme}-${variant}.png`),
        });
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`wrote screenshots to ${OUT_DIR}`);
}

await main();
