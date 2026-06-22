import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, useState } from "react";
import { fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { ChevronLeft, FileCode, Copy, Check } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { Skeleton, StaleBanner, ErrorState, EmptyState } from "@/components/metagraphed/states";
import { TableState } from "@/components/metagraphed/table-state";
import { PageHero } from "@/components/metagraphed/page-hero";
import { PageSection } from "@/components/metagraphed/page-section";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { AnimatedNumber } from "@/components/metagraphed/animated-number";
import { MethodologyCallout } from "@/components/metagraphed/methodology-callout";
import { SchemaDriftMatrix } from "@/components/metagraphed/analytics/schema-drift-matrix";
import { DriftActivity } from "@/components/metagraphed/analytics/drift-activity";
import { SchemaDriftDetail } from "@/components/metagraphed/schema-drift-detail";
import { useCopy } from "@/hooks/use-copy";
import { schemasQuery, contractsQuery, metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { apiFetch } from "@/lib/metagraphed/client";
import { API_BASE } from "@/lib/metagraphed/config";
import { isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { lineDiff, diffStats } from "@/lib/metagraphed/diff";
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
  const stable = schemas.length - drift;
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
        <CopyableCode label="openapi" value={`${API_BASE}/api/v1/openapi.json`} truncate={false} />
      }
      kpis={[
        { label: "Schemas", value: <AnimatedNumber value={schemas.length} /> },
        {
          label: "Stable",
          value: <AnimatedNumber value={stable} />,
          hint: schemas.length ? `${Math.round((stable / schemas.length) * 100)}%` : undefined,
        },
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
      <TableState
        variant="empty"
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

  const setSearch = (patch: Partial<typeof search>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      replace: true,
    });

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.open]);

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
            <input
              value={search.q}
              onChange={(e) => setSearch({ q: e.target.value })}
              placeholder="Search schemas…"
              className="w-full rounded-full border border-border bg-paper px-3 py-1.5 text-[12px] focus:outline-none focus:border-accent/50"
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
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {filtered.length} of {all.length}
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

interface SchemaSnapshot {
  current?: unknown;
  previous?: unknown;
  current_at?: string;
  previous_at?: string;
  current_version?: string;
  previous_version?: string;
}

interface SnapshotMeta {
  version?: string;
  id?: string;
  at?: string;
}

function snapshotKey(s: SnapshotMeta, idx: number): string {
  return s.version ?? s.id ?? s.at ?? `snap-${idx}`;
}

function SchemaViewer({ schema }: { schema: SchemaInfo }) {
  const { copied, copy } = useCopy({ label: "schema url" });
  const navigate = useNavigate({ from: Route.fullPath });

  // Snapshot a/b selectors (KEEP-OURS): choose which previous/current snapshot
  // to diff. Reset whenever the selected schema changes.
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  useEffect(() => {
    setA("");
    setB("");
  }, [schema.id]);

  const artifactUrl = sameOriginApiUrl(schema.url);

  // List of available snapshots (best effort — empty if endpoint absent).
  const snapshots = useQuery({
    queryKey: metagraphedQueryKey("schema-snapshots", schema.id),
    queryFn: async ({ signal }) => {
      try {
        const res = await apiFetch<SnapshotMeta[]>(
          `/api/v1/schemas/${encodeURIComponent(schema.id)}/snapshots`,
          { signal },
        );
        return Array.isArray(res.data) ? res.data : [];
      } catch {
        return [] as SnapshotMeta[];
      }
    },
    staleTime: 5 * 60_000,
  });

  const snapList = snapshots.data ?? [];

  const diff = useQuery({
    queryKey: metagraphedQueryKey("schema-diff", schema.id, a, b),
    queryFn: async ({ signal }) => {
      const params: Record<string, string> = {};
      if (a) params.a = a;
      if (b) params.b = b;
      try {
        const res = await apiFetch<SchemaSnapshot>(
          `/api/v1/schemas/${encodeURIComponent(schema.id)}/diff`,
          { signal, params },
        );
        return res.data;
      } catch {
        if (!artifactUrl) {
          throw new Error("No diff endpoint and no trusted same-origin schema URL");
        }
        const r = await fetch(artifactUrl, { signal });
        const text = await r.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep as text */
        }
        return { current: parsed } as SchemaSnapshot;
      }
    },
    staleTime: 5 * 60_000,
  });

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
        {/* Snapshot a/b selector (KEEP-OURS): only shown when ≥2 snapshots exist. */}
        {snapList.length >= 2 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-paper p-2 text-[11px]">
            <span className="font-mono uppercase tracking-widest text-ink-muted">previous</span>
            <select
              value={a}
              onChange={(e) => setA(e.target.value)}
              className="rounded border border-border bg-card px-2 py-1 font-mono text-[11px] focus:outline-none"
            >
              <option value="">auto (one before current)</option>
              {snapList.map((s, i) => (
                <option key={snapshotKey(s, i)} value={s.version ?? s.id ?? s.at ?? ""}>
                  {s.version ?? s.id ?? "snap"} · {s.at ?? "—"}
                </option>
              ))}
            </select>
            <span className="text-ink-muted">→</span>
            <span className="font-mono uppercase tracking-widest text-ink-muted">current</span>
            <select
              value={b}
              onChange={(e) => setB(e.target.value)}
              className="rounded border border-border bg-card px-2 py-1 font-mono text-[11px] focus:outline-none"
            >
              <option value="">latest</option>
              {snapList.map((s, i) => (
                <option key={snapshotKey(s, i)} value={s.version ?? s.id ?? s.at ?? ""}>
                  {s.version ?? s.id ?? "snap"} · {s.at ?? "—"}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setA("");
                setB("");
              }}
              className="ml-auto text-[11px] text-ink-muted hover:text-ink-strong underline underline-offset-2"
            >
              reset
            </button>
          </div>
        ) : null}

        {diff.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : diff.error ? (
          <ErrorState error={diff.error} onRetry={() => diff.refetch()} />
        ) : !diff.data ? (
          <EmptyState title="No snapshot" />
        ) : (
          <DriftBody data={diff.data} />
        )}
      </div>
    </div>
  );
}

