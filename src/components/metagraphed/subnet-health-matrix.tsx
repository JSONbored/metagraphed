import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { subnetsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { HealthState, Subnet } from "@/lib/metagraphed/types";

const TONE: Record<HealthState, string> = {
  ok: "bg-health-ok/80 hover:bg-health-ok",
  warn: "bg-health-warn/75 hover:bg-health-warn",
  down: "bg-health-down/75 hover:bg-health-down",
  unknown: "bg-ink-subtle/30 hover:bg-ink-subtle/60",
};

/**
 * Heatmap of every active application subnet colored by health. Clicking a
 * cell deep-links to that subnet. Renders a tooltip with the subnet name +
 * health state on hover. Falls back to a static skeleton on first paint.
 */
export function SubnetHealthMatrix() {
  const { data, isLoading } = useQuery({
    ...subnetsQuery({ limit: 256, sort: "netuid", order: "asc" }),
  });
  const rows = ((data?.data ?? []) as Subnet[]).slice().sort((a, b) => a.netuid - b.netuid);

  if (isLoading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1.5">
        {Array.from({ length: 128 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-sm bg-surface-2/60 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={80}>
      <div className="space-y-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1.5">
          {rows.map((s) => {
            const tone = TONE[s.health ?? "unknown"];
            return (
              <Tooltip key={s.netuid}>
                <TooltipTrigger asChild>
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: s.netuid }}
                    className={classNames(
                      "group aspect-square rounded-sm transition-all duration-150 ring-0 hover:ring-2 hover:ring-accent/40 hover:scale-110",
                      tone,
                    )}
                    aria-label={`SN${s.netuid}${s.name ? ` — ${s.name}` : ""}`}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  <div className="font-display font-semibold text-ink-strong">
                    SN{s.netuid}{" "}
                    {s.name ? <span className="text-ink-muted">· {s.name}</span> : null}
                  </div>
                  <div className="font-mono uppercase tracking-widest text-[9px] text-ink-muted mt-0.5">
                    {s.health ?? "unknown"}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <Legend />
      </div>
    </TooltipProvider>
  );
}

function Legend() {
  const items: Array<{ label: string; state: HealthState }> = [
    { label: "OK", state: "ok" },
    { label: "Warn", state: "warn" },
    { label: "Down", state: "down" },
    { label: "Unknown", state: "unknown" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
      {items.map((i) => (
        <span key={i.state} className="inline-flex items-center gap-1.5">
          <span className={classNames("size-2 rounded-sm", TONE[i.state])} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}
