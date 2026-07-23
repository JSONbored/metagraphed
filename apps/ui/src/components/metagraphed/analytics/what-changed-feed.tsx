import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertTriangle, GitBranch, Radio, Sparkles } from "lucide-react";
import { changelogQuery, endpointIncidentsQuery } from "@/lib/metagraphed/queries";
import { TimeAgo } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { classNames } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";
import { useTimeRange, RANGE_HOURS, RANGE_LABEL } from "./time-range-context";

type FeedItem = {
  id: string;
  kind: "change" | "incident";
  title: string;
  detail?: string;
  at?: string;
  ts: number;
  tone: "default" | "accent" | "warn" | "down";
};

const KIND_ICON = {
  change: GitBranch,
  incident: AlertTriangle,
} as const;

/**
 * Unified "what changed in this range" feed combining registry changelog
 * entries with endpoint incidents, sorted newest first.
 */
export function WhatChangedFeed({ className, limit = 10 }: { className?: string; limit?: number }) {
  const { range } = useTimeRange();
  const cutoff = Date.now() - RANGE_HOURS[range] * 3_600_000;
  const { data: cRes } = useSuspenseQuery(changelogQuery());
  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());

  const items = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    for (const c of cRes.data ?? []) {
      const ts = c.at ? Date.parse(c.at) : 0;
      const k = (c.kind ?? "").toLowerCase();
      out.push({
        id: `c:${c.id}`,
        kind: "change",
        title: c.title || c.id,
        detail: k || "registry update",
        at: c.at,
        ts,
        tone: k.includes("adapter") ? "accent" : "default",
      });
    }
    for (const inc of (iRes.data ?? []) as EndpointIncident[]) {
      const ts = inc.started_at ? Date.parse(inc.started_at) : 0;
      const ongoing = !inc.ended_at;
      const state = (inc.state ?? "down").toString();
      out.push({
        id: `i:${inc.id}`,
        kind: "incident",
        title: inc.message || `Endpoint ${inc.endpoint_id ?? ""} ${state}`,
        detail: ongoing ? "ongoing" : `resolved · ${state}`,
        at: inc.started_at,
        ts,
        tone: state === "warn" ? "warn" : "down",
      });
    }
    return out
      .filter((x) => x.ts === 0 || x.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }, [cRes.data, iRes.data, cutoff, limit]);

  return (
    <Panel as="div" flush className={className}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="mg-type-micro text-ink-muted">What changed · {RANGE_LABEL[range]}</div>
            <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
              Recent registry signal
            </h3>
          </div>
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted">
            <Sparkles className="size-3" aria-hidden />
            live
          </span>
        </div>
        {items.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-xs text-ink-muted">
            <Radio className="size-3.5" aria-hidden />
            Nothing notable in the last {RANGE_LABEL[range]}.
          </div>
        ) : (
          <ol className="space-y-2.5">
            {items.map((it) => {
              const Icon = KIND_ICON[it.kind];
              return (
                <li key={it.id} className="flex items-start gap-2.5 group">
                  <span
                    className={classNames(
                      "mt-0.5 inline-flex size-5 items-center justify-center rounded border shrink-0",
                      it.tone === "accent" && "border-accent/40 text-accent",
                      it.tone === "warn" && "border-health-warn/40 text-health-warn",
                      it.tone === "down" && "border-health-down/40 text-health-down",
                      it.tone === "default" && "border-border text-ink-muted",
                    )}
                    aria-hidden
                  >
                    <Icon className="size-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-ink-strong truncate group-hover:text-accent transition-colors">
                      {it.title}
                    </div>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      {it.detail ? (
                        <span className="mg-type-micro text-ink-muted truncate">{it.detail}</span>
                      ) : null}
                      {it.at ? (
                        <span className="font-mono text-[10px] text-ink-muted">
                          <TimeAgo at={it.at} />
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Panel>
  );
}
