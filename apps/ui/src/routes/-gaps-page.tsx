import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ContributeSearch } from "./contribute";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useEffect, useState } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { RegistryPipelinePanel } from "@/components/metagraphed/registry-pipeline-panel";
import {
  DataTable,
  ExternalLink,
  BrandIcon,
  CurationChip,
  AnalyticsSection,
  SectionHead,
  EntityHero,
  FactSentence,
  FactCell,
} from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
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
  reviewAttributionCandidatesQuery,
  reviewEnrichmentEvidenceQuery,
  reviewGapPrioritiesQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { GITHUB_REPO } from "@/lib/metagraphed/config";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { StateBlock } from "@/components/metagraphed/states/state-block";
import type { CurationLevel, Gap, Subnet } from "@/lib/metagraphed/types";
import { MISSING_KINDS, STATUS_OPTIONS, TARGET_OPTIONS, SORT_OPTIONS } from "./contribute";
import { readKey, readString } from "@/lib/metagraphed/read-key";

// #8304: gap rows rendered before the explicit expander. Module scope so it
// is initialised before the component that reads it, not after (a `const`
// declared below the component would be in its TDZ at first render).
const GAP_PAGE = 25;

export function GapsPage() {
  return (
    <AppShell>
      <EntityHero
        name="Contribute"
        action={
          <ExternalLink href={GITHUB_REPO} className="text-13">
            github
          </ExternalLink>
        }
        sentence={
          <FactSentence>
            The contributor work queue — which subnets are missing which public interfaces, and
            where a correction or addition helps most. Submit through the GitHub repo.
          </FactSentence>
        }
      />

      <main className="space-y-20 md:space-y-24">
        <AsyncPanel height="sm">
          <GapsKpiStrip />
        </AsyncPanel>

        <AsyncPanel height="md">
          <MissingKindsAtAGlance />
        </AsyncPanel>

        <section>
          <SectionHead name="Integrability scoreboard" />
          <AsyncPanel height="lg">
            <IntegrabilityBoard />
          </AsyncPanel>
        </section>

        <AnalyticsSection
          id="coverage-matrix"
          name="What's actually missing"
          question="Subnets × required public-interface kinds. Cells link straight to that subnet's surfaces tab."
        >
          <AsyncPanel height="lg">
            <CoverageMatrix />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="completeness-distribution"
          name="Registry shape"
          question="Histogram of completeness across every scored profile. Median and quartile markers show where the registry sits today."
        >
          <AsyncPanel height="md">
            <CompletenessHistogram />
          </AsyncPanel>
        </AnalyticsSection>

        <AsyncPanel height="lg">
          <OpenGapsSection />
        </AsyncPanel>

        {/* #10300: /candidates, /curation, /profiles and /source-snapshots were
            all published and rendered nowhere. The issue listed them as
            "plausibly API-only... but it should be a recorded decision, because
            right now 'no page exists' and 'no page should exist' are
            indistinguishable from the outside". This is that decision, made the
            other way -- they are the four stages of registry intake, and this
            is the console where someone asks where it has stalled. */}
        <AnalyticsSection
          id="registry-pipeline"
          name="Registry pipeline"
          question="Discovered, curated, profiled — and the snapshot of what each source actually said."
        >
          <RegistryPipelinePanel />
        </AnalyticsSection>

        <AnalyticsSection
          id="profile-completeness"
          name="Profile completeness"
          question="Per-subnet completeness across required public-interface kinds."
        >
          <AsyncPanel height="md">
            <CompletenessList />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="adapter-candidates"
          name="Adapter candidates"
          question="Subnets where a maintained adapter would unlock the highest registry value."
        >
          <AsyncPanel height="md">
            <AdapterCandidates />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="enrichment-queue"
          name="Enrichment queue"
          question="Prioritized list of registry entries awaiting verification or enrichment."
        >
          <AsyncPanel height="md">
            <EnrichmentQueue />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="enrichment-targets"
          name="Enrichment targets"
          question="Per-target contributor task board — the specific surfaces to add per subnet, ranked by priority."
        >
          <AsyncPanel height="md">
            <EnrichmentTargets />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="enrichment-evidence"
          name="Enrichment evidence"
          question="The detailed candidate evidence behind the enrichment queue — one level down from the summary above."
        >
          <AsyncPanel height="md">
            <EnrichmentEvidence />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="attribution-candidates"
          name="Attribution candidates"
          question="Addresses the sweep found in the text of pages subnets publish, which nobody has judged yet. Each row is a LEAD, not an attribution — open the source and decide."
        >
          <AsyncPanel height="md">
            <AttributionCandidates />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="gap-priorities"
          name="Gap priorities"
          question="Priority-scored per-subnet gap board — ranked separately from the interface-facet gaps above."
        >
          <AsyncPanel height="md">
            <GapPriorityList />
          </AsyncPanel>
        </AnalyticsSection>
      </main>

      <ApiSourceFooter
        paths={[
          "/api/v1/gaps",
          "/api/v1/review/profile-completeness",
          "/api/v1/review/adapter-candidates",
          "/api/v1/review/enrichment-queue",
          "/api/v1/review/enrichment-targets",
          "/api/v1/review/attribution-candidates",
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
  const avgComp =
    completeness.length > 0
      ? Math.round(
          (completeness.reduce((a, r) => a + (r.completeness ?? 0), 0) / completeness.length) * 100,
        )
      : null;
  // Below-50% subnets distribution for the queue tile.

  return (
    <Panel
      flush
      bodyClassName="grid grid-cols-2 md:grid-cols-5 divide-x divide-border overflow-hidden"
    >
      <FactCell
        label="Open gaps"
        value={gaps.length}
        hint="Outstanding registry gaps across all subnets, split by severity."
      />
      <FactCell
        label="High severity"
        value={high}
        hint="Count of gaps marked `high` — these are blocking registry curation."
      />
      <FactCell
        label="Avg completeness"
        value={avgComp != null ? `${avgComp}%` : "—"}
        hint="Mean profile completeness across all scored subnets. Updated when the review pipeline reruns."
      />
      <FactCell
        label="Adapter candidates"
        value={adapters.length}
        hint="Subnets where a maintained adapter would unlock the most registry value."
      />
      <FactCell
        label="Queue depth"
        value={queue.length}
        hint="Items the enrichment pipeline has flagged for human review or re-probe."
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
  const rows = useMemo(() => (gapsRes.data ?? []) as Gap[], [gapsRes.data]);
  const navigate = useNavigate({ from: "/contribute" });
  const search = useSearch({ from: "/contribute" }) as ContributeSearch;
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
    <AnalyticsSection
      id="missing-kinds"
      name="Missing kinds across the registry"
      question="Click a row to filter the open-gaps section by that resource kind and jump straight to it."
    >
      <ul className="rounded border border-border bg-card divide-y divide-border">
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
                    search: (prev: Record<string, unknown>) => ({
                      ...prev,
                      missing: Array.from(next).join(","),
                      ...(wasEmpty ? { status: "open", sort: "priority" } : {}),
                    }),
                    replace: true,
                  });
                  focusOpenGaps();
                }}
                className={classNames(
                  "grid w-full grid-cols-[80px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors focus:outline-none",
                  isActive
                    ? "ring-1 ring-inset ring-accent/60"
                    : "hover:bg-surface focus-visible:bg-surface",
                )}
                aria-pressed={isActive}
                aria-label={`Filter open gaps by ${k}, ${n} subnets missing this kind`}
              >
                <span
                  className={classNames("text-13", isActive ? "text-accent" : "text-ink-strong")}
                >
                  {k}
                </span>
                <span
                  className={classNames(
                    "h-2 rounded transition-colors",
                    isActive ? "bg-accent" : "bg-health-warn/70",
                  )}
                  style={{ width: `${pct}%` }}
                  aria-hidden
                />
                <span className="text-11 tabular-nums text-ink-muted">{n} subnets</span>
              </button>
            </li>
          );
        })}
      </ul>
      {activeMissing.size > 0 ? (
        <div className="text-13 mt-2 flex flex-wrap items-center gap-2 text-ink-muted">
          <span>filtered by:</span>
          {Array.from(activeMissing).map((k) => (
            <span
              key={k}
              className="inline-flex h-5 items-center rounded border border-accent/40 bg-primary-soft px-2 text-accent"
            >
              {k}
            </span>
          ))}
          <button
            type="button"
            onClick={() =>
              navigate({
                search: (prev: Record<string, unknown>) => ({ ...prev, missing: "" }),
                replace: true,
              })
            }
            className="ml-1 inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 text-ink-muted hover:text-ink-strong"
          >
            <X className="size-3" /> clear
          </button>
        </div>
      ) : null}
    </AnalyticsSection>
  );
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
  const rows = useMemo(() => (data.data ?? []) as Gap[], [data.data]);
  const search = useSearch({ from: "/contribute" }) as ContributeSearch;
  const navigate = useNavigate({ from: "/contribute" });

  const setSearch = (patch: Partial<typeof search>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
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

  // Bounded first paint for the gap list (#8304). Resets whenever the filter
  // set changes, so narrowing the query never leaves a stale "show more" count.
  const [gapLimit, setGapLimit] = useState(GAP_PAGE);
  useEffect(() => {
    setGapLimit(GAP_PAGE);
  }, [search.status, search.target, search.q, search.sort]);

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

  const visibleGaps = useMemo(() => sorted.slice(0, gapLimit), [sorted, gapLimit]);

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
          className="w-full rounded border border-border bg-card pl-8 pr-3 py-1.5 text-13 focus:outline-none focus:border-accent/50"
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
        onReset={() => navigate({ search: {}, replace: true })}
      />
      <span className="ml-auto text-10 text-ink-muted">
        {sorted.length} of {rows.length}
      </span>
    </>
  );

  return (
    <AnalyticsSection
      id="open-gaps"
      name="Missing evidence, by priority"
      question="Filter by status, curation target, and missing resource kind."
      controls={toolbar}
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
                "text-10 inline-flex h-6 items-center rounded border px-2.5 transition-colors",
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
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-accent/30 bg-primary-soft/40 px-3 py-2 text-11 text-ink-strong">
          <span className="text-13 text-ink-muted">filtered by missing kind:</span>
          {Array.from(missingSet).map((k) => (
            <span
              key={k}
              className="inline-flex h-5 items-center rounded border border-accent/40 bg-paper px-2 text-accent"
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
            className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-0.5 text-10 text-ink-muted hover:text-ink-strong"
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
          {/* #8304: this rendered EVERY gap unconditionally -- 126 rich cards,
              which is where the page's 52,681px came from (the coverage matrix
              above was already capped at 24). Bounded to an initial page with
              an explicit expand, so first paint is finite and nothing is
              hidden from anyone who wants it. */}
          {visibleGaps.map((g) => (
            <GapRow
              key={g.id}
              gap={g}
              highlightKinds={missingSet}
              subnet={g.netuid != null ? subnetById.get(g.netuid) : undefined}
            />
          ))}
        </ul>
      )}
      {sorted.length > visibleGaps.length ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setGapLimit((n) => n + GAP_PAGE)}
            className="mg-focus-ring rounded border border-border bg-card px-4 py-2 text-13 font-medium text-ink-muted transition-colors hover:border-accent/60 hover:text-ink-strong"
          >
            Show more gaps ({sorted.length - visibleGaps.length} remaining)
          </button>
        </div>
      ) : null}
    </AnalyticsSection>
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
  const rawSources: Array<{ label: string; href: string }> = [];
  for (const key of ["evidence_url", "source_url", "docs_url", "url"]) {
    const v = readString(gap, key);
    if (v?.startsWith("http")) {
      rawSources.push({ label: key.replace("_url", ""), href: v });
    }
  }
  const evidence = readKey(gap, "evidence");
  if (Array.isArray(evidence)) {
    for (const entry of evidence) {
      if (typeof entry !== "object" || entry === null) continue;
      const url = readString(entry, "url");
      if (url?.startsWith("http")) {
        rawSources.push({
          label: readString(entry, "source") ?? "evidence",
          href: url,
        });
      }
    }
  }

  // #8361: /contribute averaged ~700px per card on mobile with every gap
  // rendered in full. Collapse to a summary row (identity, count, priority,
  // first 3 missing kinds) via the shared MobileCollapse pattern; the full
  // detail below is unchanged, just gated behind the mobile trigger. Each
  // card owns its own open state (no single-expanded coordination) -- the
  // simpler option the issue allows, and it keeps expand/collapse purely
  // presentational so it never has to touch the URL-synced filters/sort.

  return (
    <li>
      <Panel
        flush
        className={classNames(
          matchedKind ? "ring-1 ring-inset ring-accent/30" : null,
          "md:border-0 md:rounded-none md:bg-transparent md:p-0 md:ring-0",
        )}
      >
        <div className="grid grid-cols-[6px_1fr_auto] gap-3 p-4">
          <span aria-hidden className={classNames("rounded", sevTint)} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <SeverityChip severity={gap.severity} />
              {gap.category ? (
                <span
                  className={classNames(
                    "text-10 inline-flex h-5 items-center rounded border px-2",
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
                  className="inline-flex items-center gap-1.5 text-10 text-accent hover:underline"
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
                    <span className="font-display text-13 text-ink normal-case">
                      · {subnet.name}
                    </span>
                  ) : null}
                </Link>
              ) : null}
            </div>
            <div className="font-medium text-ink-strong">{gap.title ?? gap.id}</div>
            {gap.description ? (
              <p className="mt-1 text-13 text-ink-muted leading-relaxed line-clamp-2">
                {gap.description}
              </p>
            ) : null}
            {gap.suggested_action ? (
              <p className="mt-1.5 text-13 text-ink">↳ {gap.suggested_action}</p>
            ) : null}
            {matchedKind && (rawSources.length > 0 || gap.netuid != null) ? (
              <div className="text-13 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-muted">
                <span>relevant sources:</span>
                {rawSources.map((s) => (
                  <ExternalLink key={s.href} href={s.href} className="text-13 normal-case">
                    {s.label}
                  </ExternalLink>
                ))}
                {rawSources.length === 0 && gap.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: gap.netuid }}
                    hash="evidence"
                    className="text-accent hover:underline normal-case"
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
                className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-1 text-13 text-ink-muted hover:text-accent hover:border-accent/40"
              >
                open
              </Link>
            ) : null}
            <ExternalLink
              href={`${GITHUB_REPO}/issues/new?title=${encodeURIComponent(`gap: ${gap.title ?? gap.id}`)}`}
              className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-1 text-13 text-ink-muted hover:text-accent hover:border-accent/40"
            >
              file
            </ExternalLink>
          </div>
        </div>
      </Panel>
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
        "text-10 inline-flex h-5 items-center rounded border bg-transparent px-2",
        "mg-dot-before before:mr-1.5",
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
    <label className="inline-flex items-center gap-1.5 text-13 text-ink-muted">
      <span className="text-13">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-card px-2.5 py-1 text-13 text-ink focus:outline-none focus:border-accent/50"
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
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => String(r.netuid)}
      caption="Profile completeness"
      source="profile-completeness"
      link={RouterLink}
      rowHref={(r) => `/subnets/${r.netuid}`}
      empty={
        <EmptyState
          title="No completeness data"
          description="Completeness scores will appear here once profiles are scored."
          action={{ label: "Browse subnets", href: "/subnets" }}
          lastChecked={meta?.generated_at}
        />
      }
      columns={[
        {
          key: "netuid",
          label: "Subnet",
          sortable: true,
          value: (r) => r.netuid,
          format: (_v, r) => `SN${r.netuid}`,
        },
        {
          key: "completeness",
          label: "Completeness",
          kind: "tint",
          sortable: true,
          value: (r) => r.completeness ?? null,
          tint: (r) => r.completeness ?? null,
          format: (v) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—"),
        },
      ]}
    />
  );
}

