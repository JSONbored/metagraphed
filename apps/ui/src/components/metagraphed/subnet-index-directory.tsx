import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SUBNETS_ALL_LIMIT, subnetsQuery } from "@/lib/metagraphed/queries";

/**
 * A complete, crawlable index of every subnet.
 *
 * WHY THIS EXISTS, and it is not a duplicate of the table above it.
 *
 * The registry table virtualizes its body (#8248): all 129 rows are fetched,
 * filtered and sorted, but only the rows in view are ever mounted as real DOM
 * nodes. That is the right call for a sortable 129-row table — and it means the
 * SERVER-RENDERED HTML of /subnets contains anchors for about 30 subnets.
 * Measured against production on 2026-08-14: 30 distinct `/subnets/{n}` hrefs
 * for 129 subnets.
 *
 * So 99 subnet pages had no internal link anywhere on the site and were
 * reachable only from sitemap.xml. A URL whose only referrer is a sitemap is
 * the classic profile for "Crawled – currently not indexed", which is the
 * bucket 5,797 of our URLs sit in — and per-subnet lookups are the demand
 * Search Console actually records, so those are the pages that most need to be
 * reachable.
 *
 * Deliberately NOT a change to the table's virtualization: that would trade a
 * real interaction and rendering cost for the same links this gets for free.
 *
 * Deliberately inside a collapsed `<details>`: the children of a closed
 * `<details>` are in the DOM and in the server-rendered HTML, so a crawler
 * follows every link, while a reader who came for the table sees one line
 * rather than a wall of 129 links. It is a jump list for them, not a doorway
 * page for a crawler — the links carry the subnet's real name, and every target
 * is a substantive page we already publish.
 */
export function SubnetIndexDirectory() {
  // The same query the table issues, minus the reader's `q` filter — a
  // directory that shrinks when someone types a search is not an index. On the
  // first (and crawled) render there is no `q`, so this shares the table's
  // cache entry and costs no extra request.
  const { data } = useSuspenseQuery(subnetsQuery({ limit: SUBNETS_ALL_LIMIT }));
  const subnets = [...data.data].sort((a, b) => a.netuid - b.netuid);
  if (subnets.length === 0) return null;

  return (
    <details className="mt-8 rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer mg-type-label text-ink-muted hover:text-ink-strong">
        All {subnets.length} subnets
      </summary>
      <nav aria-label="All subnets" className="mt-3">
        <ul className="columns-2 gap-x-6 sm:columns-3 lg:columns-4">
          {subnets.map((subnet) => (
            <li key={subnet.netuid} className="break-inside-avoid py-0.5">
              <Link
                to="/subnets/$netuid"
                params={{ netuid: subnet.netuid }}
                className="mg-type-caption text-ink-muted hover:text-accent"
              >
                <span className="text-ink-strong">SN{subnet.netuid}</span>
                {subnet.name ? ` · ${subnet.name}` : ""}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}
