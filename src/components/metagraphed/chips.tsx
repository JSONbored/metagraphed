import { classNames } from "@/lib/metagraphed/format";
import type { CurationLevel, HealthState } from "@/lib/metagraphed/types";

export function HealthDot({ state }: { state?: HealthState | string }) {
  const map: Record<string, string> = {
    ok: "bg-health-ok",
    warn: "bg-health-warn",
    degraded: "bg-health-warn",
    down: "bg-health-down",
    offline: "bg-health-down",
    unknown: "bg-health-unknown",
  };
  const cls = map[(state as string) ?? "unknown"] ?? "bg-health-unknown";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={classNames("size-1.5 rounded-full", cls)} />
      <span className="text-[11px] font-medium capitalize text-ink">{state ?? "unknown"}</span>
    </span>
  );
}

export function HealthPill({ state, label }: { state?: HealthState | string; label?: string }) {
  const map: Record<string, string> = {
    ok: "text-health-ok border-health-ok/30 bg-health-ok/5",
    warn: "text-health-warn border-health-warn/30 bg-health-warn/5",
    down: "text-health-down border-health-down/30 bg-health-down/5",
    unknown: "text-ink-muted border-border bg-surface",
  };
  const key = (state as string) ?? "unknown";
  const cls = map[key] ?? map.unknown;
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        cls,
      )}
    >
      <span
        className={classNames(
          "size-1.5 rounded-full",
          key === "ok"
            ? "bg-health-ok"
            : key === "warn"
              ? "bg-health-warn"
              : key === "down"
                ? "bg-health-down"
                : "bg-health-unknown",
        )}
      />
      {label ?? key}
    </span>
  );
}

const curationLabel: Record<CurationLevel, string> = {
  native: "Native",
  "candidate-discovered": "Candidate",
  "machine-verified": "Machine",
  "maintainer-reviewed": "Reviewed",
  "adapter-backed": "Adapter",
};

const curationCls: Record<CurationLevel, string> = {
  native: "bg-curation-native text-paper border-curation-native",
  "candidate-discovered": "bg-transparent text-ink-muted border-dashed border-ink-subtle",
  "machine-verified": "bg-curation-machine/10 text-curation-machine border-curation-machine/30",
  "maintainer-reviewed": "bg-curation-verified/10 text-curation-verified border-curation-verified/30",
  "adapter-backed": "bg-curation-pilot/10 text-curation-pilot border-curation-pilot/30",
};

export function CurationChip({ level }: { level?: CurationLevel | string }) {
  const lvl = (level as CurationLevel) ?? "candidate-discovered";
  const label = curationLabel[lvl] ?? String(level ?? "—");
  const cls = curationCls[lvl] ?? curationCls["candidate-discovered"];
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        cls,
      )}
    >
      {label}
    </span>
  );
}

export function CandidateChip() {
  return (
    <span className="inline-flex items-center rounded border border-dashed border-ink-subtle bg-transparent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
      Unverified
    </span>
  );
}
