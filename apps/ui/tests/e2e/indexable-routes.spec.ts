import { test, expect, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";

import { SUBNET_SLOT_CAP } from "../../src/lib/metagraphed/bittensor";
import { OG_CARD_VERSION } from "../../src/lib/metagraphed/og-card-limits";
import { HUB_COPY, HUB_DESCRIPTION_MAX, HUB_TITLE_MAX } from "../../src/lib/metagraphed/hub-copy";

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
  "/health",
  "/contribute",
  "/about",
  "/validators",
  "/accounts",
  "/docs",
];

/**
 * Retired paths: permanent moves, every one documented as such in its route.
 *
 * `carries` is the piece of the Location header proving the destination kept
 * the section or filter the retired page WAS. A link to one category that
 * landed on the unfiltered registry would still be a 301 to the right pathname
 * and would still have lost the question. Asserted as a substring rather than
 * as a whole URL so the check does not also pin param order or a trailing
 * slash, neither of which is the property under test.
 */
const MUST_BE_301: ReadonlyArray<readonly [from: string, to: string, carries?: string]> = [
  ["/explorer", "/chain"],
  ["/blocks", "/chain/blocks"],
  ["/events", "/chain/events"],
  ["/extrinsics", "/chain/extrinsics"],
  // #11619: /runtime redirects PAST the retired /chain/runtime, not into it.
  // Chaining 301s costs a hop on every crawl and every share-card fetch, and
  // Google follows at most five before giving up on the URL entirely.
  ["/runtime", "/chain", "#governance"],
  ["/schemas", "/apis/schemas"],
  ["/surfaces", "/apis"],
  ["/endpoints", "/apis/endpoints"],
  ["/providers", "/apis/providers"],
  ["/gaps", "/contribute"],
  ["/portfolio", "/settings", "#wallet"],
  ["/sudo", "/chain", "#governance"],
  // #11625 merged /status into /health: the self-health verdict is its fourth
  // section, so the redirect lands on that section rather than the top.
  ["/status", "/health", "#self-health"],
  ["/admin-changes", "/chain", "#governance"],
  ["/tools/ss58", "/accounts"],
  // #11613 folded five more routes into the rebuilt /subnets index. Each one
  // ranked, faceted or grouped subnets, which is what that page now does in
  // sections and filters — so they are retired the same way every other
  // consolidation above was, and asserted here for the same reason: the status
  // code IS the property, and a 307 would leave the old URL in the index.
  ["/revenue", "/subnets", "#revenue"],
  ["/leaderboards", "/subnets", "#rankings"],
  ["/subnets/category", "/subnets", "#domains"],
  ["/subnets/category/inference", "/subnets", "domain=inference"],
  ["/subnets/with-api", "/subnets", "api=true"],
  // #11619 folded four chain tabs into the rebuilt /chain. Each one was a
  // reading OF the chain that the page now draws as a section, so each keeps
  // its inbound links by landing on that section rather than on the top of a
  // six-section page with the question dropped.
  ["/chain/analytics", "/chain", "#stake-flow"],
  ["/chain/emissions", "/chain", "#emission"],
  ["/chain/governance", "/chain", "#governance"],
  ["/chain/runtime", "/chain", "#governance"],
];

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

  for (const [from, to, carries] of MUST_BE_301) {
    test(`${from} is a permanent redirect to ${to}${carries ?? ""}`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });
      // 301, not the framework's 307 default: these routes are retired, and a
      // temporary redirect tells a search engine to keep the old URL and keep
      // re-checking it instead of moving the signals to the new page.
      expect(response.status(), `${from} should be 301 (permanent)`).toBe(301);
      const location = response.headers()["location"] ?? "";
      expect(new URL(location, "http://localhost").pathname).toBe(to);
      if (carries) {
        expect(
          location,
          `${from} redirects to the right page but drops the ${carries} it was retired into`,
        ).toContain(carries);
      }
    });
  }

  // ONE HOP, and the table above cannot prove it on its own (#11619).
  //
  // Every row asserts the first response. A destination that is ITSELF retired
  // still passes every one of them: the status is 301, the pathname is what the
  // row named, and the fragment is carried — the reader just arrives one hop
  // later than the row claims. That is not hypothetical. /runtime, /sudo and
  // /admin-changes each pointed at a /chain tab that #11619 retired, so leaving
  // them alone would have built exactly that chain, and each hop bleeds a
  // little of what the 301 exists to pass on. Google gives up after five.
  //
  // Derived from MUST_BE_301 rather than listed, so a retirement pointed at a
  // redirect fails the moment it is added instead of when someone re-reads the
  // table.
  for (const to of [...new Set(MUST_BE_301.map(([, destination]) => destination))]) {
    test(`${to} is a destination, not another hop`, async ({ request }) => {
      const response = await request.get(to, { maxRedirects: 0 });
      expect(
        response.status(),
        `${to} is the target of a retired route but answers ` +
          `${response.status()} -> ${response.headers()["location"] ?? "(no location)"}. ` +
          `Repoint every route that names it at the page that actually renders.`,
      ).toBe(200);
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

test.describe("#11294 the markdown twin is reachable, and a stale one 404s", () => {
  // 634 prose pages compile a clean `_markdown` export (source.config.ts's
  // remarkLLMs plugin, declared once for both collections). /docs/raw/* served
  // it and nothing pointed at it; /news had no such route at all; and an
  // unknown path answered 500, because `throw notFound()` has no boundary in a
  // server route handler.
  //
  // These assert the raw HTTP response, because the status and the headers ARE
  // the property under test.

  for (const [html, raw] of [
    ["/docs/mcp", "/docs/raw/mcp"],
    ["/docs", "/docs/raw"],
    ["/news/sn38/2026-w25", "/news/raw/sn38/2026-w25"],
    ["/news", "/news/raw"],
  ] as const) {
    test(`${html} links and serves ${raw}`, async ({ request }) => {
      const page = await request.get(html);
      expect(page.status()).toBe(200);
      expect(await page.text(), `${html} does not advertise its markdown twin`).toContain(
        `href="https://metagraph.sh${raw}"`,
      );

      const markdown = await request.get(raw, { maxRedirects: 0 });
      expect(markdown.status(), `${raw} does not answer`).toBe(200);
      expect(markdown.headers()["content-type"]).toContain("text/markdown");
      // The HTML page is the canonical, sitemapped copy; two indexable copies
      // of one page is the duplicate-content bet #11204 records losing.
      expect(markdown.headers()["x-robots-tag"]).toContain("noindex");
      expect((await markdown.text()).length, `${raw} is empty`).toBeGreaterThan(0);
    });
  }

  for (const path of ["/docs/raw/index", "/docs/raw/does-not-exist", "/news/raw/sn0/1999-w01"]) {
    test(`${path} is a 404, not a 500`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      // A 5xx tells Googlebot the host is unhealthy and it backs off crawling
      // ALL of it; it tells an agent to retry. 404 is true and terminal.
      expect(response.status(), `${path} answered ${response.status()}`).toBe(404);
    });
  }

  for (const [path, mustContain] of [
    ["/docs/llms.txt", "/docs/raw/"],
    ["/news/llms.txt", "/news/raw/"],
  ] as const) {
    test(`${path} indexes its section and states the twin rule`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).toContain(mustContain);
      // Absolute links only: a machine fetching a text file has no base to
      // resolve "/docs/feeds" against.
      expect(body, `${path} still carries site-relative links`).not.toMatch(/\]\(\/(docs|news)/);
      expect(body.split("\n").filter((l) => l.includes("](http")).length).toBeGreaterThan(5);
    });
  }
});