function AdapterCandidates() {
  const { data } = useSuspenseQuery(reviewAdapterCandidatesQuery());
  const meta = data.meta;
  // The payload can carry several rows for one subnet (and rows with no
  // netuid at all), so the row key has to include the position.
  const rows = (data.data ?? []).map((r, i) => ({ ...r, rowId: `${r.netuid ?? "none"}-${i}` }));
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.rowId}
      caption="Adapter candidates"
      source="adapter-candidates"
      link={RouterLink}
      rowHref={(r) => (r.netuid != null ? `/subnets/${r.netuid}` : undefined)}
      empty={
        <EmptyState
          title="No adapter candidates"
          description="Adapter candidates appear once a subnet has enough public surface area to warrant one."
          action={{ label: "Suggest on GitHub", href: GITHUB_REPO, external: true }}
          lastChecked={meta?.generated_at}
        />
      }
      columns={[
        {
          key: "netuid",
          label: "Subnet",
          sortable: true,
          value: (r) => r.netuid ?? null,
          format: (v) => (typeof v === "number" ? `SN${v}` : "—"),
        },
        {
          key: "reason",
          label: "Recommendation",
          value: (r) => r.reason ?? null,
          format: (v) => (typeof v === "string" && v ? v : "No recommendation recorded"),
        },
        {
          key: "score",
          label: "Score",
          kind: "number",
          sortable: true,
          value: (r) => r.score ?? null,
          format: (v) => formatNumber(typeof v === "number" ? Math.round(v) : null),
        },
      ]}
    />
  );
}

