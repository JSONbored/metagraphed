import { pageMeta } from "@/lib/metagraphed/seo-meta";
import { createFileRoute } from "@tanstack/react-router";
import { AboutPage } from "./-about-page";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: pageMeta(
      "About — Metagraphed",
      "Methodology, scope, and contribution model for Metagraphed — the unofficial Bittensor explorer and integration registry.",
    ),
  }),
  component: AboutPage,
});
