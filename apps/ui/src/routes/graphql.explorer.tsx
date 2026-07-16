import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { GraphiqlExplorer } from "@/components/metagraphed/graphiql-explorer";
import { API_BASE } from "@/lib/metagraphed/config";

// GraphQL's one published, mainnet-only path -- content/docs/graphql.mdx
// (the docs page this explorer links back to) states the same literal.
const GRAPHQL_ENDPOINT_PATH = "/api/v1/graphql";

export const Route = createFileRoute("/graphql/explorer")({
  head: () => ({
    meta: [
      { title: "GraphQL Explorer — Metagraphed" },
      {
        name: "description",
        content:
          "Interactive GraphiQL explorer for the Metagraphed API — schema-aware autocomplete, docs, and live queries against the public /api/v1/graphql endpoint. No API key.",
      },
    ],
  }),
  component: GraphqlExplorerPage,
});

const ENDPOINT_URL = `${API_BASE}${GRAPHQL_ENDPOINT_PATH}`;

function GraphqlExplorerPage() {
  return (
    <AppShell>
      <Link
        to="/docs/$"
        params={{ _splat: "graphql" }}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-muted transition-colors hover:text-ink-strong"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        GraphQL docs
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold text-ink-strong md:text-3xl">
        Explorer
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
        Schema-aware autocomplete, docs, and history against the live endpoint. No API key.
      </p>
      <div className="mt-6">
        <GraphiqlExplorer
          endpoint={ENDPOINT_URL}
          heightClassName="h-[70vh] min-h-[520px] max-h-[900px]"
        />
      </div>
    </AppShell>
  );
}
