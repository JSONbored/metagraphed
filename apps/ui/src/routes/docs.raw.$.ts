import { createFileRoute } from "@tanstack/react-router";
import { docsSource } from "@/lib/docs-source";
import { rawMarkdownResponse } from "@/lib/metagraphed/raw-markdown";

// The markdown twin of every /docs/* page.
//
// Backs docs.$.tsx's <ViewOptionsPopover markdownUrl> AND its
// `<link rel="alternate" type="text/markdown">`. The popover's "View as
// Markdown" item is a plain <a target="_blank" href> -- Chrome silently blocks
// target="_blank" navigation to data: URLs (no console error, no new tab), so
// markdownUrl needs a real fetchable route, not a client-built data: URI.
//
// getText("processed") reads the compiled MDX module's own `_markdown` export
// (source.config.ts's remarkLLMs plugin) straight from the eagerly-imported
// collections/server glob -- no filesystem access, so this works the same in
// the Cloudflare Worker runtime as it does in dev. The other getText() mode,
// "raw", does a real fs readFile of the source .mdx file and would only work
// locally.
//
// The response policy (404 rather than a 500, noindex, caching) lives in
// raw-markdown.ts so the /news twin cannot drift from this one.

/** Extracted so it is unit-testable without depending on createFileRoute's internal shape. */
export function resolveRawMarkdown(splat: string | undefined): Promise<Response> {
  return rawMarkdownResponse(docsSource, "docs", splat);
}

export const Route = createFileRoute("/docs/raw/$")({
  server: {
    handlers: {
      GET: ({ params }) => resolveRawMarkdown(params._splat),
    },
  },
});
