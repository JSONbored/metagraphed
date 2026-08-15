import { createFileRoute } from "@tanstack/react-router";
import { registryFacetDatasetJsonLd, stringifyJsonLd } from "@/lib/metagraphed/json-ld";
import { categoryCopy, categoryPath } from "@/lib/metagraphed/subnet-categories";
import { clampText } from "@/lib/metagraphed/truncate";
import { HUB_DESCRIPTION_MAX, HUB_TITLE_MAX } from "@/lib/metagraphed/hub-copy";
import { SubnetCategoryPage } from "./-subnets-category-page";

// #11342: "which Bittensor subnets do X" — the query shape between the 129
// subnet pages and the hub, which we answered with nothing.
//
// A static `category` segment beside /subnets/$netuid and /subnets/with-api;
// the router prefers the static prefix, the same precedence /docs/raw relies
// on (#11294).
export const Route = createFileRoute("/subnets/category/$slug")({
  head: ({ params }) => {
    const copy = categoryCopy(params.slug);
    // Clamped with the site's one truncation rule rather than hand-counted:
    // these are generated from per-category copy, so a long label must not be
    // able to push the tag past what Google shows. Brand last, as everywhere.
    const title = clampText(
      `${copy.label} subnets on Bittensor — health & APIs · Metagraphed`,
      HUB_TITLE_MAX,
    );
    const description = clampText(copy.summary, HUB_DESCRIPTION_MAX);
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
      scripts: [
        {
          type: "application/ld+json",
          children: stringifyJsonLd(
            registryFacetDatasetJsonLd({
              name: `Bittensor ${copy.label.toLowerCase()} subnets`,
              identifier: `subnets-category-${params.slug}`,
              description: copy.summary,
              path: categoryPath(params.slug),
              apiUrl: "/api/v1/subnets",
            }),
          ),
        },
      ],
    };
  },
  component: SubnetCategoryPage,
});
