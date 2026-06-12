import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { fallback } from "@tanstack/zod-adapter";
import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { ExternalLink } from "@/components/metagraphed/external-link";
import {
  EmptyState,
  ErrorState,
  PageHeading,
  Skeleton,
  StaleBanner,
} from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { schemasQuery, contractsQuery } from "@/lib/metagraphed/queries";
import { apiFetch } from "@/lib/metagraphed/client";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatRelative, isStaleFreshness } from "@/lib/metagraphed/format";
import { lineDiff, diffStats } from "@/lib/metagraphed/diff";
import type { SchemaInfo } from "@/lib/metagraphed/types";

const schemasSearchSchema = z.object({
  drift: fallback(z.enum(["all", "drift", "stable"]), "all").default("all"),
  open: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/schemas")({
  validateSearch: zodValidator(schemasSearchSchema),
  head: () => ({
    meta: [
      { title: "Schemas — Metagraphed" },
      {
        name: "description",
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
      <PageHeading
        eyebrow="Operations"
        title="Schemas & contracts"
        description="JSON Schema is canonical truth. Drift compares the current snapshot to the previous published version."
        right={
          <CopyableCode
            label="openapi"
            value={`${API_BASE}/api/v1/openapi.json`}
            truncate={false}
          />
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-16 w-full" />}>
          <SchemasKpiStrip />
        </Suspense>
      </QueryErrorBoundary>
      <div className="mt-6 space-y-8">
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Contracts
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-24 w-full" />}>
              <ContractsList />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Schema index
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <SchemasList />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter
        paths={["/api/v1/schemas", "/api/v1/contracts"]}
        artifacts={["/metagraph/openapi.json"]}
      />
    </AppShell>
  );
}

function ContractsList() {
  const { data } = useSuspenseQuery(contractsQuery());
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="No contracts published" />;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((c) => (
        <div key={c.id} className="rounded border border-border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-display text-sm font-semibold text-ink-strong">
                {c.name ?? c.id}
              </div>
              <div className="font-mono text-[10px] text-ink-muted">{c.version ?? "—"}</div>
            </div>
            <FileCode className="size-4 text-ink-muted" />
          </div>
          {c.url ? (
            <div className="mt-2">
              <ExternalLink href={c.url} className="text-[11px]">
                {c.url}
              </ExternalLink>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SchemasList() {
  const search = Route.useSearch();
  const { data } = useSuspenseQuery(schemasQuery());
  const all = (data.data ?? []) as SchemaInfo[];
  const filtered = all.filter((s) => {
    if (search.drift === "drift") return !!s.drift;
    if (search.drift === "stable") return !s.drift;
    return true;
  });
  const stale = isStaleFreshness(data.meta?.generated_at);

  return (
    <div className="space-y-3">
      {stale ? <StaleBanner generatedAt={data.meta?.generated_at} /> : null}
      <div className="flex items-center gap-2 text-xs">
        <FilterPill value="all" current={search.drift} label="All" />
        <FilterPill value="drift" current={search.drift} label="Drift only" />
        <FilterPill value="stable" current={search.drift} label="Stable" />
      </div>
      {filtered.length === 0 ? (
        <EmptyState title="No schemas match this filter" />
      ) : (
        <ul className="space-y-2">
          {filtered.map((s) => (
            <SchemaRow key={s.id} schema={s} initiallyOpen={search.open === s.id} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterPill({ value, current, label }: { value: string; current: string; label: string }) {
  const active = value === current;
  return (
    <Link
      to="/schemas"
      search={(prev: Record<string, unknown>) => ({ ...prev, drift: value }) as never}
      className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest ${active ? "bg-ink-strong text-paper border-ink-strong" : "border-border bg-card text-ink-muted hover:border-ink/30"}`}
    >
      {label}
    </Link>
  );
}

function SchemaRow({ schema, initiallyOpen }: { schema: SchemaInfo; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <li className="rounded border border-border bg-card overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface/40"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-ink-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-ink-muted" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-strong truncate">{schema.name ?? schema.id}</span>
            {schema.drift ? (
              <span className="rounded border border-health-warn/30 bg-health-warn/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-health-warn">
                drift
              </span>
            ) : (
              <span className="rounded border border-border bg-paper px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-muted">
                stable
              </span>
            )}
            {schema.netuid != null ? (
              <span className="font-mono text-[10px] text-ink-muted">SN{schema.netuid}</span>
            ) : null}
          </div>
          <div className="font-mono text-[10px] text-ink-muted truncate">
            {schema.url ?? schema.id}
          </div>
        </div>
        <span className="font-mono text-[10px] text-ink-muted shrink-0">
          <TimeAgo at={schema.updated_at} />
        </span>
      </button>
      {open ? (
        <div className="border-t border-border bg-paper">
          <QueryErrorBoundary>
            <Suspense
              fallback={
                <div className="p-4">
                  <Skeleton className="h-24 w-full" />
                </div>
              }
            >
              <DriftView schema={schema} />
            </Suspense>
          </QueryErrorBoundary>
        </div>
      ) : null}
    </li>
  );
}

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

function DriftView({ schema }: { schema: SchemaInfo }) {
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");

  // List of available snapshots (best effort — empty if endpoint absent).
  const snapshots = useQuery({
    queryKey: ["metagraphed", "schema-snapshots", schema.id],
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
    queryKey: ["metagraphed", "schema-diff", schema.id, a, b],
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
        if (schema.url) {
          const r = await fetch(schema.url, { signal });
          const text = await r.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep as text */
          }
          return { current: parsed } as SchemaSnapshot;
        }
        throw new Error("No diff endpoint and no schema URL");
      }
    },
    staleTime: 5 * 60_000,
  });

  if (diff.isLoading)
    return (
      <div className="p-4">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (diff.error)
    return (
      <div className="p-4">
        <ErrorState error={diff.error} onRetry={() => diff.refetch()} />
      </div>
    );
  const data = diff.data;
  if (!data)
    return (
      <div className="p-4">
        <EmptyState title="No snapshot" />
      </div>
    );

  const currentStr = stringify(data.current);
  const previousStr = data.previous != null ? stringify(data.previous) : "";

  return (
    <div className="p-4 space-y-3">
      {snapList.length >= 2 ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-paper p-2 text-[11px]">
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

      {!previousStr ? (
        <>
          <div className="flex items-center gap-3 text-[11px] font-mono text-ink-muted">
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
            <pre className="mt-2 max-h-96 overflow-auto rounded border border-border bg-card p-3 font-mono text-[11px] text-ink-strong whitespace-pre">
              {currentStr.slice(0, 5000)}
              {currentStr.length > 5000 ? "\n…(truncated)" : ""}
            </pre>
          ) : null}
        </>
      ) : (
        <DiffPanel previousStr={previousStr} currentStr={currentStr} data={data} />
      )}
    </div>
  );
}

function DiffPanel({
  previousStr,
  currentStr,
  data,
}: {
  previousStr: string;
  currentStr: string;
  data: SchemaSnapshot;
}) {
  const lines = lineDiff(previousStr, currentStr);
  const stats = diffStats(lines);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
        <span className="text-ink-muted">
          previous: {data.previous_version ?? "—"} · <TimeAgo at={data.previous_at} />
        </span>
        <span className="text-ink-muted">→</span>
        <span className="text-ink-strong">
          current: {data.current_version ?? "—"} · <TimeAgo at={data.current_at} />
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="text-health-ok">+{stats.added}</span>
          <span className="text-health-down">−{stats.removed}</span>
          <span className="text-ink-muted">{stats.unchanged} unchanged</span>
        </span>
      </div>
      <div className="max-h-[480px] overflow-auto rounded border border-border bg-card font-mono text-[11px]">
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
    </>
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

function SchemasKpiStrip() {
  const { data } = useSuspenseQuery(schemasQuery());
  const rows = (data.data ?? []) as SchemaInfo[];
  const drift = rows.filter((s) => s.drift).length;
  const stable = rows.length - drift;
  const subnets = new Set(rows.map((s) => s.netuid).filter((n) => n != null)).size;
  const stats: Array<{ label: string; value: string; tone?: string }> = [
    { label: "Schemas", value: String(rows.length) },
    { label: "Stable", value: String(stable), tone: "text-health-ok" },
    { label: "Drift", value: String(drift), tone: drift ? "text-health-warn" : undefined },
    { label: "Subnets covered", value: String(subnets) },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded overflow-hidden">
      {stats.map((s) => (
        <div key={s.label} className="bg-card p-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {s.label}
          </div>
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
