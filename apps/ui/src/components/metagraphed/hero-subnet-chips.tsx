import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BrandIcon } from "@jsonbored/ui-kit";
import { subnetsQuery, healthQuery } from "@/lib/metagraphed/queries";
import type { Subnet } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";

type HealthState = "ok" | "warn" | "down" | "unknown";

const TONE: Record<HealthState, string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  down: "bg-health-down",
  unknown: "bg-ink-subtle/60",
};

const CURATION_RANK: Record<string, number> = {
  "adapter-backed": 4,
  "maintainer-reviewed": 3,
  "machine-verified": 2,
  "candidate-discovered": 1,
  native: 0,
};

/**
 * Horizontal "trending" rail of subnet chips for the home hero. Picks the
 * most curated / actively probed subnets, renders each as a tiny BrandIcon
 * + name + netuid badge + health dot. Read-only — no extra API calls beyond
 * the two queries already in use across the homepage.
 */
export function HeroSubnetChips({ limit = 14 }: { limit?: number }) {
  const { data: subnetsRes } = useSuspenseQuery(subnetsQuery({ limit: 128 }));
  const { data: healthRes } = useSuspenseQuery(healthQuery());

  const items = useMemo(() => {
    const subnets = (subnetsRes.data ?? []) as Subnet[];
    const healthMap = new Map<number, HealthState>();
    const hsubs = (healthRes.data as { subnets?: Array<{ netuid: number; status?: string }> })
      ?.subnets;
    if (Array.isArray(hsubs)) {
      for (const s of hsubs) {
        const st = s.status;
        healthMap.set(
          s.netuid,
          st === "ok" ? "ok" : st === "degraded" ? "warn" : st === "failed" ? "down" : "unknown",
        );
      }
    }
    return subnets
      .filter((s) => s.netuid !== 0)
      .map((s) => ({
        s,
        rank:
          (CURATION_RANK[s.curation_level ?? ""] ?? 0) * 10000 +
          (s.surfaces_count ?? 0) * 100 +
          (s.participants ?? 0) / 100,
        health: (s.health ?? healthMap.get(s.netuid) ?? "unknown") as HealthState,
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);
  }, [subnetsRes.data, healthRes.data, limit]);

  if (items.length === 0) return null;

  return (
    <div
      className="mg-chip-rail mg-fade-in mg-fade-in-delay-3 mt-8 -mx-4 md:mx-0"
      role="list"
      aria-label="Trending subnets"
    >
      <div className="flex gap-2 overflow-x-auto px-4 md:px-0 pb-1 snap-x snap-mandatory">
        {items.map(({ s, health }) => (
          <Link
            key={s.netuid}
            to="/subnets/$netuid"
            params={{ netuid: s.netuid }}
            role="listitem"
            className={classNames(
              "mg-metric-tile mg-focus-ring snap-start shrink-0",
              "inline-flex items-center gap-2 rounded-full border border-border bg-card/80",
              "px-2.5 py-1.5 hover:border-accent/40 transition-colors",
            )}
            title={`${s.name ?? `Subnet ${s.netuid}`} · SN${s.netuid}`}
          >
            <BrandIcon
              size={16}
              name={s.name ?? `Subnet ${s.netuid}`}
              fallback={s.netuid}
              url={s.website}
              netuid={s.netuid}
            />
            <span className="font-medium text-[12px] text-ink-strong truncate max-w-[120px]">
              {s.name ?? `Subnet ${s.netuid}`}
            </span>
            <span className="mg-type-micro text-ink-muted">SN{s.netuid}</span>
            {/* #6423: role="img" so the label is exposed -- a plain span is
                role="generic", whose aria-label AT is not required to announce.
                Matches ui-kit HealthDot's treatment of this same visual. */}
            <span
              role="img"
              aria-label={`health ${health}`}
              title={`health ${health}`}
              className={classNames("size-1.5 rounded-full shrink-0", TONE[health])}
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
