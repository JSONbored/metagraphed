import { pageMeta } from "@/lib/metagraphed/seo-meta";
import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "./-terms-page";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: pageMeta(
      "Terms of use — Metagraphed",
      "What you can rely on from Metagraphed, what you cannot, and the fair-use expectations for its public API and MCP server.",
    ),
  }),
  component: TermsPage,
});
