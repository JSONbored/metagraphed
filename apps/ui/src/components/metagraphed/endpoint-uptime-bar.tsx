import { useMemo } from "react";
import { classNames } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";
import { useHydrated } from "@/hooks/use-hydrated";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compact 7d uptime bar. Each pip is one day, colored by whether that
 * endpoint had an incident overlap: ok (mint), degraded (amber), down (red).
 * Falls back to a neutral "no signal" row when no incidents are known.
 */
export function EndpointUptimeBar({
  endpointId,
  incidents,
  days = 7,
  className,
}: {
  endpointId: string;
  incidents: EndpointIncident[];
  days?: number;
  className?: string;
}) {
  const hydrated = useHydrated();
  const pips = useMemo(() => {
    // Keep SSR and the first client render identical; live time is introduced
    // only after hydration so this tiny chart can never destabilize the route.
    const now = hydrated ? Date.now() : 0;
    const buckets: Array<"ok" | "warn" | "down" | "unknown"> = Array.from(
      { length: days },
      () => "ok",
    );
    const relevant = incidents.filter((i) => i.endpoint_id === endpointId);
    for (const inc of relevant) {
      const start = inc.started_at ? Date.parse(inc.started_at) : NaN;
      const end = inc.ended_at ? Date.parse(inc.ended_at) : now;
      if (!isFinite(start)) continue;
      for (let d = 0; d < days; d++) {
        const dayStart = now - (days - d) * DAY_MS;
        const dayEnd = dayStart + DAY_MS;
        if (start < dayEnd && end > dayStart) {
          const s = String(inc.state ?? "");
          const rank = s === "down" ? 3 : s === "degraded" ? 2 : 1;
          const cur = buckets[d];
          const curRank = cur === "down" ? 3 : cur === "warn" ? 2 : cur === "ok" ? 1 : 0;
          if (rank > curRank) buckets[d] = rank === 3 ? "down" : rank === 2 ? "warn" : "ok";
        }
      }
    }
    if (relevant.length === 0) return buckets.map(() => "unknown" as const);
    return buckets;
  }, [endpointId, incidents, days, hydrated]);

  return (
    <div
      className={classNames("inline-flex items-center gap-[2px]", className)}
      role="img"
      aria-label={`${days}-day uptime signal`}
      title={`${days}-day uptime — hover a pip for the day`}
    >
      {pips.map((p, i) => (
        <span
          key={i}
          className={classNames(
            "block h-3 w-[3px] rounded-[1px]",
            p === "ok" && "bg-health-ok/70",
            p === "warn" && "bg-health-warn/80",
            p === "down" && "bg-health-down/80",
            p === "unknown" && "bg-ink-subtle/40",
          )}
          title={`day -${pips.length - i}: ${p}`}
        />
      ))}
    </div>
  );
}
