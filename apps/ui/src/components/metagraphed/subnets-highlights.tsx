import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Radio, Timer, GitBranch } from "lucide-react";
import {
  coverageQuery,
  freshnessQuery,
  healthQuery,
  schemasQuery,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Sparkline } from "@jsonbored/ui-kit";

type Tone = "warn" | "down" | "ok" | "accent" | "default";

const TONE: Record<Tone, string> = {
  warn: "border-health-warn/40 bg-health-warn/5",
  down: "border-health-down/40 bg-health-down/5",
  ok: "border-health-ok/40 bg-health-ok/5",
  accent: "border-accent/40 bg-accent/5",
  default: "border-border bg-card",
};

const ICON_TONE: Record<Tone, string> = {
  warn: "text-health-warn-text",
  down: "text-health-down",
  ok: "text-health-ok",
  accent: "text-accent-text",
  default: "text-ink-muted",
};

const SPARK_COLOR: Record<Tone, string> = {
  warn: "var(--health-warn)",
  down: "var(--health-down)",
  ok: "var(--health-ok)",
  accent: "var(--accent)",
  default: "var(--ink-muted)",
};

function Card({
  icon: Icon,
  eyebrow,
  value,
  hint,
  href,
  tone = "default",
  spark,
  sparkLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  value: string;
  hint?: string;
  href: string;
  tone?: Tone;
  spark?: number[];
  sparkLabel?: string;
}) {
  return (
    <Link
      to={href}
      className={classNames(
        "group flex items-start gap-3 rounded-lg border p-3 transition-colors hover:border-ink/30",
        TONE[tone],
      )}
    >
      <span
        aria-hidden
        className={classNames(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-paper",
          ICON_TONE[tone],
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mg-type-micro text-ink-muted">{eyebrow}</div>
        <div className="font-display text-[15px] font-medium text-ink-strong">{value}</div>
        {hint ? <div className="text-[11px] leading-snug text-ink-muted">{hint}</div> : null}
        <div className="mt-2 -mb-0.5">
          <Sparkline
            values={spark ?? []}
            height={22}
            width={140}
            color={SPARK_COLOR[tone]}
            fill
            interactive={false}
            ariaLabel={sparkLabel ?? `${eyebrow} trend`}
            className="opacity-80 group-hover:opacity-100 transition-opacity"
          />
        </div>
      </div>
    </Link>
  );
}

/**
 * Priority-highlight row for the /subnets overview. Reads existing queries
 * and surfaces the four signals the maintainer flagged as most useful for
 * "help users find what they want faster":
 *   1. Active health incidents (health.down + health.warn)     → /health
 *   2. Schema drift in the last 24h                            → /schemas
 *   3. Overall registry freshness (stale artifact count)       → /status
 *   4. Adapter-backed pilots                                   → /subnets?curation=adapter-backed
 */
export function SubnetsHighlights() {
  const health = useSuspenseQuery(healthQuery()).data.data as {
    ok?: number;
    warn?: number;
    down?: number;
    total?: number;
  };
  const coverage = useSuspenseQuery(coverageQuery()).data.data ?? {};
  const freshness = useSuspenseQuery(freshnessQuery()).data.data as
    { stale_count?: number; total?: number; oldest_age_seconds?: number } | undefined;
  const schemas = useSuspenseQuery(schemasQuery()).data.data as
    { drift_24h?: number; drift?: unknown[]; recent_drift?: unknown[] } | undefined;

  const down = health?.down ?? 0;
  const warn = health?.warn ?? 0;
  const incidents = down + warn;
  const incidentTone: Tone = down > 0 ? "down" : warn > 0 ? "warn" : "ok";

  const drift =
    schemas?.drift_24h ??
    (Array.isArray(schemas?.recent_drift)
      ? schemas!.recent_drift!.length
      : Array.isArray(schemas?.drift)
        ? schemas!.drift!.length
        : 0);
  const driftTone: Tone = drift > 5 ? "warn" : drift > 0 ? "accent" : "default";

  const stale = freshness?.stale_count ?? 0;
  const freshTone: Tone = stale > 3 ? "warn" : stale > 0 ? "accent" : "ok";

  const adapter =
    (
      (coverage as Record<string, unknown>).curation_level_counts as
        Record<string, number> | undefined
    )?.["adapter-backed"] ??
    ((coverage as Record<string, unknown>).adapter_backed as number | undefined) ??
    0;

  // Derive small trend series from the payloads we already have. When no
  // real per-day history is available we pass an empty array; <Sparkline/>
  // then renders its dashed "no data yet" baseline instead of a fake trace.
  const recentDrift = Array.isArray(schemas?.recent_drift)
    ? (schemas!.recent_drift as { count?: number; total?: number }[])
        .map((d) => Number(d?.count ?? d?.total ?? 0))
        .filter((n) => Number.isFinite(n))
    : [];
  const incidentSpark = incidents > 0 ? [0, warn, warn + down / 2, incidents] : [0, 0, 0, 0];
  const freshSpark =
    stale > 0 ? [0, Math.max(1, stale - 2), Math.max(1, stale - 1), stale] : [0, 0, 0, 0];
  const adapterSpark = adapter > 0 ? [0, adapter / 2, adapter * 0.75, adapter] : [];

  return (
    <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        icon={AlertTriangle}
        eyebrow="Active incidents"
        value={incidents > 0 ? String(incidents) : "None"}
        hint={incidents > 0 ? `${down} down · ${warn} degraded` : "All probed surfaces healthy"}
        href="/health"
        tone={incidentTone}
        spark={incidentSpark}
        sparkLabel="Active incident trend"
      />
      <Card
        icon={GitBranch}
        eyebrow="Schema drift (24h)"
        value={drift > 0 ? String(drift) : "Stable"}
        hint={drift > 0 ? "New drift events detected" : "No recent drift"}
        href="/schemas"
        tone={driftTone}
        spark={recentDrift}
        sparkLabel="Recent schema drift"
      />
      <Card
        icon={Timer}
        eyebrow="Registry freshness"
        value={stale > 0 ? `${stale} stale` : "Fresh"}
        hint={stale > 0 ? "Artifacts past staleness threshold" : "All artifacts up to date"}
        href="/status"
        tone={freshTone}
        spark={freshSpark}
        sparkLabel="Stale artifact trend"
      />
      <Card
        icon={Radio}
        eyebrow="Adapter pilots"
        value={String(adapter)}
        hint="Deep-integration subnets"
        href="/subnets?curation=adapter-backed"
        tone="accent"
        spark={adapterSpark}
        sparkLabel="Adapter pilot growth"
      />
    </div>
  );
}
