import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import {
  ExternalLink,
  TableState,
  PageSection,
  SectionHeading,
  MethodologyCallout,
  BrandIcon,
  CurationChip,
  StatWithSpark,
  MiniStack,
  MiniRadial,
} from "@jsonbored/ui-kit";
import { AsyncPanel, PageMasthead, Panel } from "@/components/metagraphed/primitives";
import { ResetFiltersButton } from "@/components/metagraphed/table-controls";
import { X, Search } from "lucide-react";
import { IntegrabilityBoard } from "@/components/metagraphed/integrability-board";
import {
  CoverageMatrix,
  CompletenessHistogram,
} from "@/components/metagraphed/analytics/coverage-matrix";
import {
  gapsQuery,
  reviewProfileCompletenessQuery,
  reviewAdapterCandidatesQuery,
  reviewEnrichmentQueueQuery,
  reviewEnrichmentTargetsQuery,
  reviewEnrichmentEvidenceQuery,
  reviewGapPrioritiesQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { GITHUB_REPO } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";
import { StateBlock } from "@/components/metagraphed/states/state-block";
import type { CurationLevel, Gap, Subnet } from "@/lib/metagraphed/types";

const STATUS_OPTIONS = ["all", "open", "in-review", "resolved", "wont-fix"] as const;
const TARGET_OPTIONS = [
  "all",
  "native",
  "candidate-discovered",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const MISSING_KINDS = [
  "docs",
  "repo",
  "openapi",
  "endpoint",
  "dashboard",
  "data",
  "sdk",
  "example",
  "rpc",
] as const;
const SORT_OPTIONS = ["priority", "netuid", "updated"] as const;

const searchSchema = z.object({
  status: fallback(z.enum(STATUS_OPTIONS), "all").default("all"),
  target: fallback(z.enum(TARGET_OPTIONS), "all").default("all"),
  missing: fallback(z.string(), "").default(""), // comma-separated
  q: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(SORT_OPTIONS), "priority").default("priority"),
});

export const Route = createFileRoute("/gaps")({
  validateSearch: zodValidator(searchSchema),
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
      <PageMasthead
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

      <main className="space-y-20 md:space-y-24">
        <AsyncPanel height="sm">
          <GapsKpiStrip />
        </AsyncPanel>

        <AsyncPanel height="md">
          <MissingKindsAtAGlance />
        </AsyncPanel>

        <AsyncPanel height="sm">
          <GapsMethodology />
        </AsyncPanel>

        <section>
          <SectionHeading title="Integrability scoreboard" />
          <AsyncPanel height="lg">
            <IntegrabilityBoard />
          </AsyncPanel>
        </section>

        <PageSection
          id="coverage-matrix"
          eyebrow="Coverage"
          title="What's actually missing"
          description="Subnets × required public-interface kinds. Cells link straight to that subnet's surfaces tab."
        >
          <AsyncPanel height="lg">
            <CoverageMatrix />
          </AsyncPanel>
        </PageSection>

        <PageSection
          id="completeness-distribution"
          eyebrow="Distribution"
          title="Registry shape"
          description="Histogram of completeness across every scored profile. Median and quartile markers show where the registry sits today."
        >
          <AsyncPanel height="md">
            <CompletenessHistogram />
          </AsyncPanel>
        </PageSection>

        <AsyncPanel height="lg">
          <OpenGapsSection />
        </AsyncPanel>

        <PageSection
          id="profile-completeness"
          eyebrow="Coverage"
          title="Profile completeness"
          description="Per-subnet completeness across required public-interface kinds."
        >
          <AsyncPanel height="md">
            <CompletenessList />
          </AsyncPanel>
        </PageSection>

        <PageSection
          id="adapter-candidates"
          eyebrow="Pilots"
          title="Adapter candidates"
          description="Subnets where a maintained adapter would unlock the highest registry value."
        >
          <AsyncPanel height="md">
            <AdapterCandidates />
          </AsyncPanel>
        </PageSection>

        <PageSection
          id="enrichment-queue"
          eyebrow="Queue"
          title="Enrichment queue"
          description="Prioritized list of registry entries awaiting verification or enrichment."
        >
          <AsyncPanel height="md">
            <EnrichmentQueue />
          </AsyncPanel>
        </PageSection>

        <PageSection
          id="enrichment-targets"
          eyebrow="Targets"
          title="Enrichment targets"
          description="Per-target contributor task board — the specific surfaces to add per subnet, ranked by priority."
        >
          <AsyncPanel height="md">
            <EnrichmentTargets />
          </AsyncPanel>
        </PageSection>

        <PageSection
          id="enrichment-evidence"
          eyebrow="Evidence"
          title="Enrichment evidence"
          description="The detailed candidate evidence behind the enrichment queue — one level down from the summary above."
        >
          <AsyncPanel height="md">
            <EnrichmentEvidence />
          </AsyncPanel>
        </PageSection>

        <PageSection
          id="gap-priorities"
          eyebrow="Priorities"
          title="Gap priorities"
          description="Priority-scored per-subnet gap board — ranked separately from the interface-facet gaps above."
        >
          <AsyncPanel height="md">
            <GapPriorityList />
          </AsyncPanel>
        </PageSection>
      </main>

      <ApiSourceFooter
        paths={[
          "/api/v1/gaps",
          "/api/v1/review/profile-completeness",
          "/api/v1/review/adapter-candidates",
          "/api/v1/review/enrichment-queue",
          "/api/v1/review/enrichment-targets",
          "/api/v1/review/enrichment-evidence",
          "/api/v1/review/gaps",
        ]}
      />
    </AppShell>
  );
}

/* --------------------------- KPI strip --------------------------- */

function GapsKpiStrip() {
  const gapsRes = useSuspenseQuery(gapsQuery()).data;
  const completenessRes = useSuspenseQuery(reviewProfileCompletenessQuery()).data;
  const queueRes = useSuspenseQuery(reviewEnrichmentQueueQuery()).data;
  const adaptersRes = useSuspenseQuery(reviewAdapterCandidatesQuery()).data;
  const gaps = (gapsRes.data ?? []) as Gap[];
  const completeness = completenessRes.data ?? [];
  const queue = queueRes.data ?? [];
  const adapters = adaptersRes.data ?? [];

  const high = gaps.filter((g) => g.severity === "high").length;
  const medium = gaps.filter((g) => g.severity === "medium").length;
  const low = gaps.filter((g) => !g.severity || g.severity === "low").length;
  const avgComp =
    completeness.length > 0
      ? Math.round(
          (completeness.reduce((a, r) => a + (r.completeness ?? 0), 0) / completeness.length) * 100,
        )
      : null;
  // Below-50% subnets distribution for the queue tile.
  const below50 = completeness.filter((r) => (r.completeness ?? 0) < 0.5).length;
  const above75 = completeness.filter((r) => (r.completeness ?? 0) >= 0.75).length;

  return (
    <Panel
      as="div"
      flush
      bodyClassName="grid grid-cols-2 md:grid-cols-5 divide-x divide-border overflow-hidden"
    >
      <StatWithSpark
        label="Open gaps"
        value={gaps.length}
        full="Outstanding registry gaps across all subnets, split by severity."
        hint={`${high} high · ${medium} med · ${low} low`}
        updatedAt={gapsRes.meta?.generated_at}
        viz={
          <MiniStack
            segments={[
              { label: "high", value: high, color: "var(--health-down)" },
              { label: "med", value: medium, color: "var(--health-warn)" },
              { label: "low", value: low, color: "var(--ink-subtle)" },
            ]}
          />
        }
      />
      <StatWithSpark
        label="High severity"
        value={high}
        tone={high > 0 ? "down" : "default"}
        hint={high === 0 ? "none open" : "needs attention"}
        full="Count of gaps marked `high` — these are blocking registry curation."
        updatedAt={gapsRes.meta?.generated_at}
      />
      <StatWithSpark
        label="Avg completeness"
        value={avgComp != null ? `${avgComp}%` : "—"}
        tone={
          avgComp != null && avgComp >= 75
            ? "ok"
            : avgComp != null && avgComp < 50
              ? "warn"
              : "default"
        }
        hint={`${completeness.length} scored`}
        full="Mean profile completeness across all scored subnets. Updated when the review pipeline reruns."
        updatedAt={completenessRes.meta?.generated_at}
        viz={
          <div className="flex items-center gap-2">
            <MiniRadial value={avgComp != null ? avgComp / 100 : 0} size={20} stroke={3} />
            <span className="font-mono text-[9.5px] text-ink-muted truncate">
              {above75} ≥75% · {below50} &lt;50%
            </span>
          </div>
        }
      />
      <StatWithSpark
        label="Adapter candidates"
        value={adapters.length}
        hint="prioritized leads"
        full="Subnets where a maintained adapter would unlock the most registry value."
        updatedAt={adaptersRes.meta?.generated_at}
      />
      <StatWithSpark
        label="Queue depth"
        value={queue.length}
        hint="awaiting enrichment"
        full="Items the enrichment pipeline has flagged for human review or re-probe."
        updatedAt={queueRes.meta?.generated_at}
      />
    </Panel>
  );
}

/**
 * Horizontal "missing kinds at a glance" bar — the registry shows you
 * which kinds (docs/repo/openapi/...) are missing across the most subnets.
 * Click a row to filter the open-gaps section by that kind.
 */
function MissingKindsAtAGlance() {
  const gapsRes = useSuspenseQuery(gapsQuery()).data;
  const rows = (gapsRes.data ?? []) as Gap[];
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const activeMissing = useMemo<Set<string>>(
    () => new Set((search.missing ?? "").split(",").filter(Boolean)),
    [search.missing],
  );

  const counts = useMemo(() => {
    // Bind to the real per-row missing kinds (data.gaps[].gaps.missing_kinds),
    // preserved by normalizeGap — not the curation_level in g.category.
    const m = new Map<string, number>();
    for (const g of rows) {
      for (const k of g.missing_kinds ?? []) {
        const key = k.toLowerCase();
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const max = counts.reduce((a, [, v]) => Math.max(a, v), 0) || 1;
  if (counts.length === 0) return null;

  const focusOpenGaps = () => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      document.getElementById("open-gaps")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <PageSection
      id="missing-kinds"
      eyebrow="At a glance"
      title="Missing kinds across the registry"
      description="Click a row to filter the open-gaps section by that resource kind and jump straight to it."
    >
      <ul className="rounded-xl border border-border bg-card divide-y divide-border">
        {counts.map(([k, n]) => {
          const isActive = activeMissing.has(k);
          const pct = Math.max(2, Math.round((n / max) * 100));
          return (
            <li key={k} className={isActive ? "bg-primary-soft/40" : undefined}>
              <button
                type="button"
                onClick={() => {
                  // Toggle k into the existing multi-select (matching the
                  // Open-gaps panel's additive-Set logic) instead of
                  // overwriting it with a single kind (#6582). Only snap
                  // status/sort to the "open by priority" view on a fresh jump
                  // (nothing previously selected) -- an in-progress multi-select
                  // keeps the user's own status/sort choices.
                  const next = new Set(activeMissing);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  const wasEmpty = activeMissing.size === 0;
                  navigate({
                    search: (prev: Record<string, unknown>) =>
                      ({
                        ...prev,
                        missing: Array.from(next).join(","),
                        ...(wasEmpty ? { status: "open", sort: "priority" } : {}),
                      }) as never,
                    replace: true,
                  });
                  focusOpenGaps();
                }}
                className={classNames(
                  "grid w-full grid-cols-[80px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors focus:outline-none",
                  isActive
                    ? "ring-1 ring-inset ring-accent/60"
                    : "hover:bg-surface/40 focus-visible:bg-surface/60",
                )}
                aria-pressed={isActive}
                aria-label={`Filter open gaps by ${k}, ${n} subnets missing this kind`}
              >
                <span
                  className={classNames(
                    "mg-type-micro text-[10px]",
                    isActive ? "text-accent" : "text-ink-strong",
                  )}
                >
                  {k}
                </span>
                <span
                  className={classNames(
                    "h-2 rounded-full transition-colors",
                    isActive ? "bg-accent" : "bg-health-warn/70",
                  )}
                  style={{ width: `${pct}%` }}
                  aria-hidden
                />
                <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                  {n} subnets
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {activeMissing.size > 0 ? (
        <div className="mg-type-micro mt-2 flex flex-wrap items-center gap-2 text-[10px] text-ink-muted">
          <span>filtered by:</span>
          {Array.from(activeMissing).map((k) => (
            <span
              key={k}
              className="inline-flex h-5 items-center rounded-full border border-accent/40 bg-primary-soft px-2 text-accent"
            >
              {k}
            </span>
          ))}
          <button
            type="button"
            onClick={() =>
              navigate({
                search: (prev: Record<string, unknown>) => ({ ...prev, missing: "" }) as never,
                replace: true,
              })
            }
            className="ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> clear
          </button>
        </div>
      ) : null}
    </PageSection>
  );
}

function GapsMethodology() {
  const gapsRes = useSuspenseQuery(gapsQuery()).data;
  return <MethodologyCallout generatedAt={gapsRes.meta?.generated_at} windowLabel="snapshot" />;
}

/* --------------------------- Open gaps + filters --------------------------- */

function OpenGapsSection() {
  const { data: gapsRes } = useSuspenseQuery(gapsQuery());
  const data = gapsRes;
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  const subnetById = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);
  const rows = (data.data ?? []) as Gap[];
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const setSearch = (patch: Partial<typeof search>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
      replace: true,
    });

  const missingSet = useMemo<Set<string>>(
    () => new Set(search.missing ? search.missing.split(",").filter(Boolean) : []),
    [search.missing],
  );

  const filtered = useMemo(() => {
    const needle = search.q.trim().toLowerCase();
    return rows.filter((g) => {
      const status = (g as Record<string, unknown>).status as string | undefined;
      if (search.status !== "all" && (status ?? "open") !== search.status) return false;
      const target = (g as Record<string, unknown>).target_curation as CurationLevel | undefined;
      if (search.target !== "all" && target !== search.target) return false;
      if (missingSet.size > 0) {
        const kinds = (g.missing_kinds ?? []).map((k) => k.toLowerCase());
        const has = Array.from(missingSet).some((m) => kinds.includes(String(m).toLowerCase()));
        if (!has) return false;
      }
      if (!needle) return true;
      return [g.title, g.description, g.category, g.suggested_action, String(g.netuid ?? "")]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [rows, search.status, search.target, search.q, missingSet]);

  const sorted = useMemo(() => {
    const sevRank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const arr = [...filtered];
    if (search.sort === "priority") {
      arr.sort((a, b) => (sevRank[a.severity ?? "low"] ?? 3) - (sevRank[b.severity ?? "low"] ?? 3));
    } else if (search.sort === "netuid") {
      arr.sort((a, b) => (a.netuid ?? 1e9) - (b.netuid ?? 1e9));
    } else {
      arr.sort((a, b) => {
        const at = Date.parse(((a as Record<string, unknown>).updated_at as string) ?? "") || 0;
        const bt = Date.parse(((b as Record<string, unknown>).updated_at as string) ?? "") || 0;
        return bt - at;
      });
    }
    return arr;
  }, [filtered, search.sort]);

  const hasFilters =
    search.status !== "all" ||
    search.target !== "all" ||
    missingSet.size > 0 ||
    !!search.q ||
    search.sort !== "priority";

  const toolbar = (
    <>
      <div className="relative flex-1 min-w-[180px] max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
        <input
          value={search.q}
          onChange={(e) => setSearch({ q: e.target.value })}
          placeholder="Search title, description, netuid…"
          className="w-full rounded-full border border-border bg-card pl-8 pr-3 py-1.5 text-[12px] focus:outline-none focus:border-accent/50"
          aria-label="Search gaps"
        />
      </div>
      <FilterSelect
        label="Status"
        value={search.status}
        onChange={(v) => setSearch({ status: v as typeof search.status })}
        options={STATUS_OPTIONS as readonly string[]}
      />
      <FilterSelect
        label="Target"
        value={search.target}
        onChange={(v) => setSearch({ target: v as typeof search.target })}
        options={TARGET_OPTIONS as readonly string[]}
      />
      <FilterSelect
        label="Sort"
        value={search.sort}
        onChange={(v) => setSearch({ sort: v as typeof search.sort })}
        options={SORT_OPTIONS as readonly string[]}
      />
      <ResetFiltersButton
        active={hasFilters}
        onReset={() => navigate({ search: {} as never, replace: true })}
      />
      <span className="ml-auto font-mono text-[10px] text-ink-muted">
        {sorted.length} of {rows.length}
      </span>
    </>
  );

  return (
    <PageSection
      id="open-gaps"
      eyebrow="Open gaps"
      title="Missing evidence, by priority"
      description="Filter by status, curation target, and missing resource kind."
      toolbar={toolbar}
    >
      <div className="flex flex-wrap gap-1.5">
        {MISSING_KINDS.map((k) => {
          const active = missingSet.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => {
                const next = new Set(missingSet);
                if (active) next.delete(k);
                else next.add(k);
                setSearch({ missing: Array.from(next).join(",") });
              }}
              className={classNames(
                "mg-type-micro inline-flex h-6 items-center rounded-full border px-2.5 text-[10px] transition-colors",
                active
                  ? "border-accent bg-primary-soft text-ink-strong"
                  : "border-border bg-paper text-ink-muted hover:border-accent/50 hover:text-ink",
              )}
              aria-pressed={active}
            >
              {k}
            </button>
          );
        })}
      </div>

      {missingSet.size > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-primary-soft/40 px-3 py-2 font-mono text-[11px] text-ink-strong">
          <span className="uppercase tracking-widest text-[10px] text-ink-muted">
            filtered by missing kind:
          </span>
          {Array.from(missingSet).map((k) => (
            <span
              key={k}
              className="inline-flex h-5 items-center rounded-full border border-accent/40 bg-paper px-2 text-accent"
            >
              {k}
            </span>
          ))}
          <span className="text-ink-muted">
            · {sorted.length} {sorted.length === 1 ? "gap" : "gaps"}
          </span>
          <button
            type="button"
            onClick={() => setSearch({ missing: "" })}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-paper px-2 py-0.5 text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> clear
          </button>
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <div className="mt-6">
          <StateBlock
            kind="registry"
            variant="empty"
            title={rows.length === 0 ? "No open gaps" : "No gaps match these filters"}
            description={
              rows.length === 0
                ? "The registry has no outstanding curation gaps right now. New ones appear when the coverage pipeline detects missing kinds or stale evidence."
                : "Try clearing one filter at a time, or widen your search. The pinned missing-kinds at the top of the page show what's actually unresolved."
            }
            updatedAt={gapsRes.meta?.generated_at}
            windowLabel="latest snapshot"
            freshnessHint="Gaps recompute on each registry build using coverage + evidence snapshots."
            evidenceHref="/metagraph/gaps.json"
            actions={
              rows.length === 0
                ? [
                    { label: "Browse subnets", to: "/subnets", primary: true },
                    { label: "Suggest on GitHub", href: GITHUB_REPO, external: true },
                  ]
                : [
                    {
                      label: "Reset filters",
                      onClick: () =>
                        setSearch({ q: "", status: "all", target: "all", missing: "" }),
                      primary: true,
                    },
                    { label: "Suggest on GitHub", href: GITHUB_REPO, external: true },
                  ]
            }
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {sorted.map((g) => (
            <GapRow
              key={g.id}
              gap={g}
              highlightKinds={missingSet}
              subnet={g.netuid != null ? subnetById.get(g.netuid) : undefined}
            />
          ))}
        </ul>
      )}
    </PageSection>
  );
}

function GapRow({
  gap,
  highlightKinds,
  subnet,
}: {
  gap: Gap;
  highlightKinds?: Set<string>;
  subnet?: Subnet;
}) {
  const sev = (gap.severity ?? "low").toLowerCase();
  const sevTint =
    sev === "high" ? "bg-health-down" : sev === "medium" ? "bg-health-warn" : "bg-ink-subtle/60";

  const gapKinds = (gap.missing_kinds ?? []).map((k) => k.toLowerCase());
  const matchedKind = highlightKinds
    ? Array.from(highlightKinds).find((k) => gapKinds.includes(k.toLowerCase()))
    : undefined;

  // Surface any source/evidence links already on the gap row. Falls back to
  // the subnet's #evidence deep link so users always have somewhere to go.
  const rec = gap as unknown as Record<string, unknown>;
  const rawSources: Array<{ label: string; href: string }> = [];
  for (const key of ["evidence_url", "source_url", "docs_url", "url"]) {
    const v = rec[key];
    if (typeof v === "string" && v.startsWith("http")) {
      rawSources.push({ label: key.replace("_url", ""), href: v });
    }
  }
  const evidence = rec.evidence;
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      const u = (e as Record<string, unknown>)?.url;
      if (typeof u === "string" && u.startsWith("http")) {
        rawSources.push({
          label: String((e as Record<string, unknown>)?.source ?? "evidence"),
          href: u,
        });
      }
    }
  }

  return (
    <li
      className={classNames(
        "group grid grid-cols-[6px_1fr_auto] gap-3 rounded-xl border bg-card p-4 transition-colors",
        matchedKind
          ? "border-accent/50 ring-1 ring-inset ring-accent/30"
          : "border-border hover:border-accent/40",
      )}
    >
      <span aria-hidden className={classNames("rounded-full", sevTint)} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <SeverityChip severity={gap.severity} />
          {gap.category ? (
            <span
              className={classNames(
                "mg-type-micro inline-flex h-5 items-center rounded-full border px-2 text-[10px]",
                matchedKind
                  ? "border-accent/50 bg-primary-soft text-accent"
                  : "border-transparent text-ink-muted",
              )}
            >
              {gap.category}
            </span>
          ) : null}
          {gap.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: gap.netuid }}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] text-accent hover:underline"
            >
              <BrandIcon
                url={subnet?.website}
                iconUrl={subnet?.icon_url}
                netuid={gap.netuid}
                name={subnet?.name}
                fallback={gap.netuid}
                size={14}
              />
              <span>SN{gap.netuid}</span>
              {subnet?.name ? (
                <span className="font-display text-[11px] text-ink normal-case tracking-normal">
                  · {subnet.name}
                </span>
              ) : null}
            </Link>
          ) : null}
        </div>
        <div className="font-medium text-ink-strong">{gap.title ?? gap.id}</div>
        {gap.description ? (
          <p className="mt-1 text-[13px] text-ink-muted leading-relaxed line-clamp-2">
            {gap.description}
          </p>
        ) : null}
        {gap.suggested_action ? (
          <p className="mt-1.5 text-[12px] text-ink">↳ {gap.suggested_action}</p>
        ) : null}
        {matchedKind && (rawSources.length > 0 || gap.netuid != null) ? (
          <div className="mg-type-micro mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-muted">
            <span>relevant sources:</span>
            {rawSources.map((s) => (
              <ExternalLink
                key={s.href}
                href={s.href}
                className="text-[10px] normal-case tracking-normal"
              >
                {s.label}
              </ExternalLink>
            ))}
            {rawSources.length === 0 && gap.netuid != null ? (
              <Link
                to="/subnets/$netuid"
                params={{ netuid: gap.netuid }}
                hash="evidence"
                className="text-accent hover:underline normal-case tracking-normal"
              >
                evidence on SN{gap.netuid}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {gap.netuid != null ? (
          <Link
            to="/subnets/$netuid"
            params={{ netuid: gap.netuid }}
            className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted hover:text-accent hover:border-accent/40"
          >
            open
          </Link>
        ) : null}
        <a
          href={`${GITHUB_REPO}/issues/new?title=${encodeURIComponent(`gap: ${gap.title ?? gap.id}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted hover:text-accent hover:border-accent/40"
        >
          file
        </a>
      </div>
    </li>
  );
}

function SeverityChip({ severity }: { severity?: string }) {
  const tone =
    severity === "high"
      ? "border-health-down/40 text-health-down before:bg-health-down"
      : severity === "medium"
        ? "border-health-warn/40 text-health-warn before:bg-health-warn"
        : "border-border text-ink-muted before:bg-ink-subtle";
  return (
    <span
      className={classNames(
        "mg-type-micro inline-flex h-5 items-center rounded-full border bg-transparent px-2 text-[10px]",
        "before:content-[''] before:size-1.5 before:rounded-full before:mr-1.5",
        tone,
      )}
    >
      {severity ?? "low"}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
      <span className="mg-type-micro text-[10px]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-ink focus:outline-none focus:border-accent/50"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/* --------------------------- Other lists --------------------------- */

function CompletenessList() {
  const { data } = useSuspenseQuery(reviewProfileCompletenessQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No completeness data"
        description="Completeness scores will appear here once profiles are scored."
        cta={{ label: "Browse subnets", href: "/subnets" }}
        generatedAt={meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, 24).map((r) => (
        <li
          key={r.netuid}
          className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-2.5"
        >
          <Link
            to="/subnets/$netuid"
            params={{ netuid: r.netuid }}
            className="font-mono text-[11px] text-ink-muted hover:text-accent w-12"
          >
            SN{r.netuid}
          </Link>
          <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.round((r.completeness ?? 0) * 100)}%` }}
            />
          </div>
          <span className="font-mono text-[11px] text-ink-strong w-10 text-right tabular-nums">
            {Math.round((r.completeness ?? 0) * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function AdapterCandidates() {
  const { data } = useSuspenseQuery(reviewAdapterCandidatesQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No adapter candidates"
        description="Adapter candidates appear once a subnet has enough public surface area to warrant one."
        cta={{ label: "Suggest on GitHub", href: GITHUB_REPO, external: true }}
        generatedAt={meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li
          key={`${r.netuid}-${i}`}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
        >
          {r.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: r.netuid }}
              className="font-mono text-[11px] text-ink-muted hover:text-accent w-12"
            >
              SN{r.netuid}
            </Link>
          ) : (
            <span className="font-mono text-[11px] text-ink-muted w-12">—</span>
          )}
          <span className="flex-1 text-[13px] text-ink">
            {r.reason ?? <span className="text-ink-muted">No recommendation recorded</span>}
          </span>
          {r.score != null ? (
            <span
              className="font-mono text-[11px] text-ink-strong tabular-nums"
              title="Priority score"
            >
              {Math.round(r.score)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function EnrichmentQueue() {
  const { data } = useSuspenseQuery(reviewEnrichmentQueueQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="Queue is empty"
        description="Nothing is currently awaiting enrichment."
        cta={{ label: "Browse registry", href: "/subnets" }}
        generatedAt={meta?.generated_at}
      />
    );
  return (
    <Panel as="div" flush className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="mg-type-micro bg-surface-2/60 text-[10px] text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 text-left">ID</th>
              <th className="px-4 py-2.5 text-left">Netuid</th>
              <th className="px-4 py-2.5 text-left">Priority</th>
              <th className="px-4 py-2.5 text-left">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="mg-row-hover">
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">{r.id}</td>
                <td className="px-4 py-2.5 font-mono text-[11px]">
                  {r.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: r.netuid }}
                      className="hover:text-accent"
                    >
                      SN{r.netuid}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px]">{r.priority ?? "—"}</td>
                <td className="px-4 py-2.5 text-[12px] text-ink-muted">{r.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// #3355: per-target enrichment board — mirrors EnrichmentQueue's table idiom but
// sourced from /api/v1/review/enrichment-targets (several targets per subnet).
function EnrichmentTargets() {
  const { data } = useSuspenseQuery(reviewEnrichmentTargetsQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No enrichment targets"
        description="Every subnet's target surfaces are covered — nothing outstanding."
        cta={{ label: "Browse registry", href: "/subnets" }}
        generatedAt={meta?.generated_at}
      />
    );
  return (
    <Panel as="div" flush className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="mg-type-micro bg-surface-2/60 text-[10px] text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 text-left">Netuid</th>
              <th className="px-4 py-2.5 text-left">Subnet</th>
              <th className="px-4 py-2.5 text-left">Target</th>
              <th className="px-4 py-2.5 text-left">Action</th>
              <th className="px-4 py-2.5 text-left">Priority</th>
              <th className="px-4 py-2.5 text-left">Missing / recommended</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="mg-row-hover">
                <td className="px-4 py-2.5 font-mono text-[11px]">
                  {r.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: r.netuid }}
                      className="hover:text-accent"
                    >
                      SN{r.netuid}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5 text-[12px] text-ink-strong">{r.name ?? "—"}</td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {r.targetType ?? "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {r.targetAction ?? "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px]">{r.priority ?? "—"}</td>
                <td className="px-4 py-2.5 text-[12px] text-ink-muted">{r.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// #3354: the detailed candidate evidence behind the enrichment queue -- one
// level down from EnrichmentQueue's summary rollup. Mirrors the same table
// idiom, sourced from /api/v1/review/enrichment-evidence.
function EnrichmentEvidence() {
  const { data } = useSuspenseQuery(reviewEnrichmentEvidenceQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No enrichment evidence"
        description="No candidate evidence is currently behind the enrichment queue."
        cta={{ label: "Browse registry", href: "/subnets" }}
        generatedAt={meta?.generated_at}
      />
    );
  return (
    <Panel as="div" flush className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="mg-type-micro bg-surface-2/60 text-[10px] text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 text-left">Netuid</th>
              <th className="px-4 py-2.5 text-left">Lane</th>
              <th className="px-4 py-2.5 text-left">Evidence action</th>
              <th className="px-4 py-2.5 text-left">Missing kinds</th>
              <th className="px-4 py-2.5 text-left">Direct submission kinds</th>
              <th className="px-4 py-2.5 text-left">Priority</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="mg-row-hover">
                <td className="px-4 py-2.5 font-mono text-[11px]">
                  {r.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: r.netuid }}
                      className="hover:text-accent"
                    >
                      SN{r.netuid}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {r.lane ?? "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {r.evidenceAction ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-[12px] text-ink-muted">
                  {r.missingKinds.length > 0 ? r.missingKinds.join(", ") : "—"}
                </td>
                <td className="px-4 py-2.5 text-[12px] text-ink-muted">
                  {r.directSubmissionKinds.length > 0 ? r.directSubmissionKinds.join(", ") : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px]">{r.priority ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// #3356: the priority-scored per-subnet gap board -- distinct from the
// interface-facet OpenGapsSection above and from the enrichment-queue/
// -targets/-evidence sections, which are enrichment-pipeline data, not
// gap-priority scoring. Mirrors AdapterCandidates's row-list idiom.
function GapPriorityList() {
  const { data } = useSuspenseQuery(reviewGapPrioritiesQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  if (rows.length === 0)
    return (
      <TableState
        variant="empty"
        title="No gap priorities"
        description="The priority-scored gap board is empty — nothing currently ranked."
        cta={{ label: "Browse registry", href: "/subnets" }}
        generatedAt={meta?.generated_at}
      />
    );
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li
          key={`${r.netuid}-${i}`}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
        >
          {r.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: r.netuid }}
              className="font-mono text-[11px] text-ink-muted hover:text-accent w-12 shrink-0"
            >
              SN{r.netuid}
            </Link>
          ) : (
            <span className="font-mono text-[11px] text-ink-muted w-12 shrink-0">—</span>
          )}
          <span className="flex-1 text-[13px] text-ink truncate">{r.name ?? "—"}</span>
          <CurationChip level={r.curation_level} />
          <span className="hidden sm:block max-w-[240px] truncate text-[11px] text-ink-muted">
            {r.missing_kinds && r.missing_kinds.length > 0 ? r.missing_kinds.join(", ") : "—"}
          </span>
          {r.priority_score != null ? (
            <span
              className="font-mono text-[11px] text-ink-strong tabular-nums shrink-0"
              title="Priority score"
            >
              {Math.round(r.priority_score)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
