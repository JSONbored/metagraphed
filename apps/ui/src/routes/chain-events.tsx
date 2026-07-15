import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CopyButton, ExternalLink, PageHero, PageSection } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { GITHUB_REPO } from "@/lib/metagraphed/config";

export const Route = createFileRoute("/chain-events")({
  head: () => ({
    meta: [
      { title: "Chain events reference — Metagraphed" },
      {
        name: "description",
        content:
          "How GET /api/v1/chain-events, /chain-events/stats, and /blocks/{n}/chain-events serve the Postgres deep-history all-events tier: params, response shapes, curl examples, the two-store split, and the 503 data_tier_unavailable condition.",
      },
      { property: "og:title", content: "Chain events reference — Metagraphed" },
      {
        property: "og:description",
        content:
          "The Postgres deep-history all-events tier, disambiguated from the SSE change feed and the curated explorer events — params, response shapes, curl examples, and the 503 condition.",
      },
    ],
  }),
  component: ChainEventsDocsPage,
});

const ADR_0013_URL = `${GITHUB_REPO}/blob/main/docs/adr/0013-hybrid-deployment-topology.md`;
const ADR_0014_URL = `${GITHUB_REPO}/blob/main/docs/adr/0014-chain-data-infrastructure-and-postgres-cutover.md`;

const TOC: { id: string; label: string }[] = [
  { id: "disambiguation", label: "Three “events” surfaces" },
  { id: "two-store-split", label: "The two-store split" },
  { id: "split-brain", label: "Why counts disagree" },
  { id: "deployment", label: "The DATA_API dependency" },
  { id: "get-chain-events", label: "GET /chain-events" },
  { id: "get-chain-events-stats", label: "GET /chain-events/stats" },
  { id: "get-block-chain-events", label: "GET /blocks/{n}/chain-events" },
  { id: "mcp", label: "MCP tools" },
];

function ChainEventsDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Reference · for maintainers"
        title="Chain events reference"
        description="The Postgres deep-history all-events tier — every raw pallet.method event on the chain, served by a separate data Worker (ADR 0014). This page covers the three /chain-events routes, how they differ from the other two “events” surfaces, and the 503 you'll get when the data tier isn't deployed."
      />

      <nav aria-label="On this page" className="mb-10 flex flex-wrap gap-2">
        {TOC.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className="rounded-full border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-ink-muted hover:border-ink/30 hover:text-ink-strong transition-colors"
          >
            {t.label}
          </a>
        ))}
      </nav>

      <div className="space-y-2">
        <PageSection
          id="disambiguation"
          divider="none"
          title="Three “events” surfaces — pick the right one"
          description="Metagraphed exposes three unrelated things named “events.” They don't share a store, a shape, or a purpose."
        >
          <EventsCompareTable />
        </PageSection>

        <PageSection
          id="two-store-split"
          title="The two-store split"
          description={
            <>
              Originally a D1 near-real-time hot cache vs. a Postgres deep-history sink. That split
              is narrower than it used to be — read on before assuming D1 is still load-bearing
              here.
            </>
          }
        >
          <div className="space-y-3 text-sm leading-relaxed text-ink">
            <p>
              <ExternalLink href={ADR_0013_URL}>ADR 0013</ExternalLink> originally proposed D1 as a
              near-real-time explorer cache (blocks/extrinsics/account_events, pruned after a few
              days) with Postgres as the durable, unbounded sink feeding a genuinely new tier:{" "}
              <code className="font-mono text-[12px]">chain_events</code>, the raw all-events
              firehose. <ExternalLink href={ADR_0014_URL}>ADR 0014</ExternalLink> (accepted
              2026-07-10, supersedes 0013) is the current, directly-verified snapshot of what
              actually shipped.
            </p>
            <p>
              As of ADR 0014, D1's write paths for{" "}
              <code className="font-mono text-[12px]">blocks</code>,{" "}
              <code className="font-mono text-[12px]">extrinsics</code>, and{" "}
              <code className="font-mono text-[12px]">account_events</code> are retired and those
              tables are dropped in production. Every one of those tiers' serving flags (
              <code className="font-mono text-[12px]">METAGRAPH_BLOCKS_SOURCE</code>,{" "}
              <code className="font-mono text-[12px]">METAGRAPH_EXTRINSICS_SOURCE</code>,{" "}
              <code className="font-mono text-[12px]">METAGRAPH_ACCOUNT_EVENTS_SOURCE</code>) is
              flipped to <code className="font-mono text-[12px]">"postgres"</code> in production,
              read through the same <code className="font-mono text-[12px]">tryPostgresTier()</code>{" "}
              helper and the same <code className="font-mono text-[12px]">DATA_API</code> service
              binding this page's chain-events routes use.
            </p>
            <p>
              So today, the curated explorer views and the deep-history feed both live in Postgres,
              served by the same Worker. What's still genuinely different between them isn't the
              store — it's the <em>table</em>:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                The curated explorer surfaces (
                <code className="font-mono text-[12px]">/blocks/&#123;ref&#125;/events</code>,{" "}
                <code className="font-mono text-[12px]">/accounts/&#123;ss58&#125;/events</code>,{" "}
                <code className="font-mono text-[12px]">/subnets/&#123;netuid&#125;/events</code>)
                read <code className="font-mono text-[12px]">account_events</code> — decoded and
                filtered down to a fixed allowlist of “interesting” kinds (Transfer, NetworkAdded,
                NeuronDeregistered, StakeAdded/Removed, and roughly thirty more), attributed to the
                account(s) involved.
              </li>
              <li>
                The deep-history tier (<code className="font-mono text-[12px]">/chain-events*</code>
                ) reads <code className="font-mono text-[12px]">chain_events</code> — literally
                every pallet.method event the indexer decodes, no kind filtering, no account
                attribution. It never had a D1 form; it's been Postgres-only (TimescaleDB) from day
                one.
              </li>
            </ul>
          </div>
        </PageSection>

        <PageSection
          id="split-brain"
          title="Why the same block can show two different event counts"
          description="Not a bug: two different tables, two different filters, populated by the same indexer."
        >
          <div className="space-y-3 text-sm leading-relaxed text-ink">
            <p>
              <code className="font-mono text-[12px]">
                GET /api/v1/blocks/&#123;n&#125;/chain-events
              </code>{" "}
              (raw, unfiltered <code className="font-mono text-[12px]">chain_events</code>) and{" "}
              <code className="font-mono text-[12px]">
                GET /api/v1/blocks/&#123;ref&#125;/events
              </code>{" "}
              (curated, filtered <code className="font-mono text-[12px]">account_events</code>) can
              legitimately report different counts for the identical block. The curated feed is
              always a subset of the raw one — routine system/consensus events (
              <code className="font-mono text-[12px]">System.ExtrinsicSuccess</code>,{" "}
              <code className="font-mono text-[12px]">TransactionPayment.TransactionFeePaid</code>,
              and similar per-extrinsic bookkeeping) show up in{" "}
              <code className="font-mono text-[12px]">chain-events</code> but were never in scope
              for the curated allowlist.
            </p>
            <p>
              Don't treat a mismatch between the two as a sync bug or evidence of ingestion drift —
              cross-checking them for parity is comparing two different, intentionally-scoped views
              of the same block, not two copies of the same data.
            </p>
          </div>
        </PageSection>

        <PageSection
          id="deployment"
          title="Deployment dependency: the DATA_API binding"
          description="All three routes are a proxy, not a first-party handler in this Worker."
        >
          <div className="space-y-3 text-sm leading-relaxed text-ink">
            <p>
              The main API Worker's{" "}
              <code className="font-mono text-[12px]">handleChainEventsProxy</code> (
              <code className="font-mono text-[12px]">workers/api.mjs</code>) forwards all three
              routes as-is to a separate Cloudflare Worker (
              <code className="font-mono text-[12px]">workers/data-api.mjs</code>, the
              metagraphed-data-api service) over a Worker-to-Worker service binding named{" "}
              <code className="font-mono text-[12px]">DATA_API</code>. That split keeps the
              postgres.js driver and the Hyperdrive-backed Postgres tiers out of the main Worker's
              bundle, which is already near its size budget.
            </p>
            <p>
              There are two distinct failure modes, with two distinct error codes — don't conflate
              them when triaging:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <code className="font-mono text-[12px]">data_tier_unavailable</code> — either this
                Worker's own <code className="font-mono text-[12px]">DATA_API</code> binding isn't
                wired into this deployment (503, checked before any request even reaches the data
                Worker), or the data Worker responded but its body couldn't be parsed as JSON (502,
                an unreadable upstream response).
              </li>
              <li>
                <code className="font-mono text-[12px]">data_query_failed</code> (status mirrors the
                upstream) — the data Worker <em>is</em> reachable and returned readable JSON, but a
                non-2xx status: its own <code className="font-mono text-[12px]">HYPERDRIVE</code>{" "}
                binding is missing (its own 503) or the query errored. The proxy rewraps whatever
                status/message the data Worker returned.
              </li>
            </ul>
            <p>
              All three routes only accept <code className="font-mono text-[12px]">GET</code> (and{" "}
              <code className="font-mono text-[12px]">HEAD</code>, normalized to a{" "}
              <code className="font-mono text-[12px]">GET</code> internally). The proxy doesn't gate
              the method itself — a <code className="font-mono text-[12px]">POST</code> is forwarded
              straight through and comes back as the data Worker's own 405, wrapped as{" "}
              <code className="font-mono text-[12px]">data_query_failed</code> rather than a
              dedicated method-not-allowed code.
            </p>
            <p>
              Every request to any of the three routes is also capped by a shared, per-client-IP
              rate limiter (60 requests / 60s), checked before the tier-availability check above —
              exceeding it returns{" "}
              <code className="font-mono text-[12px]">429 data_rate_limited</code> with a{" "}
              <code className="font-mono text-[12px]">retry-after: 60</code> header.
            </p>
            <CodeBlock
              label="503 · data_tier_unavailable"
              value={JSON.stringify(
                {
                  ok: false,
                  schema_version: 1,
                  data: null,
                  error: {
                    code: "data_tier_unavailable",
                    message: "The all-events data tier is not bound to this deployment.",
                  },
                  meta: { contract_version: "2026-07-10.1" },
                },
                null,
                2,
              )}
            />
          </div>
        </PageSection>

        <PageSection id="get-chain-events" title="GET /api/v1/chain-events">
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink">
              The recent all-events feed, newest first. Optionally scoped to one pallet/method, one
              block, or one extrinsic within a block; keyset-paginated for stable seeking at the
              head of the chain.
            </p>
            <ParamsTable
              rows={[
                {
                  name: "limit",
                  where: "query",
                  type: "integer",
                  def: "50",
                  notes: "1–200. Values outside range clamp rather than error.",
                },
                {
                  name: "pallet",
                  where: "query",
                  type: "string",
                  notes: (
                    <>
                      Optional. Must match{" "}
                      <code className="font-mono text-[11px]">
                        ^[A-Za-z][A-Za-z0-9_]&#123;0,63&#125;$
                      </code>{" "}
                      (1–64 ASCII letters, digits, or underscores, starting with a letter) or the
                      request 400s.
                    </>
                  ),
                },
                {
                  name: "method",
                  where: "query",
                  type: "string",
                  notes: (
                    <>
                      Optional, same pattern as{" "}
                      <code className="font-mono text-[11px]">pallet</code>. Requires{" "}
                      <code className="font-mono text-[11px]">pallet</code> unless{" "}
                      <code className="font-mono text-[11px]">block</code> is also set (avoids an
                      unindexed global scan) — 400s otherwise.
                    </>
                  ),
                },
                {
                  name: "block",
                  where: "query",
                  type: "integer",
                  notes: "Optional. Scopes the feed to one block number.",
                },
                {
                  name: "extrinsic",
                  where: "query",
                  type: "integer",
                  notes: (
                    <>
                      Optional. Only honored when{" "}
                      <code className="font-mono text-[11px]">block</code> is also set — otherwise
                      it's silently ignored, not an error.
                    </>
                  ),
                },
                {
                  name: "cursor",
                  where: "query",
                  type: "string",
                  notes: (
                    <>
                      Opaque{" "}
                      <code className="font-mono text-[11px]">
                        observed_at.block_number.event_index
                      </code>{" "}
                      keyset token from a prior response's{" "}
                      <code className="font-mono text-[11px]">next_cursor</code>. Takes precedence
                      over <code className="font-mono text-[11px]">before</code> when both are sent.
                    </>
                  ),
                },
                {
                  name: "before",
                  where: "query",
                  type: "integer",
                  notes: (
                    <>
                      Legacy <code className="font-mono text-[11px]">block_number</code>-only
                      cursor, kept for existing callers. Prefer{" "}
                      <code className="font-mono text-[11px]">cursor</code> — it can skip same-block
                      events at a page boundary.
                    </>
                  ),
                },
                {
                  name: "format",
                  where: "query",
                  type: '"json" | "csv"',
                  def: "json",
                  notes: (
                    <>
                      <code className="font-mono text-[11px]">csv</code> (or an{" "}
                      <code className="font-mono text-[11px]">Accept: text/csv</code> header)
                      downloads the page's rows as text/csv — block_number, event_index, pallet,
                      method, phase, extrinsic_index, observed_at. The nested{" "}
                      <code className="font-mono text-[11px]">args</code> object has no flat CSV
                      form and is omitted.
                    </>
                  ),
                },
              ]}
            />
            <p className="text-sm leading-relaxed text-ink">
              <strong className="text-ink-strong">Response</strong> —{" "}
              <code className="font-mono text-[12px]">
                &#123; count, next_before, next_cursor, events: ChainEvent[] &#125;
              </code>
              . <code className="font-mono text-[12px]">next_cursor</code> is{" "}
              <code className="font-mono text-[12px]">null</code> once a page comes back shorter
              than <code className="font-mono text-[12px]">limit</code> (no more rows). Each{" "}
              <code className="font-mono text-[12px]">ChainEvent</code> is{" "}
              <code className="font-mono text-[12px]">
                &#123; block_number, event_index, pallet, method, args, phase, extrinsic_index,
                observed_at &#125;
              </code>
              ; <code className="font-mono text-[12px]">args</code> is decoded server-side (account
              fields render as SS58, other 32/20-byte values as 0x-hex) rather than the raw SCALE
              dump; <code className="font-mono text-[12px]">observed_at</code> is epoch
              milliseconds.
            </p>
            <CodeBlock
              label="curl"
              value="curl -s 'https://api.metagraph.sh/api/v1/chain-events?pallet=SubtensorModule&method=NeuronRegistered&limit=5'"
            />
          </div>
        </PageSection>

        <PageSection id="get-chain-events-stats" title="GET /api/v1/chain-events/stats">
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink">
              The pallet.method event-count distribution over a recent block window — an aggregate
              (“what's been happening lately”), not a row-level feed. This is what the MCP{" "}
              <code className="font-mono text-[12px]">get_chain_activity</code> tool mirrors.
            </p>
            <ParamsTable
              rows={[
                {
                  name: "blocks",
                  where: "query",
                  type: "integer",
                  def: "1000",
                  notes: "1–5000, the trailing-block window measured from the current chain tip.",
                },
              ]}
            />
            <p className="text-sm leading-relaxed text-ink">
              <strong className="text-ink-strong">Response</strong> —{" "}
              <code className="font-mono text-[12px]">
                &#123; window_blocks, groups, activity: [&#123; pallet, method, count &#125;] &#125;
              </code>
              . <code className="font-mono text-[12px]">activity</code> is ordered by{" "}
              <code className="font-mono text-[12px]">count</code> descending (ties broken by
              pallet/method for a stable order under Hyperdrive's pooled connections), capped at the
              top 100 groups.
            </p>
            <CodeBlock
              label="curl"
              value="curl -s 'https://api.metagraph.sh/api/v1/chain-events/stats?blocks=500'"
            />
            <p className="text-[12px] text-ink-muted">
              <code className="font-mono text-[11px]">?format=csv</code> has no effect here — this
              route has no top-level row array to export, so a CSV request falls through to the
              normal JSON envelope.
            </p>
          </div>
        </PageSection>

        <PageSection
          id="get-block-chain-events"
          title="GET /api/v1/blocks/{block_number}/chain-events"
        >
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink">
              Every raw event in exactly one block, in natural order. The block-level companion to{" "}
              <code className="font-mono text-[12px]">/api/v1/chain-events?block=</code>.
            </p>
            <ParamsTable
              rows={[
                {
                  name: "block_number",
                  where: "path",
                  type: "integer",
                  notes: (
                    <>
                      Required, digits only (no <code className="font-mono text-[11px]">0x</code>{" "}
                      block-hash form here, unlike{" "}
                      <code className="font-mono text-[11px]">/blocks/&#123;ref&#125;</code>). An
                      unknown or not-yet-backfilled block still returns 200 with an empty{" "}
                      <code className="font-mono text-[11px]">events</code> array — never a 404.
                    </>
                  ),
                },
              ]}
            />
            <p className="text-sm leading-relaxed text-ink">
              <strong className="text-ink-strong">Response</strong> —{" "}
              <code className="font-mono text-[12px]">
                &#123; block_number, count, events: ChainEvent[] &#125;
              </code>
              , <code className="font-mono text-[12px]">events</code> ordered by{" "}
              <code className="font-mono text-[12px]">event_index</code> ascending.
            </p>
            <CodeBlock
              label="curl"
              value="curl -s https://api.metagraph.sh/api/v1/blocks/5000000/chain-events"
            />
          </div>
        </PageSection>

        <PageSection id="mcp" title="Also reachable via MCP">
          <p className="text-sm leading-relaxed text-ink">
            Four MCP tools mirror these routes for AI agents:{" "}
            <code className="font-mono text-[12px]">list_chain_events</code> (
            <code className="font-mono text-[12px]">GET /api/v1/chain-events</code>),{" "}
            <code className="font-mono text-[12px]">get_extrinsic_chain_events</code> (the same
            route scoped by <code className="font-mono text-[12px]">block</code> +{" "}
            <code className="font-mono text-[12px]">extrinsic</code>),{" "}
            <code className="font-mono text-[12px]">get_chain_activity</code> (
            <code className="font-mono text-[12px]">GET /api/v1/chain-events/stats</code>), and{" "}
            <code className="font-mono text-[12px]">get_block_chain_events</code> (
            <code className="font-mono text-[12px]">
              GET /api/v1/blocks/&#123;n&#125;/chain-events
            </code>
            ). The MCP tools call the <code className="font-mono text-[12px]">DATA_API</code> Worker
            directly and return its bare JSON body; the REST routes above wrap the identical data in
            the standard <code className="font-mono text-[12px]">&#123; ok, data, meta &#125;</code>{" "}
            envelope. Both hit the same 503 when the data tier isn't bound.
          </p>
        </PageSection>
      </div>

      <ApiSourceFooter paths={["/api/v1/chain-events", "/api/v1/chain-events/stats"]} />
    </AppShell>
  );
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="mg-label">{label}</span>
        <CopyButton value={value} label={label} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre">
        {value}
      </pre>
    </div>
  );
}

