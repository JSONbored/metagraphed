import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

const LEAKED_IMPLEMENTATION_COPY = /Only while there IS more to fetch|vocabularies \(#11696\)/i;

// Source comments placed directly between JSX children become reader-visible
// text. These three surfaces each contain a paginated table, so keep the
// regression at the rendered-document boundary rather than trusting source
// syntax alone.
for (const route of [
  "/chain/events",
  "/apis",
  "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
]) {
  test(`${route} never exposes implementation commentary`, async ({ page }) => {
    await gotoThroughRestart(page, route);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(LEAKED_IMPLEMENTATION_COPY);
  });
}
