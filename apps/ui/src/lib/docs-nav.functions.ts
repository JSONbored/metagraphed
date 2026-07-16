import { createServerFn } from "@tanstack/react-start";
import { docsSource } from "@/lib/docs-source";

export interface DocsNavEntry {
  url: string;
  title: string;
  description: string;
}

// content/docs/api-reference/** holds 150+ individually-generated OpenAPI
// operation pages (see scripts/generate-openapi-docs.mjs) -- real content
// for Fumadocs' own sidebar/search, but far too many to flood the ⌘K
// palette's "Jump to" list with. Only its index page (the reference landing
// page) is surfaced there; the generated operation pages stay reachable via
// that page's own sidebar instead.
const API_REFERENCE_PREFIX = "/docs/api-reference/";

// Flattened index of every content/docs/*.mdx page, sourced live from
// docsSource rather than a hand-maintained list. The ⌘K command palette's
// "Jump to" group is built from this so a new docs page shows up
// automatically -- previously it relied on a hardcoded ROUTE_INDEX entry per
// page, which is exactly how /docs/chain-events went missing from the
// palette for a while after its route shipped.
export const getDocsNav = createServerFn({ method: "GET" }).handler(
  async (): Promise<DocsNavEntry[]> =>
    docsSource
      .getPages()
      .filter((page) => !page.url.startsWith(API_REFERENCE_PREFIX))
      .map((page) => ({
        url: page.url,
        title: page.data.title,
        description: page.data.description ?? "",
      })),
);