function DriftBody({ data }: { data: SchemaSnapshot }) {
  const currentStr = stringify(data.current);
  const previousStr = data.previous != null ? stringify(data.previous) : "";

  if (!previousStr) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-ink-muted">
          <span>current: {data.current_version ?? "—"}</span>
          <span>·</span>
          <span>
            captured <TimeAgo at={data.current_at} />
          </span>
        </div>
        <EmptyState
          title="No previous version recorded"
          description="Drift can only be shown once a second snapshot is published."
        />
        {currentStr ? (
          <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-paper p-4 font-mono text-[11px] text-ink-strong whitespace-pre leading-relaxed">
            {currentStr.slice(0, 5000)}
            {currentStr.length > 5000 ? "\n…(truncated)" : ""}
          </pre>
        ) : null}
      </div>
    );
  }

  const lines = lineDiff(previousStr, currentStr);
  const stats = diffStats(lines);
  const total = stats.added + stats.removed + stats.unchanged || 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
        <span className="text-ink-muted">
          previous: {data.previous_version ?? "—"} · <TimeAgo at={data.previous_at} />
        </span>
        <span className="text-ink-muted">→</span>
        <span className="text-ink-strong">
          current: {data.current_version ?? "—"} · <TimeAgo at={data.current_at} />
        </span>
        <span className="ml-auto inline-flex items-center gap-3">
          <span className="text-health-ok">+{stats.added}</span>
          <span className="text-health-down">−{stats.removed}</span>
          <span className="text-ink-muted">{stats.unchanged} unchanged</span>
        </span>
      </div>
      {/* Diff distribution bar */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div style={{ width: `${(stats.added / total) * 100}%` }} className="bg-health-ok" />
        <div style={{ width: `${(stats.removed / total) * 100}%` }} className="bg-health-down" />
        <div
          style={{ width: `${(stats.unchanged / total) * 100}%` }}
          className="bg-ink-subtle/40"
        />
      </div>

      <div className="max-h-[480px] overflow-auto rounded-lg border border-border bg-paper font-mono text-[11px]">
        <table className="w-full">
          <tbody>
            {lines.map((l, idx) => {
              const bg =
                l.kind === "add" ? "bg-health-ok/5" : l.kind === "del" ? "bg-health-down/5" : "";
              const marker = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
              const color =
                l.kind === "add"
                  ? "text-health-ok"
                  : l.kind === "del"
                    ? "text-health-down"
                    : "text-ink";
              return (
                <tr key={idx} className={bg}>
                  <td className="select-none px-2 py-0.5 text-right text-ink-muted w-10 border-r border-border">
                    {"aLine" in l ? l.aLine : ""}
                  </td>
                  <td className="select-none px-2 py-0.5 text-right text-ink-muted w-10 border-r border-border">
                    {"bLine" in l ? l.bLine : ""}
                  </td>
                  <td className={`px-2 py-0.5 ${color}`}>
                    <span className="select-none mr-2 opacity-50">{marker}</span>
                    <span className="whitespace-pre-wrap break-all">{l.text || " "}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