function EnrichmentQueue() {
  const { data } = useSuspenseQuery(reviewEnrichmentQueueQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      caption="Enrichment queue"
      source="enrichment-queue"
      link={RouterLink}
      rowHref={(r) => (r.netuid != null ? `/subnets/${r.netuid}` : undefined)}
      empty={
        <EmptyState
          title="Queue is empty"
          description="Nothing is currently awaiting enrichment."
          action={{ label: "Browse registry", href: "/subnets" }}
          lastChecked={meta?.generated_at}
        />
      }
      columns={[
        { key: "id", label: "ID", kind: "identifier", sortable: true, value: (r) => r.id },
        {
          key: "netuid",
          label: "Netuid",
          sortable: true,
          value: (r) => r.netuid ?? null,
          format: (v) => (typeof v === "number" ? `SN${v}` : "—"),
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          sortable: true,
          value: (r) => r.priority ?? null,
        },
        { key: "note", label: "Note", value: (r) => r.note ?? null },
      ]}
    />
  );
}

// #3355: per-target enrichment board — mirrors EnrichmentQueue's table idiom but
// sourced from /api/v1/review/enrichment-targets (several targets per subnet).
function EnrichmentTargets() {
  const { data } = useSuspenseQuery(reviewEnrichmentTargetsQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      caption="Enrichment targets"
      source="enrichment-targets"
      link={RouterLink}
      rowHref={(r) => (r.netuid != null ? `/subnets/${r.netuid}` : undefined)}
      empty={
        <EmptyState
          title="No enrichment targets"
          description="Every subnet's target surfaces are covered — nothing outstanding."
          action={{ label: "Browse registry", href: "/subnets" }}
          lastChecked={meta?.generated_at}
        />
      }
      columns={[
        {
          key: "netuid",
          label: "Netuid",
          sortable: true,
          value: (r) => r.netuid ?? null,
          format: (v) => (typeof v === "number" ? `SN${v}` : "—"),
        },
        { key: "name", label: "Subnet", sortable: true, value: (r) => r.name ?? null },
        { key: "targetType", label: "Target", sortable: true, value: (r) => r.targetType ?? null },
        {
          key: "targetAction",
          label: "Action",
          sortable: true,
          value: (r) => r.targetAction ?? null,
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          sortable: true,
          value: (r) => r.priority ?? null,
        },
        { key: "note", label: "Missing / recommended", value: (r) => r.note ?? null },
      ]}
    />
  );
}

