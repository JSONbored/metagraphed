import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Radio, Database, AlertOctagon } from "lucide-react";
import { HealthDot } from "./chips";
import { EmptyState } from "./states";
import { classNames } from "@/lib/metagraphed/format";
import type { Endpoint } from "@/lib/metagraphed/types";

interface Bucket {
  key: "rpc" | "data" | "incidents";
  label: string;
  icon: typeof Radio;
  match: (e: Endpoint) => boolean;
}

const BUCKETS: Bucket[] = [
  {
    key: "rpc",
    label: "Root RPC / WSS",
    icon: Radio,
    match: (e) =>
      ["rpc", "wss", "archive"].includes(String(e.kind ?? "").toLowerCase()),
  },
  {
    key: "data",
    label: "SSE / Data",
    icon: Database,
    match: (e) =>
      ["sse", "data", "stream", "ws", "websocket"].includes(
        String(e.kind ?? "").toLowerCase(),
      ),
  },
  {
    key: "incidents",
    label: "Incidents (open)",
    icon: AlertOctagon,
    match: (e) => e.health === "down" || e.health === "warn",
  },
];

function maskHost(url?: string): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

function dominantHealth(items: Endpoint[]): Endpoint["health"] {
  if (items.length === 0) return "unknown";
  if (items.some((e) => e.health === "down")) return "down";
  if (items.some((e) => e.health === "warn")) return "warn";
  if (items.every((e) => e.health === "ok")) return "ok";
  return "unknown";
}

/**
 * Compact "Endpoints at a glance" card — three operational buckets with a
 * one-tap expand to reveal the full inline endpoint table.
 */
export function EndpointsGlance({
  endpoints,
  fullList,
  defaultOpen = false,
}: {
  endpoints: Endpoint[];
  /** Render-prop for the full inline table when expanded. */
  fullList: () => ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (endpoints.length === 0) {
    return (
      <EmptyState
        title="No tracked endpoints"
        description="Once endpoints are registered, this card surfaces RPC/WSS, data streams, and incidents at a glance."
      />
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <ul className="divide-y divide-border">
        {BUCKETS.map((b) => {
          const items = endpoints.filter(b.match);
          const top = items[0];
          const Icon = b.icon;
          return (
            <li
              key={b.key}
              className="flex items-center gap-3 px-4 py-3"
            >
              <Icon className="size-3.5 shrink-0 text-ink-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    {b.label}
                  </span>
                  <span className="font-display text-sm font-semibold text-ink-strong tabular-nums">
                    {items.length}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                  {top ? maskHost(top.url) : "—"}
                </div>
              </div>
              <HealthDot state={dominantHealth(items)} />
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={classNames(
          "flex w-full items-center justify-center gap-1.5 border-t border-border bg-surface/40 px-3 py-2 text-[11px] font-medium text-ink-muted hover:text-ink-strong",
        )}
        aria-expanded={open}
      >
        {open ? (
          <>
            <ChevronUp className="size-3" /> Hide full list
          </>
        ) : (
          <>
            <ChevronDown className="size-3" /> Show all {endpoints.length} endpoints
          </>
        )}
      </button>
      {open ? <div className="border-t border-border p-3">{fullList()}</div> : null}
    </div>
  );
}
