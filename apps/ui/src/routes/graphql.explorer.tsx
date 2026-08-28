import { createFileRoute } from "@tanstack/react-router";
import { GraphqlExplorerPage } from "./-graphql-explorer-page";

export const Route = createFileRoute("/graphql/explorer")({
  head: () => ({
    meta: [
      { title: "GraphQL Explorer — Metagraphed" },
      {
        name: "description",
        content:
          "Explore the public Metagraphed GraphQL API with schema-aware autocomplete, docs, live queries, and chainEvents subscriptions. No API key.",
      },
    ],
  }),
  component: GraphqlExplorerPage,
});