// #3354: the detailed candidate evidence behind the enrichment queue -- one
// level down from EnrichmentQueue's summary rollup. Mirrors the same table
// idiom, sourced from /api/v1/review/enrichment-evidence.
function EnrichmentEvidence() {
  const { data } = useSuspenseQuery(reviewEnrichmentEvidenceQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      caption="Enrichment evidence"
      source="enrichment-evidence"
      link={RouterLink}
      rowHref={(r) => (r.netuid != null ? `/subnets/${r.netuid}` : undefined)}
      empty={
        <EmptyState
          title="No enrichment evidence"
          description="No candidate evidence is currently behind the enrichment queue."
          action={{ label: "Browse registry", href: "/subnets" }}
          lastChecked={meta?.generated_at}
        />
      }
      columns={[
        {
          key: "netuid",
          label: "Netuid",
          sortable: true,
          value: (r) => r.netuid ?? null,
          format: (v) => (typeof v === "number" ? `SN${v}` : "—"),
        },
        { key: "lane", label: "Lane", sortable: true, value: (r) => r.lane ?? null },
        {
          key: "evidenceAction",
          label: "Evidence action",
          sortable: true,
          value: (r) => r.evidenceAction ?? null,
        },
        {
          key: "missingKinds",
          label: "Missing kinds",
          value: (r) => (r.missingKinds.length > 0 ? r.missingKinds.join(", ") : null),
        },
        {
          key: "directSubmissionKinds",
          label: "Direct submission kinds",
          value: (r) =>
            r.directSubmissionKinds.length > 0 ? r.directSubmissionKinds.join(", ") : null,
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          sortable: true,
          value: (r) => r.priority ?? null,
        },
      ]}
    />
  );
}

