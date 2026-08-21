import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { CopyableCode } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { GraphiqlExplorer } from "@/components/metagraphed/graphiql-explorer";
import {
  DataPageCanvas,
  DataPageHero,
  DataPageModule,
  DataPageStage,
} from "@/components/metagraphed/primitives";
import { API_BASE } from "@/lib/metagraphed/config";
import { toGraphqlSubscriptionUrl } from "@/lib/metagraphed/graphql-subscription-url";

// GraphQL's one published, mainnet-only path -- content/docs/graphql.mdx
// (the docs page this explorer links back to) states the same literal.
const GRAPHQL_ENDPOINT_PATH = "/api/v1/graphql";
const ENDPOINT_URL = `${API_BASE}${GRAPHQL_ENDPOINT_PATH}`;
const SUBSCRIPTION_URL = toGraphqlSubscriptionUrl(ENDPOINT_URL) ?? undefined;

export function GraphqlExplorerPage() {
  return (
    <AppShell>
      <DataPageStage>
        <DataPageHero
          id="graphql-explorer-title"
          eyebrow="GraphQL"
          live
          title="Query the live registry."
          description="Schema-aware autocomplete, docs, and history over HTTP — plus live chainEvents subscriptions over WebSocket. No API key."
          actions={
            <Link
              to="/docs/$"
              params={{ _splat: "graphql" }}
              className="inline-flex min-h-11 items-center gap-1.5 border border-border px-3 py-1.5 mg-type-caption font-medium text-ink-muted transition-colors hover:border-accent/50 hover:text-ink-strong"
            >
              <ArrowLeft aria-hidden className="size-3.5" />
              GraphQL docs
            </Link>
          }
        />
        <DataPageCanvas>
          <DataPageModule
            title="Compose and inspect."
            caption="Endpoints stay copyable at the point of use; the explorer remains the one focused workspace below."
          >
            {/* Same CopyableCode row treatment as EndpointSnippet / ApiSourceFooter —
          one labeled chip per transport, each with its own copy control. */}
            <div className="space-y-2" data-testid="graphql-explorer-endpoints">
              <CopyableCode
                label="POST"
                value={ENDPOINT_URL}
                truncate={false}
                className="w-full max-w-3xl"
              />
              {SUBSCRIPTION_URL ? (
                <CopyableCode
                  label="WSS"
                  value={SUBSCRIPTION_URL}
                  truncate={false}
                  className="w-full max-w-3xl"
                />
              ) : null}
            </div>

            <div className="mt-6">
              <GraphiqlExplorer
                endpoint={ENDPOINT_URL}
                subscriptionUrl={SUBSCRIPTION_URL}
                heightClassName="h-[70vh] min-h-[520px] max-h-[900px]"
              />
            </div>
          </DataPageModule>
        </DataPageCanvas>
        <ApiSourceFooter paths={[GRAPHQL_ENDPOINT_PATH]} />
      </DataPageStage>
    </AppShell>
  );
}
