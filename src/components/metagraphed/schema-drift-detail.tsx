import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Check, ExternalLink as ExternalIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import { Skeleton, ErrorState, EmptyState } from "@/components/metagraphed/states";
import { useCopy } from "@/hooks/use-copy";
import { apiFetch } from "@/lib/metagraphed/client";
import { metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { lineDiff, diffStats } from "@/lib/metagraphed/diff";
import { classNames } from "@/lib/metagraphed/format";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/metagraphed/freshness";
import type { SchemaInfo } from "@/lib/metagraphed/types";

interface SchemaSnapshot {
  current?: unknown;
  previous?: unknown;
  current_at?: string;
  previous_at?: string;
  current_version?: string;
  previous_version?: string;
}

interface Props {
  schema: SchemaInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user wants to drill into the full explorer for this schema. */
  onOpenInExplorer?: (id: string) => void;
}

/**
 * Modal that explains what changed in a drifting schema: a compact field/line
 * diff, a derived compatibility-impact chip row, and evidence links so the
 * user can verify against the underlying snapshots.
 */
export function SchemaDriftDetail({ schema, open, onOpenChange, onOpenInExplorer }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {schema ? (
          <DriftBody
            schema={schema}
            onOpenInExplorer={onOpenInExplorer}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DriftBody({
  schema,
  onOpenInExplorer,
  onClose,
}: {
  schema: SchemaInfo;
  onOpenInExplorer?: (id: string) => void;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy({ label: "schema url" });

  const diff = useQuery({
    queryKey: metagraphedQueryKey("schema-diff", schema.id),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<SchemaSnapshot>(
        `/api/v1/schemas/${encodeURIComponent(schema.id)}/diff`,
        { signal },
      );
      return res.data;
    },
    staleTime: 5 * 60_000,
    enabled: !!schema.id,
  });

  const freshLine = formatFreshness(schema.updated_at, "snapshot");
  const freshAbs = formatFreshnessAbsolute(schema.updated_at);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <span>{schema.name ?? schema.id}</span>
          <span className="inline-flex items-center rounded-full border border-health-warn/40 bg-health-warn/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-health-warn">
            drift
          </span>
          {schema.netuid != null ? (
            <Link
              to="/subnets/$netuid"
              params={{ netuid: schema.netuid }}
              className="font-mono text-[10px] text-accent hover:underline"
              onClick={onClose}
            >
              SN{schema.netuid}
            </Link>
          ) : null}
        </DialogTitle>
        <DialogDescription>
          <span className="font-mono text-[11px]">
            {freshLine ?? "snapshot"}
            {freshAbs ? ` · last checked ${freshAbs}` : ""}
          </span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {diff.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : diff.error ? (
          <ErrorState error={diff.error} onRetry={() => diff.refetch()} />
        ) : !diff.data ? (
          <EmptyState title="No snapshot" />
        ) : (
          <DriftDetailContent data={diff.data} schema={schema} />
        )}

        <EvidenceSection schema={schema} copied={copied} onCopy={copy} />
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        {onOpenInExplorer ? (
          <button
            type="button"
            onClick={() => {
              onOpenInExplorer(schema.id);
              onClose();
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-primary-soft px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-accent hover:bg-primary-soft/80"
          >
            open in explorer
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
        >
          close
        </button>
      </DialogFooter>
    </>
  );
}

/* --------------------------- Content --------------------------- */

function DriftDetailContent({ data, schema }: { data: SchemaSnapshot; schema: SchemaInfo }) {
  const currentStr = stringify(data.current);
  const previousStr = data.previous != null ? stringify(data.previous) : "";

  const stats = useMemo(() => {
    if (!previousStr)
      return { added: 0, removed: 0, unchanged: 0, lines: [] as ReturnType<typeof lineDiff> };
    const lines = lineDiff(previousStr, currentStr);
    const s = diffStats(lines);
    return { ...s, lines };
  }, [previousStr, currentStr]);

  if (!previousStr) {
    return (
      <div className="rounded-lg border border-border bg-paper p-4">
        <EmptyState
          title="No previous snapshot"
          description="A diff appears once a second snapshot is recorded for this schema."
        />
      </div>
    );
  }

  const compat = inferCompatibility(stats.added, stats.removed);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
        <span className="text-ink-muted">
          {data.previous_version ?? schema.previous_hash?.slice(0, 7) ?? "prev"} →{" "}
          <span className="text-ink-strong">
            {data.current_version ?? schema.hash?.slice(0, 7) ?? "current"}
          </span>
        </span>
        <span className="ml-auto inline-flex items-center gap-3">
          <span className="text-health-ok">+{stats.added}</span>
          <span className="text-health-down">−{stats.removed}</span>
          <span className="text-ink-muted">{stats.unchanged} unchanged</span>
        </span>
      </div>

      {/* Compatibility chip row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          compatibility impact
        </span>
        <CompatChip
          tone={compat.breaking ? "down" : "muted"}
          label="breaking"
          active={compat.breaking}
          info="Lines removed from the published snapshot. Likely breaks consumers expecting the prior fields."
        />
        <CompatChip
          tone={compat.additive ? "ok" : "muted"}
          label="additive"
          active={compat.additive}
          info="Lines added without removing prior content. Safe for existing clients."
        />
        <CompatChip
          tone={compat.cosmetic ? "warn" : "muted"}
          label="cosmetic"
          active={compat.cosmetic}
          info="Only formatting / ordering changes detected — no semantic deltas."
        />
        <InfoTooltip label="Inferred from line-level diff of the canonical JSON. Use the diff below to verify field semantics." />
      </div>

      {/* Diff distribution bar */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div style={{ width: `${pct(stats.added, stats)}%` }} className="bg-health-ok" />
        <div style={{ width: `${pct(stats.removed, stats)}%` }} className="bg-health-down" />
        <div style={{ width: `${pct(stats.unchanged, stats)}%` }} className="bg-ink-subtle/40" />
      </div>

      {/* Compact line diff */}
      <div className="max-h-[340px] overflow-auto rounded-lg border border-border bg-paper font-mono text-[11px]">
        <table className="w-full">
          <tbody>
            {stats.lines.map((l, idx) => {
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

function CompatChip({
  label,
  tone,
  active,
  info,
}: {
  label: string;
  tone: "ok" | "warn" | "down" | "muted";
  active: boolean;
  info: string;
}) {
  const cls =
    tone === "ok"
      ? "border-health-ok/40 text-health-ok bg-health-ok/10"
      : tone === "warn"
        ? "border-health-warn/40 text-health-warn bg-health-warn/10"
        : tone === "down"
          ? "border-health-down/40 text-health-down bg-health-down/10"
          : "border-border bg-paper text-ink-muted";
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        active ? cls : "border-border bg-paper text-ink-muted/60",
      )}
      title={info}
    >
      {label}
    </span>
  );
}

function EvidenceSection({
  schema,
  copied,
  onCopy,
}: {
  schema: SchemaInfo;
  copied: boolean;
  onCopy: (v: string) => void;
}) {
  const rec = schema as unknown as Record<string, unknown>;
  const links: Array<{ label: string; href: string }> = [];
  for (const key of ["url", "snapshot_url", "prev_snapshot_url", "artifact_path"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) {
      links.push({ label: key.replace(/_/g, " "), href: v });
    }
  }
  const evidence = rec.evidence;
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      const u = (e as Record<string, unknown>)?.url;
      if (typeof u === "string" && u.startsWith("http")) {
        links.push({
          label: String((e as Record<string, unknown>)?.source ?? "evidence"),
          href: u,
        });
      }
    }
  }

  if (links.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        evidence &amp; sources
        <InfoTooltip label="Where the snapshot diff was derived from. Open or copy these to verify the change against the source." />
      </div>
      <ul className="space-y-1.5">
        {links.map((l) => (
          <li key={l.href} className="flex items-center gap-2 font-mono text-[11px] text-ink">
            <span className="shrink-0 rounded border border-border bg-paper px-1.5 py-0.5 text-[9.5px] uppercase tracking-widest text-ink-muted">
              {l.label}
            </span>
            {l.href.startsWith("http") ? (
              <ExternalLink href={l.href} className="truncate text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <ExternalIcon className="size-3" />
                  <span className="truncate">{l.href}</span>
                </span>
              </ExternalLink>
            ) : (
              <span className="truncate text-ink-muted">{l.href}</span>
            )}
            <button
              type="button"
              onClick={() => onCopy(l.href)}
              className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-paper px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink-strong"
              aria-label={`Copy ${l.label}`}
            >
              {copied ? <Check className="size-3 text-health-ok" /> : <Copy className="size-3" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------- Helpers --------------------------- */

function inferCompatibility(added: number, removed: number) {
  const breaking = removed > 0;
  const additive = added > 0 && removed === 0;
  const cosmetic = added === 0 && removed === 0;
  return { breaking, additive, cosmetic };
}

function pct(n: number, s: { added: number; removed: number; unchanged: number }) {
  const total = s.added + s.removed + s.unchanged || 1;
  return (n / total) * 100;
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