/**
 * #11227: the attribution sweep's review queue.
 *
 * THE ONLY BOARD ON THIS PAGE WHOSE ROWS ARE UNVERIFIED CLAIMS. The others say
 * "this subnet is missing something we can add"; this one says "this string
 * looked like an address on that page". So the source is a link rather than
 * text, the address is shown whole rather than truncated to a badge, and the
 * header says LEAD -- because a table that reads like the ones above it would
 * be asserting attributions the sweep explicitly refuses to assert.
 *
 * The count line is the second half of that honesty: `reviewableCount` comes
 * off the payload, and the suppressed figures say how many candidates the
 * listing rule removed and from how many pages. A filter a reviewer cannot see
 * is one they cannot check -- and a rising suppressed share is the signal that
 * the sweep's fan-out needs narrowing before anyone is asked to read more.
 */
function AttributionCandidates() {
  const { data } = useSuspenseQuery(reviewAttributionCandidatesQuery());
  const meta = data.meta;
  const rows = data.data ?? [];
  return (
    <div className="space-y-2">
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        caption="Attribution candidates"
        source="attribution-candidates"
        link={RouterLink}
        empty={
          <EmptyState
            title="No attribution candidates"
            description="Nothing is waiting for a judgement — every candidate has been adjudicated, or every source the sweep reached was a listing."
            action={{ label: "Browse registry", href: "/subnets" }}
            lastChecked={meta?.generated_at}
          />
        }
        columns={[
          {
            key: "netuid",
            label: "Netuid",
            kind: "link",
            sortable: true,
            value: (r) => r.netuid,
            format: (v) => (typeof v === "number" ? `SN${v}` : "—"),
            href: (r) => `/subnets/${r.netuid}`,
          },
          {
            // WHOLE, not truncated: a reviewer compares it against the page,
            // and a shortened address cannot be compared — so this is plain
            // text, never `kind: "identifier"`.
            key: "ss58",
            label: "Address (unverified)",
            sortable: true,
            value: (r) => r.ss58,
            render: (r) => <span className="break-all text-ink-muted">{r.ss58}</span>,
          },
          {
            // ExternalLink, not a bare anchor: these URLs are UNTRUSTED
            // third-party strings scraped off pages the registry does not
            // control, and it is the component that runs safeExternalUrl over
            // them. A raw href here would render whatever the sweep found.
            key: "sourceUrl",
            label: "Found on",
            value: (r) => r.sourceUrl,
            render: (r) => (
              <ExternalLink href={r.sourceUrl} className="break-all text-ink-muted">
                {r.sourceUrl}
              </ExternalLink>
            ),
          },
          {
            key: "sourceAddressCount",
            label: "Addresses on that page",
            kind: "number",
            sortable: true,
            value: (r) => r.sourceAddressCount ?? null,
          },
          {
            key: "lastSeen",
            label: "Last seen",
            kind: "time",
            sortable: true,
            align: "right",
            value: (r) => r.lastSeen ?? null,
          },
        ]}
      />
      <p className="text-13 text-ink-muted">
        Showing {rows.length}
        {data.reviewableCount != null ? ` of ${data.reviewableCount} awaiting review` : ""}.
        {data.suppressedCount != null && data.suppressedSourceCount != null
          ? ` ${data.suppressedCount} more were suppressed from ${data.suppressedSourceCount} page(s) carrying more than ${data.listingAddressCap ?? "the cap"} addresses each — those are listings, and every address on one belongs to somebody else.`
          : ""}
      </p>
    </div>
  );
}

