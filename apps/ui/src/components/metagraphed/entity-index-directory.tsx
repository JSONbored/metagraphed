import type { ReactNode } from "react";

/**
 * The shell for a complete, crawlable index of an entity space.
 *
 * WHY THESE EXIST, and why they are not duplicates of the tables above them.
 *
 * The registry hub tables virtualize their bodies (#8248): every row is
 * fetched, filtered and sorted, but only the rows in view are ever mounted as
 * real DOM nodes. That is the right call for a long sortable table — and it
 * means the SERVER-RENDERED HTML of a hub carries anchors for roughly one
 * screenful. Measured against production on 2026-08-14:
 *
 *   /subnets         30 links   129 subnets
 *   /apis/providers  25 links   138 providers
 *
 * So 99 subnet pages and 113 provider pages had no internal link anywhere on
 * the site, reachable only from sitemap.xml. A URL whose only referrer is a
 * sitemap is the classic profile for "Crawled – currently not indexed", the
 * bucket 5,797 of our URLs sit in.
 *
 * Deliberately NOT a change to the virtualization: re-rendering every row live
 * would trade a real interaction and rendering cost for links this gets free.
 *
 * Deliberately a collapsed `<details>`: the children of a closed `<details>`
 * are in the DOM and in the server-rendered HTML, so a crawler follows every
 * link, while a reader who came for the table sees one line rather than a wall
 * of them. It is a jump list for them, not a doorway page for a crawler — the
 * links carry each entity's real name and every target is a substantive page
 * we already publish.
 *
 * The shell is shared so the two indexes cannot drift into different markup or
 * different reasoning; only the per-entity link differs, and that has to stay
 * with the caller because TanStack's `Link` is typed per route.
 */
export function EntityIndexDirectory({
  label,
  count,
  children,
}: {
  /** Plural entity name, e.g. "subnets". Rendered as "All 129 subnets". */
  label: string;
  count: number;
  /** One `<li>` per entity, each containing a real anchor. */
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details className="mt-8 rounded border border-border bg-card p-4">
      <summary className="cursor-pointer text-11 text-ink-muted hover:text-ink-strong">
        All {count} {label}
      </summary>
      <nav aria-label={`All ${label}`} className="mt-3">
        <ul className="columns-2 gap-x-6 sm:columns-3 lg:columns-4">{children}</ul>
      </nav>
    </details>
  );
}
