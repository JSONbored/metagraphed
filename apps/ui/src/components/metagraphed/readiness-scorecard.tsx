import { ArrowRight, Check, Minus } from "lucide-react";
import { ExternalLink } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import type { SubnetProfile } from "@/lib/metagraphed/types";

// Human labels for the backend `readiness.components` keys, ordered to read as
// an integration checklist (#369).
const COMPONENT_ORDER: Array<[string, string]> = [
  ["has_callable_api", "Callable API"],
  ["callable_now", "Callable now"],
  ["documented", "Documented"],
  ["auth_clarity", "Auth clarity"],
  ["profile_complete", "Profile complete"],
  ["active_lifecycle", "Active"],
];

function scoreTone(score: number): { label: string; cls: string } {
  if (score >= 80) return { label: "Ready to integrate", cls: "text-health-ok" };
  if (score >= 50) return { label: "Emerging", cls: "text-health-warn-text" };
  if (score >= 20) return { label: "Identity only", cls: "text-ink-muted" };
  return { label: "Dormant", cls: "text-ink-subtle-text" };
}

/**
 * Integration-readiness scorecard for the top of the subnet Overview tab (#369).
 * Composes the backend `integration_readiness` score + its component breakdown,
 * the `primary_app_surface` as a "start here" CTA, and operational-vs-missing
 * interfaces. Live probe health lives only in the masthead HealthPill (#5332) —
 * duplicating it here disagreed with the probe-backed strip and muddied which
 * indicator was authoritative.
 */
export function ReadinessScorecard({ profile }: { profile?: SubnetProfile }) {
  if (!profile) return null;
  const score = profile.integration_readiness ?? profile.completeness_score;
  const components = profile.readiness?.components;
  const cta = profile.primary_app_surface;
  const operational = profile.operational_interface_kinds ?? [];
  const missing = profile.missing_kinds ?? [];

  // Don't render an empty shell (e.g. native-only subnets with no readiness data).
  if (score == null && !components && !cta?.url && operational.length === 0) return null;

  const tone = typeof score === "number" ? scoreTone(score) : null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      aria-label="Integration readiness"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="mg-label text-ink-subtle-text">Integration readiness</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={classNames(
                "font-display text-3xl font-semibold tabular-nums",
                typeof score === "number" ? "text-ink-strong" : "text-ink-subtle-text",
              )}
            >
              {typeof score === "number" ? score : "—"}
            </span>
            <span className="text-xs text-ink-subtle-text">/ 100</span>
            {tone ? (
              <span className={classNames("text-sm font-medium", tone.cls)}>{tone.label}</span>
            ) : null}
          </div>
        </div>
      </div>

      {cta?.url ? (
        <ExternalLink
          href={cta.url}
          className="mt-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-surface px-3 py-2 text-sm"
        >
          <ArrowRight className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-ink-strong">Start here:</span>{" "}
            {cta.name ?? cta.kind ?? "Primary API"}
            {cta.provider ? <span className="text-ink-muted"> · {cta.provider}</span> : null}
          </span>
        </ExternalLink>
      ) : null}

      {components ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {COMPONENT_ORDER.filter(([key]) => key in components).map(([key, label]) => {
            const met = components[key];
            return (
              <span key={key} className="inline-flex items-center gap-1 text-xs">
                {met ? (
                  <Check className="size-3.5 text-health-ok" />
                ) : (
                  <Minus className="size-3.5 text-ink-subtle" />
                )}
                <span className={met ? "text-ink-muted" : "text-ink-subtle-text"}>{label}</span>
              </span>
            );
          })}
        </div>
      ) : null}

      {operational.length > 0 || missing.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2 text-xs text-ink-muted">
          <span className="font-medium text-ink-strong tabular-nums">{operational.length}</span>{" "}
          operational interface{operational.length === 1 ? "" : "s"}
          {missing.length > 0 ? (
            <span className="text-ink-subtle-text"> · missing {missing.join(", ")}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