interface ParamRow {
  name: string;
  where: "query" | "path";
  type: string;
  def?: string;
  notes: ReactNode;
}

function ParamsTable({ rows }: { rows: ParamRow[] }) {
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Param</th>
            <th className="px-3 py-2 text-left">Where</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Default</th>
            <th className="px-3 py-2 text-left">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.name} className="align-top">
              <td className="px-3 py-2 font-mono text-[12px] text-ink-strong whitespace-nowrap">
                {r.name}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">{r.where}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted whitespace-nowrap">
                {r.type}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">{r.def ?? "—"}</td>
              <td className="px-3 py-2 text-[12px] text-ink leading-relaxed">{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EventsSurfaceRow {
  route: string;
  store: string;
  realtime: string;
  returns: ReactNode;
}

const EVENTS_SURFACES: EventsSurfaceRow[] = [
  {
    route: "GET /api/v1/events",
    store: "R2 artifact + KV pointer",
    realtime: "SSE, poll-on-reconnect",
    returns: (
      <>
        Not chain data. A thin change feed over the <em>registry's own publish snapshot</em> (build
        pointer + changelog) — one <code className="font-mono text-[11px]">snapshot</code> SSE event
        per (re)connect, 5-minute suggested retry. Answers “did the site's content change,” not “did
        the chain move.”
      </>
    ),
  },
  {
    route: "GET /api/v1/subnets/{netuid}/events",
    store: "Postgres — account_events",
    realtime: "Near-real-time (cache: short)",
    returns: (
      <>
        Curated, decoded events for one subnet: a fixed allowlist of “interesting” kinds (Transfer,
        NetworkAdded, StakeAdded/Removed, …), attributed to the account(s) involved. Originated as a
        D1 tier; now served from the same Postgres instance the deep-history tier uses.
      </>
    ),
  },
  {
    route: "GET /api/v1/chain-events (+ /stats, + /blocks/{n}/chain-events)",
    store: "Postgres (TimescaleDB) — chain_events",
    realtime: "Near-real-time (cache: short), 503 if DATA_API isn't bound",
    returns: (
      <>
        The raw deep-history all-events tier documented on this page: every pallet.method event, no
        kind filtering, no account attribution. Postgres-only from day one — never had a D1
        equivalent.
      </>
    ),
  },
];

function EventsCompareTable() {
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">Route</th>
            <th className="px-3 py-2 text-left">Store</th>
            <th className="px-3 py-2 text-left">Real-time?</th>
            <th className="px-3 py-2 text-left">What it returns</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {EVENTS_SURFACES.map((r) => (
            <tr key={r.route} className="align-top">
              <td className="px-3 py-2 font-mono text-[11px] text-ink-strong whitespace-nowrap">
                {r.route}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted whitespace-nowrap">
                {r.store}
              </td>
              <td className="px-3 py-2 text-[11px] text-ink-muted">{r.realtime}</td>
              <td className="px-3 py-2 text-[12px] text-ink leading-relaxed">{r.returns}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
