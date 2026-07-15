import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyButton, PageHero, SectionHeading } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import {
  FEEDS_DOCS_CACHE_SECONDS,
  FEEDS_DOCS_CONTENT_TYPES,
  FEEDS_DOCS_FORMATS,
  FEEDS_DOCS_MAX_ITEMS,
  FEED_KINDS,
  FEED_PARAMS,
  buildFeedCurlExample,
  feedPath,
} from "@/lib/metagraphed/feeds-docs";

export const Route = createFileRoute("/feeds")({
  head: () => ({
    meta: [
      { title: "Feeds — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed content feeds — subscribe to registry changes, incidents, and coverage gaps as RSS 2.0, Atom 1.0, or JSON Feed. No API key.",
      },
      { property: "og:title", content: "Feeds — Metagraphed" },
      {
        property: "og:description",
        content:
          "RSS / Atom / JSON Feed over registry changes, incidents, and gaps — filter by tag, page by since/until.",
      },
    ],
  }),
  component: FeedsDocsPage,
});

const REGISTRY_FEED_URL = `${API_BASE}${feedPath("registry")}`;
const CURL_EXAMPLE = buildFeedCurlExample(DEFAULT_API_BASE, "registry", "json");

function FeedsDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="API"
        live
        title="Feeds"
        description="Subscribe to registry changes, incidents, and coverage gaps as RSS 2.0, Atom 1.0, or JSON Feed — computed at request time from artifacts already served. Read-only, no API key."
      />

      <div className="mt-6 space-y-section" data-testid="feeds-docs">
        <section>
          <SectionHeading
            title="Feeds"
            intro="Four GET feeds, all content-negotiated. Point any reader, crawler, or agent at a URL below."
          />
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  GET
                </div>
                <code className="mt-0.5 block overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
                  {REGISTRY_FEED_URL}
                </code>
              </div>
              <CopyButton value={REGISTRY_FEED_URL} label="registry feed URL" />
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    <th className="px-3 py-2.5 font-normal">Path</th>
                    <th className="px-3 py-2.5 font-normal">Summary</th>
                    <th className="px-3 py-2.5 font-normal">Item tags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {FEED_KINDS.map((kind) => (
                    <tr key={kind.slug} className="align-top">
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-strong">
                        {feedPath(kind.slug)}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-ink">{kind.summary}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                        {kind.tags}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Formats"
            intro="Format precedence: an explicit .rss / .atom / .json suffix wins, then the Accept header, then JSON Feed as the default."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Suffix</th>
                  <th className="px-3 py-2.5 font-normal">Example</th>
                  <th className="px-3 py-2.5 font-normal">Content-Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {FEEDS_DOCS_FORMATS.map((format) => (
                  <tr key={format} className="align-top">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">.{format}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                      {feedPath("registry", format)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                      {FEEDS_DOCS_CONTENT_TYPES[format]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Filtering & paging"
            intro="Every param composes. Use ?since= for incremental polling and ?tag= to turn one feed URL into a focused subscription."
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
                {FEED_PARAMS.map((row) => (
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
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Example
              </div>
              <CopyButton value={CURL_EXAMPLE} label="feeds curl example" />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
              {CURL_EXAMPLE}
            </pre>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            Responses are cached for {FEEDS_DOCS_CACHE_SECONDS}s and capped at{" "}
            {FEEDS_DOCS_MAX_ITEMS} items. Browse the same data:{" "}
            <Link to="/gaps" className="text-accent hover:underline">
              Gaps
            </Link>
            . Machine index:{" "}
            <Link to="/agents" className="text-accent hover:underline">
              For agents
            </Link>
            .
          </p>
        </section>
      </div>

      <ApiSourceFooter paths={FEED_KINDS.map((kind) => feedPath(kind.slug))} />
    </AppShell>
  );
}
