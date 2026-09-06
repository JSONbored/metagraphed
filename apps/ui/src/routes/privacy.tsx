import { pageMeta } from "@/lib/metagraphed/seo-meta";
import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "./-privacy-page";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: pageMeta(
      "Privacy policy — Metagraphed",
      "What Metagraphed collects, why, how long it is kept, and who else processes it — checkable against the code that implements it.",
    ),
  }),
  component: PrivacyPage,
});
