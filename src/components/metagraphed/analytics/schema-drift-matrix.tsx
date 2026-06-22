import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertOctagon,
  PlusCircle,
  Check,
  HelpCircle,
  Pin,
  ExternalLink as ExtIcon,
} from "lucide-react";
import { schemasQuery, evidenceQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import type { SchemaInfo, EvidenceItem } from "@/lib/metagraphed/types";

type DriftKind = "breaking" | "additive" | "unchanged" | "unknown";

const KIND_TONE: Record<DriftKind, { dot: string; fill: string; ring: string; label: string }> = {
  breaking: {
    dot: "bg-health-down",
    fill: "bg-health-down/15 hover:bg-health-down/25 border-health-down/40",
    ring: "ring-health-down/60",
    label: "Breaking",
  },
  additive: {
    dot: "bg-health-warn",
    fill: "bg-health-warn/15 hover:bg-health-warn/25 border-health-warn/40",
    ring: "ring-health-warn/60",
    label: "Additive",
  },
  unchanged: {
    dot: "bg-health-ok",
    fill: "bg-health-ok/10 hover:bg-health-ok/20 border-health-ok/30",
    ring: "ring-health-ok/60",
    label: "Unchanged",
  },
  unknown: {
    dot: "bg-ink-subtle",
    fill: "bg-border/30 hover:bg-border/60 border-border",
    ring: "ring-border",
    label: "Unknown",
  },
};

function classifyDrift(s: SchemaInfo): DriftKind {
  const raw = (s.drift_status ?? "").toLowerCase();
  if (!raw && !s.drift) return "unchanged";
  if (raw.includes("break") || raw.includes("incompat") || raw.includes("major")) return "breaking";
  if (
    raw.includes("add") ||
    raw.includes("minor") ||
    raw.includes("patch") ||
    raw.includes("compat")
  )
    return "additive";
  if (raw.includes("unchanged") || raw === "stable") return "unchanged";
  if (s.drift) return "additive";
  return "unknown";
}

interface Props {
  /** Hook into the existing schemas explorer: clicking a tile sets ?open=id. */
  setOpenSchema?: (id: string) => void;
}

/**
 * Dense drift matrix: each schema rendered as a tile, grouped by subnet,
 * tinted by drift class (breaking / additive / unchanged / unknown). A
 * filter toolbar narrows by class and lets you jump straight to source
 * evidence for the highlighted item.
 */
export function SchemaDriftMatrix({ setOpenSchema }: Props) {
  const navigate = useNavigate();
  const { data: sRes } = useSuspenseQuery(schemasQuery());
  const { data: eRes } = useSuspenseQuery(evidenceQuery({ limit: 500 }));
  const schemas = (sRes.data ?? []) as SchemaInfo[];
  const evidence = (eRes.data ?? []) as EvidenceItem[];

  const [filter, setFilter] = useState<"all" | DriftKind>("all");

  const classified = useMemo(() => {
    return schemas.map((s) => ({ schema: s, kind: classifyDrift(s) }));
  }, [schemas]);

  const counts = useMemo(() => {
    const c: Record<DriftKind | "all", number> = {
      all: classified.length,
      breaking: 0,
      additive: 0,
      unchanged: 0,
      unknown: 0,
    };
    for (const it of classified) c[it.kind] += 1;
    return c;
  }, [classified]);

  const grouped = useMemo(() => {
    const map = new Map<string, { netuid: number | null; items: typeof classified }>();
    for (const it of classified) {
      if (filter !== "all" && it.kind !== filter) continue;
      const nu = it.schema.netuid ?? null;
      const key = nu == null ? "—" : `SN${nu}`;
      const entry = map.get(key) ?? { netuid: nu, items: [] as typeof classified };
      entry.items.push(it);
      map.set(key, entry);
    }
    return Array.from(map.entries())
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => {
        const ab = a.items.filter((x) => x.kind === "breaking").length;
        const bb = b.items.filter((x) => x.kind === "breaking").length;
        if (ab !== bb) return bb - ab;
        return (a.netuid ?? 1e9) - (b.netuid ?? 1e9);
      });
  }, [classified, filter]);

  // Evidence lookup: prefer evidence rows tagged with the same netuid AND source url match,
  // else fall back to the first evidence row mentioning the schema's URL.
  const evidenceFor = (s: SchemaInfo): EvidenceItem | undefined => {
    if (!evidence.length) return undefined;
    const url = s.url ?? "";
    return (
      evidence.find((e) => e.netuid === s.netuid && url && (e.url ?? "").includes(url)) ??
      evidence.find((e) => url && (e.url ?? "").includes(url)) ??
      evidence.find((e) => e.netuid === s.netuid)
    );
  };

  const onOpen = (s: SchemaInfo) => {
    if (setOpenSchema) setOpenSchema(s.id);
    else navigate({ to: "/schemas", search: { open: s.id } as never, replace: false });
  };

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-paper/30">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Drift matrix
          </div>
          <h3 className="mt-0.5 font-display text-base font-semibold text-ink-strong">
            Every tracked schema, classified by change type
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(["all", "breaking", "additive", "unchanged", "unknown"] as const).map((k) => {
            const tone =
              k === "breaking"
                ? "border-health-down/50 text-health-down"
                : k === "additive"
                  ? "border-health-warn/50 text-health-warn"
                  : k === "unchanged"
                    ? "border-health-ok/50 text-health-ok"
                    : "border-border text-ink-muted";
            const active = filter === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={classNames(
                  "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                  active
                    ? `${tone} bg-paper`
                    : "border-border text-ink-muted hover:text-ink-strong",
                )}
                aria-pressed={active}
              >
                {k}{" "}
                <span className="tabular-nums opacity-75">{counts[k as keyof typeof counts]}</span>
              </button>
            );
          })}
          <InfoTooltip label="Heuristic classification of drift_status: 'breaking' contains 'break/incompat/major'; 'additive' contains 'add/minor/patch/compat'; otherwise we mark it as unchanged or unknown." />
        </div>
      </header>

      {grouped.length === 0 ? (
        <div className="p-8 text-center font-mono text-[11px] text-ink-muted">
          No schemas match this filter.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {grouped.map((g) => (
            <div key={g.label} className="grid grid-cols-[88px_1fr] gap-3 px-4 py-3 items-start">
              <div className="font-mono text-[11px] text-ink-muted pt-1">
                {g.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: g.netuid }}
                    className="hover:text-accent"
                  >
                    {g.label}
                  </Link>
                ) : (
                  g.label
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map(({ schema, kind }) => {
                  const tone = KIND_TONE[kind];
                  const ev = evidenceFor(schema);
                  return (
                    <DriftTile
                      key={schema.id}
                      schema={schema}
                      kind={kind}
                      tone={tone}
                      evidence={ev}
                      onOpen={() => onOpen(schema)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-paper/30 px-4 py-2 font-mono text-[10px] text-ink-muted">
        <div className="flex items-center gap-3">
          <KindLegend kind="breaking" />
          <KindLegend kind="additive" />
          <KindLegend kind="unchanged" />
          <KindLegend kind="unknown" />
        </div>
        <div className="inline-flex items-center gap-1">
          <Pin className="size-3" aria-hidden /> click a tile to inspect snapshot &amp; diff
        </div>
      </footer>
    </section>
  );
}

function DriftTile({
  schema,
  kind,
  tone,
  evidence,
  onOpen,
}: {
  schema: SchemaInfo;
  kind: DriftKind;
  tone: (typeof KIND_TONE)[DriftKind];
  evidence?: EvidenceItem;
  onOpen: () => void;
}) {
  const label = schema.name ?? schema.surface_id ?? schema.id;
  const Icon =
    kind === "breaking"
      ? AlertOctagon
      : kind === "additive"
        ? PlusCircle
        : kind === "unchanged"
          ? Check
          : HelpCircle;
  return (
    <span className="group/tile relative inline-flex items-stretch">
      <button
        type="button"
        onClick={onOpen}
        className={classNames(
          "flex items-center gap-1.5 rounded border px-2 py-1 transition-all",
          tone.fill,
          "hover:ring-2",
          tone.ring,
        )}
        title={`${tone.label} · ${label}${schema.updated_at ? ` · updated ${new Date(schema.updated_at).toISOString().slice(0, 10)}` : ""}`}
      >
        <Icon
          className={classNames(
            "size-3 shrink-0",
            kind === "breaking" && "text-health-down",
            kind === "additive" && "text-health-warn",
            kind === "unchanged" && "text-health-ok",
            kind === "unknown" && "text-ink-muted",
          )}
          aria-hidden
        />
        <span className="font-mono text-[11px] text-ink-strong truncate max-w-[180px]">
          {label}
        </span>
        {schema.updated_at ? (
          <span className="font-mono text-[9px] text-ink-muted shrink-0">
            <TimeAgo at={schema.updated_at} />
          </span>
        ) : null}
      </button>
      {evidence?.url ? (
        <a
          href={evidence.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={classNames(
            "inline-flex items-center gap-1 rounded-r border-y border-r px-1.5 -ml-px font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted hover:text-accent transition-colors",
            tone.fill,
          )}
          title={`Source evidence${evidence.source ? ` · ${evidence.source}` : ""}${evidence.recorded_at ? ` · recorded ${new Date(evidence.recorded_at).toISOString().slice(0, 10)}` : ""}`}
        >
          ev <ExtIcon className="size-2.5" aria-hidden />
        </a>
      ) : null}
    </span>
  );
}

function KindLegend({ kind }: { kind: DriftKind }) {
  const t = KIND_TONE[kind];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={classNames("inline-block size-2 rounded-sm", t.dot)} aria-hidden />
      {t.label.toLowerCase()}
    </span>
  );
}
