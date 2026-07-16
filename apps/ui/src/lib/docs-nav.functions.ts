import { createServerFn } from "@tanstack/react-start";
import { docsSource } from "@/lib/docs-source";

export interface DocsNavEntry {
  url: string;
  title: string;
  description: string;
}

// Flattened index of every content/docs/*.mdx page, sourced live from
// docsSource rather than a hand-maintained list. The ⌘K command palette's
// "Jump to" group is built from this so a new docs page shows up
// automatically -- previously it relied on a hardcoded ROUTE_INDEX entry per
// page, which is exactly how /docs/chain-events went missing from the
// palette for a while after its route shipped.
export const getDocsNav = createServerFn({ method: "GET" }).handler(
  async (): Promise<DocsNavEntry[]> =>
    docsSource.getPages().map((page) => ({
      url: page.url,
      title: page.data.title,
      description: page.data.description ?? "",
    })),
);
