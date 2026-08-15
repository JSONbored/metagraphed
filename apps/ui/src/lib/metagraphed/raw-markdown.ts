// The markdown twin of a prose page, and the two ways a machine finds it.
//
// #11294: every page under /docs and /news is compiled MDX, and source.config.ts
// runs remarkLLMs over BOTH collections, so each one already carries a clean,
// JSX-stripped `_markdown` export -- the exact artifact an answer engine wants
// instead of parsing our HTML. /docs/raw/* has served it since the "View as
// Markdown" popover shipped. Nothing pointed at it: no <link> on the page, no
// mention in either llms.txt, and no equivalent route for the 285 digests.
//
// So the twin existed for 349 pages, was reachable only by a human clicking a
// popover item, and answered 500 for any path that was not a page (see below).
//
// This module owns three things, kept together because they have to agree:
// the URL shape, the response policy, and the <link rel="alternate"> that
// advertises it.
import { SITE_ORIGIN } from "./identity";

/** The prose collections that have a markdown twin. Both are fumadocs loaders. */
export type RawMarkdownSection = "docs" | "news";

/**
 * The one thing this module needs from a fumadocs loader.
 *
 * Structural rather than `LoaderOutput<...>`: docsSource carries the OpenAPI
 * loader plugin and newsSource does not, so their inferred types differ in
 * ways that have nothing to do with reading a page's markdown. Naming the
 * contract instead of the implementation also makes the unit tests a two-line
 * object rather than a mocked loader.
 */
export interface MarkdownPageSource {
  getPage(
    slugs: string[],
  ): { data: { getText: (mode: "processed") => Promise<string> } } | undefined;
}

/**
 * `noindex`, deliberately.
 *
 * These 634 URLs are the same content as the HTML pages, which are the ones in
 * the sitemap and the ones that carry the canonical, the JSON-LD and the OG
 * card. Letting a search index hold both is a duplicate-content bet this site
 * has already lost once: #11204 records the indexed count going 2,542 -> 4,099
 * on thin pages, Google reassessing, and ~600 impressions/day becoming single
 * digits.
 *
 * It costs the intended reader nothing. `noindex` governs SEARCH INDEXING; an
 * agent fetching this URL directly -- which is the whole point, and what the
 * `rel="alternate"` link and llms.txt tell it to do -- is unaffected.
 */
const NOINDEX = "noindex";

/**
 * Content changes only on deploy (the markdown is compiled into the bundle),
 * so a miss is cheap and a long stale window costs nothing but saves an agent
 * that walks all 349 docs pages from paying a round trip each time.
 */
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

/**
 * Build the path of a page's markdown twin: `/docs/a/b` -> `/docs/raw/a/b`.
 *
 * Empty splat is the section index (`/docs` -> `/docs/raw`), which is a real
 * page in both collections.
 */
export function rawMarkdownPath(section: RawMarkdownSection, splat: string | undefined): string {
  const rest = (splat ?? "").split("/").filter(Boolean).join("/");
  return rest ? `/${section}/raw/${rest}` : `/${section}/raw`;
}

/**
 * The `<link rel="alternate" type="text/markdown">` a prose page emits.
 *
 * This is the per-page half of discovery, and the half that needs no
 * convention to be known in advance: a crawler that has the HTML in hand is
 * told where the machine-readable version of THIS page is, the same way
 * server.ts's `rel="alternate" type="application/json"` points an entity page
 * at its API record.
 */
export function rawMarkdownLink(section: RawMarkdownSection, splat: string | undefined) {
  return {
    rel: "alternate",
    type: "text/markdown",
    href: `${SITE_ORIGIN}${rawMarkdownPath(section, splat)}`,
    title: "This page as plain markdown",
  };
}

/**
 * Serve one page's compiled markdown, or a real 404.
 *
 * The 404 is the fix, not a detail. This resolver used to `throw notFound()`,
 * which is TanStack Router's signal for a LOADER inside the component tree --
 * a server route handler has no not-found boundary to catch it, so the throw
 * escaped to the Worker's error handler and every unknown path answered
 * **500** with an HTML error page. Measured against production 2026-08-15:
 * `/docs/raw/index` and `/docs/raw/nonexistent-page-xyz` both 500.
 *
 * That is the worst possible answer for this route's readers. A 500 tells
 * Googlebot the server is unhealthy and it backs off crawling the whole host;
 * it tells an agent to retry. A 404 says "this page does not exist", which is
 * true and terminal.
 *
 * The existing unit test asserted `isNotFound(err)` -- it passed, on the throw,
 * while production served 500. A test that pins the mechanism rather than the
 * answer cannot see this class of bug, so the tests here assert the STATUS.
 */
export async function rawMarkdownResponse(
  source: MarkdownPageSource,
  section: RawMarkdownSection,
  splat: string | undefined,
): Promise<Response> {
  const slugs = (splat ?? "").split("/").filter(Boolean);
  const page = source.getPage(slugs);
  if (!page) {
    return new Response(
      `# Not found\n\nNo ${section} page at \`${rawMarkdownPath(section, splat)}\`.\n` +
        `The index of every ${section} page is at ${SITE_ORIGIN}/${section}/llms.txt\n`,
      {
        status: 404,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "x-robots-tag": NOINDEX,
          // Never cache an absence: the page may exist after the next deploy.
          "cache-control": "no-store",
        },
      },
    );
  }
  return new Response(await page.data.getText("processed"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-robots-tag": NOINDEX,
      "cache-control": CACHE_CONTROL,
    },
  });
}
