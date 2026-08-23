import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /subnets/category/{slug} retired into the /subnets domain filter (#11613).
 *
 * #11342 shipped these as ten standalone pages because "which Bittensor
 * subnets do inference" was a query we answered with nothing. The rebuilt index
 * answers it in place: the same taxonomy is a filter on the registry table, so
 * a reader gets the selection AND everything that surrounds it instead of a
 * near-duplicate table on a URL of its own.
 *
 * A permanent redirect rather than a deletion: these URLs are in the sitemap,
 * in llms.txt, and linked from the hub's own category chips, so deleting the
 * route would answer a crawler that already knows them with a 404. 301 and not
 * the framework's 307 default because the route is RETIRED rather than
 * temporarily moved — a temporary redirect tells a search engine to keep the
 * old URL and re-check it, while a permanent one transfers the signals to
 * /subnets and lets the old URL drop out.
 *
 * The slug carries across as the `domain` filter, so a link to one category
 * lands on that category's selection rather than the unfiltered registry.
 */
export const Route = createFileRoute("/subnets/category/$slug")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/subnets",
      search: { domain: params.slug },
      replace: true,
      statusCode: 301,
    });
  },
});
