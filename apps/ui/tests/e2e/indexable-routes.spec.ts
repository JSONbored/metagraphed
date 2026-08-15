import { test, expect } from "@playwright/test";

// #11204: a URL we ask Google to index must ANSWER, and a URL we have retired
// must say so permanently.
//
// Measured against production on 2026-08-15, sampling the live sitemap: 33 of
// 113 sampled URLs answered 307, including every one of the 1,023 validator
// pages — 62% of the sitemap. Each redirected to itself plus a full dump of its
// default search params:
//
//   /validators/5E2LP…  307 -> /validators/5E2LP…?tab=subnets&window=30d&sort=…
//   /apis               307 -> /apis?q=&sort=&order=asc&limit=25&cursor=&page=1…
//
// Googlebot got the identical 307. The page it lands on canonicalizes back to
// the clean URL, so the crawler is handed a redirect whose destination points
// home again — the shape that fills the "Page with redirect" and "Alternate
// page with proper canonical tag" buckets and spends crawl budget doing it.
//
// The cause is TanStack Router materialising `.default()` values during
// `validateSearch` and rewriting the URL to match. `stripDefaultSearchParams`
// (lib/metagraphed/url-state.ts) exists for exactly this and had been applied
// to some routes and not others; nothing asserted which.
//
// These assert against the RAW HTTP RESPONSE with redirects disabled, because
// the status code IS the property under test. A normal `page.goto` follows the
// redirect and reports the 200 at the end of it, which is precisely how this
// stayed invisible.

/** Every path in server.ts's SITEMAP_STATIC_PATHS, plus one of each entity family. */
const MUST_BE_200 = [
  "/",
  "/subnets",
  "/apis",
  "/apis/providers",
  "/apis/endpoints",
  "/apis/schemas",
  "/chain",
  "/chain/blocks",
  "/chain/extrinsics",
  "/chain/events",
  "/chain/governance",
  "/chain/runtime",
  "/health",
  "/status",
  "/contribute",
  "/about",
  "/validators",
  "/accounts",
  "/docs",
];

/** Retired paths: permanent moves, every one documented as such in its route. */
const MUST_BE_301 = [
  ["/explorer", "/chain"],
  ["/blocks", "/chain/blocks"],
  ["/events", "/chain/events"],
  ["/extrinsics", "/chain/extrinsics"],
  ["/runtime", "/chain/runtime"],
  ["/schemas", "/apis/schemas"],
  ["/surfaces", "/apis"],
  ["/endpoints", "/apis/endpoints"],
  ["/providers", "/apis/providers"],
  ["/gaps", "/contribute"],
  ["/portfolio", "/accounts"],
  ["/sudo", "/chain/governance"],
  ["/tools/ss58", "/accounts"],
] as const;

test.describe("#11204 indexable routes answer, retired routes redirect permanently", () => {
  for (const path of MUST_BE_200) {
    test(`${path} answers 200 with no redirect hop`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(
        response.status(),
        `${path} must not redirect — it is a URL the sitemap asks Google to index. ` +
          `Got ${response.status()} -> ${response.headers()["location"] ?? "(no location)"}. ` +
          `A route whose validateSearch schema uses .default() needs ` +
          `search: { middlewares: [stripDefaultSearchParams(schema)] }.`,
      ).toBe(200);
    });
  }

  for (const [from, to] of MUST_BE_301) {
    test(`${from} is a permanent redirect to ${to}`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });
      // 301, not the framework's 307 default: these routes are retired, and a
      // temporary redirect tells a search engine to keep the old URL and keep
      // re-checking it instead of moving the signals to the new page.
      expect(response.status(), `${from} should be 301 (permanent)`).toBe(301);
      const location = response.headers()["location"] ?? "";
      expect(new URL(location, "http://localhost").pathname).toBe(to);
    });
  }
});

// #11261: what the docs <head> says, against the raw response.
//
// Two separate budgets that were both wrong. The 290 generated API-reference
// pages shipped `content=""` — an EMPTY description, worse than none, on 83% of
// the docs (#11258). The 25 hand-written pages ran the other way, to 256
// characters, because their frontmatter `description` is also the visible
// subtitle and was written as prose.
//
// Both are bounded in the head now, and NEITHER changes what the page shows.
const DOCS_META_MAX = 160;

test.describe("#11258 docs pages describe themselves, within budget", () => {
  const PAGES = [
    "/docs",
    "/docs/feeds",
    "/docs/mcp",
    "/docs/economics",
    "/docs/api-reference/subnets/domains",
    "/docs/api-reference/blocks/block-detail-by-network",
  ];

  for (const path of PAGES) {
    test(`${path} has a non-empty description inside the budget`, async ({ request }) => {
      const html = await (await request.get(path)).text();
      const raw = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? null;
      expect(raw, `${path} emits no description meta tag at all`).not.toBeNull();
      // Entities inflate the raw attribute (&#x27; is 6 characters for one
      // apostrophe), so measure the decoded value — measuring the raw string
      // reports a page as over budget when it is not.
      const decoded = raw!
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"');
      expect(decoded.length, `${path} description is empty`).toBeGreaterThan(0);
      expect(decoded.length, `${path}: ${decoded.length} chars`).toBeLessThanOrEqual(DOCS_META_MAX);
      // Markdown renders literally in a meta tag.
      expect(decoded, `${path} carries markdown`).not.toContain("`");
    });
  }

  test("bounding the head does not truncate what the page shows", async ({ request }) => {
    // /docs/feeds carries the longest hand-written description (256 chars). The
    // subtitle under the H1 must still be all of it.
    const html = await (await request.get("/docs/feeds")).text();
    const subtitle = /<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    const text = subtitle.replace(/<[^>]+>/g, "");
    expect(text.length).toBeGreaterThan(DOCS_META_MAX);
    expect(text).toContain("no API key");
  });
});

