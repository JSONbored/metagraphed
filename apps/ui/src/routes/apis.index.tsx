import { createFileRoute } from "@tanstack/react-router";
import { surfacesSearchSchema } from "@/lib/metagraphed/surface-filters";
import { SurfacesPage } from "./-surfaces-page";

export const Route = createFileRoute("/apis/")({
  validateSearch: surfacesSearchSchema,
  head: () => ({
    meta: [
      { title: "API catalog — Metagraphed" },
      {
        name: "description",
        content:
          "Verified public interfaces across Bittensor subnets: APIs, docs, dashboards, repos, SDKs.",
      },
      { property: "og:title", content: "Surfaces — Metagraphed" },
      {
        property: "og:description",
        content:
          "Verified public interfaces across Bittensor subnets: APIs, docs, dashboards, repos, SDKs.",
      },
    ],
  }),
  component: SurfacesPage,
});
