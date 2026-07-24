import { createFileRoute } from "@tanstack/react-router";
import { PrimitivesPreview } from "./-design-primitives-page";

export const Route = createFileRoute("/design/primitives")({
  head: () => ({
    meta: [
      { title: "Primitives · Metagraphed" },
      {
        name: "description",
        content:
          "Shared registry UI primitives: chips, status badges, filters, freshness, breadcrumbs, density, columns.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PrimitivesPreview,
});
