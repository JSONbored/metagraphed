import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertTriangle, GitBranch, Activity } from "lucide-react";
import { changelogQuery, endpointIncidentsQuery } from "@/lib/metagraphed/queries";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { classNames } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";

type TickerItem = {
  id: string;
  icon: typeof GitBranch;
  kind: string;
  title: string;
  at?: string;
  tone: "default" | "accent" | "warn" | "down";
};

const TONE_CLASS: Record<TickerItem["tone"], string> = {
  default: "text-ink-muted",
  accent: "text-accent",
  warn: "text-health-warn",
  down: "text-health-down",
};

/**
 * Thin CSS-only marquee strip for the hero. Reuses the changelog +
 * incidents queries already fetched lower on the page (no extra request).
 * Pauses on hover; falls back to a static row under reduced motion.
 */
export function HeroTicker({ limit = 8 }: { limit?: number }) {
  const { data: cRes } = useSuspenseQuery(changelogQuery());
  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());

  const items = useMemo<TickerItem[]>(() => {
    const out: Array<TickerItem & { ts: number }> = [];
    for (const c of cRes.data ?? []) {
      const ts = c.at ? Date.parse(c.at) : 0;
      const k = (c.kind ?? "registry").toLowerCase();
      out.push({
        id: `c:${c.id}`,
        icon: GitBranch,
        kind: k,
        title: c.title || c.id,
        at: c.at,
        tone: k.includes("adapter") ? "accent" : "default",
        ts,
      });
    }
    for (const inc of (iRes.data ?? []) as EndpointIncident[]) {
      const ts = inc.started_at ? Date.parse(inc.started_at) : 0;
      const state = (inc.state ?? "down").toString();
      out.push({
        id: `i:${inc.id}`,
        icon: AlertTriangle,
        kind: `endpoint ${state}`,
        title: inc.message || `Endpoint ${inc.endpoint_id ?? ""} ${state}`,
        at: inc.started_at,
        tone: state === "warn" ? "warn" : "down",
        ts,
      });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }, [cRes.data, iRes.data, limit]);

  if (items.length === 0) return null;

  // Duplicate so the CSS loop is seamless.
  const loop = [...items, ...items];

  return (
    <div
      className="mg-ticker mg-fade-in mg-fade-in-delay-3 mt-6 relative overflow-hidden border-y border-border/60"
      aria-label="Recent registry signal"
    >
      <div className="mg-ticker-track flex items-center gap-6 py-2 whitespace-nowrap">
        {loop.map((it, i) => {
          const Icon = it.icon;
          return (
            <span key={`${it.id}-${i}`} className="inline-flex items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5">
                <Icon className={classNames("size-3", TONE_CLASS[it.tone])} aria-hidden />
                <span
                  className={classNames(
                    "font-mono uppercase tracking-[0.14em] text-[10px]",
                    TONE_CLASS[it.tone],
                  )}
                >
                  {it.kind}
                </span>
              </span>
              <span className="text-ink-strong truncate max-w-[36ch]">{it.title}</span>
              {it.at ? (
                <span className="font-mono text-[10px] text-ink-muted">
                  <TimeAgo at={it.at} />
                </span>
              ) : null}
              <span aria-hidden className="text-ink-subtle">
                ·
              </span>
            </span>
          );
        })}
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-paper to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-paper to-transparent"
      />
      <span
        aria-hidden
        className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-muted bg-paper px-1.5"
      >
        <Activity className="size-2.5" />
        live
      </span>
    </div>
  );
}
