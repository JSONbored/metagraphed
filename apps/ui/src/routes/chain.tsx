import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyButton, PageHero, SectionHeading } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import {
  CHAIN_ACTIVITY_PATH,
  CHAIN_ANALYTICS_ROUTES,
  CHAIN_CALLS_PATH,
  CHAIN_FEES_PATH,
  CHAIN_SIGNERS_PATH,
  buildChainBehaviourRows,
  buildChainCsvCurlExample,
  buildChainCurlExample,
  chainAnalyticsUrl,
} from "@/lib/metagraphed/chain-docs";

export const Route = createFileRoute("/chain")({
  head: () => ({
    meta: [
      { title: "Chain analytics — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed chain analytics — GET /api/v1/chain/activity, /calls, /signers, /fees: windowed network aggregates, call mix, signer leaderboards, and the fee market.",
      },
      { property: "og:title", content: "Chain analytics — Metagraphed" },
      {
        property: "og:description",
        content:
          "Four windowed read endpoints over the first-party chain tiers — daily activity, call mix, most-active signers, and fee/tip market analytics. JSON or CSV.",
      },
    ],
  }),
  component: ChainDocsPage,
});

const ACTIVITY_URL = chainAnalyticsUrl(API_BASE, CHAIN_ACTIVITY_PATH);
const CURL_EXAMPLE = buildChainCurlExample(DEFAULT_API_BASE);
const CSV_CURL_EXAMPLE = buildChainCsvCurlExample(DEFAULT_API_BASE);
const BEHAVIOUR_ROWS = buildChainBehaviourRows();

function ChainDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="API"
        live
        title="Chain analytics"
        description="Four windowed read endpoints over the first-party chain tiers — what the network did each day, which pallets it spent its blockspace on, who signed the most, and what it paid in fees. No API key."
      />

      <div className="mt-6 space-y-section" data-testid="chain-docs">
        <section>
          <SectionHeading
            title="Endpoints"
            intro="All four are GET, unauthenticated, and share one rolling window contract. Every response carries the standard envelope (ok, data, meta) with the snapshot's observed_at."
          />
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  GET
                </div>
                <code className="mt-0.5 block overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
                  {ACTIVITY_URL}
                </code>
              </div>
              <CopyButton value={ACTIVITY_URL} label="Chain activity URL" />
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    <th className="px-3 py-2.5 font-normal">Method</th>
                    <th className="px-3 py-2.5 font-normal">Path</th>
                    <th className="px-3 py-2.5 font-normal">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {CHAIN_ANALYTICS_ROUTES.map((route) => (
                    <tr key={route.path} className="align-top">
                      <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                        {route.method}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                        {route.path}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-ink">{route.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Example
                </div>
                <CopyButton value={CURL_EXAMPLE} label="Chain analytics curl example" />
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
                {CURL_EXAMPLE}
              </pre>
            </div>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            Live block + extrinsic UI:{" "}
            <Link to="/explorer" className="text-accent hover:underline">
              Explorer
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
            title="Parameters"
            intro="Each route allowlists its own query params — anything else is a 400 rather than a silently ignored filter. Response fields are the keys of the data object."
          />
          <div className="space-y-4">
            {CHAIN_ANALYTICS_ROUTES.map((route) => (
              <div key={route.path} className="rounded-lg border border-border bg-card px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[13px] text-ink-strong">{route.title}</span>
                  <code className="font-mono text-[11px] text-ink-muted">{route.path}</code>
                </div>
                <dl className="mt-3 space-y-1.5">
                  {route.params.map((param) => (
                    <div key={param.name} className="flex flex-wrap gap-x-2 text-[12px]">
                      <dt className="font-mono text-ink-strong">{param.name}</dt>
                      <dd className="font-mono text-ink-muted">{param.values}</dd>
                      <dd className="w-full text-ink-muted sm:w-auto">{param.detail}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 border-t border-border pt-2">
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    Response
                  </div>
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-ink-strong">
                    {route.responseFields.map((field) => (
                      <li key={field}>{field}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHeading
            title="CSV export"
            intro="Add ?format=csv to any of the four. Each route exports its primary row-shaped table — the fee-payer leaderboard stays JSON-only in the envelope."
          />
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {CHAIN_ANALYTICS_ROUTES.map((route) => (
                <div key={route.path} className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    {route.title}
                  </div>
                  <ul className="space-y-1 font-mono text-[12px] text-ink-strong">
                    {route.csvColumns.map((column) => (
                      <li key={column}>{column}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Example
                </div>
                <CopyButton value={CSV_CURL_EXAMPLE} label="Chain analytics CSV curl example" />
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
                {CSV_CURL_EXAMPLE}
              </pre>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Behaviour"
            intro="Shared contract across the four routes. Matching constants live in workers/config.mjs and workers/request-handlers/analytics.mjs."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Aspect</th>
                  <th className="px-3 py-2.5 font-normal">Value</th>
                  <th className="px-3 py-2.5 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {BEHAVIOUR_ROWS.map((row) => (
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

      <ApiSourceFooter
        paths={[CHAIN_ACTIVITY_PATH, CHAIN_CALLS_PATH, CHAIN_SIGNERS_PATH, CHAIN_FEES_PATH]}
      />
    </AppShell>
  );
}
