import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "./-privacy-page";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy policy — Metagraphed" },
      {
        name: "description",
        content:
          "What Metagraphed collects, why, how long it is kept, and who else processes it — checkable against the code that implements it.",
      },
    ],
  }),
  component: PrivacyPage,
});
