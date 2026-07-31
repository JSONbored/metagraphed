import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins, Radio, Timer } from "lucide-react";
import { subnetHealthQuery, subnetProfileQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { statPhase } from "@/lib/metagraphed/stat-phase";
import {
  curationTileState,
  operationalTileState,
  type TileTone as Tone,
} from "@/lib/metagraphed/subnet-health-tile";
import { Skeleton, StatUnavailable } from "@/components/metagraphed/states";

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
  value: React.ReactNode;
  hint?: string;
  href: string;
  tone?: Tone;
}) {
  return (
    <a
      href={href}
      className={classNames(
        "group flex items-start gap-3 rounded-md border p-3 transition-colors hover:border-ink/30 mg-focus-ring",
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
        <div className="mg-type-caption text-ink-muted">{eyebrow}</div>
        <div
          className="truncate font-display font-medium text-ink-strong"
          style={{ fontSize: "var(--mg-type-body-lg)" }}
        >
          {value}
        </div>
        {hint ? (
          <div className="truncate mg-type-caption leading-snug text-ink-muted">{hint}</div>
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
  const healthResult = useQuery(subnetHealthQuery(netuid));
  const profileResult = useQuery(subnetProfileQuery(netuid));

  const health = healthResult.data?.data;
  const operational = operationalTileState({
    phase: statPhase(healthResult),
    down: health?.down,
    warn: health?.warn,
    total: health?.total,
  });

  const profile = profileResult.data?.data;
  const curation = curationTileState({
    phase: statPhase(profileResult),
    curationLevel: profile?.curation_level ?? null,
  });

  // #8363: this tile names the registry's own curation review, not surface
  // verification -- a distinct concept from the masthead's data-snapshot
  // "Snapshot Xh ago" caption, which two "Freshness" labels on the same page
  // used to conflate. reviewed_at is when a curator last confirmed this
  // profile; a subnet's on-chain/operational data can be minutes old while
  // its curation review is genuinely months old, so 90 days (not 7) is the
  // threshold before that reads as stale.
  const reviewedAt = profile?.reviewed_at ?? null;
  // Gate Date.now()-derived tone + label behind hydration so SSR and the first
  // client render agree; otherwise this component drives the same hydration
  // mismatch that cascaded into the /subnets/:netuid Suspense-stream crash.
  const reviewMs =
    hydrated && reviewedAt ? Date.now() - new Date(reviewedAt).getTime() : Number.POSITIVE_INFINITY;
  const reviewTone: Tone =
    !hydrated || !reviewedAt ? "default" : reviewMs > 90 * 864e5 ? "warn" : "default";

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
        value={
          operational.phase === "pending" ? (
            <Skeleton className="h-5 w-16" />
          ) : operational.phase === "error" ? (
            <StatUnavailable />
          ) : (
            operational.value
          )
        }
        hint={operational.hint}
        href="#operational"
        tone={operational.tone}
      />
      <Tile
        icon={Timer}
        eyebrow="Last reviewed"
        value={reviewedAt ? (hydrated ? ageLabel(reviewedAt) : "Recently") : "Not yet reviewed"}
        hint="registry curation review"
        href="#profile"
        tone={reviewTone}
      />
      <Tile
        icon={Radio}
        eyebrow="Curation"
        value={
          curation.phase === "pending" ? (
            <Skeleton className="h-5 w-16" />
          ) : curation.phase === "error" ? (
            <StatUnavailable />
          ) : (
            curation.value
          )
        }
        hint={curation.hint}
        href="#profile"
        tone={curation.tone}
      />
    </div>
  );
}
