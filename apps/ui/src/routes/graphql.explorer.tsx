import { pageMeta } from "@/lib/metagraphed/seo-meta";
import { createFileRoute } from "@tanstack/react-router";
import { GraphqlExplorerPage } from "./-graphql-explorer-page";

export const Route = createFileRoute("/graphql/explorer")({
  head: () => ({
    meta: pageMeta(
      "GraphQL Explorer — Metagraphed",
      "Explore the public Metagraphed GraphQL API with schema-aware autocomplete, docs, live queries, and chainEvents subscriptions. No API key.",
    ),
  }),
  component: GraphqlExplorerPage,
});
