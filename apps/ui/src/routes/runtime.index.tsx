import { createFileRoute } from "@tanstack/react-router";
import { RuntimePage } from "./-runtime-index-page";

export const Route = createFileRoute("/runtime/")({
  head: () => ({
    meta: [
      { title: "Runtime — Metagraphed" },
      {
        name: "description",
        content:
          "Spec-version upgrade history for the Bittensor chain — every runtime upgrade observed, newest first.",
      },
      { property: "og:title", content: "Runtime — Metagraphed" },
      {
        property: "og:description",
        content:
          "Spec-version upgrade history for the Bittensor chain — every runtime upgrade observed, newest first.",
      },
    ],
  }),
  component: RuntimePage,
});
