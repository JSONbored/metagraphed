import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "./-settings-page";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Developer settings — Metagraphed" },
      {
        name: "description",
        content: "Create, look up, and delete change-feed webhook subscriptions.",
      },
      { property: "og:title", content: "Developer settings — Metagraphed" },
      {
        property: "og:description",
        content: "Create, look up, and delete change-feed webhook subscriptions.",
      },
    ],
  }),
  component: SettingsPage,
});
