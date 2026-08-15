import { test, expect } from "@playwright/test";

// #11204: every subnet and provider page must have a real internal link from
// its hub.
//
// The registry hubs virtualize their bodies (#8248), so the server-rendered
// HTML only ever carried anchors for the rows in view. Measured against
// production on 2026-08-14:
//
//   /subnets          30 links for 129 subnets   -> 99 pages unlinked
//   /apis/providers   25 links for 138 providers -> 113 pages unlinked
//
// Those pages were reachable only from sitemap.xml — the profile that lands a
// URL in "Crawled – currently not indexed", and per-subnet lookups are the
// demand Search Console actually records.
//
// These assert against the RAW HTTP RESPONSE rather than the hydrated DOM, via
// the `request` fixture: a crawler does not run our JavaScript, so the property
// only means something in the bytes the server sends. Asserting on
// `page.content()` would pass on links React added after hydration and prove
// nothing about what Googlebot indexes.
const API_STUB = "http://127.0.0.1:8081";

/** Distinct path segments linked under `prefix` in a raw HTML body. */
function linkedUnder(html: string, prefix: string): Set<string> {
  const pattern = new RegExp(`href="${prefix}([^"#?]+)"`, "g");
  return new Set([...html.matchAll(pattern)].map((match) => match[1]));
}

test.describe("#11204 crawlable entity indexes", () => {
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
    const linked = linkedUnder(await page.text(), "/subnets/");
    const missing = netuids.filter((netuid) => !linked.has(String(netuid)));
    expect(
      missing,
      `subnet pages with no internal link in the server-rendered HTML: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("the server-rendered /apis/providers links to EVERY provider", async ({ request }) => {
    const listed = await request.get(`${API_STUB}/api/v1/providers`);
    expect(listed.ok(), "the stub must serve the provider list this page reads").toBe(true);
    const slugs = (
      ((await listed.json()) as { data?: { providers?: Array<{ slug?: string; id?: string }> } })
        .data?.providers ?? []
    )
      // The list keys providers by `id`; the UI derives the route slug as
      // `slug ?? id` (normalizeProviderListItem), so match that here.
      .map((provider) => provider.slug || provider.id)
      .filter((slug): slug is string => Boolean(slug));
    expect(slugs.length).toBeGreaterThan(100);

    const page = await request.get("/apis/providers");
    expect(page.ok()).toBe(true);
    const linked = linkedUnder(await page.text(), "/providers/");
    const missing = slugs.filter(
      (slug) => !linked.has(encodeURIComponent(slug)) && !linked.has(slug),
    );
    expect(
      missing,
      `provider pages with no internal link in the server-rendered HTML: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
