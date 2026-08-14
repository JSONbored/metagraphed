import { test, expect } from "@playwright/test";

// #11204: every subnet page must have a real internal link from /subnets.
//
// The registry table virtualizes its body (#8248), so the server-rendered HTML
// only ever carried anchors for the rows in view. Measured against production
// on 2026-08-14: 30 distinct `/subnets/{n}` hrefs for 129 subnets, which left
// 99 subnet pages reachable only from sitemap.xml — the profile that lands a
// URL in "Crawled – currently not indexed", and per-subnet lookups are the
// demand Search Console actually records.
//
// This asserts against the RAW HTTP RESPONSE rather than the hydrated DOM, via
// the `request` fixture: a crawler does not run our JavaScript, so the property
// only means something if it holds in the bytes the server sends. Asserting on
// `page.content()` would pass on links React added after hydration and prove
// nothing about what Googlebot indexes.
const API_STUB = "http://127.0.0.1:8081";

test.describe("#11204 crawlable subnet index", () => {
  test("the server-rendered /subnets links to EVERY subnet", async ({ request }) => {
    const listed = await request.get(`${API_STUB}/api/v1/subnets?limit=200`);
    expect(listed.ok(), "the stub must serve the subnet list this page reads").toBe(true);
    const netuids = (
      ((await listed.json()) as { data?: { subnets?: Array<{ netuid?: number }> } }).data
        ?.subnets ?? []
    )
      .map((subnet) => subnet.netuid)
      .filter((netuid): netuid is number => Number.isInteger(netuid));
    // Guard the guard: if the fixture ever served an empty list this test would
    // otherwise assert nothing and pass.
    expect(netuids.length).toBeGreaterThan(100);

    const page = await request.get("/subnets");
    expect(page.ok()).toBe(true);
    const html = await page.text();

    const linked = new Set(
      [...html.matchAll(/href="\/subnets\/(\d+)"/g)].map((match) => Number(match[1])),
    );
    const missing = netuids.filter((netuid) => !linked.has(netuid));
    expect(
      missing,
      `subnet pages with no internal link in the server-rendered HTML: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
