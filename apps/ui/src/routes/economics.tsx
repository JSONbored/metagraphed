import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyButton, PageHero, SectionHeading } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import {
  ECONOMICS_ARTIFACT_PATH,
  ECONOMICS_PARAMS,
  ECONOMICS_PATH,
  ECONOMICS_SORT_FIELDS,
  ECONOMICS_SURFACES,
  ECONOMICS_TRENDS_DEFAULT_WINDOW,
  ECONOMICS_TRENDS_METRICS,
  ECONOMICS_TRENDS_PATH,
  ECONOMICS_TRENDS_WINDOWS,
  buildEconomicsCurlExample,
  buildEconomicsTrendsCurlExample,
} from "@/lib/metagraphed/economics-docs";

export const Route = createFileRoute("/economics")({
  head: () => ({
    meta: [
      { title: "Economics — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed economics endpoints — per-subnet stake, alpha price, market-cap and FDV proxies, emission share, and the network-wide daily time series. No API key.",
      },
      { property: "og:title", content: "Economics — Metagraphed" },
      {
        property: "og:description",
        content:
          "GET /api/v1/economics and /economics/trends — filter, sort, page, or download as CSV.",
      },
    ],
  }),
  component: EconomicsDocsPage,
});

const ECONOMICS_URL = `${API_BASE}${ECONOMICS_PATH}`;
const LIST_CURL = buildEconomicsCurlExample(DEFAULT_API_BASE);
const TRENDS_CURL = buildEconomicsTrendsCurlExample(DEFAULT_API_BASE);

function EconomicsDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="API"
        live
        title="Economics"
        description="Per-subnet stake, alpha price, market-cap and FDV proxies, registration cost, and emission share — plus the network-wide daily time series. Read-only, no API key."
      />

      <div className="mt-6 space-y-section" data-testid="economics-docs">
        <section>
          <SectionHeading
            title="Endpoints"
            intro="Two GET routes: a per-subnet snapshot list and the network-wide daily rollup."
          />
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  GET
                </div>
                <code className="mt-0.5 block overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
                  {ECONOMICS_URL}
                </code>
              </div>
              <CopyButton value={ECONOMICS_URL} label="economics URL" />
            </div>
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
                  {ECONOMICS_SURFACES.map((row) => (
                    <tr key={row.path} className="align-top">
                      <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                        {row.method}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                        {row.path}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-ink">{row.summary}</td>
                      <td className="px-3 py-2.5 text-[12px] text-ink-muted">{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Filtering & sorting"
            intro="Params on the list route. `sort` takes a bare field name and pairs with the separate `order` param — a combined `field:desc` token is not supported."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Param</th>
                  <th className="px-3 py-2.5 font-normal">Value</th>
                  <th className="px-3 py-2.5 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ECONOMICS_PARAMS.map((row) => (
                  <tr key={row.param} className="align-top">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                      ?{row.param}=
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] text-ink">
                      {row.value}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-muted">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Sortable fields
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-ink-strong">
              {ECONOMICS_SORT_FIELDS.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Example
              </div>
              <CopyButton value={LIST_CURL} label="economics curl example" />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
              {LIST_CURL}
            </pre>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Trends"
            intro="One row per UTC day across all subnets, aggregated live from the daily subnet_snapshots rollup. Pass ?format=csv to download the per-day series."
          />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Windows (?window=)
              </div>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-ink-strong">
                {ECONOMICS_TRENDS_WINDOWS.map((w) => (
                  <li key={w}>
                    {w}
                    {w === ECONOMICS_TRENDS_DEFAULT_WINDOW ? (
                      <span className="ml-1 text-ink-muted">(default)</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Per-day metrics
              </div>
              <ul className="space-y-1 font-mono text-[12px] text-ink-strong">
                {ECONOMICS_TRENDS_METRICS.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Example
              </div>
              <CopyButton value={TRENDS_CURL} label="economics trends curl example" />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
              {TRENDS_CURL}
            </pre>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            Live charts for this data:{" "}
            <Link to="/subnets" className="text-accent hover:underline">
              Subnets
            </Link>
            . Machine index:{" "}
            <Link to="/agents" className="text-accent hover:underline">
              For agents
            </Link>
            .
          </p>
        </section>
      </div>

      <ApiSourceFooter
        paths={[ECONOMICS_PATH, ECONOMICS_TRENDS_PATH]}
        artifacts={[ECONOMICS_ARTIFACT_PATH]}
      />
    </AppShell>
  );
}
