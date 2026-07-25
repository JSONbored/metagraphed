import { createFileRoute } from "@tanstack/react-router";
import { tableSearchSchema } from "@/lib/metagraphed/url-state";
import { SubnetsPage } from "./-subnets-index-page";

export const Route = createFileRoute("/subnets/")({
  validateSearch: tableSearchSchema,
  head: () => ({
    meta: [
      { title: "Subnets — Metagraphed" },
      {
        name: "description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
      { property: "og:title", content: "Subnets — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
    ],
  }),
  component: SubnetsPage,
});
