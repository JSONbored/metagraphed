import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, TrendingUp, Timer } from "lucide-react";
import { endpointsQuery, endpointIncidentsQuery } from "@/lib/metagraphed/queries";
import type { Endpoint } from "@/lib/metagraphed/types";
import { Chip, Panel } from "@/components/metagraphed/primitives";
import { HealthDot } from "@jsonbored/ui-kit";

interface Item {
  key: string;
  label: string;
  value: string;
  hint?: string;
  href?: string;
  icon: typeof AlertTriangle;
  tone: "warn" | "down" | "accent" | "default";
  rows: Endpoint[];
}

/**
 * Horizontal 3-4 card strip surfacing "what needs attention now" above the
 * endpoints directory: freshly-degraded probes, open incidents,
 * highest-latency archive nodes, newest additions. Each card deep-links
 * back into the filtered directory so clicking is action, not decoration.
 */
export function EndpointsPriorityStrip() {
  const { data: eData } = useSuspenseQuery(endpointsQuery());
  const { data: iData } = useSuspenseQuery(endpointIncidentsQuery());
  const rows = useMemo(() => (eData.data ?? []) as Endpoint[], [eData]);
  const incidents = useMemo(
    () => (iData.data ?? []) as Array<{ endpoint_id?: string; severity?: string }>,
    [iData],
  );

  const items = useMemo<Item[]>(() => {
    const degraded = rows.filter((e) => e.health === "warn" || e.health === "down");
    const slowArchive = [...rows.filter((e) => e.archive && typeof e.latency_ms === "number")]
      .sort((a, b) => (b.latency_ms ?? 0) - (a.latency_ms ?? 0))
      .slice(0, 5);
    const recentAdd = [...rows.filter((e) => e.last_probed_at)]
      .sort((a, b) => Date.parse(b.last_probed_at ?? "0") - Date.parse(a.last_probed_at ?? "0"))
      .slice(0, 5);
    const open = incidents.filter((i) => (i.severity ?? "").toLowerCase() !== "resolved");

    return [
      {
        key: "degraded",
        label: "Degraded now",
        value: `${degraded.length}`,
        hint: degraded.length ? "probes reporting warn/down" : "all probes healthy",
        href: "/endpoints?health=warn",
        icon: AlertTriangle,
        tone: degraded.length ? "warn" : "default",
        rows: degraded.slice(0, 4),
      },
      {
        key: "incidents",
        label: "Open incidents",
        value: `${open.length}`,
        hint: open.length ? "unresolved in last 24h" : "no active incidents",
        icon: AlertTriangle,
        tone: open.length ? "down" : "default",
        rows: [],
      },
      {
        key: "slow-archive",
        label: "Slowest archive",
        value: slowArchive[0]?.latency_ms ? `${slowArchive[0].latency_ms}ms` : "—",
        hint: "top 5 by last-probe latency",
        href: "/endpoints?eligibility=archive-capable&sort=latency&order=desc",
        icon: Timer,
        tone: "accent",
        rows: slowArchive,
      },
      {
        key: "recent",
        label: "Freshly probed",
        value: `${recentAdd.length}`,
        hint: "most recent probe cycle",
        icon: TrendingUp,
        tone: "accent",
        rows: recentAdd,
      },
    ];
  }, [rows, incidents]);

  return (
    <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
      {items.map((it) => (
        <PriorityCard key={it.key} item={it} />
      ))}
    </div>
  );
}

function PriorityCard({ item }: { item: Item }) {
  const Icon = item.icon;
  const body = (
    <Panel as="div" dense interactive className="h-full">
      <div className="flex items-center justify-between gap-2">
        <span className="mg-label inline-flex items-center gap-1.5">
          <Icon className="size-3" aria-hidden />
          {item.label}
        </span>
        {item.tone === "warn" || item.tone === "down" ? (
          <span
            className="mg-live-dot"
            style={{ color: item.tone === "down" ? "var(--health-down)" : "var(--health-warn)" }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-xl text-ink-strong tabular-nums">{item.value}</span>
      </div>
      {item.hint ? <p className="mt-0.5 text-[11px] text-ink-muted">{item.hint}</p> : null}
      {item.rows.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {item.rows.slice(0, 3).map((r) => (
            <li key={r.id} className="flex items-center gap-1.5 text-[11px] text-ink-muted min-w-0">
              <HealthDot state={r.health ?? "unknown"} />
              <span className="truncate font-mono">{r.provider ?? r.provider_slug ?? r.id}</span>
              {r.latency_ms != null ? (
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                  {r.latency_ms}ms
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-muted">
          <Chip tone="muted">Nothing to review</Chip>
        </div>
      )}
    </Panel>
  );
  if (!item.href) return body;
  return (
    <Link to={item.href} className="block h-full mg-focus-ring rounded">
      {body}
    </Link>
  );
}
