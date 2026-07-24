import { createFileRoute } from "@tanstack/react-router";
import { GraphqlExplorerPage } from "./-graphql-explorer-page";

export const Route = createFileRoute("/graphql/explorer")({
  head: () => ({
    meta: [
      { title: "GraphQL Explorer — Metagraphed" },
      {
        name: "description",
        content:
          "Interactive GraphiQL explorer for the Metagraphed API — schema-aware autocomplete, docs, live queries, and chainEvents subscriptions against the public /api/v1/graphql endpoint. No API key.",
      },
    ],
  }),
  component: GraphqlExplorerPage,
});
