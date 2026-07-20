import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { GraphiqlExplorer } from "@/components/metagraphed/graphiql-explorer";
import { API_BASE } from "@/lib/metagraphed/config";
import { toGraphqlSubscriptionUrl } from "@/lib/metagraphed/graphql-subscription-url";

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
          "Interactive GraphiQL explorer for the Metagraphed API — schema-aware autocomplete, docs, live queries, and chainEvents subscriptions against the public /api/v1/graphql endpoint. No API key.",
      },
    ],
  }),
  component: GraphqlExplorerPage,
});

const ENDPOINT_URL = `${API_BASE}${GRAPHQL_ENDPOINT_PATH}`;
const SUBSCRIPTION_URL = toGraphqlSubscriptionUrl(ENDPOINT_URL) ?? undefined;

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
        Schema-aware autocomplete, docs, and history against the live endpoint — including{" "}
        <code className="font-mono text-[12px] text-ink">chainEvents</code> subscriptions over{" "}
        <code className="font-mono text-[12px] text-ink">graphql-transport-ws</code>. No API key.
      </p>
      {SUBSCRIPTION_URL ? (
        <p
          className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted"
          data-testid="graphql-subscription-endpoint"
        >
          POST {ENDPOINT_URL}
          <span className="mx-2 text-border">·</span>
          WSS {SUBSCRIPTION_URL}
        </p>
      ) : null}
      <div className="mt-6">
        <GraphiqlExplorer
          endpoint={ENDPOINT_URL}
          subscriptionUrl={SUBSCRIPTION_URL}
          heightClassName="h-[70vh] min-h-[520px] max-h-[900px]"
        />
      </div>
    </AppShell>
  );
}
