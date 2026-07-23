import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins, Radio, Timer } from "lucide-react";
import {
  subnetHealthQuery,
  subnetProfileQuery,
  subnetSurfacesQuery,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";

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

function Tile({
  icon: Icon,
  eyebrow,
  value,
  hint,
  href,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  value: string;
  hint?: string;
  href: string;
  tone?: Tone;
}) {
  return (
    <a
      href={href}
      className={classNames(
        "group flex items-start gap-3 rounded-lg border p-3 transition-colors hover:border-ink/30 mg-focus-ring",
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
        <div className="truncate font-display text-[15px] font-medium text-ink-strong">{value}</div>
        {hint ? (
          <div className="truncate text-[11px] leading-snug text-ink-muted">{hint}</div>
        ) : null}
      </div>
    </a>
  );
}

function ageLabel(iso?: string | null): string {
  if (!iso) return "Unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Unknown";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * Per-subnet priority strip mirroring SubnetsHighlights, showing at-a-glance
 * signals for the specific subnet so users can jump to the section they want
 * (economics / operational / resources / evidence) in one click.
 */
export function SubnetPriorityHighlights({ netuid }: { netuid: number }) {
  const hydrated = useHydrated();
  const { data: healthResult } = useQuery(subnetHealthQuery(netuid));
  const { data: profileResult } = useQuery(subnetProfileQuery(netuid));
  const { data: surfacesResult } = useQuery(subnetSurfacesQuery(netuid));

  const health = healthResult?.data ?? {};
  const down = (health as { down?: number }).down ?? 0;
  const warn = (health as { warn?: number }).warn ?? 0;
  const incidents = down + warn;
  const incidentTone: Tone = down > 0 ? "down" : warn > 0 ? "warn" : "ok";

  const profile = profileResult?.data;
  const curation = profile?.curation_level ?? "candidate-discovered";
  const isAdapter = curation === "adapter-backed";
  const curationLabel = curation
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");

  const surfaces =
    (surfacesResult?.data as Array<{ last_verified_at?: string | null }> | undefined) ?? [];
  const newest = surfaces
    .map((s) => s.last_verified_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .reverse()[0];
  // Gate Date.now()-derived tone + label behind hydration so SSR and the first
  // client render agree; otherwise this component drives the same hydration
  // mismatch that cascaded into the /subnets/:netuid Suspense-stream crash.
  const freshMs =
    hydrated && newest ? Date.now() - new Date(newest).getTime() : Number.POSITIVE_INFINITY;
  const freshTone: Tone = !hydrated
    ? "default"
    : !newest
      ? "default"
      : freshMs > 7 * 864e5
        ? "warn"
        : freshMs > 24 * 36e5
          ? "accent"
          : "ok";

  const surfaceCount = surfaces.length;

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Tile
        icon={Coins}
        eyebrow="Economics"
        value="View headline"
        hint="Emission share · alpha price · volume"
        href="#economics"
        tone="accent"
      />
      <Tile
        icon={AlertTriangle}
        eyebrow="Operational"
        value={incidents > 0 ? `${incidents} open` : "Healthy"}
        hint={incidents > 0 ? `${down} down · ${warn} degraded` : "All probed surfaces up"}
        href="#operational"
        tone={incidentTone}
      />
      <Tile
        icon={Timer}
        eyebrow="Freshness"
        value={newest ? (hydrated ? ageLabel(newest) : "Recently") : "No probes"}
        hint={
          surfaceCount > 0
            ? `${surfaceCount} verified surface${surfaceCount === 1 ? "" : "s"}`
            : "No verified surfaces yet"
        }
        href="#resources"
        tone={freshTone}
      />
      <Tile
        icon={Radio}
        eyebrow="Curation"
        value={curationLabel}
        hint={isAdapter ? "Deep integration — adapter-backed" : "Registry curation level"}
        href="#profile"
        tone={isAdapter ? "accent" : "default"}
      />
    </div>
  );
}
