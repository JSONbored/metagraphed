import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyButton, PageHero, SectionHeading } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { GraphiqlExplorer } from "@/components/metagraphed/graphiql-explorer";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import {
  GRAPHQL_ENDPOINT_PATH,
  GRAPHQL_ROOT_QUERIES,
  buildGraphqlCurlExample,
  buildGraphqlLimitRows,
} from "@/lib/metagraphed/graphql-docs";

export const Route = createFileRoute("/graphql")({
  head: () => ({
    meta: [
      { title: "GraphQL — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed GraphQL at /api/v1/graphql — schema discovery, root queries, complexity/depth limits, pagination, and rate limits.",
      },
      { property: "og:title", content: "GraphQL — Metagraphed" },
      {
        property: "og:description",
        content:
          "Shape one request across the registry: subnets, providers, economics, surfaces, health, compare, and opportunity boards.",
      },
    ],
  }),
  component: GraphqlDocsPage,
});

const ENDPOINT_URL = `${API_BASE}${GRAPHQL_ENDPOINT_PATH}`;
const CURL_EXAMPLE = buildGraphqlCurlExample(DEFAULT_API_BASE);
const LIMIT_ROWS = buildGraphqlLimitRows();

function GraphqlDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="API"
        live
        title="GraphQL"
        description="Shape one request across the registry — a subnet with health, surfaces, endpoints, and economics, a provider with its subnets, or the economic opportunity boards. No API key."
      />

      <div className="mt-6 space-y-section" data-testid="graphql-docs">
        <section>
          <SectionHeading
            title="Endpoint"
            intro="POST a GraphQL document. GET returns the published SDL. Introspection is enabled. Mainnet-only path."
          />
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  POST · GET
                </div>
                <code className="mt-0.5 block overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
                  {ENDPOINT_URL}
                </code>
              </div>
              <CopyButton value={ENDPOINT_URL} label="GraphQL endpoint" />
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Example
                </div>
                <CopyButton value={CURL_EXAMPLE} label="GraphQL curl example" />
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
                {CURL_EXAMPLE}
              </pre>
            </div>
          </div>
        </section>

        <section id="explorer">
          <SectionHeading
            title="Explorer"
            intro="Run a query against the live endpoint — schema-aware autocomplete, docs, and history, right in the browser."
          />
          <GraphiqlExplorer endpoint={ENDPOINT_URL} />
        </section>

        <section>
          <SectionHeading
            title="Schema"
            intro="GET the endpoint for the live SDL. Introspection queries (__schema / __type) are allowed and exempt from the depth and complexity budgets applied to product queries."
          />
          <ul className="space-y-1.5 font-mono text-[12px] text-ink-muted">
            <li>
              <span className="text-ink-strong">GET</span> {GRAPHQL_ENDPOINT_PATH} → SDL document
            </li>
            <li>
              <span className="text-ink-strong">POST</span> {GRAPHQL_ENDPOINT_PATH} →{" "}
              <code className="text-ink-strong">
                {'{ "query", "variables?", "operationName?" }'}
              </code>
            </li>
            <li>
              Field names mirror artifact JSON keys (snake_case) so resolvers read registry rows
              directly.
            </li>
          </ul>
        </section>

        <section>
          <SectionHeading
            title="Root queries"
            intro="Ten Query roots cover the same registry surfaces as REST. List roots take cursor pagination; relationship fields (fresh nested artifacts) cost more against the complexity budget."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Field</th>
                  <th className="px-3 py-2.5 font-normal">Args</th>
                  <th className="px-3 py-2.5 font-normal">Returns</th>
                  <th className="px-3 py-2.5 font-normal">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {GRAPHQL_ROOT_QUERIES.map((q) => (
                  <tr key={q.name} className="align-top">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">{q.name}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">{q.args}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                      {q.returns}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink">{q.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            Subscriptions: <code className="text-ink-strong">chainEvents</code> over the same path
            via <code className="text-ink-strong">graphql-transport-ws</code> (WebSocket). See{" "}
            <Link to="/agents" className="text-accent hover:underline">
              For agents
            </Link>{" "}
            for other machine surfaces.
          </p>
        </section>

        <section>
          <SectionHeading
            title="Limits"
            intro="Hard caps enforced on every POST. Matching constants live in src/graphql.mjs; rate limiting is keyed per client IP alongside the RPC proxy."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Limit</th>
                  <th className="px-3 py-2.5 font-normal">Value</th>
                  <th className="px-3 py-2.5 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {LIMIT_ROWS.map((row) => (
                  <tr key={row.label} className="align-top">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                      {row.label}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink">
                      {row.value}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-muted">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <ApiSourceFooter paths={[GRAPHQL_ENDPOINT_PATH]} />
    </AppShell>
  );
}
