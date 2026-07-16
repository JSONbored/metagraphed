import { remarkLLMs } from "fumadocs-core/mdx-plugins/remark-llms";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
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
