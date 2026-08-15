import { remarkLLMs } from "fumadocs-core/mdx-plugins/remark-llms";
import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

// #8705: the weekly digests, generated into content/news/** from
// registry/generated/digests.json by scripts/generate-digest-pages.ts. Its own
// collection rather than a subtree of `docs` because it is a different product
// surface with its own URL space (/news/sn8/2026-w31) and its own sidebar --
// folding it into the docs tree would put "Subnet 104 — 2026-W29" in the API
// reference nav.
//
// No `lastModified`: these pages are immutable once written (the store is
// append-only), so a git-derived modified date would only ever restate the
// generation date already on the page.
export const news = defineDocs({
  dir: "content/news",
  docs: {
    // #11279: declared, or fumadocs' frontmatter schema strips it before
    // page.data and the Article node silently loses its temporalCoverage --
    // exactly how metaDescription vanished in #11258.
    schema: frontmatterSchema.extend({
      /** ISO 8601 interval, `2026-07-20/2026-07-26`: the week this digest covers. */
      temporalCoverage: z.string().optional(),
    }),
  },
});

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // #11251: `metaDescription` has to be DECLARED, not merely written into the
    // frontmatter. Fumadocs validates frontmatter with a zod object that strips
    // unknown keys, so the generator's key reached the file and then vanished
    // before `page.data` — the generated pages kept shipping an empty
    // `<meta name="description">` and nothing failed to say so.
    //
    // Separate from `description` on purpose: `description` is what
    // <DocsDescription> paints as a one-line subtitle, and the API-reference
    // pages already render their prose in full inside <APIPage/>. This carries
    // the same sentence to the <head> without painting it twice.
    schema: frontmatterSchema.extend({
      metaDescription: z.string().optional(),
    }),
    // Computed from local `git log` at build/dev-compile time -- NOT a live
    // GitHub API call. That distinction matters here: this app deploys to a
    // Cloudflare Worker with no .git directory at runtime, and an
    // unauthenticated runtime call to the GitHub REST API would rate-limit
    // fast (60/hr, shared across every visitor hitting the edge). Baking
    // this into the compiled page data at build time sidesteps both
    // problems entirely.
    lastModified: true,
  },
});

// Adds a `_markdown` export (clean, JSX-stripped markdown of the compiled
// page) alongside the usual toc/frontmatter/default exports -- read by
// docs.$.tsx to power a per-page "Copy as Markdown" button.
export default defineConfig({
  mdxOptions: {
    // filterElement explicit here (not relying on remarkLLMs' own default):
    // observed the default silently dropping <Callout> content entirely --
    // an LLM export that loses a page's warnings defeats the point of it.
    remarkPlugins: (plugins) => [...plugins, [remarkLLMs, { filterElement: () => true }]],
  },
});
