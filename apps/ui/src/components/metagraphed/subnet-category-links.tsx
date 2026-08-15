import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SUBNETS_ALL_LIMIT, subnetsQuery } from "@/lib/metagraphed/queries";
import { categoryCopy, MIN_CATEGORY_SUBNETS } from "@/lib/metagraphed/subnet-categories";
import type { Subnet } from "@/lib/metagraphed/types";

/**
 * Links from /subnets to the category pages (#11342).
 *
 * Derived from the rendered rows rather than a written list: a category the
 * registry stops deriving stops being linked, and one it starts deriving is
 * linked the moment it clears the threshold. A hand-written list here would go
 * stale exactly the way every hand-listed gate in this repo has.
 *
 * Sitemap-only is the profile that lands a URL in "Crawled – currently not
 * indexed" (#11277), so these anchors are the half that makes the pages real.
 */
export function SubnetCategoryLinks() {
  const { data } = useSuspenseQuery(subnetsQuery({ limit: SUBNETS_ALL_LIMIT }));
  const counts = new Map<string, number>();
  for (const row of (data.data ?? []) as Subnet[]) {
    for (const category of row.derived_categories ?? []) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const categories = [...counts.entries()]
    .filter(([, count]) => count >= MIN_CATEGORY_SUBNETS)
    .sort((a, b) => b[1] - a[1]);
  if (categories.length === 0) return null;

  return (
    <nav aria-label="Subnet categories" className="mt-8">
      <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
        Browse by what they do
      </h2>
      <p className="mt-1.5 mg-type-caption leading-relaxed text-ink-muted">
        Categories are derived from what each subnet publishes about itself, not from a
        hand-maintained list.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {categories.map(([slug, count]) => (
          <li key={slug}>
            <Link
              to="/subnets/category/$slug"
              params={{ slug }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 mg-type-caption text-ink-muted hover:border-accent hover:text-accent-text"
            >
              {categoryCopy(slug).label}
              <span className="tabular-nums text-ink-muted/70">{count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
