import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

// #6426: extrinsics.$hash.tsx's "Related Multisig calls" section had no isError
// branch. A failed relatedQuery fetch left `data` undefined, so relatedCalls
// became [] and the section rendered the SAME "No other extrinsics reference
// this call_hash yet." copy as a genuine zero-row result -- a reader could not
// tell "no siblings" from "we couldn't find out". The fix adds an isError
// branch rendering TableState variant="error"; these tests pin both directions
// and the first fails on the pre-fix code, which is the point.
//
// Deterministic by design, mirroring evidence-deep-link.spec.ts: every
// api.metagraph.sh request is fulfilled locally (no live chain data), so a
// real multisig call gaining or losing siblings can never make this flap. The
// only moving part is the related-calls request's status -- 500 for the error
// case, an empty 200 for the empty case.

const HERE = path.dirname(fileURLToPath(import.meta.url));
// An approve_as_multi, so its call_args carry a direct call_hash and
// multisigCallHash() returns non-null -- the precondition for the section to
// render at all (an as_multi nests its call and would not).
const DETAIL = readFileSync(path.join(HERE, "fixtures", "extrinsic-multisig-6426.json"), "utf8");
const HASH = "0x25a23bcd160f1403ed130b1cd594302b8fc949f99802e7aee15e8a5670238564";
const ROUTE = `/extrinsics/${HASH}`;

const isRelatedCalls = (url: string) =>
  url.includes("/api/v1/extrinsics?") && url.includes("call_hash=");

/**
 * Stubs every api.metagraph.sh request so nothing hits live data, then lets the
 * caller decide how the related-calls lookup resolves. Routes are matched
 * last-registered-first, so the specific handlers below win over the catch-all.
 */
async function openExtrinsic(
  page: import("@playwright/test").Page,
  relatedResponder: (route: import("@playwright/test").Route) => Promise<void> | void,
) {
  // Catch-all first (lowest priority): anything we don't care about resolves to
  // an empty-but-valid payload rather than reaching the network.
  await page.route("**/api.metagraph.sh/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: {} }),
    }),
  );
  // The extrinsic detail itself must succeed or the page never renders.
  await page.route(`**/api/v1/extrinsics/${HASH}**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: DETAIL }),
  );
  // The related-calls lookup -- the request under test.
  await page.route((url) => isRelatedCalls(url.toString()), relatedResponder);

  await page.goto(ROUTE);
  // The client retries a failed query 3x with backoff (router.tsx), so give the
  // error state time to settle rather than asserting on a mid-retry skeleton.
  const section = page.locator("section#multisig-chain");
  await expect(section).toBeVisible();
}

test.describe("#6426 Related Multisig calls error state", () => {
  test("a failed lookup shows an error state, not the empty-result copy", async ({ page }) => {
    await openExtrinsic(page, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "internal", message: "boom" } }),
      }),
    );

    const section = page.locator("section#multisig-chain");
    // The client retries a failed query 3x with backoff before isError flips
    // (router.tsx), so allow well past that window rather than the 5s default.
    await expect(section.getByText("Couldn't load related Multisig calls")).toBeVisible({
      timeout: 20_000,
    });
    // The whole point: a fetch failure must NOT read as "no related calls".
    await expect(
      section.getByText("No other extrinsics reference this call_hash yet."),
    ).toHaveCount(0);
  });

  test("a successful empty lookup still shows the empty-result copy", async ({ page }) => {
    await openExtrinsic(page, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { extrinsics: [] } }),
      }),
    );

    const section = page.locator("section#multisig-chain");
    await expect(
      section.getByText("No other extrinsics reference this call_hash yet."),
    ).toBeVisible();
    await expect(section.getByText("Couldn't load related Multisig calls")).toHaveCount(0);
  });
});
