import { test, expect, type Page } from "@playwright/test";
import { renderConsentPage, type ConsentView } from "../../../../src/oauth-consent.ts";
import { BEFORE_CONSENT_HTML } from "./oauth-consent-before.ts";

const URL = "https://consent.invalid/authorize";
const view: ConsentView = {
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  clientName: "A claimed name must not replace the host",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  registeredRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  scopes: ["profile", "offline_access"],
  nonce: "fixture-consent-nonce",
};

// All requests are intercepted. These are rendered fixtures, never a login,
// production request, or call to GitHub.
async function openConsent(page: Page, fixture = view, html = renderConsentPage(fixture)) {
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    requests.push(request.url());
    if (request.url() === URL && request.method() === "GET")
      await route.fulfill({ contentType: "text/html", body: html });
    else if (request.url() === URL && request.method() === "POST")
      await route.fulfill({ contentType: "text/plain", body: "fixture approval received" });
    else await route.abort();
  });
  await page.goto(URL);
  await page.evaluate(() => document.fonts.ready);
  return requests;
}

async function capture(page: Page, name: string) {
  // Fixed viewport only. Keep compact PNG chunks in existing CI logs so the
  // before/after matrix is recoverable without changing artifact workflows.
  const png = (await page.screenshot()).toString("base64");
  for (let offset = 0; offset < png.length; offset += 8000)
    console.log(
      "MCP_CONSENT_SCREENSHOT",
      JSON.stringify({ name, offset, data: png.slice(offset, offset + 8000) }),
    );
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    test(`MCP consent ${colorScheme} at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const requests = await openConsent(page, view, BEFORE_CONSENT_HTML);
      await capture(page, `before-${colorScheme}-${viewport.width}`);
      await page.setContent(renderConsentPage(view));
      await page.evaluate(() => document.fonts.ready);
      await expect(
        page.getByRole("heading", { name: "Connect your MCP client", level: 1 }),
      ).toBeVisible();
      await expect(page.getByRole("img", { name: "Metagraphed" })).toBeVisible();
      await expect(page.locator(".host")).toHaveText("claude.ai");
      await expect(page.getByText(view.clientName!)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue to GitHub" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Cancel", exact: true })).toHaveAttribute(
        "href",
        "/",
      );
      const metrics = await page.evaluate(() => ({
        fontLoaded: document.fonts.check('13px "Geist"'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        radius: getComputedStyle(document.querySelector(".card")!).borderRadius,
        targetHeights: [...document.querySelectorAll(".button")].map(
          (button) => button.getBoundingClientRect().height,
        ),
        transition: getComputedStyle(document.querySelector(".primary")!).transitionDuration,
      }));
      expect(metrics.fontLoaded).toBe(true);
      expect(metrics.overflow).toBe(false);
      expect(metrics.background).toBe(
        colorScheme === "light" ? "rgb(248, 248, 245)" : "rgb(22, 22, 22)",
      );
      expect(metrics.radius).toBe("4px");
      expect(metrics.targetHeights.every((height) => height >= 44)).toBe(true);
      expect(metrics.transition).toBe("0s");
      expect(requests).toEqual([URL]);

      await capture(page, `after-${colorScheme}-${viewport.width}`);
    });
  }
}

test("MCP consent supports keyboard approval with the unchanged nonce", async ({ page }) => {
  await openConsent(page);
  const button = page.getByRole("button", { name: "Continue to GitHub" });
  const cancel = page.getByRole("link", { name: "Cancel", exact: true });
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const submitted = page.waitForRequest(
    (request) => request.url() === URL && request.method() === "POST",
  );
  await page.keyboard.press("Enter");
  const form = new URLSearchParams((await submitted).postData()!);
  expect(form.get("consent_nonce")).toBe(view.nonce);
  expect(form.get("approve")).toBe("yes");
});

test("MCP consent reflows long claimed names, scopes, and loopback warnings on a small phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openConsent(page, {
    ...view,
    clientId: "opaque-dcr-client",
    clientName: `<script>untrusted-${"long-name-".repeat(40)}</script>`,
    redirectUri: "http://localhost:3118/callback",
    registeredRedirectUris: ["http://localhost:3118/callback"],
    scopes: ["profile", `future:${"long-scope-".repeat(40)}`],
  });
  await expect(page.getByText("(name self-reported)", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This client runs on your own machine.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Continue to GitHub" })).toBeVisible();
});
