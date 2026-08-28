import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "./-settings-page";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Metagraphed" },
      {
        name: "description",
        content:
          "Personalize Metagraphed, manage API keys, alerts and webhooks, and take your local watchlists and address labels with you.",
      },
      { property: "og:title", content: "Settings — Metagraphed" },
      {
        property: "og:description",
        content:
          "Personalize Metagraphed, manage API keys, alerts and webhooks, and take your local watchlists and address labels with you.",
      },
    ],
  }),
  component: SettingsPage,
});
