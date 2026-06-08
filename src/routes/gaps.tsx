import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  gapsQuery,
  reviewProfileCompletenessQuery,
  reviewAdapterCandidatesQuery,
  reviewEnrichmentQueueQuery,
} from "@/lib/metagraphed/queries";
import { GITHUB_REPO } from "@/lib/metagraphed/config";
import type { Gap } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/gaps")({
  head: () => ({
    meta: [
      { title: "Gaps — Metagraphed" },
      { name: "description", content: "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo." },
    ],
  }),
  component: GapsPage,
});

function GapsPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Operations"
        title="Registry gaps"
        description="Public read-only view of missing resources and enrichment priorities. Submit corrections through the GitHub repo."
        right={<ExternalLink href={GITHUB_REPO} className="text-xs">github</ExternalLink>}
      />
      <div className="space-y-8">
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Open gaps</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <GapsList />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Profile completeness</h2>
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <CompletenessList />
              </Suspense>
            </QueryErrorBoundary>
          </div>
          <div>
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Adapter candidates</h2>
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <AdapterCandidates />
              </Suspense>
            </QueryErrorBoundary>
          </div>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">Enrichment queue</h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <EnrichmentQueue />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter paths={["/api/v1/gaps", "/api/v1/review/profile-completeness", "/api/v1/review/adapter-candidates", "/api/v1/review/enrichment-queue"]} />
    </AppShell>
  );
}

function severityCls(s?: string) {
  if (s === "high") return "border-health-down/30 bg-health-down/5 text-health-down";
  if (s === "medium") return "border-health-warn/30 bg-health-warn/5 text-health-warn";
  return "border-border bg-paper text-ink-muted";
}

function GapsList() {
  const { data } = useSuspenseQuery(gapsQuery());
  const rows = (data.data ?? []) as Gap[];
  if (rows.length === 0) return <EmptyState title="No open gaps" />;
  return (
    <ul className="space-y-2">
      {rows.map((g) => (
        <li key={g.id} className="rounded border border-border bg-card p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${severityCls(g.severity)}`}>
                  {g.severity ?? "low"}
                </span>
                {g.category ? <span className="font-mono text-[10px] uppercase text-ink-muted">{g.category}</span> : null}
                {g.netuid != null ? (
                  <Link to="/subnets/$netuid" params={{ netuid: String(g.netuid) }} className="font-mono text-[10px] text-ink-muted hover:text-ink-strong">SN{g.netuid}</Link>
                ) : null}
              </div>
              <div className="font-medium text-ink-strong">{g.title ?? g.id}</div>
              {g.description ? <p className="mt-1 text-xs text-ink-muted">{g.description}</p> : null}
              {g.suggested_action ? <p className="mt-1 text-xs text-ink">↳ {g.suggested_action}</p> : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CompletenessList() {
  const { data } = useSuspenseQuery(reviewProfileCompletenessQuery());
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="No completeness data" />;
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, 20).map((r) => (
        <li key={r.netuid} className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2">
          <Link to="/subnets/$netuid" params={{ netuid: String(r.netuid) }} className="font-mono text-[11px] text-ink-muted hover:text-ink-strong w-12">SN{r.netuid}</Link>
          <div className="flex-1 h-1.5 rounded bg-surface overflow-hidden">
            <div className="h-full bg-ink-strong" style={{ width: `${Math.round((r.completeness ?? 0) * 100)}%` }} />
          </div>
          <span className="font-mono text-[11px] text-ink-strong w-10 text-right">{Math.round((r.completeness ?? 0) * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

function AdapterCandidates() {
  const { data } = useSuspenseQuery(reviewAdapterCandidatesQuery());
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="No adapter candidates" />;
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={`${r.netuid}-${i}`} className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2">
          <Link to="/subnets/$netuid" params={{ netuid: String(r.netuid) }} className="font-mono text-[11px] text-ink-muted hover:text-ink-strong w-12">SN{r.netuid}</Link>
          <span className="flex-1 text-xs text-ink">{r.reason ?? "—"}</span>
          {r.score != null ? <span className="font-mono text-[11px] text-ink-strong">{r.score.toFixed(2)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function EnrichmentQueue() {
  const { data } = useSuspenseQuery(reviewEnrichmentQueueQuery());
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="Queue is empty" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left">ID</th>
            <th className="px-3 py-2 text-left">Netuid</th>
            <th className="px-3 py-2 text-left">Priority</th>
            <th className="px-3 py-2 text-left">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">{r.id}</td>
              <td className="px-3 py-2 font-mono text-[11px]">
                {r.netuid != null ? <Link to="/subnets/$netuid" params={{ netuid: String(r.netuid) }} className="hover:text-ink-strong">SN{r.netuid}</Link> : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{r.priority ?? "—"}</td>
              <td className="px-3 py-2 text-[12px] text-ink-muted">{r.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
