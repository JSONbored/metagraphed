import { pageMeta } from "@/lib/metagraphed/seo-meta";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "./-settings-page";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: pageMeta(
      "Settings — Metagraphed",
      "Personalize Metagraphed, manage API keys, alerts and webhooks, and take your local watchlists and address labels with you.",
    ),
  }),
  component: SettingsPage,
});
