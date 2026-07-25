import { createFileRoute } from "@tanstack/react-router";
import { AboutPage } from "./-about-page";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Metagraphed" },
      {
        name: "description",
        content:
          "Methodology, scope, and contribution model for Metagraphed — the unofficial Bittensor explorer and integration registry.",
      },
    ],
  }),
  component: AboutPage,
});
