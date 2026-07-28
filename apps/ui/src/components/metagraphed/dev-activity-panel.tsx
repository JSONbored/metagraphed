import { Star } from "lucide-react";
import { BarMini, SectionAnchor, TimeAgo } from "@jsonbored/ui-kit";
import type { SubnetProfile } from "@/lib/metagraphed/types";

/**
 * About-tab dev-activity module (#8379, extends #6639). Reads fields already
 * present on the profile this page already fetched -- no separate query.
 * Hidden entirely (not an empty-state card) when the subnet has no resolved
 * source repo, matching SubnetLineageSection's own `return null` convention
 * on this same tab.
 */
export function DevActivityPanel({ profile }: { profile?: SubnetProfile }) {
  if (!profile?.repo) return null;

  const weeks = profile.github_commits_weekly ?? [];
  const hasCommits = weeks.some((w) => w.count > 0);

  return (
    <SectionAnchor
      id="dev-activity"
      title="Dev activity"
      subtitle="Commits, stars, and last push on the resolved source repo."
      info="Captured from the GitHub API against this subnet's resolved source repo (curated, or chain-declared as a fallback). Refreshed daily; a repo that fails to load keeps its last-known values, marked unreachable, for up to 30 days."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mg-type-caption text-ink-muted">
        {profile.github_stars != null ? (
          <span className="inline-flex items-center gap-1.5">
            <Star className="size-3.5" aria-hidden /> {profile.github_stars.toLocaleString()} stars
          </span>
        ) : null}
        {profile.github_last_push_at ? (
          <span>
            Last push <TimeAgo at={profile.github_last_push_at} />
          </span>
        ) : null}
        {profile.github_unreachable ? (
          <span className="text-health-warn">
            Repo unreachable — showing the last successful capture
          </span>
        ) : null}
      </div>
      {hasCommits ? (
        <div className="mt-4">
          <BarMini
            data={weeks.map((w) => ({
              label: new Date(w.week).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              }),
              value: w.count,
            }))}
            ariaLabel="Weekly commits, last 90 days"
          />
        </div>
      ) : null}
    </SectionAnchor>
  );
}
