import { createFileRoute } from "@tanstack/react-router";
import { rawMarkdownResponse } from "@/lib/metagraphed/raw-markdown";

// #11294: the markdown twin of every /news/* digest -- the half of the pair
// that was never built.
//
// The 285 digest pages compile a `_markdown` export exactly like the docs do:
// source.config.ts's remarkLLMs plugin is declared in the shared
// `defineConfig({ mdxOptions })`, not per-collection, so it has always run over
// this collection too. Only the route to serve it was missing, which meant the
// pages whose entire value is a specific, quotable claim about one subnet's
// week were the ones an answer engine had to scrape HTML for.
//
// Sits alongside news.$.tsx the same way docs.raw.$.ts sits alongside
// docs.$.tsx: the router matches the more specific segment, so /news/raw/...
// reaches this handler and /news/sn38/2026-w25 still reaches the page.

/** Extracted so it is unit-testable without depending on createFileRoute's internal shape. */
export async function resolveRawMarkdown(splat: string | undefined): Promise<Response> {
  const { newsSource } = await import("@/lib/news-source");
  return rawMarkdownResponse(newsSource, "news", splat);
}

export const Route = createFileRoute("/news/raw/$")({
  server: {
    handlers: {
      GET: ({ params }) => resolveRawMarkdown(params._splat),
    },
  },
});
