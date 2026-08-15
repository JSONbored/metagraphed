import { createFileRoute } from "@tanstack/react-router";
import { hubMeta } from "@/lib/metagraphed/hub-copy";
import { stringifyJsonLd, registryFacetDatasetJsonLd } from "@/lib/metagraphed/json-ld";
import { SubnetsWithApiPage } from "./-subnets-with-api-page";

// #11316: the one faceted page of the three this epic proposed that survived
// measurement. See -subnets-with-api-page.tsx for why the other two did not.
//
// A STATIC segment beside /subnets/$netuid: the router prefers it over the
// param route, the same precedence /docs/raw relies on (#11294). Nothing else
// is needed to keep /subnets/64 working.
export const Route = createFileRoute("/subnets/with-api")({
  head: () => ({
    meta: hubMeta("/subnets/with-api"),
    // The page is a registry projection, so it gets the same Dataset treatment
    // every other registry record has -- a filtered view of the catalog is
    // still a dataset, and saying so is what ties it to the catalog node the
    // site graph already publishes.
    scripts: [
      {
        type: "application/ld+json",
        children: stringifyJsonLd(
          registryFacetDatasetJsonLd({
            name: "Bittensor subnets publishing a machine-readable API specification",
            identifier: "subnets-with-api",
            description:
              "The subset of Bittensor subnets that publish an OpenAPI specification, with " +
              "integration-readiness scores and probe-derived health for each.",
            path: "/subnets/with-api",
            apiUrl: "/api/v1/agent-catalog",
          }),
        ),
      },
    ],
  }),
  component: SubnetsWithApiPage,
});
