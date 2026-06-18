import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { PageSection } from "@/components/metagraphed/page-section";
import { TableState } from "@/components/metagraphed/table-state";
import { IntegrabilityBoard } from "@/components/metagraphed/integrability-board";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { SectionHeading } from "@/components/metagraphed/section-heading";
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
      {
        name: "description",
        content:
          "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo.",
      },
      { property: "og:title", content: "Gaps — Metagraphed" },
      {
        property: "og:description",
        content:
          "Registry gaps, profile completeness, adapter candidates, and enrichment priorities. Corrections via the public repo.",
      },
    ],
  }),
  component: GapsPage,
});

function GapsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Operations"
        live
        title="Registry gaps"
        description="Public read-only view of missing resources and enrichment priorities. Submit corrections through the GitHub repo."
        actions={
          <ExternalLink href={GITHUB_REPO} className="text-xs">
            github
          </ExternalLink>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-16 w-full" />}>
          <GapsKpiStrip />
        </Suspense>
      </QueryErrorBoundary>
      <div className="mt-6 space-y-section">
        <section>
          <SectionHeading title="Integrability scoreboard" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <IntegrabilityBoard />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <PageSection
          id="open-gaps"
          eyebrow="Open gaps"
          title="Missing evidence, by priority"
          description="Public read-only view of outstanding registry gaps."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <GapsList />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>
        <section className="grid gap-6 lg:grid-cols-2">
          <PageSection
            id="profile-completeness"
            eyebrow="Coverage"
            title="Profile completeness"
            description="Per-subnet completeness across required public-interface kinds."
          >
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <CompletenessList />
              </Suspense>
            </QueryErrorBoundary>
          </PageSection>
          <PageSection
            id="adapter-candidates"
            eyebrow="Pilots"
            title="Adapter candidates"
            description="Subnets where a maintained adapter would unlock the highest registry value."
          >
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <AdapterCandidates />
              </Suspense>
            </QueryErrorBoundary>
          </PageSection>
        </section>
        <PageSection
          id="enrichment-queue"
          eyebrow="Queue"
          title="Enrichment queue"
          description="Prioritized list of registry entries awaiting verification or enrichment."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <EnrichmentQueue />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>
      </div>
      <ApiSourceFooter
        paths={[
          "/api/v1/gaps",
          "/api/v1/review/profile-completeness",
          "/api/v1/review/adapter-candidates",
          "/api/v1/review/enrichment-queue",
        ]}
      />
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
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No open gaps"
        description="The registry has no outstanding gaps right now."
        cta={{ label: "Suggest on GitHub", href: GITHUB_REPO, external: true }}
        generatedAt={data.meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-2">
      {rows.map((g) => (
        <li key={g.id} className="rounded border border-border bg-card p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${severityCls(g.severity)}`}
                >
                  {g.severity ?? "low"}
                </span>
                {g.category ? (
                  <span className="font-mono text-[10px] uppercase text-ink-muted">
                    {g.category}
                  </span>
                ) : null}
                {g.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: g.netuid }}
                    className="font-mono text-[10px] text-ink-muted hover:text-ink-strong"
                  >
                    SN{g.netuid}
                  </Link>
                ) : null}
              </div>
              <div className="font-medium text-ink-strong">{g.title ?? g.id}</div>
              {g.description ? (
                <p className="mt-1 text-xs text-ink-muted">{g.description}</p>
              ) : null}
              {g.suggested_action ? (
                <p className="mt-1 text-xs text-ink">↳ {g.suggested_action}</p>
              ) : null}
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
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No completeness data"
        description="Completeness scores will appear here once profiles are scored."
        cta={{ label: "Browse subnets", href: "/subnets" }}
        generatedAt={data.meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, 20).map((r) => (
        <li
          key={r.netuid}
          className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2"
        >
          <Link
            to="/subnets/$netuid"
            params={{ netuid: r.netuid }}
            className="font-mono text-[11px] text-ink-muted hover:text-ink-strong w-12"
          >
            SN{r.netuid}
          </Link>
          <div className="flex-1 h-1.5 rounded bg-surface overflow-hidden">
            <div
              className="h-full bg-ink-strong"
              style={{ width: `${Math.round((r.completeness ?? 0) * 100)}%` }}
            />
          </div>
          <span className="font-mono text-[11px] text-ink-strong w-10 text-right">
            {Math.round((r.completeness ?? 0) * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function AdapterCandidates() {
  const { data } = useSuspenseQuery(reviewAdapterCandidatesQuery());
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No adapter candidates"
        description="Adapter candidates appear once a subnet has enough public surface area to warrant one."
        cta={{ label: "Suggest on GitHub", href: GITHUB_REPO, external: true }}
        generatedAt={data.meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li
          key={`${r.netuid}-${i}`}
          className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2"
        >
          <Link
            to="/subnets/$netuid"
            params={{ netuid: r.netuid }}
            className="font-mono text-[11px] text-ink-muted hover:text-ink-strong w-12"
          >
            SN{r.netuid}
          </Link>
          <span className="flex-1 text-xs text-ink">{r.reason ?? "—"}</span>
          {r.score != null ? (
            <span className="font-mono text-[11px] text-ink-strong">{r.score.toFixed(2)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function EnrichmentQueue() {
  const { data } = useSuspenseQuery(reviewEnrichmentQueueQuery());
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="Queue is empty"
        description="Nothing is currently awaiting enrichment."
        cta={{ label: "Browse registry", href: "/subnets" }}
        generatedAt={data.meta?.generated_at}
      />
    );
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
                {r.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: r.netuid }}
                    className="hover:text-ink-strong"
                  >
                    SN{r.netuid}
                  </Link>
                ) : (
                  "—"
                )}
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

function GapsKpiStrip() {
  const gaps = useSuspenseQuery(gapsQuery()).data.data as Gap[] | undefined;
  const completeness = useSuspenseQuery(reviewProfileCompletenessQuery()).data.data ?? [];
  const queue = useSuspenseQuery(reviewEnrichmentQueueQuery()).data.data ?? [];
  const rows = gaps ?? [];
  const high = rows.filter((g) => g.severity === "high").length;
  const medium = rows.filter((g) => g.severity === "medium").length;
  const avgComp =
    completeness.length > 0
      ? Math.round(
          (completeness.reduce((a, r) => a + (r.completeness ?? 0), 0) / completeness.length) * 100,
        )
      : null;
  const stats: Array<{ label: string; value: string; tone?: string }> = [
    { label: "Open gaps", value: String(rows.length) },
    { label: "High severity", value: String(high), tone: high ? "text-health-down" : undefined },
    { label: "Medium", value: String(medium), tone: medium ? "text-health-warn" : undefined },
    { label: "Avg completeness", value: avgComp != null ? `${avgComp}%` : "—" },
    { label: "Queue depth", value: String(queue.length) },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="rounded border border-border bg-card p-3">
          <div className="mg-label">{s.label}</div>
          <div
            className={`font-display text-xl font-semibold tabular-nums ${s.tone ?? "text-ink-strong"}`}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}
