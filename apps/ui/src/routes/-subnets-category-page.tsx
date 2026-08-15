import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  AsyncPanel,
  PageMasthead,
  Panel,
  TableSkeleton,
} from "@/components/metagraphed/primitives";
import { SectionHeading, StatusBadge, type HealthStatus } from "@jsonbored/ui-kit";
import { SUBNETS_ALL_LIMIT, subnetsQuery } from "@/lib/metagraphed/queries";
import { categoryCopy, MIN_CATEGORY_SUBNETS } from "@/lib/metagraphed/subnet-categories";
import type { Subnet } from "@/lib/metagraphed/types";

/**
 * `/subnets/category/{slug}` — the subnets doing one kind of work (#11342).
 *
 * The query shape sitting directly above "what is subnet 64", and the one a
 * person types before they know a netuid. The registry has computed
 * `derived_categories` on every subnet all along and surfaced them nowhere.
 */

function inCategory(rows: Subnet[], slug: string): Subnet[] {
  return rows
    .filter((row) => (row.derived_categories ?? []).includes(slug))
    .sort(
      (a, b) =>
        (b.integration_readiness ?? 0) - (a.integration_readiness ?? 0) || a.netuid - b.netuid,
    );
}

function CategoryTable({ slug }: { slug: string }) {
  const { data } = useSuspenseQuery(subnetsQuery({ limit: SUBNETS_ALL_LIMIT }));
  const all = (data.data ?? []) as Subnet[];
  const rows = inCategory(all, slug);
  const copy = categoryCopy(slug);

  const withSpec = rows.filter((r) => (r.official_surface_count ?? 0) > 0).length;
  const probed = rows.filter((r) => (r.probed_surface_count ?? 0) > 0).length;

  // Below the bar this is a near-duplicate of the one subnet it lists, so it
  // says so rather than rendering a one-row table dressed as a category.
  if (rows.length < MIN_CATEGORY_SUBNETS) {
    return (
      <SectionHeading
        title={`Not enough subnets to compare yet`}
        intro={`The registry currently classifies ${rows.length} subnet${rows.length === 1 ? "" : "s"} under ${copy.label.toLowerCase()}. A category needs at least ${MIN_CATEGORY_SUBNETS} before a comparison page tells you anything a single subnet page would not — browse all subnets instead.`}
      />
    );
  }

  return (
    <>
      {/* Synthesis first, list second — the rule every new URL in #11313 ships
          under. These counts come from our own probe cycle. */}
      <SectionHeading
        title={`${copy.label} on Bittensor today`}
        intro={`${rows.length} subnets are classified under ${copy.label.toLowerCase()}. ${withSpec} publish at least one first-party interface and ${probed} have a surface that answered our most recent probe. ${copy.guidance}`}
      />
      <Panel>
        <table className="w-full text-left mg-type-data-sm">
          <caption className="sr-only">
            Bittensor {copy.label.toLowerCase()} subnets, ranked by integration readiness
          </caption>
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Subnet
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Readiness
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Surfaces
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Health
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.netuid} className="border-b border-border/60">
                <th scope="row" className="px-3 py-2 font-normal">
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: row.netuid }}
                    className="text-accent-text hover:underline"
                  >
                    SN{row.netuid} {row.name ?? ""}
                  </Link>
                </th>
                <td className="px-3 py-2 tabular-nums">{row.integration_readiness ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">
                  {row.official_surface_count ?? 0}/{row.surface_count ?? 0}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={(row.status as HealthStatus) ?? "unknown"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div className="mt-10">
        <SectionHeading
          title={`What "${copy.label.toLowerCase()}" means here`}
          intro={copy.summary}
        />
        <SectionHeading
          title="How the classification is derived"
          intro="Categories come from what a subnet publishes about itself — its declared purpose, its source repository and the interfaces it exposes — not from a hand-maintained list. A subnet can belong to several, and 60 of 129 currently belong to none, which is a coverage gap in our data rather than a statement about those subnets."
        />
      </div>
    </>
  );
}

export function SubnetCategoryPage() {
  const { slug } = useParams({ from: "/subnets/category/$slug" });
  const copy = categoryCopy(slug);
  return (
    <AppShell>
      <PageMasthead
        live
        eyebrow="Category"
        title={`${copy.label} subnets`}
        description={copy.summary}
      />
      <AsyncPanel context="subnet-category" fallback={<TableSkeleton rows={8} columns={4} />}>
        <CategoryTable slug={slug} />
      </AsyncPanel>
    </AppShell>
  );
}
