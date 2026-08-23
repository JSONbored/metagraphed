import { createFileRoute } from "@tanstack/react-router";
import { PrimitivesPreview } from "./-design-primitives-page";

export const Route = createFileRoute("/design/primitives")({
  head: () => ({
    meta: [
      { title: "Design system · Metagraphed" },
      {
        name: "description",
        content:
          "The design system: the fourteen primitives with their specimens, props and measured anatomy, and every design token with its light and dark value.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PrimitivesPreview,
});
