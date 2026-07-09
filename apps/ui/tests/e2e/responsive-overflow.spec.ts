import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { findOverflowViolations } from "./find-overflow-violations.js";
import { ROUTES, VIEWPORTS } from "./overflow-check.config.js";

// Baseline-diff, not zero-tolerance: this app has pre-existing, already-tracked
// overflow bugs (#3930, #3931, #3985, etc.) that are separately-scored
// contributor work, not something this check should force-fix or block on.
// The baseline is a snapshot of KNOWN violations at the time it was last
// regenerated; this test fails only on a NEW element escaping the viewport
// that isn't already in that snapshot -- converting "a human might notice a
// new regression by luck" into "CI always catches it," without also making
// every apps/ui PR red until the existing backlog is cleared.
//
// Regenerate after intentionally fixing (shrinks it) or after confirming a
// new entry is an accepted layout choice, not a bug (grows it) --
// `npm run test:e2e:update-baseline --workspace=apps/ui`. Don't hand-edit;
// let the script keep it consistent with the real detector output.
const BASELINE_PATH = new URL("./overflow-baseline.json", import.meta.url);
const baseline: Record<string, string[]> = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

function fingerprint(v: { tag: string; cls: string }): string {
  return `${v.tag}:${v.cls}`;
}

for (const route of ROUTES) {
  test.describe(route, () => {
    for (const viewport of VIEWPORTS) {
      test(`no new overflow-escaping elements at ${viewport.name} (${viewport.width}px)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route);
        // Not a fixed wait: the home page's live "movers" panel measurably
        // flips between an empty/skeleton and fully-loaded width depending on
        // how long its data fetch takes, so a fixed delay produced
        // nondeterministic results across otherwise-identical runs. Wait for
        // the actual fetch to settle instead. (/explorer is excluded above
        // specifically because IT can't reach networkidle at all.)
        await page.waitForLoadState("networkidle");

        const violations = await page.evaluate(findOverflowViolations, viewport.width);
        const found = new Set(violations.map(fingerprint));
        const known = new Set(baseline[`${route}@${viewport.width}`] ?? []);
        const newViolations = [...found].filter((f) => !known.has(f));

        expect(
          newViolations,
          newViolations.length
            ? `${route} at ${viewport.width}px: ${newViolations.length} new element(s) escaping the viewport, not in the known baseline: ${newViolations.join(", ")}. If this is confirmed intentional (not a bug), regenerate the baseline; otherwise this is a real regression.`
            : "",
        ).toEqual([]);
      });
    }
  });
}
