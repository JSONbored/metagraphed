import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyButton, PageHero, SectionHeading } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import {
  RPC_API_SURFACES,
  RPC_DOCS_DENIED_PREFIXES,
  RPC_DOCS_NETWORKS,
  RPC_DOCS_SAFE_METHODS,
  RPC_DOCS_STATE_QUERY_METHODS,
  RPC_ENDPOINTS_PATH,
  RPC_POOLS_PATH,
  RPC_PROXY_PATH_TEMPLATE,
  RPC_USAGE_PATH,
  buildRpcCurlExample,
  buildRpcLimitRows,
  rpcProxyPath,
} from "@/lib/metagraphed/rpc-docs";

export const Route = createFileRoute("/rpc")({
  head: () => ({
    meta: [
      { title: "RPC — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed RPC surface — POST /rpc/v1/{network} proxy, GET /api/v1/rpc/pools, /endpoints, /usage, allowlisted methods, and rate limits.",
      },
      { property: "og:title", content: "RPC — Metagraphed" },
      {
        property: "og:description",
        content:
          "One read-only JSON-RPC URL for finney and test, plus the pool, endpoint catalog, and usage analytics APIs.",
      },
    ],
  }),
  component: RpcDocsPage,
});

const FINNEY_PROXY_URL = `${API_BASE}${rpcProxyPath("finney")}`;
const CURL_EXAMPLE = buildRpcCurlExample(DEFAULT_API_BASE, "finney");
const LIMIT_ROWS = buildRpcLimitRows();

function RpcDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="API"
        live
        title="RPC"
        description="One read-only JSON-RPC URL for Bittensor — health-aware load balancing, failover, and abuse controls. Plus the pool roster, endpoint catalog, and proxy usage analytics. No API key."
      />

      <div className="mt-6 space-y-section" data-testid="rpc-docs">
        <section>
          <SectionHeading
            title="Proxy"
            intro="POST a single JSON-RPC object to /rpc/v1/{network}. Supported networks: finney (mainnet) and test (testnet). WebSocket upgrade is not available on this HTTP path — use wss.metagraph.sh or a public WSS endpoint."
          />
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  POST
                </div>
                <code className="mt-0.5 block overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
                  {`${API_BASE}${RPC_PROXY_PATH_TEMPLATE}`}
                </code>
              </div>
              <CopyButton value={FINNEY_PROXY_URL} label="RPC proxy URL (finney)" />
            </div>
            <ul className="space-y-1.5 font-mono text-[12px] text-ink-muted">
              {RPC_DOCS_NETWORKS.map((network) => (
                <li key={network}>
                  <span className="text-ink-strong">{network}</span> →{" "}
                  <code className="text-ink-strong">
                    {API_BASE}
                    {rpcProxyPath(network)}
                  </code>
                </li>
              ))}
            </ul>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Example
                </div>
                <CopyButton value={CURL_EXAMPLE} label="RPC curl example" />
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
                {CURL_EXAMPLE}
              </pre>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Catalog & analytics"
            intro="Static registry projections and live proxy telemetry. Live explorer UI for pools and traffic lives on Endpoints."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Method</th>
                  <th className="px-3 py-2.5 font-normal">Path</th>
                  <th className="px-3 py-2.5 font-normal">Summary</th>
                  <th className="px-3 py-2.5 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {RPC_API_SURFACES.map((row) => (
                  <tr key={row.path} className="align-top">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                      {row.method}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">{row.path}</td>
                    <td className="px-3 py-2.5 text-[12px] text-ink">{row.summary}</td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-muted">{row.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            Live pool + usage panels:{" "}
            <Link to="/endpoints" className="text-accent hover:underline">
              Endpoints
            </Link>
            . Machine index:{" "}
            <Link to="/agents" className="text-accent hover:underline">
              For agents
            </Link>
            .
          </p>
        </section>

        <section>
          <SectionHeading
            title="Allowlisted methods"
            intro="Only safe read methods pass. Mutating and heavy prefixes are denied. State-query methods need param validation and a separate rate budget."
          />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Safe methods
              </div>
              <ul className="space-y-1 font-mono text-[12px] text-ink-strong">
                {RPC_DOCS_SAFE_METHODS.map((method) => (
                  <li key={method}>{method}</li>
                ))}
              </ul>
            </div>
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  State-query (extra budget)
                </div>
                <ul className="space-y-1 font-mono text-[12px] text-ink-strong">
                  {RPC_DOCS_STATE_QUERY_METHODS.map((method) => (
                    <li key={method}>{method}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Denied prefixes
                </div>
                <ul className="space-y-1 font-mono text-[12px] text-ink-muted">
                  {RPC_DOCS_DENIED_PREFIXES.map((prefix) => (
                    <li key={prefix}>
                      <code className="text-ink-strong">{prefix}</code>*
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Limits"
            intro="Hard caps on every proxied POST. Matching constants live in workers/config.mjs and workers/request-handlers/rpc-proxy.mjs."
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

      <ApiSourceFooter paths={[RPC_POOLS_PATH, RPC_ENDPOINTS_PATH, RPC_USAGE_PATH]} />
    </AppShell>
  );
}
