import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { ChevronLeft, FileCode, Copy, Check } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  TimeAgo,
  CopyableCode,
  ExternalLink,
  PageHero,
  PageSection,
  AnimatedNumber,
  MethodologyCallout,
} from "@jsonbored/ui-kit";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { DownloadOpenApiButton } from "@/components/metagraphed/download-openapi-button";
import { Skeleton, StaleBanner, EmptyState } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { SchemaDriftMatrix } from "@/components/metagraphed/analytics/schema-drift-matrix";
import { DriftActivity } from "@/components/metagraphed/analytics/drift-activity";
import { SchemaDriftDetail } from "@/components/metagraphed/schema-drift-detail";
import { SchemaSnapshotSummary } from "@/components/metagraphed/schema-snapshot-summary";
import { useCopy } from "@/hooks/use-copy";
import { schemasQuery, contractsQuery, metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { normalizeDriftStatus } from "@/lib/metagraphed/schema-drift";
import { API_BASE, DEFAULT_API_BASE } from "@/lib/metagraphed/config";
import { isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { SearchInput, ResetFiltersButton } from "@/components/metagraphed/table-controls";
import type { SchemaInfo } from "@/lib/metagraphed/types";

const schemasSearchSchema = z.object({
  drift: fallback(z.enum(["all", "drift", "stable"]), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  open: fallback(z.string(), "").default(""),
  driftDetail: fallback(z.string(), "").default(""),
});

function sameOriginApiUrl(url?: string) {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  try {
    const apiBaseUrl = new URL(API_BASE);
    const artifactUrl = new URL(url, apiBaseUrl);
    if (!["http:", "https:"].includes(artifactUrl.protocol)) return undefined;
    return artifactUrl.origin === apiBaseUrl.origin ? artifactUrl.href : undefined;
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/schemas")({
  validateSearch: schemasSearchSchema,
  head: () => ({
    meta: [
      { title: "Schemas — Metagraphed" },
      {
        name: "description",
        content:
          "OpenAPI, contracts, schema index, and drift between current and previous snapshots.",
      },
      { property: "og:title", content: "Schemas — Metagraphed" },
      {
        property: "og:description",
        content:
          "OpenAPI, contracts, schema index, and drift between current and previous snapshots.",
      },
    ],
  }),
  component: SchemasPage,
});

function SchemasPage() {
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <SchemasHero />
        </Suspense>
      </QueryErrorBoundary>

      <main className="space-y-section">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <SchemasMethodology />
          </Suspense>
        </QueryErrorBoundary>

        <PageSection
          eyebrow="Activity"
          title="Drift activity"
          description="Per-schema change weight. Stable schemas are dim; drifting schemas surface on top — click a drifting row for change details, or a stable row to open it in the explorer below."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <DriftActivityRibbon />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>

        <PageSection
          eyebrow="Drift"
          title="Schema drift matrix"
          description="Every tracked schema classified by change type, with one-click access to source evidence."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <SchemaDriftMatrix />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>

        <PageSection
          eyebrow="Contracts"
          title="Published contracts"
          description="Versioned envelope contracts that govern API responses."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <ContractsList />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>

        <PageSection
          eyebrow="Explorer"
          title="Schema index"
          description="Browse every tracked JSON Schema. Select one to inspect the latest snapshot and recent drift."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-[480px] w-full" />}>
              <SchemaExplorer />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>
      </main>

      <ApiSourceFooter
        paths={["/api/v1/schemas", "/api/v1/contracts"]}
        artifacts={["/metagraph/openapi.json"]}
      />

      <QueryErrorBoundary>
        <Suspense fallback={null}>
          <SchemaDriftDetailHost />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function SchemaDriftDetailHost() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(schemasQuery());
  const all = (data.data ?? []) as SchemaInfo[];
  const schema = search.driftDetail ? (all.find((s) => s.id === search.driftDetail) ?? null) : null;
  return (
    <SchemaDriftDetail
      schema={schema}
      open={!!schema}
      onOpenChange={(o) => {
        if (!o) {
          navigate({
            search: (p: Record<string, unknown>) => ({ ...p, driftDetail: "" }) as never,
            replace: true,
          });
        }
      }}
      onOpenInExplorer={(id) =>
        navigate({
          search: (p: Record<string, unknown>) => ({ ...p, driftDetail: "", open: id }) as never,
          replace: true,
        })
      }
    />
  );
}

/* --------------------------- Hero --------------------------- */

function SchemasHero() {
  const { data: sRes } = useSuspenseQuery(schemasQuery());
  const { data: cRes } = useSuspenseQuery(contractsQuery());
  const schemas = (sRes.data ?? []) as SchemaInfo[];
  const drift = schemas.filter((s) => s.drift).length;
  const fresh = schemas.filter((s) => normalizeDriftStatus(s.drift_status) === "new").length;
  const stable = schemas.length - drift - fresh;
  const subnets = new Set(schemas.map((s) => s.netuid).filter((n) => n != null)).size;
  const contractsCount = (cRes.data ?? []).length;

  return (
    <PageHero
      eyebrow="Operations"
      live
      title="Schemas & contracts"
      description="JSON Schema is canonical truth. Drift compares the current snapshot to the previous published version."
      caption={<>schemas / v1</>}
      actions={
        <>
          <CopyableCode
            label="openapi"
            value={`${API_BASE}/api/v1/openapi.json`}
            truncate={false}
          />
          <DownloadOpenApiButton url={`${DEFAULT_API_BASE}/metagraph/openapi.json`} />
          <Link
            to="/docs/$"
            params={{ _splat: "api-reference" }}
            className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text transition-colors hover:bg-accent/15"
          >
            Browse reference
          </Link>
        </>
      }
      kpis={[
        { label: "Schemas", value: <AnimatedNumber value={schemas.length} /> },
        {
          label: "Stable",
          value: <AnimatedNumber value={stable} />,
          hint: schemas.length ? `${Math.round((stable / schemas.length) * 100)}%` : undefined,
        },
        { label: "New", value: <AnimatedNumber value={fresh} /> },
        { label: "Drift", value: <AnimatedNumber value={drift} /> },
        { label: "Contracts", value: <AnimatedNumber value={contractsCount} /> },
        { label: "Subnets covered", value: <AnimatedNumber value={subnets} /> },
      ]}
    />
  );
}

/* --------------------------- Methodology --------------------------- */

function SchemasMethodology() {
  const { data } = useSuspenseQuery(schemasQuery());
  return <MethodologyCallout generatedAt={data.meta?.generated_at} windowLabel="snapshot" />;
}

/* --------------------------- Drift activity --------------------------- */

function DriftActivityRibbon() {
  const { data } = useSuspenseQuery(schemasQuery());
  const all = (data.data ?? []) as SchemaInfo[];
  return <DriftActivity schemas={all} fromPath={Route.fullPath} />;
}

/* --------------------------- Contracts --------------------------- */

function ContractsList() {
  const { data } = useSuspenseQuery(contractsQuery());
  const rows = data.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No contracts published"
        description="Versioned contracts will appear here once the registry ships its first envelope."
      />
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((c) => {
        const artifactUrl = sameOriginApiUrl(c.path);
        return (
          <div key={c.id} className="rounded-xl border border-border bg-card p-4 mg-hover-lift">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-display text-sm font-semibold text-ink-strong">{c.id}</div>
                {c.description ? (
                  <div className="font-mono text-[10px] text-ink-muted mt-0.5">{c.description}</div>
                ) : null}
              </div>
              <FileCode className="size-4 text-ink-muted shrink-0" />
            </div>
            {c.path && artifactUrl ? (
              <div className="mt-3">
                <ExternalLink href={artifactUrl} className="text-[11px]">
                  {c.path}
                </ExternalLink>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------- Split explorer --------------------------- */

function SchemaExplorer() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(schemasQuery());
  const all = (data.data ?? []) as SchemaInfo[];

  const filtered = useMemo(() => {
    const needle = search.q.trim().toLowerCase();
    return all.filter((s) => {
      if (search.drift === "drift" && !s.drift) return false;
      if (search.drift === "stable" && s.drift) return false;
      if (!needle) return true;
      const hay = [s.name, s.id, s.url, String(s.netuid ?? "")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [all, search.drift, search.q]);

  const selectedId = search.open || filtered[0]?.id || "";
  const selected = useMemo(
    () => all.find((s) => s.id === selectedId) ?? filtered[0],
    [all, filtered, selectedId],
  );

  const stale = isStaleFreshness(data.meta?.generated_at);

  const setSearch = useCallback(
    (patch: Partial<typeof search>) =>
      navigate({
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
        // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
        resetScroll: false,
        replace: true,
      }),
    [navigate],
  );

  // Esc clears the selected schema on desktop (mobile uses the explicit "back"
  // button inside the viewer). Skips when focus is in an input/textarea so it
  // doesn't fight the global search shortcut handlers.
  useEffect(() => {
    if (!search.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      setSearch({ open: "" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search.open, setSearch]);

  return (
    <div className="space-y-4">
      {stale ? (
        <StaleBanner
          generatedAt={data.meta?.generated_at}
          refreshQueryKeys={[metagraphedQueryKey("schemas"), metagraphedQueryKey("contracts")]}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
        {/* Left rail */}
        <aside className="rounded-xl border border-border bg-card overflow-hidden flex flex-col max-h-[min(680px,70vh)]">
          <div className="border-b border-border p-3 space-y-2.5">
            {/* The shared SearchInput, which carries an aria-label (a
                placeholder is not an accessible name), replacing the bespoke
                unlabelled <input> (#6394). w-full keeps the left-rail width. */}
            <SearchInput
              value={search.q}
              onChange={(q) => setSearch({ q })}
              placeholder="Search schemas…"
              className="w-full"
            />
            <div className="flex items-center gap-1">
              {(["all", "drift", "stable"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setSearch({ drift: v })}
                  className={classNames(
                    "flex-1 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-all duration-150",
                    search.drift === v
                      ? "border-ink/40 bg-ink-strong text-paper"
                      : "border-border bg-paper text-ink-muted hover:text-ink-strong hover:border-accent/40",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {filtered.length} of {all.length}
              </div>
              {/* One-click way back to the unfiltered view for a shared
                  /schemas?q=X&drift=Y link -- clears BOTH the search text and
                  the drift pill, matching the filtersActive/ResetFiltersButton
                  convention every other list page uses (#6394). The `open` /
                  `driftDetail` selection state is a viewer target, not a filter,
                  so it is left untouched. */}
              <ResetFiltersButton
                active={!!search.q || search.drift !== "all"}
                onReset={() => setSearch({ q: "", drift: "all" })}
                bare
              />
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto divide-y divide-border/60">
            {filtered.length === 0 ? (
              <li className="p-8 text-center">
                <EmptyState title="No schemas match" />
              </li>
            ) : (
              filtered.map((s) => {
                const active = s.id === selected?.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSearch({ open: s.id })}
                      className={classNames(
                        "w-full text-left px-3 py-2.5 transition-colors",
                        active ? "bg-primary-soft" : "hover:bg-surface/60",
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          aria-hidden
                          className={classNames(
                            "size-1.5 rounded-full shrink-0",
                            s.drift ? "bg-health-warn" : "bg-health-ok",
                          )}
                        />
                        <span className="text-sm text-ink-strong truncate font-medium">
                          {s.name ?? s.id}
                        </span>
                        {s.netuid != null ? (
                          <span className="ml-auto font-mono text-[10px] text-ink-muted shrink-0">
                            SN{s.netuid}
                          </span>
                        ) : null}
                      </div>
                      <div className="font-mono text-[10px] text-ink-muted truncate mt-1">
                        {s.url ?? s.id}
                      </div>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        {/* Right viewer */}
        <section className="rounded-xl border border-border bg-card overflow-hidden min-h-[480px]">
          {selected ? (
            <SchemaViewer schema={selected} />
          ) : (
            <div className="p-12 text-center">
              <EmptyState
                title="Select a schema"
                description="Pick a schema from the left to inspect snapshot and drift."
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* --------------------------- Schema viewer --------------------------- */

function SchemaViewer({ schema }: { schema: SchemaInfo }) {
  const { copied, copy } = useCopy({ label: "schema url" });
  const navigate = useNavigate({ from: Route.fullPath });

  // No backend /schemas/{id}/diff or /snapshots endpoint exists — both 404. The
  // drift/snapshot summary is rendered inline from the record's own fields
  // (snapshot + hash + previous_hash + drift_status), so the viewer never errors
  // on a normal row.
  const artifactUrl = sameOriginApiUrl(schema.url);

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() =>
                navigate({
                  search: (p: Record<string, unknown>) => ({ ...p, open: "" }) as never,
                  replace: true,
                })
              }
              className="lg:hidden inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong mb-2"
            >
              <ChevronLeft className="size-3" /> back
            </button>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display text-xl font-semibold text-ink-strong tracking-[-0.01em]">
                {schema.name ?? schema.id}
              </h3>
              {schema.drift ? (
                <span className="inline-flex items-center rounded-full border border-health-warn/40 bg-health-warn/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-health-warn">
                  drift
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-health-ok/40 bg-health-ok/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-health-ok">
                  stable
                </span>
              )}
              {schema.netuid != null ? (
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: schema.netuid }}
                  className="font-mono text-[10px] text-accent hover:underline"
                >
                  SN{schema.netuid}
                </Link>
              ) : null}
            </div>
            <div className="font-mono text-[11px] text-ink-muted mt-1.5">
              snapshot <TimeAgo at={schema.updated_at} />
            </div>
          </div>
          {artifactUrl ? (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => copy(artifactUrl)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-paper px-3 py-1.5 text-[11px] text-ink hover:border-accent/40 transition-colors"
              >
                {copied ? <Check className="size-3 text-health-ok" /> : <Copy className="size-3" />}
                {copied ? "copied" : "copy url"}
              </button>
              <ExternalLink href={artifactUrl} className="text-[11px]">
                open
              </ExternalLink>
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5 space-y-3">
        <SchemaSnapshotSummary schema={schema} />
      </div>
    </div>
  );
}
