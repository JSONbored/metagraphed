import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyButton, PageHero, SectionHeading } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import {
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOKS_BASE_PATH,
  WEBHOOK_ENDPOINTS,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE,
  WEBHOOK_FILTER_FIELDS,
  WEBHOOK_IDEMPOTENCY_HEADER,
  WEBHOOK_MAX_DELIVERY_ROUNDS,
  WEBHOOK_REDELIVERY_MAX_MS,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TTL_SECONDS,
  buildWebhookCurlExample,
  webhookRedeliveryDelaySeconds,
} from "@/lib/metagraphed/webhooks-docs";

export const Route = createFileRoute("/webhooks")({
  head: () => ({
    meta: [
      { title: "Webhooks — Metagraphed" },
      {
        name: "description",
        content:
          "Metagraphed change-feed webhooks — subscribe an HTTPS endpoint to registry publish events, HMAC-SHA256 signed, with netuid/kind filters and at-least-once redelivery.",
      },
      { property: "og:title", content: "Webhooks — Metagraphed" },
      {
        property: "og:description",
        content:
          "POST/GET/DELETE subscription management, signature verification, filter syntax, and the exponential redelivery schedule for the change-feed webhook contract.",
      },
    ],
  }),
  component: WebhooksDocsPage,
});

const SUBSCRIPTIONS_URL = `${API_BASE}${WEBHOOKS_BASE_PATH}`;
const CURL_EXAMPLE = buildWebhookCurlExample(DEFAULT_API_BASE);
const TTL_DAYS = WEBHOOK_TTL_SECONDS / 60 / 60 / 24;
const REDELIVERY_MAX_HOURS = WEBHOOK_REDELIVERY_MAX_MS / 1000 / 60 / 60;

function WebhooksDocsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="API"
        title="Webhooks"
        description="Subscribe an HTTPS endpoint to the registry's publish change feed — HMAC-SHA256 signed POSTs, filtered by subnet or change kind, delivered at-least-once with exponential-backoff redelivery. Mutations require a shared subscription token."
      />

      <div className="mt-6 space-y-section" data-testid="webhooks-docs">
        <section>
          <SectionHeading
            title="Endpoints"
            intro="Subscriptions live under one base path. Create with a token, read or delete with the subscription's own secret."
          />
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  POST
                </div>
                <code className="mt-0.5 block overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink-strong">
                  {SUBSCRIPTIONS_URL}
                </code>
              </div>
              <CopyButton value={SUBSCRIPTIONS_URL} label="webhook subscriptions URL" />
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    <th className="px-3 py-2.5 font-normal">Method</th>
                    <th className="px-3 py-2.5 font-normal">Path</th>
                    <th className="px-3 py-2.5 font-normal">Summary</th>
                    <th className="px-3 py-2.5 font-normal">Auth</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {WEBHOOK_ENDPOINTS.map((endpoint) => (
                    <tr key={`${endpoint.method} ${endpoint.path}`} className="align-top">
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-strong">
                        {endpoint.method}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-strong">
                        {endpoint.path}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-ink">{endpoint.summary}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                        {endpoint.auth}
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
            title="Request & response shape"
            intro="POST body accepts a public https:// url, optional netuid/kind filters, and an optional caller-supplied secret."
          />
          <div className="space-y-2 text-[12px] leading-relaxed text-ink">
            <p>
              <code className="font-mono text-[11px] text-ink-strong">POST</code> body —{" "}
              <code className="font-mono text-[11px]">
                &#123; url: string, filters?: &#123; netuids?, kinds? &#125;, secret?: string &#125;
              </code>
              . <code className="font-mono text-[11px]">url</code> must be a public{" "}
              <code className="font-mono text-[11px]">https://</code> URL — no credentials, no
              private/loopback/link-local hosts, default port only.{" "}
              <code className="font-mono text-[11px]">secret</code> is optional (16-256 characters);
              a server-generated one is used when omitted. Body is capped at{" "}
              {MAX_WEBHOOK_BODY_BYTES} bytes.
            </p>
            <p>
              <code className="font-mono text-[11px] text-ink-strong">201</code> response —{" "}
              <code className="font-mono text-[11px]">
                &#123; id, url, filters, secret, active, created_at, delivery &#125;
              </code>
              . <code className="font-mono text-[11px]">secret</code> is returned once, at creation,
              and never echoed back by <code className="font-mono text-[11px]">GET</code>. Store it
              — it's required to verify delivery signatures and to delete the subscription.
            </p>
            <p>
              <code className="font-mono text-[11px] text-ink-strong">GET</code> response —{" "}
              <code className="font-mono text-[11px]">
                &#123; id, url, filters, created_at, active, delivery &#125;
              </code>
              , where <code className="font-mono text-[11px]">delivery</code> summarizes recent
              redelivery health:{" "}
              <code className="font-mono text-[11px]">
                &#123; status, pending, dead_letter, last_failure &#125;
              </code>
              .
            </p>
            <p>
              <code className="font-mono text-[11px] text-ink-strong">DELETE</code> response —{" "}
              <code className="font-mono text-[11px]">&#123; id, deleted: true &#125;</code>.
              Dormant subscriptions also self-expire after {TTL_DAYS} days.
            </p>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Signature verification"
            intro="Every delivery is a signed POST. Verify the HMAC before trusting the body, and dedupe retries with the idempotency key."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Header</th>
                  <th className="px-3 py-2.5 font-normal">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr className="align-top">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                    {WEBHOOK_SIGNATURE_HEADER}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-muted">
                    Hex-encoded HMAC-SHA256 of the raw request body, keyed by your subscription
                    secret.
                  </td>
                </tr>
                <tr className="align-top">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                    {WEBHOOK_TIMESTAMP_HEADER}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-muted">
                    ISO-8601 timestamp of the delivery attempt.
                  </td>
                </tr>
                <tr className="align-top">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                    {WEBHOOK_EVENT_ID_HEADER}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-muted">
                    Stable id derived from the event body's content — identical across every
                    (re)delivery of that event, to every subscriber.
                  </td>
                </tr>
                <tr className="align-top">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                    {WEBHOOK_IDEMPOTENCY_HEADER}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-muted">
                    Key scoped to one subscription and one event — identical across retries and
                    redeliveries, so a subscriber can dedupe the at-least-once delivery.
                  </td>
                </tr>
                <tr className="align-top">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                    {WEBHOOK_SECRET_HEADER}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-muted">
                    Not sent on delivery — this is what you send back to{" "}
                    <code className="font-mono text-[11px]">DELETE</code> a subscription, to prove
                    ownership.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink">
            Verify by recomputing the HMAC-SHA256 of the exact raw body (before any JSON
            re-serialization) with your secret and comparing it, in constant time, to{" "}
            {WEBHOOK_SIGNATURE_HEADER}. Every delivery's{" "}
            <code className="font-mono text-[11px]">type</code> field is{" "}
            <code className="font-mono text-[11px]">"{WEBHOOK_EVENT_TYPE}"</code>.
          </p>
        </section>

        <section>
          <SectionHeading
            title="Filters"
            intro="Both facets narrow independently; an omitted facet means no restriction on that axis, while an explicit empty array matches nothing."
          />
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-paper/40 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  <th className="px-3 py-2.5 font-normal">Field</th>
                  <th className="px-3 py-2.5 font-normal">Type</th>
                  <th className="px-3 py-2.5 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {WEBHOOK_FILTER_FIELDS.map((row) => (
                  <tr key={row.field} className="align-top">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ink-strong">
                      {row.field}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] text-ink">
                      {row.type}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-muted">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionHeading
            title="Retry & delivery"
            intro="Delivery is at-least-once. A transient failure is parked and redelivered with exponential backoff, then dead-lettered."
          />
          <div className="space-y-2 text-[12px] leading-relaxed text-ink">
            <p>
              A parked delivery becomes due{" "}
              <code className="font-mono text-[11px]">min(base * 2^(round-1), max)</code> after its
              last attempt — {webhookRedeliveryDelaySeconds(1) / 60} min after round 1, doubling
              each round, capped at {REDELIVERY_MAX_HOURS}h. After {WEBHOOK_MAX_DELIVERY_ROUNDS}{" "}
              failed rounds, or on a deterministic 4xx rejection (redirects included), the delivery
              dead-letters — check a subscription's{" "}
              <code className="font-mono text-[11px]">delivery.status</code> via{" "}
              <code className="font-mono text-[11px]">GET</code>. Network errors, timeouts, 5xx, and
              429 are retried; other 4xx responses are not.
            </p>
            <p>
              Parked deliveries self-clean after {TTL_DAYS} days, the same horizon dormant
              subscriptions use.
            </p>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Example — create a subscription
              </div>
              <CopyButton value={CURL_EXAMPLE} label="webhooks curl example" />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-strong">
              {CURL_EXAMPLE}
            </pre>
          </div>
          <p className="mt-3 font-mono text-[11px] text-ink-muted">
            Watch the same publish moment as an SSE stream instead of subscribing:{" "}
            <code className="font-mono text-[11px]">GET /api/v1/events</code>. Poll the same changes
            as a feed:{" "}
            <Link to="/feeds" className="text-accent hover:underline">
              Feeds
            </Link>
            .
          </p>
        </section>
      </div>

      <ApiSourceFooter paths={["/api/v1/webhooks/subscriptions"]} />
    </AppShell>
  );
}
