import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

test.describe("child-commit controlled loading", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("lets a phone reader inspect an activity mark before following its block link", async ({
    page,
  }) => {
    let releaseClient: (() => void) | undefined;
    const clientReleased = new Promise<void>((resolve) => {
      releaseClient = resolve;
    });
    let firstClientHeld: (() => void) | undefined;
    const firstClientResponse = new Promise<void>((resolve) => {
      firstClientHeld = resolve;
    });
    const heldScripts: Array<{ url: string; status: number }> = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.resourceType() !== "script" ||
        new URL(request.url()).origin !== "http://localhost:8080"
      ) {
        await route.fallback();
        return;
      }
      const upstream = await route.fetch();
      heldScripts.push({ url: request.url(), status: upstream.status() });
      firstClientHeld?.();
      await clientReleased;
      await route.fulfill({ response: upstream });
    });
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await gotoThroughRestart(page, "/chain/blocks", { waitUntil: "commit" });

      await firstClientResponse;
      const rawActivity = page.locator(".mg-block-activity");
      const rawMark = rawActivity.locator(".mg-block-activity-mark").nth(1);
      await expect(rawActivity.locator(".mg-block-activity-mark").first()).toHaveAttribute(
        "tabindex",
        "0",
      );
      await expect(rawMark).not.toHaveAttribute("data-active", "true");
      const firstMarkTabIndex = await rawActivity
        .locator(".mg-block-activity-mark")
        .first()
        .getAttribute("tabindex");
      const targetSelectedBefore = (await rawMark.getAttribute("data-active")) === "true";
      const targetHrefBefore = await rawMark.getAttribute("href");
      expect(targetHrefBefore).toMatch(/^\/blocks\/\d+$/);
      const markerBefore = await rawActivity.getAttribute("data-client-enhanced");
      expect(markerBefore).toBeNull();
      const activityBeforeClient = await rawActivity.elementHandle();
      if (!activityBeforeClient) throw new Error("SSR activity section is absent");
      expect(heldScripts.length).toBeGreaterThan(0);
      expect(heldScripts.every((script) => script.status >= 200 && script.status < 300)).toBe(true);
      await test.info().attach("child-readiness-before-release", {
        body: JSON.stringify({
          heldScripts,
          markerBefore,
          firstMarkTabIndex,
          targetHrefBefore,
          targetSelectedBefore,
        }),
        contentType: "application/json",
      });
      releaseClient?.();

      // Resolve the mark only in an instance whose own client effect committed.
      // The same locator also waits for a new instance if this section remounts.
      const activity = page.locator('.mg-block-activity[data-client-enhanced="true"]');
      await expect(activity).toBeVisible();
      const mark = activity.locator(".mg-block-activity-mark").nth(1);
      const href = await mark.getAttribute("href");
      expect(href).toMatch(/^\/blocks\/\d+$/);
      // The fixture window is intentionally static while the numeric block it
      // names changes between captures. Give intent preloading a real compact
      // block record so this interaction test never leaks a fixture miss.
      const blockFixture = await page.request.get("http://127.0.0.1:8081/api/v1/blocks/8713384");
      expect(blockFixture.ok()).toBe(true);
      const blockBody = await blockFixture.body();
      const extrinsicsFixture = await page.request.get(
        "http://127.0.0.1:8081/api/v1/blocks/8713384/extrinsics?limit=100",
      );
      expect(extrinsicsFixture.ok()).toBe(true);
      const extrinsicsBody = await extrinsicsFixture.body();
      await page.route("**/api/v1/blocks/*", async (route) => {
        if (new URL(route.request().url()).pathname !== `/api/v1${href}`) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: blockFixture.status(),
          contentType: blockFixture.headers()["content-type"] ?? "application/json",
          body: blockBody,
        });
      });
      await page.route("**/api/v1/blocks/*/extrinsics*", async (route) => {
        await route.fulfill({
          status: extrinsicsFixture.status(),
          contentType: extrinsicsFixture.headers()["content-type"] ?? "application/json",
          body: extrinsicsBody,
        });
      });

      await expect(mark).not.toHaveAttribute("data-active", "true");
      const sameSectionNode = await activity.evaluate(
        (element, previousSection) => element === previousSection,
        activityBeforeClient,
      );
      expect(sameSectionNode).toBe(true);
      expect(href).toBe(targetHrefBefore);
      const markerAfter = await activity.getAttribute("data-client-enhanced");
      expect(markerAfter).toBe("true");
      const targetSelectedAfter = (await mark.getAttribute("data-active")) === "true";
      await test.info().attach("child-readiness-before-touch", {
        body: JSON.stringify({
          markerAfter,
          sameSectionNode,
          targetHrefAfter: href,
          targetSelectedAfter,
        }),
        contentType: "application/json",
      });

      await mark.tap();
      await expect(page).toHaveURL(/\/chain\/blocks$/);
      await expect(mark).toHaveAttribute("data-active", "true");
      await expect(page.locator(".mg-block-activity-reading")).toContainText(
        `#${Number(href!.replace("/blocks/", "")).toLocaleString("en-US")}`,
      );

      await mark.click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));

    } finally {
      releaseClient?.();
    }
  });
});
