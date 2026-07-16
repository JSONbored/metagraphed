import { remarkLLMs } from "fumadocs-core/mdx-plugins/remark-llms";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
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
