import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileCode, GitCompare } from "lucide-react";
import { subnetSchemasQuery } from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";
import { TimeAgo, CopyableCode } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";

function driftTone(status?: string): string {
  switch (status) {
    case "drift":
    case "changed":
      return "border-health-warn/40 bg-health-warn/10 text-health-warn";
    case "broken":
    case "removed":
    case "failed":
      return "border-health-down/40 bg-health-down/10 text-health-down";
    case "unchanged":
    case "captured":
      return "border-health-ok/30 bg-health-ok/10 text-health-ok";
    default:
      return "border-ink-subtle bg-paper text-ink-muted";
  }
}

/**
 * Compact schema-drift summary for a subnet profile. Joined client-side from
 * /api/v1/schemas until the profile endpoint exposes native drift fields.
 *
 * Props:
 *  - `compact` shows a one-line summary suitable for the Overview tab.
 *  - Without it, renders a full per-schema list.
 */
export function SchemaDriftSummary({ netuid, compact }: { netuid: number; compact?: boolean }) {
  const { data, meta } = useSuspenseQuery(subnetSchemasQuery(netuid)).data;
  const schemas = data ?? [];
  const generated = meta?.generated_at;

  if (schemas.length === 0) {
    return (
      <EmptyState
        title="No tracked schemas"
        description="OpenAPI/JSON Schema URLs verified for this subnet will show here once captured."
        lastChecked={generated}
        action={{
          label: "Browse all schemas",
          href: "/schemas",
        }}
      />
    );
  }

  const drift = schemas.filter((s) => s.drift_status && s.drift_status !== "unchanged");
  const counts: Record<string, number> = {};
  for (const s of schemas) {
    const k = s.drift_status ?? "unknown";
    counts[k] = (counts[k] ?? 0) + 1;
  }

  if (compact) {
    return (
      <div className="rounded border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <GitCompare className="size-3.5 text-ink-muted" />
            <span className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong">
              Schema drift
            </span>
            <span className="font-mono text-[10px] text-ink-muted">{schemas.length} tracked</span>
          </div>
          <Link
            to="/subnets/$netuid"
            params={{ netuid: netuid }}
            search={(prev: Record<string, unknown>) => ({ ...prev, tab: "schemas" })}
            className="font-mono text-[10px] text-ink-muted hover:text-ink-strong"
          >
            view all →
          </Link>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(counts).map(([k, v]) => (
            <span
              key={k}
              className={classNames(
                "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                driftTone(k),
              )}
            >
              {k} · {v}
            </span>
          ))}
        </div>
        {drift.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-[11px] text-ink-muted">
            {drift.slice(0, 3).map((s) => (
              <li key={s.id} className="truncate font-mono">
                · {s.name ?? s.url}
              </li>
            ))}
            {drift.length > 3 ? (
              <li className="text-[10px]">+ {drift.length - 3} more changed</li>
            ) : null}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {schemas.map((s) => (
        <li key={s.id} className="rounded border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode className="size-3.5 text-ink-muted shrink-0" />
              <span className="truncate text-sm font-medium text-ink-strong">
                {s.name ?? s.url}
              </span>
              <span
                className={classNames(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  driftTone(s.drift_status),
                )}
              >
                {s.drift_status ?? "unknown"}
              </span>
            </div>
            <span className="font-mono text-[10px] text-ink-muted shrink-0">
              <TimeAgo at={s.updated_at} />
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {s.url ? (
              <CopyableCode label="schema" value={s.url} truncate={false} className="w-full" />
            ) : null}
            {s.artifact_path ? (
              <CopyableCode
                label="artifact"
                value={`${API_BASE}${s.artifact_path}`}
                truncate={false}
                className="w-full"
              />
            ) : null}
          </div>
          {s.hash && s.previous_hash && s.hash !== s.previous_hash ? (
            <div className="mt-1.5 font-mono text-[10px] text-ink-muted truncate">
              hash {s.previous_hash.slice(0, 8)} → {s.hash.slice(0, 8)}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
