import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { SchemaInfo } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { RegistryEmpty } from "@/components/metagraphed/states/registry-empty";

interface Props {
  schemas: SchemaInfo[];
  /** Route fullPath used by `useNavigate({ from })`. */
  fromPath: string;
}

/**
 * Compact, scannable list of schema drift activity. Replaces the pill-row
 * ribbon — drifting schemas sit on top with a change-weight bar, additive /
 * removed counts, and freshness stamp; stable schemas collapse into a dim
 * secondary list. Click a drifting row to open the change-detail modal,
 * click a stable row to open it in the schema explorer.
 */
export function DriftActivity({ schemas, fromPath }: Props) {
  const navigate = useNavigate({ from: fromPath as "/schemas" });
  const [scope, setScope] = useState<"drifting" | "all">("drifting");

  const { drifting, stable } = useMemo(() => {
    const drifting = schemas
      .filter((s) => s.drift)
      .sort((a, b) => weight(b) - weight(a) || stampOrder(b, a));
    const stable = schemas
      .filter((s) => !s.drift)
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    return { drifting, stable };
  }, [schemas]);

  const visibleStable = scope === "all" ? stable : [];
  const total = schemas.length;

  if (total === 0) {
    return (
      <RegistryEmpty
        variant="empty"
        title="No schemas tracked yet"
        description="Drift activity appears once the registry has two snapshots of a schema to compare."
        freshnessHint="Snapshots refresh on every registry build. A schema must have a previous + current artifact to show drift."
        actions={[
          { label: "Browse schemas", to: "/schemas", primary: true },
          { label: "Open API", href: "/api/v1/schemas", external: true },
        ]}
      />
    );
  }

  const openDrift = (id: string) =>
    navigate({
      to: "/schemas",
      search: (prev: Record<string, unknown>) => ({ ...prev, driftDetail: id }) as never,
      replace: true,
    });
  const openInExplorer = (id: string) =>
    navigate({
      to: "/schemas",
      search: (prev: Record<string, unknown>) => ({ ...prev, open: id, drift: "all" }) as never,
      replace: true,
    });

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-paper/40 px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          <span
            className="inline-flex size-1.5 rounded-full bg-health-warn animate-pulse"
            aria-hidden
          />
          <span>drift activity</span>
        </div>
        <div className="font-mono text-[11px] text-ink">
          <span className="text-health-warn">{drifting.length} drifting</span>
          <span className="text-ink-muted"> · {stable.length} stable</span>
        </div>
        <div
          className="ml-auto inline-flex items-center rounded-md border border-border bg-card p-0.5"
          role="tablist"
          aria-label="Drift scope"
        >
          {(["drifting", "all"] as const).map((v) => {
            const on = scope === v;
            return (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setScope(v)}
                className={classNames(
                  "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  on ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong",
                )}
              >
                {v === "drifting" ? "drifting only" : "show all"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Drifting list */}
      {drifting.length === 0 ? (
        <div className="p-6">
          <RegistryEmpty
            variant="empty"
            title="No drift detected"
            description="All tracked schemas match their previous snapshot. New activity will appear here as soon as a published schema changes."
            actions={[{ label: "Browse schemas", onClick: () => setScope("all"), primary: true }]}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {drifting.map((s) => (
            <DriftRow key={s.id} schema={s} onClick={() => openDrift(s.id)} />
          ))}
        </ul>
      )}

      {/* Stable list (toggled) */}
      {visibleStable.length > 0 ? (
        <div className="border-t border-border bg-paper/30">
          <div className="px-4 pt-3 pb-1.5 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
            stable · {visibleStable.length}
          </div>
          <ul className="divide-y divide-border/40">
            {visibleStable.map((s) => (
              <StableRow key={s.id} schema={s} onClick={() => openInExplorer(s.id)} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-t border-border px-4 py-2 font-mono text-[10px] text-ink-muted">
        click a drifting row for change details · stable rows open in the explorer below
      </div>
    </div>
  );
}

/* ------------------------------ Rows ------------------------------ */

function DriftRow({ schema, onClick }: { schema: SchemaInfo; onClick: () => void }) {
  const w = weight(schema);
  const added = numericField(schema, ["added", "added_count", "additions"]);
  const removed = numericField(schema, ["removed", "removed_count", "deletions"]);
  const updatedAt = schema.updated_at ?? null;
  const label = schema.name ?? schema.id;

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-health-warn/5 focus:outline-none focus-visible:bg-health-warn/10"
        aria-label={`${label} drifting, open change details`}
      >
        <WeightBar weight={w} tone="warn" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-display text-[13px] font-medium text-ink-strong">
              {label}
            </span>
            {schema.netuid != null ? (
              <span className="shrink-0 rounded-full border border-border bg-paper px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted">
                SN{schema.netuid}
              </span>
            ) : null}
            {schema.drift_status ? (
              <span className="shrink-0 rounded-full border border-health-warn/30 bg-health-warn/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-widest text-health-warn">
                {schema.drift_status}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-ink-muted">
            {added != null ? <span className="text-health-ok">+{added}</span> : null}
            {removed != null ? <span className="text-health-down">−{removed}</span> : null}
            {schema.previous_hash && schema.hash ? (
              <span className="opacity-80">
                {schema.previous_hash.slice(0, 7)} → {schema.hash.slice(0, 7)}
              </span>
            ) : null}
            {updatedAt ? (
              <span className="opacity-80">
                · <TimeAgo at={updatedAt} />
              </span>
            ) : null}
          </div>
        </div>
        <ArrowUpRight className="size-4 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </li>
  );
}

function StableRow({ schema, onClick }: { schema: SchemaInfo; onClick: () => void }) {
  const label = schema.name ?? schema.id;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-surface focus:outline-none focus-visible:bg-surface"
      >
        <span
          className="inline-block size-1.5 shrink-0 rounded-full bg-ink-subtle/50"
          aria-hidden
        />
        <span className="truncate text-[12px] text-ink-muted group-hover:text-ink-strong">
          {label}
        </span>
        {schema.netuid != null ? (
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-ink-muted/70">
            SN{schema.netuid}
          </span>
        ) : null}
        <ChevronRight className="ml-auto size-3.5 text-ink-muted opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
    </li>
  );
}

/* ------------------------------ Bits ------------------------------ */

function WeightBar({ weight: w, tone }: { weight: number; tone: "warn" | "muted" }) {
  const filled = Math.min(8, Math.max(1, Math.round(w)));
  return (
    <div
      className="inline-flex items-center gap-[2px]"
      role="img"
      aria-label={`Change weight ${filled} of 8`}
    >
      {Array.from({ length: 8 }).map((_, i) => {
        const on = i < filled;
        return (
          <span
            key={i}
            aria-hidden
            className={classNames(
              "h-3 w-1 rounded-[1px]",
              on ? (tone === "warn" ? "bg-health-warn" : "bg-ink-strong") : "bg-ink-subtle/25",
            )}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------ Helpers ------------------------------ */

function weight(s: SchemaInfo): number {
  const added = numericField(s, ["added", "added_count", "additions"]) ?? 0;
  const removed = numericField(s, ["removed", "removed_count", "deletions"]) ?? 0;
  const sum = added + removed;
  if (sum > 0) {
    // log-ish scaling so a 1-line change still registers a visible bar segment
    return Math.min(8, 1 + Math.log2(sum + 1));
  }
  // Fall back to drift_status severity if numeric counts aren't on the record.
  switch ((s.drift_status ?? "").toLowerCase()) {
    case "breaking":
      return 7;
    case "additive":
      return 3;
    case "cosmetic":
      return 1;
    default:
      return 2;
  }
}

function numericField(s: SchemaInfo, keys: string[]): number | null {
  const rec = s as unknown as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function stampOrder(a: SchemaInfo, b: SchemaInfo): number {
  const at = a.updated_at ? Date.parse(a.updated_at) : 0;
  const bt = b.updated_at ? Date.parse(b.updated_at) : 0;
  return at - bt;
}