test.describe("#11266 the weekly digests are reachable at all", () => {
  // 161 digest pages shipped in #8705 and were reachable from NOTHING: absent
  // from sitemap.xml, and /news itself had no inbound link anywhere on the site
  // (measured against production — 0 links from /, /subnets, /subnets/38,
  // /docs, /about). /news linked its own 160 children, so the whole subtree
  // hung off a page a crawler could not find. Their own route comment calls
  // them "the pages the issue expects search and social to land on".

  test("sitemap.xml lists the digests", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    const news = locs.filter((u) => new URL(u).pathname.startsWith("/news"));
    expect(news.length, "no /news URLs in the sitemap").toBeGreaterThan(100);
    expect(news, "the /news index itself must be listed").toContain("https://metagraph.sh/news");
    // A sitemap that lists a URL twice is a sitemap the crawler distrusts.
    expect(new Set(locs).size).toBe(locs.length);
  });

  test("every page links /news, so the subtree is not sitemap-only", async ({ request }) => {
    // Sitemap-only is the textbook profile for "Crawled – currently not
    // indexed": discoverable, but with nothing saying it matters.
    for (const path of ["/", "/subnets", "/docs"]) {
      const html = await (await request.get(path)).text();
      expect(html, `${path} does not link /news`).toContain('href="/news"');
    }
  });

  test("a digest the sitemap lists actually answers", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    const digest = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => new URL(m[1]!).pathname)
      .find((p) => /^\/news\/sn\d+\//.test(p));
    expect(digest, "the sitemap lists no per-week digest").toBeTruthy();
    const response = await request.get(digest!, { maxRedirects: 0 });
    expect(response.status(), `${digest} is in the sitemap but does not answer 200`).toBe(200);
  });
});

test.describe("#11279 the digests are typed, and say what week they cover", () => {
  test("a digest emits an Article whose temporalCoverage matches its own text", async ({
    request,
  }) => {
    const html = await (await request.get("/news/sn38/2026-w25")).text();
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(
      (m) => JSON.parse(m[1]!) as Record<string, unknown>,
    );
    const article = blocks.find((b) => b["@type"] === "Article");
    expect(article, "no Article node on a digest page").toBeTruthy();
    expect(article!.temporalCoverage).toBe("2026-06-15/2026-06-21");
    // The structured data must agree with what the reader can see, which is the
    // rule every builder in json-ld.ts ships under.
    expect(html).toContain("15–21 June 2026");
  });

  test("the archive index is an Article with no week to claim", async ({ request }) => {
    const html = await (await request.get("/news")).text();
    const article = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
      .map((m) => JSON.parse(m[1]!) as Record<string, unknown>)
      .find((b) => b["@type"] === "Article");
    expect(article).toBeTruthy();
    expect(article).not.toHaveProperty("temporalCoverage");
  });
});

test.describe("#11283 every breadcrumb link goes somewhere", () => {
  // buildCrumbs (components/metagraphed/breadcrumb-nav.ts) makes a link out of
  // EVERY path segment, so a page at /a/b/c offers /a and /a/b whether or not
  // those are routes. Measured against production: 129 of 162 intermediate
  // prefixes answered 404 — 124 /news/sn{n} folders, /docs/protocol,
  // /docs/playbooks, /graphql, /tools, /design. The JSON-LD BreadcrumbList
  // linked them too, which is a claim Google validates.
  //
  // The property is general, so the test is: derive the prefixes from the
  // sitemap rather than listing them, and a new nested route cannot reintroduce
  // the hole without failing here.

  test("no intermediate path segment is a dead link", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
    expect(paths.length).toBeGreaterThan(100);

    const prefixes = new Set<string>();
    for (const path of paths) {
      const parts = path.split("/").filter(Boolean);
      let acc = "";
      // Every ancestor, not the page itself.
      for (let i = 0; i < parts.length - 1; i++) {
        acc += `/${parts[i]}`;
        prefixes.add(acc);
      }
    }
    // Container segments that have children but are in no sitemap entry.
    for (const p of ["/graphql", "/tools", "/design"]) prefixes.add(p);

    const dead: string[] = [];
    for (const prefix of [...prefixes].sort()) {
      const response = await request.get(prefix, { maxRedirects: 0 });
      // 200 (it is a page) or 301 (a container that sends you to the content).
      if (response.status() !== 200 && response.status() !== 301) {
        dead.push(`${response.status()} ${prefix}`);
      }
    }
    expect(dead, `breadcrumbs link ${dead.length} dead paths`).toStrictEqual([]);
  });
});
