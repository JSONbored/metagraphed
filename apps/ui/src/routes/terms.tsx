import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "./-terms-page";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of use — Metagraphed" },
      {
        name: "description",
        content:
          "What you can rely on from Metagraphed, what you cannot, and the fair-use expectations for its public API and MCP server.",
      },
    ],
  }),
  component: TermsPage,
});
