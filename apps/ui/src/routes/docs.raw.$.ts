import { createFileRoute, notFound } from "@tanstack/react-router";
import { docsSource } from "@/lib/docs-source";

// Backs docs.$.tsx's <ViewOptionsPopover markdownUrl>. That popover's "View
// as Markdown" item is a plain <a target="_blank" href> -- Chrome silently
// blocks target="_blank" navigation to data: URLs (no console error, no new
// tab), so markdownUrl needs a real fetchable route, not a client-built
// data: URI.
//
// getText("processed") reads the compiled MDX module's own `_markdown`
// export (source.config.ts's remarkLLMs plugin) straight from the eagerly-
// imported collections/server glob -- no filesystem access, so this works
// the same in the Cloudflare Worker runtime as it does in dev. The other
// getText() mode, "raw", does a real fs readFile of the source .mdx file
// and would only work locally.
export const Route = createFileRoute("/docs/raw/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = params._splat?.split("/") ?? [];
        const page = docsSource.getPage(slugs);
        if (!page) throw notFound();
        const markdown = await page.data.getText("processed");
        return new Response(markdown, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
