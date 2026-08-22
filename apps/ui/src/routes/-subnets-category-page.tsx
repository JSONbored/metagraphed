import { useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { Skeleton } from "@/components/metagraphed/states";
import { DataTable, SectionHead, EntityHero, FactSentence } from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
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
      <SectionHead
        name={`Not enough subnets to compare yet`}
        question={`The registry currently classifies ${rows.length} subnet${rows.length === 1 ? "" : "s"} under ${copy.label.toLowerCase()}. A category needs at least ${MIN_CATEGORY_SUBNETS} before a comparison page tells you anything a single subnet page would not — browse all subnets instead.`}
      />
    );
  }

  return (
    <>
      {/* Synthesis first, list second — the rule every new URL in #11313 ships
          under. These counts come from our own probe cycle. */}
      <SectionHead
        name={`${copy.label} on Bittensor today`}
        question={`${rows.length} subnets are classified under ${copy.label.toLowerCase()}. ${withSpec} publish at least one first-party interface and ${probed} have a surface that answered our most recent probe. ${copy.guidance}`}
      />
      <DataTable
        rows={rows}
        rowKey={(row) => String(row.netuid)}
        caption={`Bittensor ${copy.label.toLowerCase()} subnets, ranked by integration readiness`}
        source="subnet-category"
        link={RouterLink}
        rowHref={(row) => `/subnets/${row.netuid}`}
        columns={[
          {
            key: "subnet",
            label: "Subnet",
            sortable: true,
            value: (row) => `SN${row.netuid}${row.name ? ` ${row.name}` : ""}`,
          },
          {
            key: "readiness",
            label: "Readiness",
            kind: "number",
            sortable: true,
            value: (row) => row.integration_readiness ?? null,
          },
          {
            key: "surfaces",
            label: "Surfaces",
            sortable: true,
            value: (row) => row.official_surface_count ?? 0,
            format: (_value, row) => `${row.official_surface_count ?? 0}/${row.surface_count ?? 0}`,
          },
          {
            key: "health",
            label: "Health",
            kind: "status",
            sortable: true,
            value: (row) => (typeof row.status === "string" ? row.status : "unknown"),
          },
        ]}
      />
      <div className="mt-10">
        <SectionHead
          name={`What "${copy.label.toLowerCase()}" means here`}
          question={copy.summary}
        />
        <SectionHead
          name="How the classification is derived"
          question="Categories come from what a subnet publishes about itself — its declared purpose, its source repository and the interfaces it exposes — not from a hand-maintained list. A subnet can belong to several, and 60 of 129 currently belong to none, which is a coverage gap in our data rather than a statement about those subnets."
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
      <EntityHero
        name={`${copy.label} subnets`}
        sentence={<FactSentence>{copy.summary}</FactSentence>}
      />
      <AsyncPanel context="subnet-category" fallback={<Skeleton className="h-64 w-full" />}>
        <CategoryTable slug={slug} />
      </AsyncPanel>
    </AppShell>
  );
}