// #3356: the priority-scored per-subnet gap board -- distinct from the
// interface-facet OpenGapsSection above and from the enrichment-queue/
// -targets/-evidence sections, which are enrichment-pipeline data, not
// gap-priority scoring.
function GapPriorityList() {
  const { data } = useSuspenseQuery(reviewGapPrioritiesQuery());
  const meta = data.meta;
  const rows = (data.data ?? []).map((r, i) => ({ ...r, rowId: `${r.netuid ?? "none"}-${i}` }));
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.rowId}
      caption="Gap priorities"
      source="gap-priorities"
      link={RouterLink}
      rowHref={(r) => (r.netuid != null ? `/subnets/${r.netuid}` : undefined)}
      empty={
        <EmptyState
          title="No gap priorities"
          description="The priority-scored gap board is empty — nothing currently ranked."
          action={{ label: "Browse registry", href: "/subnets" }}
          lastChecked={meta?.generated_at}
        />
      }
      columns={[
        {
          key: "netuid",
          label: "Subnet",
          sortable: true,
          value: (r) => r.netuid ?? null,
          format: (v) => (typeof v === "number" ? `SN${v}` : "—"),
        },
        { key: "name", label: "Name", sortable: true, value: (r) => r.name ?? null },
        {
          key: "curation_level",
          label: "Curation",
          sortable: true,
          value: (r) => r.curation_level ?? null,
          render: (r) => <CurationChip level={r.curation_level} />,
        },
        {
          key: "missing_kinds",
          label: "Missing kinds",
          value: (r) =>
            r.missing_kinds && r.missing_kinds.length > 0 ? r.missing_kinds.join(", ") : null,
        },
        {
          key: "priority_score",
          label: "Priority",
          kind: "number",
          sortable: true,
          value: (r) => r.priority_score ?? null,
          format: (v) => formatNumber(typeof v === "number" ? Math.round(v) : null),
        },
      ]}
    />
  );
}