test.describe("#11613 the retired facets do not shadow the subnet detail route", () => {
  // /subnets/with-api and /subnets/category/$slug were pages until #11613 and
  // are redirects now, but they are still STATIC and PARAM segments declared
  // beside /subnets/$netuid. Precedence is the thing that must not move: if it
  // ever flipped, every one of the 129 detail pages would answer 301 to the
  // index instead of rendering.
  //
  // netuid 1, not 64: the e2e stub's fixture carries subnet 1 and not 64, so
  // asserting on 64 would test the fixture rather than the routing.
  test("a netuid is served by the detail route, not by a retired facet", async ({ request }) => {
    // The positive control first: without it, "did not answer 301" would also
    // be true of a route that stopped answering at all.
    const real = await request.get("/subnets/1", { maxRedirects: 0 });
    expect(real.status(), "/subnets/1 no longer renders — a facet segment is shadowing it").toBe(
      200,
    );

    // An unknown netuid must reach the detail route's own not-found rather
    // than being swallowed by a facet redirect, which is what a precedence
    // flip would look like from outside.
    const unknown = await request.get("/subnets/999999", { maxRedirects: 0 });
    expect(
      unknown.status(),
      "an unknown netuid was answered by a retired facet's redirect",
    ).not.toBe(301);
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

test.describe("#11320 the hub pages compete for the category queries", () => {
  // Measured against production 2026-08-15, before this shipped:
  //
  //   /subnets     "Subnets — Metagraphed"      21 chars, 1 H2
  //   /validators  "Validators — Metagraphed"   24 chars, 0 H2s
  //   /apis        "API catalog — Metagraphed"  25 chars, 1 H2
  //
  // Eight sites rank for "bittensor subnets list" — taostats, bittensor.ai,
  // CoinGecko, TaoMarketCap, SubnetRadar and more — and we were on none of
  // them, while /subnets/38 (tuned in #11230) ranks 4–8 when it appears. The
  // detail pages were fixed; the hubs pointing at them never were.
  //
  // The subjects are HUB_COPY's own keys, not a list written here: a hub added
  // without an entry fails, an entry added without a route fails. Every gate in
  // this repo that listed its own subjects has since gone blind to something
  // (#11288's ALLOW_GENERIC, #11234's tag list).
  const HUB_PATHS = Object.keys(HUB_COPY) as Array<keyof typeof HUB_COPY>;

  /**
   * Entities inflate a raw attribute — `&amp;` is five characters for one
   * ampersand — so a compliant 56-character title measures 60 unless decoded.
   * This exact mistake reported a 149-char description as 164 in #11259.
   */
  const decode = (value: string) =>
    value
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");

  for (const path of HUB_PATHS) {
    test(`${path} emits the copy HUB_COPY defines`, async ({ request }) => {
      const html = await (await request.get(path)).text();
      const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
      const description = decode(
        /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "",
      );

      // The rendered page must carry the module's strings, not a copy that
      // drifted from them — which is the whole reason HUB_COPY exists.
      expect(title, `${path} title`).toBe(HUB_COPY[path].title);
      expect(description, `${path} description`).toBe(HUB_COPY[path].description);
    });

    test(`${path} stays inside Google's truncation`, async ({ request }) => {
      const html = await (await request.get(path)).text();
      const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
      const description = decode(
        /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "",
      );
      expect(title.length, `${path}: "${title}"`).toBeLessThanOrEqual(HUB_TITLE_MAX);
      expect(description.length, `${path}: ${description.length} chars`).toBeLessThanOrEqual(
        HUB_DESCRIPTION_MAX,
      );
    });

    test(`${path} does not lead with the brand`, async ({ request }) => {
      // A brand search for this project returns the Bittensor SDK's own
      // bt.metagraph docs and not us, so the front of the tag has to earn the
      // click on terms. Brand rides at the end.
      const html = await (await request.get(path)).text();
      const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
      expect(title.startsWith("Metagraphed")).toBe(false);
      expect(title).toContain("Bittensor");
    });

    test(`${path} has the headings a scannable page needs`, async ({ request }) => {
      // A hub that is a bare table answers no informational question. The H2s
      // come from HubSections, so this fails if the explanation is dropped or
      // rendered as <span> — which is exactly what /validators was doing with
      // ten metric definitions already written.
      const html = await (await request.get(path)).text();
      const headings = [...html.matchAll(/<h2[^>]*>/g)].length;
      expect(headings, `${path} renders ${headings} H2s`).toBeGreaterThanOrEqual(3);
    });
  }

  test("the subnet count comes from the protocol cap, and the page agrees", async ({ request }) => {
    // 128, not 129: root (netuid 0) is governance, and a title claiming 129
    // would disagree with the rows the page lists — the same defect as a
    // breadcrumb that renames its own target (#11303).
    const html = await (await request.get("/subnets")).text();
    const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
    expect(title).toContain(String(SUBNET_SLOT_CAP));
    expect(title).not.toContain("129");
  });
});

test.describe("#11315 the hubs stay within a payload ratchet", () => {
  // Measured against production 2026-08-15, and the first number was a trap
  // worth recording: `curl | wc -c` reports the UNCOMPRESSED document, and
  // these pages ship brotli at roughly 8:1.
  //
  //   page          uncompressed    on the wire
  //   /validators      1,297 KB        164 KB
  //   /apis              690 KB         82 KB
  //   /subnets           513 KB         68 KB
  //   /                   99 KB         24 KB
  //
  // So the cost is not bandwidth — it is main-thread work. /validators renders
  // 50 rows and dehydrates 1,447, and that JSON is decompressed, parsed and
  // deserialised on whatever phone loaded the page.
  //
  // This is a RATCHET, not a target: each ceiling sits just above what that
  // page renders today, so a regression fails while a page that gets lighter
  // simply passes with room to spare. Lower a number when a page shrinks;
  // never raise one to admit a regression.
  //
  // Per page, not one global ceiling, and that distinction was earned: a single
  // number large enough for /apis/endpoints (4,948 KB in production, the worst
  // page on the site and one this epic had not sampled) would let every other
  // hub quadruple without failing.
  //
  // Measured against the e2e stub, which is what CI runs. Production is larger
  // against both the deterministic fixture build and a production-form local
  // crawl. The ratchet catches a code change that inflates the document; it is
  // deliberately above current output so ordinary data drift has headroom.
  const MAX_HTML_KIB: Record<keyof typeof HUB_COPY, number> = {
    // #11618 lowered this from 130. The rebuilt landing page reads three
    // fields of an economics row, so it asks for three -- the full response is
    // 129 rows of ~45 fields and was 176 KB of inlined dehydration. It also
    // stopped fetching the registry list for a name it already had.
    "/": 70,
    // #11612 lowered this from 560. Dropping `github_commits_weekly` (52
    // weekly objects per subnet, 74 KB of the 331 KB this page inlined as SSR
    // dehydration) and `github_languages` from the list rows took the document
    // from 555 to 479 KiB. Nothing rendered either field.
    // #11616 lowered this from 490: a DataTable no longer renders a disclosure
    // chevron on a row that has nothing to expand, and the chevron it does
    // render is drawn in CSS rather than an inline SVG per row. 479 -> 418.
    "/subnets": 430,
    // #11761 stores the operator directory as field-name-free tuples and
    // reconstructs its readable row model after hydration. The deterministic
    // document fell from 466 to 231 KiB while retaining all validator links.
    "/validators": 245,
    "/apis": 100,
    "/apis/providers": 400,
    // The rebuilt endpoint view requests bounded rows instead of dehydrating
    // the entire catalog: 4,948 KiB in the old production page -> ~58 KiB.
    "/apis/endpoints": 100,
    "/apis/schemas": 100,
    "/chain": 100,
  };

  for (const path of Object.keys(HUB_COPY) as Array<keyof typeof HUB_COPY>) {
    test(`${path} stays under the HTML ratchet`, async ({ request }) => {
      const html = await (await request.get(path)).text();
      const kib = Math.round(Buffer.byteLength(html, "utf8") / 1024);
      expect(
        kib,
        `${path} renders ${kib} KiB of HTML against a ceiling of ${MAX_HTML_KIB[path]} KiB. ` +
          `This is a ratchet — lower it when a page gets lighter, never raise it ` +
          `to admit a regression.`,
      ).toBeLessThanOrEqual(MAX_HTML_KIB[path]);
    });
  }

  test("the validators hub keeps its internal links while shedding payload", async ({
    request,
  }) => {
    // The one thing this workstream must not trade away. #11231 found 99 of 129
    // subnet pages with no inbound link anywhere on the site; paginating or
    // virtualising away anchors to save bytes would reintroduce exactly that,
    // and it is the most expensive regression available here.
    const html = await (await request.get("/validators")).text();
    const links = new Set([...html.matchAll(/href="\/validators\/([^"?#]+)"/g)].map((m) => m[1]));
    expect(links.size, "the hub stopped linking validator pages").toBeGreaterThanOrEqual(50);
  });

  test("the directory dehydrates rows without the per-subnet breakdown", async ({ request }) => {
    // `subnets` is 66% of every API row (1,090 of 1,641 bytes) and neither
    // consumer of this cache key reads it — the heatmap that does uses
    // limit: 15, a different key. Dropping it during normalization keeps it out
    // of the react-query cache and therefore out of the SSR dehydration.
    const html = await (await request.get("/validators")).text();
    const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]!)
      .sort((a, b) => b.length - a.length)[0]!;
    // Fields that exist ONLY inside subnets[].
    expect(inline, "the per-subnet breakdown is back in the dehydration").not.toContain(
      "stake_alpha",
    );
    expect(inline).not.toContain("emission_alpha");
    // The query cache now stores the grouped operator result itself, not the
    // larger intermediate validator records the component used to group.
    expect(inline).not.toContain("coldkey_identity");
    expect(inline).not.toContain("latest_block_number");
    expect(inline).toContain("hotkey_count");
    expect(inline).toContain("validator-operator-directory");
    expect(inline).not.toContain("totalStakeTao");
    expect(inline).not.toContain("apyEstimate");
  });
});

test.describe("sitewide payload and entry-bundle ratchets", () => {
  const ROUTE_FAMILY_HTML_KIB = {
    "/subnets/19": 150,
    "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u": 190,
    "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9": 100,
    "/providers/lium": 80,
    "/blocks/8713384": 90,
    "/extrinsics/0x986f1f7da3d93882e8c19bbe3b303ef8ba5454062272446598d17aa599ca4428": 90,
    "/docs": 240,
    "/docs/mcp": 270,
    "/docs/api-reference/subnets/subnets-by-network": 430,
    "/news": 540,
    "/news/sn19/2026-w17": 340,
    "/graphql/explorer": 80,
  } as const;

  for (const [path, ceiling] of Object.entries(ROUTE_FAMILY_HTML_KIB)) {
    test(`${path} stays under its route-family HTML ratchet`, async ({ request }) => {
      const html = await (await request.get(path)).text();
      const kib = Math.round(Buffer.byteLength(html, "utf8") / 1024);
      expect(
        kib,
        `${path} renders ${kib} KiB against a ${ceiling} KiB route-family ceiling. ` +
          `Preserve the rendered information, then narrow the query, dehydration, or markup.`,
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  test("the global client entry stays split from route data and Zod", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const entryPath = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(entryPath, "the page emitted no module entry script").toBeTruthy();
    const entry = await (await request.get(entryPath!)).body();
    const rawKib = Math.round(entry.byteLength / 1024);
    const gzipKib = Math.round(gzipSync(entry).byteLength / 1024);
    expect(rawKib, `global entry grew to ${rawKib} KiB`).toBeLessThanOrEqual(740);
    expect(gzipKib, `global entry grew to ${gzipKib} KiB gzip`).toBeLessThanOrEqual(240);
    const source = entry.toString("utf8");
    expect(source, "the global entry contains the full query registry").not.toContain(
      "subnet-overview",
    );
  });
});

test.describe("#11319 the SEO invariants are derived, not listed", () => {
  // Every SEO property this repo has fixed was re-broken by a route family that
  // shipped later:
  //
  //   /news shipped after buildBreadcrumb   -> 285 pages, no BreadcrumbList (#11303)
  //   /news shipped after the sitemap       -> 161 pages reachable from nothing (#11277)
  //   the API-reference generator wrote children and no index, three times (#11234, #11287)
  //   server.og-copy.test.ts hand-listed ALLOW_GENERIC, which hid what it named (#11294)
  //
  // The pattern is always the same: a gate that lists its subjects goes blind to
  // the next one. So the subjects here come from sitemap.xml, and one page per
  // FAMILY is sampled — a family being the first two path segments. A new route
  // family is covered the moment it enters the sitemap, with nobody remembering
  // to add it.
  //
  // Sampling by family rather than exhaustively keeps this bounded: the sitemap
  // is ~1,900 URLs and the families are a couple of dozen.

  const DESCRIPTION_MAX = 160;
  /**
   * Minimum share of tokens that are words rather than identifiers.
   *
   * The floor #11313 §3 ships under. `?tab=metagraph` renders 8,112 words of
   * which 45% are ss58 hashes and bare numbers — the page shape that put 5,797
   * URLs in "Crawled – currently not indexed". Any page family we ask Google to
   * index has to clear this.
   */
  const MIN_PROSE_RATIO = 0.6;

  const decode = (value: string) =>
    value
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");

  /**
   * A bounded, derived sample: up to three second-level shapes per top-level
   * section.
   *
   * Two rules were tried and rejected against real data. "First two segments"
   * makes /subnets/64 and /validators/5Grwva… each their own family — 1,461 of
   * the sitemap's 1,945 URLs, a near-exhaustive crawl run three times per
   * suite. Adding an identifier regex fixed those but not /providers/{slug},
   * whose segments are words: still 184 families, 138 of them one provider each.
   *
   * Anything that tries to classify a segment as "an identifier" is guessing at
   * the route template from the outside. Capping per section does not: it needs
   * no such judgement, it is bounded by construction, and every top-level area
   * of the site is still represented — which is the property that matters, since
   * the failure this gate exists for is a whole page FAMILY shipping wrong
   * (#11303's 285 digests, #11277's 161), never one instance of one.
   */
  const PER_SECTION = 3;

  /** Representative URLs, derived from the live sitemap. */
  async function sampleByFamily(request: import("@playwright/test").APIRequestContext) {
    const xml = await (await request.get("/sitemap.xml")).text();
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
    expect(paths.length, "sitemap is empty").toBeGreaterThan(20);

    const bySection = new Map<string, Map<string, string>>();
    for (const path of paths) {
      const parts = path.split("/").filter(Boolean);
      const section = parts.length === 0 ? "/" : `/${parts[0]}`;
      const shape = parts.length > 1 ? `/${parts[0]}/${parts[1]}` : section;
      const shapes = bySection.get(section) ?? new Map<string, string>();
      if (!shapes.has(shape) && shapes.size < PER_SECTION) shapes.set(shape, path);
      bySection.set(section, shapes);
    }

    const sample = [...bySection.values()].flatMap((shapes) => [...shapes.entries()]);
    // A sample that collapsed to nothing would make every assertion below pass
    // vacuously, and one that failed to collapse would make the suite crawl the
    // whole sitemap. Both are bugs in the rule above, so both fail here.
    expect(sample.length, "sampler returned nothing").toBeGreaterThan(10);
    expect(sample.length, "sampler is not bounded").toBeLessThan(60);
    return sample.sort(([a], [b]) => a.localeCompare(b));
  }

  test("every page family describes itself, within budget", async ({ request }) => {
    // Extends #11258's docs-only check to the whole sitemap. An empty
    // description is worse than none — 290 pages shipped `content=""`.
    const failures: string[] = [];
    for (const [family, path] of await sampleByFamily(request)) {
      const response = await request.get(path);
      if (!(response.headers()["content-type"] ?? "").includes("text/html")) continue;
      const raw = /<meta name="description" content="([^"]*)"/.exec(await response.text())?.[1];
      const description = decode(raw ?? "");
      if (!description) failures.push(`${family} (${path}): no description`);
      else if (description.length > DESCRIPTION_MAX) {
        failures.push(`${family} (${path}): ${description.length} chars`);
      }
    }
    expect(failures, `page families with a bad description:\n${failures.join("\n")}`).toStrictEqual(
      [],
    );
  });

  test("every Dataset asserts when it was last modified", async ({ request }) => {
    // #11314 added dateModified to subnet and provider records. This is what
    // stops the NEXT Dataset-emitting family shipping without it — the exact
    // way /news shipped without a BreadcrumbList.
    const failures: string[] = [];
    for (const [family, path] of await sampleByFamily(request)) {
      const response = await request.get(path);
      if (!(response.headers()["content-type"] ?? "").includes("text/html")) continue;
      const html = await response.text();
      const nodes = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
        .flatMap((m) => {
          const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
          return (parsed["@graph"] as Record<string, unknown>[]) ?? [parsed];
        })
        .filter((node) => node["@type"] === "Dataset");
      for (const node of nodes) {
        // No exemptions since #11613: the one Dataset that carried no publish
        // timestamp of its own was the /subnets/with-api facet, and that page
        // is a filter on /subnets now rather than a URL emitting its own node.
        if (!node.dateModified) {
          failures.push(`${family} (${path}): Dataset "${node.identifier}" has no dateModified`);
        }
      }
    }
    expect(failures, `Datasets missing dateModified:\n${failures.join("\n")}`).toStrictEqual([]);
  });

  test("no page family is mostly identifiers", async ({ request }) => {
    const failures: string[] = [];
    for (const [family, path] of await sampleByFamily(request)) {
      const response = await request.get(path);
      if (!(response.headers()["content-type"] ?? "").includes("text/html")) continue;
      const text = (await response.text())
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z#0-9]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const tokens = text.split(" ").filter(Boolean);
      if (tokens.length < 50) continue;
      // ss58 addresses, hex hashes and bare numbers — the tokens that inflate a
      // word count without telling a reader anything.
      const identifiers = tokens.filter(
        (t) =>
          /^5[A-HJ-NP-Za-km-z1-9]{6,}$/.test(t) ||
          /^0x[0-9a-f]+$/i.test(t) ||
          /^[\d.,%τ$-]+$/.test(t),
      ).length;
      const ratio = (tokens.length - identifiers) / tokens.length;
      if (ratio < MIN_PROSE_RATIO) {
        failures.push(`${family} (${path}): ${Math.round(ratio * 100)}% prose`);
      }
    }
    expect(
      failures,
      `page families below the ${MIN_PROSE_RATIO * 100}% prose floor:\n${failures.join("\n")}`,
    ).toStrictEqual([]);
  });
});

test.describe("#11613 the sitemap stops advertising the retired routes", () => {
  // The category pages and the API facet were sitemap entries until they folded
  // into /subnets. A sitemap that keeps listing them asks a crawler to spend
  // budget on a redirect and refills the "Page with redirect" bucket #11204
  // emptied — so this is the half of the retirement that the 301s above cannot
  // prove on their own.
  test("no retired URL is offered for indexing", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
    // The positive control: an empty or truncated sitemap would satisfy every
    // assertion below while proving nothing.
    expect(paths.length, "the sitemap is empty — nothing below is meaningful").toBeGreaterThan(100);
    expect(paths, "the subnet index is missing from the sitemap").toContain("/subnets");

    const retired = paths.filter(
      (p) =>
        p === "/revenue" ||
        p === "/leaderboards" ||
        p === "/subnets/with-api" ||
        p.startsWith("/subnets/category"),
    );
    expect(retired, `the sitemap lists ${retired.length} retired URL(s)`).toStrictEqual([]);
  });
});

// Parse the raw Worker response in an inert document: no hydration can repair
// or add the tags seen by a crawler, and no external document resources load.
async function socialHead(page: Page, html: string) {
  return page.evaluate((source) => {
    const head = new DOMParser().parseFromString(source, "text/html").head;
    return {
      titles: [...head.querySelectorAll("title")].map((tag) => tag.textContent),
      meta: [...head.querySelectorAll("meta")].map((tag) => ({
        key: tag.getAttribute("property") ?? tag.getAttribute("name"),
        content: tag.getAttribute("content"),
      })),
      canonicals: [...head.querySelectorAll('link[rel="canonical"]')].map((tag) =>
        tag.getAttribute("href"),
      ),
      documents: [...head.querySelectorAll('script[type="application/ld+json"]')]
        .map((tag) => JSON.parse(tag.textContent ?? "{}") as Record<string, unknown>)
        .filter((value) => value["@type"] === "Article" || value["@type"] === "TechArticle"),
    };
  }, html);
}

test.describe("#12103 one coherent social preview survives Worker HTML rewriting", () => {
  const routes = [
    "/",
    "/validators",
    "/settings",
    "/compare?subnets=1,19",
    "/about",
    "/privacy",
    "/terms",
    "/graphql/explorer",
    "/docs",
    "/docs/",
    "/docs/feeds",
    "/news",
    "/news/",
    "/news/sn38/2026-w25",
    "/subnets/1",
    "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
    "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
    "/providers/lium",
    "/blocks/8713384",
    "/extrinsics/0x986f1f7da3d93882e8c19bbe3b303ef8ba5454062272446598d17aa599ca4428",
    "/events/8713384/0",
    "/events/8713384/320",
  ];
  for (const route of routes) {
    test(`${route} exposes one image, matching alt and canonical metadata`, async ({
      request,
      page,
    }) => {
      let response = await request.get(route, { maxRedirects: 0 });
      let finalRoute = route;
      if (route === "/docs/" || route === "/news/") {
        expect(response.status()).toBe(307);
        const location = new URL(response.headers()["location"]!, "https://metagraph.sh");
        expect(location.pathname).toBe(route.slice(0, -1));
        finalRoute = location.pathname;
        response = await request.get(finalRoute, { maxRedirects: 0 });
      }
      expect(response.status()).toBe(200);
      const head = await socialHead(page, await response.text());
      await test.info().attach("social-metadata", {
        body: JSON.stringify({ route, finalRoute, status: response.status(), ...head }, null, 2),
        contentType: "application/json",
      });
      const values = (key: string) =>
        head.meta.filter((tag) => tag.key === key).map((tag) => tag.content);
      expect(head.titles).toHaveLength(1);
      expect(values("og:title")).toHaveLength(1);
      expect(values("og:description")).toHaveLength(1);
      expect(values("og:image")).toHaveLength(1);
      const image = new URL(values("og:image")[0]!);
      expect(image.origin).toBe("https://metagraph.sh");
      expect(image.pathname).toBe("/og");
      expect(image.searchParams.get("v")).toBe(OG_CARD_VERSION);
      expect(values("twitter:card")).toEqual(["summary_large_image"]);
      expect(values("twitter:image")).toEqual(values("og:image"));
      expect(values("og:image:width")).toEqual(["1200"]);
      expect(values("og:image:height")).toEqual(["630"]);
      const imageTitle = image.searchParams.get("title");
      expect(imageTitle).toBeTruthy();
      const subtitle = image.searchParams.get("subtitle");
      if (route === "/") {
        expect(subtitle).toBe(
          "Explore Bittensor. Follow the chain, subnets and public interfaces.",
        );
      }
      const alt = subtitle ? `${imageTitle} — ${subtitle}` : imageTitle;
      expect(values("og:image:alt")).toEqual([alt]);
      expect(values("twitter:image:alt")).toEqual([alt]);
      const canonical = `https://metagraph.sh${new URL(finalRoute, "https://metagraph.sh").pathname}`;
      expect(head.canonicals).toEqual([canonical]);
      expect(values("og:url")).toEqual([canonical]);
      if (/^\/(?:about|privacy|terms|settings|compare|graphql\/explorer)(?:[?/#]|$)/.test(route)) {
        expect(values("og:title")).toEqual(head.titles);
        expect(values("og:description")).toEqual(values("description"));
      }
      if (/^\/(?:docs|news)(?:\/|$)/.test(route)) {
        expect(head.documents).toHaveLength(1);
        expect(head.documents[0]!.image).toBe(image.href);
      }
      if (route.startsWith("/events/")) {
        expect(image.searchParams.get("stat1")).toBe("Block");
        expect(image.searchParams.get("stat1v")).toBe("8713384");
        expect(image.searchParams.get("stat2")).toBe("Event index");
        expect(image.searchParams.get("stat2v")).toBe(route.split("/").at(-1));
        expect(imageTitle).not.toBe("Metagraphed");
      }
      if (
        route.startsWith("/validators") ||
        route.startsWith("/compare") ||
        route === "/settings"
      ) {
        expect(values("og:description").join(" ")).not.toMatch(
          /APY|stake value|staking history|portfolio/i,
        );
        expect(image.searchParams.get("subtitle")).not.toMatch(
          /APY|stake value|staking history|portfolio/i,
        );
        expect([...image.searchParams.values()].join(" ")).not.toContain("Stake value");
      }
    });
  }
  for (const route of [
    "/events/8713384/999999",
    "/events/bad/0",
    "/docs/not-a-real-page",
    "/news/not-a-real-page",
    "/validators/bad",
  ]) {
    test(`${route} keeps a missing-page title and noindex without claiming a resolved image`, async ({
      request,
      page,
    }) => {
      const response = await request.get(route, { maxRedirects: 0 });
      expect(response.status()).toBe(404);
      const head = await socialHead(page, await response.text());
      await test.info().attach("social-metadata", {
        body: JSON.stringify({ route, status: response.status(), ...head }, null, 2),
        contentType: "application/json",
      });
      expect(head.titles).toHaveLength(1);
      expect(head.titles[0]).toContain("not found");
      // The explicit noindex remains authoritative alongside the global
      // preview defaults; do not infer absence from a generic 404 body alone.
      expect(head.meta.filter((tag) => tag.key === "robots")).toContainEqual({
        key: "robots",
        content: "noindex",
      });
      expect(
        head.meta.filter((tag) => tag.key === "og:image" || tag.key === "twitter:image"),
      ).toEqual([]);
      expect(head.documents).toEqual([]);
    });
  }
});
