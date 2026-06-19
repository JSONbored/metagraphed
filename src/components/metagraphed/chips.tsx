import { classNames } from "@/lib/metagraphed/format";
import type { CurationLevel, HealthState } from "@/lib/metagraphed/types";

/**
 * Universal health indicator.
 *
 * Minimal pulsing dot with optional label. The dot itself is the primary
 * affordance — color carries the state, a subtle pulse signals attention for
 * `warn` and `down`. Reduced-motion users see static dots (CSS handles this).
 *
 * Variants:
 *   - `dot`   compact, dot-only (table rows, sidebar, list rows)
 *   - `label` dot + state name (detail headers, summaries)
 *
 * Color mapping is fixed and documented:
 *   green   ok        — probes succeeding
 *   amber   warn      — degraded / high latency
 *   red     down      — failing probes / open incident
 *   grey    unknown   — never probed, offline, or stale
 */
type Variant = "dot" | "label";

const STATE_LABEL: Record<string, string> = {
  ok: "OK",
  warn: "Degraded",
  degraded: "Degraded",
  down: "Down",
  offline: "Offline",
  unknown: "Unknown",
};

const STATE_COLOR: Record<string, string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  degraded: "bg-health-warn",
  down: "bg-health-down",
  offline: "bg-health-down",
  unknown: "bg-health-unknown",
};

function normalize(state?: HealthState | string): string {
  const s = (state as string) ?? "unknown";
  return STATE_COLOR[s] ? s : "unknown";
}

export function HealthDot({
  state,
  variant = "dot",
  className,
}: {
  state?: HealthState | string;
  variant?: Variant;
  className?: string;
}) {
  const key = normalize(state);
  const color = STATE_COLOR[key];
  const label = STATE_LABEL[key];
  const shouldPulse = key === "warn" || key === "degraded" || key === "down" || key === "offline";

  const dot = (
    <span
      role="img"
      aria-label={`Health: ${label.toLowerCase()}`}
      title={label}
      className={classNames(
        "relative inline-block size-2 rounded-full shrink-0",
        color,
        shouldPulse && "mg-pulse",
        className,
      )}
    />
  );

  if (variant === "dot") return dot;

  return (
    <span className="inline-flex items-center gap-1.5">
      {dot}
      <span className="text-[11px] font-medium text-ink">{label}</span>
    </span>
  );
}

/**
 * Back-compat: HealthPill now renders as a labeled dot. Existing call sites
 * keep working; the visual is unified across the app.
 */
export function HealthPill({ state, label }: { state?: HealthState | string; label?: string }) {
  if (label) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <HealthDot state={state} />
        <span className="text-[11px] font-medium text-ink">{label}</span>
      </span>
    );
  }
  return <HealthDot state={state} variant="label" />;
}

const curationLabel: Record<CurationLevel, string> = {
  native: "Native",
  "candidate-discovered": "Candidate",
  "machine-verified": "Machine",
  "maintainer-reviewed": "Reviewed",
  "adapter-backed": "Adapter",
};

const curationCls: Record<CurationLevel, string> = {
  native: "bg-transparent text-ink-strong border-ink-strong/40",
  "candidate-discovered": "bg-transparent text-ink-muted border-dashed border-ink-subtle",
  "machine-verified": "bg-transparent text-ink-muted border-border",
  "maintainer-reviewed": "bg-primary-soft text-curation-verified border-accent/40",
  "adapter-backed": "bg-primary-soft text-curation-pilot border-accent/50",
};

// Surfaces carry a per-surface `authority` (rather than a curation_level); give
// those values their own readable labels + reuse the nearest curation styling.
const authorityLabel: Record<string, string> = {
  official: "Official",
  "registry-observed": "Observed",
  "provider-claimed": "Claimed",
  community: "Community",
  "native-chain": "Native",
};

const authorityCls: Record<string, string> = {
  official: curationCls["maintainer-reviewed"],
  "registry-observed": curationCls["machine-verified"],
  "provider-claimed": curationCls["adapter-backed"],
  community: curationCls["candidate-discovered"],
  "native-chain": curationCls["native"],
};

export function CurationChip({ level }: { level?: CurationLevel | string }) {
  const key = String(level ?? "");
  const label = Object.hasOwn(curationLabel, key)
    ? curationLabel[key as CurationLevel]
    : Object.hasOwn(authorityLabel, key)
      ? authorityLabel[key]
      : level
        ? key
        : "—";
  const cls = Object.hasOwn(curationCls, key)
    ? curationCls[key as CurationLevel]
    : Object.hasOwn(authorityCls, key)
      ? authorityCls[key]
      : curationCls["candidate-discovered"];
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
