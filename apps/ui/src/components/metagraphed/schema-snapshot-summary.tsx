import { TimeAgo, InfoTooltip } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import type { SchemaInfo } from "@/lib/metagraphed/types";

/**
 * Inline drift/snapshot summary rendered ENTIRELY from the schema record's own
 * fields (snapshot + hash + previous_hash + drift_status). There is no backend
 * /schemas/{id}/diff or /snapshots endpoint, so this never fires a network
 * request — it cannot 404 into an ErrorState on a normal row.
 */

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

interface SnapshotFields {
  title?: string;
  version?: string;
  openapi_version?: string;
  path_count?: number;
  component_schema_count?: number;
  server_count?: number;
  tag_count?: number;
  auth_required?: boolean;
  observed_at?: string;
}

function readSnapshot(schema: SchemaInfo): SnapshotFields {
  const raw = (schema as Record<string, unknown>).snapshot;
  if (!raw || typeof raw !== "object") return {};
  const s = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    title: str(s.title),
    version: str(s.version),
    openapi_version: str(s.openapi_version),
    path_count: num(s.path_count),
    component_schema_count: num(s.component_schema_count),
    server_count: num(s.server_count),
    tag_count: num(s.tag_count),
    auth_required: typeof s.auth_required === "boolean" ? s.auth_required : undefined,
    observed_at: str(s.observed_at),
  };
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-paper px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] text-ink-strong tabular-nums truncate">
        {value}
      </div>
    </div>
  );
}

export function SchemaSnapshotSummary({ schema }: { schema: SchemaInfo }) {
  const snap = readSnapshot(schema);
  const driftStatus = schema.drift_status ?? (schema.drift ? "changed" : "unchanged");
  const hashChanged =
    !!schema.hash && !!schema.previous_hash && schema.hash !== schema.previous_hash;

  const metrics: Array<{ label: string; value: string }> = [];
  if (snap.version) metrics.push({ label: "version", value: snap.version });
  if (snap.openapi_version) metrics.push({ label: "openapi", value: snap.openapi_version });
  if (snap.path_count != null) metrics.push({ label: "paths", value: String(snap.path_count) });
  if (snap.component_schema_count != null)
    metrics.push({ label: "components", value: String(snap.component_schema_count) });
  if (snap.tag_count != null) metrics.push({ label: "tags", value: String(snap.tag_count) });
  if (snap.server_count != null)
    metrics.push({ label: "servers", value: String(snap.server_count) });
  if (snap.auth_required != null)
    metrics.push({ label: "auth", value: snap.auth_required ? "required" : "none" });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span
          className={classNames(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-widest",
            driftTone(driftStatus),
          )}
        >
          {driftStatus}
        </span>
        <span className="text-ink-muted">
          captured <TimeAgo at={snap.observed_at ?? schema.updated_at} />
        </span>
        <InfoTooltip label="Snapshot summary derived from the published schema record. Full line-level diffs require snapshot history, which the registry does not currently expose." />
      </div>

      {/* Hash transition (the registry's canonical drift signal). */}
      <div className="rounded-lg border border-border bg-paper p-3 font-mono text-[11px]">
        {hashChanged ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted">{schema.previous_hash!.slice(0, 12)}</span>
            <span className="text-ink-muted">→</span>
            <span className="text-ink-strong">{schema.hash!.slice(0, 12)}</span>
            <span className="ml-auto text-health-warn uppercase tracking-widest text-[10px]">
              hash changed
            </span>
          </div>
        ) : schema.hash ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-strong">{schema.hash.slice(0, 12)}</span>
            <span className="ml-auto text-ink-muted uppercase tracking-widest text-[10px]">
              hash stable
            </span>
          </div>
        ) : (
          <span className="text-ink-muted">No hash recorded for this snapshot.</span>
        )}
      </div>

      {metrics.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {metrics.map((m) => (
            <MetaCell key={m.label} label={m.label} value={m.value} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
