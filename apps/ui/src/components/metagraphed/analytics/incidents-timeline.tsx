import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink as ExtIcon } from "lucide-react";
import { endpointIncidentsQuery, endpointsQuery, rpcPoolsQuery } from "@/lib/metagraphed/queries";
import { classNames, durationLabel } from "@/lib/metagraphed/format";
import { TimeAgo, InfoTooltip } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { useTimeRange, RANGE_HOURS, RANGE_LABEL } from "./time-range-context";
import type { Endpoint, EndpointIncident, HealthState, RpcPool } from "@/lib/metagraphed/types";

const SEVERITY_RANK: Record<string, number> = { down: 3, warn: 2, unknown: 1, ok: 0 };

const SEVERITY_TINT: Record<string, string> = {
  down: "bg-health-down",
  warn: "bg-health-warn",
  unknown: "bg-ink-subtle/60",
  ok: "bg-health-ok",
};

interface Row {
  host: string;
  netuid: number | null;
  pool: string | null;
  worst: HealthState;
  ongoing: number;
  total: number;
  items: EndpointIncident[];
}

/**
 * Severity-colored incidents timeline. Each row is a host; each pill is an
 * incident positioned by start time inside the active range, sized by
 * duration, and tinted by state. Rows deep-link to the host subnet and
 * RPC pool when those associations can be inferred.
 */
export function IncidentsTimeline({ className }: { className?: string }) {
  const { range } = useTimeRange();
  const totalMs = RANGE_HOURS[range] * 3_600_000;
  const now = Date.now();
  const cutoff = now - totalMs;

  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());
  const { data: eRes } = useSuspenseQuery(endpointsQuery({ limit: 500 }));
  const { data: pRes } = useSuspenseQuery(rpcPoolsQuery());

  const incidents = (iRes.data ?? []) as EndpointIncident[];
  const endpoints = (eRes.data ?? []) as Endpoint[];
  const pools = (pRes.data ?? []) as RpcPool[];

  // Map endpoint_id → endpoint metadata so each incident can deep-link.
  const endpointMap = useMemo(() => {
    const m = new Map<string, Endpoint>();
    for (const e of endpoints) {
      const id = asString(e.id);
      if (id) m.set(id, e);
    }
    return m;
  }, [endpoints]);

  const [filter, setFilter] = useState<"all" | "ongoing" | "down" | "warn" | "resolved">("all");

  const filtered = useMemo(() => {
    return incidents.filter((i) => {
      const start = i.started_at ? Date.parse(i.started_at) : 0;
      if (start && start < cutoff && !!i.ended_at) return false;
      const ongoing = !i.ended_at;
      switch (filter) {
        case "ongoing":
          return ongoing;
        case "down":
          return i.state === "down";
        case "warn":
          return i.state === "warn";
        case "resolved":
          return !ongoing;
        default:
          return true;
      }
    });
  }, [incidents, filter, cutoff]);

  const rows = useMemo<Row[]>(() => {
    const byHost = new Map<string, EndpointIncident[]>();
    for (const i of filtered) {
      const host = hostKey(i.endpoint_id);
      const arr = byHost.get(host) ?? [];
      arr.push(i);
      byHost.set(host, arr);
    }
    const out: Row[] = [];
    for (const [host, items] of byHost) {
      const sample = items[0]!;
      const endpointId = asString(sample.endpoint_id);
      const ep = endpointId ? endpointMap.get(endpointId) : undefined;
      const netuid =
        (sample.netuid as number | undefined) ?? (ep?.netuid as number | undefined) ?? null;
      const pool = asString(ep?.pool) ?? null;
      const worst = items.reduce<HealthState>(
        (acc, cur) =>
          (SEVERITY_RANK[cur.state ?? "unknown"] ?? 0) > (SEVERITY_RANK[acc ?? "unknown"] ?? 0)
            ? (cur.state as HealthState)
            : acc,
        "unknown",
      );
      out.push({
        host,
        netuid,
        pool,
        worst,
        ongoing: items.filter((i) => !i.ended_at).length,
        total: items.length,
        items: items.sort(
          (a, b) => Date.parse(b.started_at ?? "0") - Date.parse(a.started_at ?? "0"),
        ),
      });
    }
    return out.sort((a, b) => {
      const sev = (SEVERITY_RANK[b.worst] ?? 0) - (SEVERITY_RANK[a.worst] ?? 0);
      if (sev !== 0) return sev;
      return b.total - a.total;
    });
  }, [filtered, endpointMap]);

  const counts = useMemo(() => {
    return {
      all: incidents.length,
      ongoing: incidents.filter((i) => !i.ended_at).length,
      down: incidents.filter((i) => i.state === "down").length,
      warn: incidents.filter((i) => i.state === "warn").length,
      resolved: incidents.filter((i) => !!i.ended_at).length,
    };
  }, [incidents]);

  // Pools we can identify the host as part of (best-effort).
  const poolByHost = useMemo(() => {
    const m = new Map<string, RpcPool>();
    for (const p of pools) {
      const name = (asString(p.name) ?? asString(p.id) ?? "").toLowerCase();
      if (!name) continue;
      m.set(name, p);
    }
    return m;
  }, [pools]);

  return (
    <Panel as="div" flush className={classNames("overflow-hidden", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Incidents · {RANGE_LABEL[range]}
          </div>
          <InfoTooltip label="Bars are positioned by incident start within the selected range and sized by duration. Color reflects severity. Click a row to open the host subnet or pool." />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(["all", "ongoing", "down", "warn", "resolved"] as const).map((k) => {
            const active = filter === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={classNames(
                  "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                  active
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border text-ink-muted hover:text-ink-strong hover:border-ink-muted/50",
                )}
                aria-pressed={active}
              >
                {k} <span className="tabular-nums text-ink-muted/80">{counts[k]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-6">
          <EmptyState
            title="No incidents in this range"
            description="Widen the time range or change the filter to see resolved incidents."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {/* Header axis */}
          <li className="grid grid-cols-[minmax(180px,260px)_1fr_min-content] items-center gap-3 px-4 py-1.5 bg-paper/40 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            <span>Host</span>
            <span className="flex items-center justify-between">
              <span>-{RANGE_LABEL[range]}</span>
              <span>now</span>
            </span>
            <span className="text-right">links</span>
          </li>
          {rows.map((r) => {
            const pool = r.pool ? poolByHost.get(r.pool.toLowerCase()) : undefined;
            return (
              <li
                key={r.host}
                className="grid grid-cols-[minmax(180px,260px)_1fr_min-content] items-center gap-3 px-4 py-3 group hover:bg-paper/40 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={classNames(
                        "inline-block size-2 rounded-sm",
                        SEVERITY_TINT[r.worst] ?? SEVERITY_TINT.unknown,
                      )}
                      aria-hidden
                    />
                    <span className="font-mono text-[12px] text-ink-strong truncate">{r.host}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-muted">
                    {r.ongoing > 0 ? (
                      <span className="text-health-down">{r.ongoing} ongoing</span>
                    ) : null}
                    <span>{r.total} total</span>
                  </div>
                </div>
                <TimelineTrack now={now} totalMs={totalMs} items={r.items} />
                <div className="flex items-center justify-end gap-2 text-[11px]">
                  {r.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: r.netuid }}
                      className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted hover:text-accent hover:border-accent/40"
                    >
                      SN{r.netuid}
                      <ChevronRight className="size-3" aria-hidden />
                    </Link>
                  ) : null}
                  {pool ? (
                    <Link
                      to="/endpoints"
                      search={(prev: Record<string, unknown>) =>
                        ({ ...prev, q: pool.name ?? pool.id }) as never
                      }
                      className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted hover:text-accent hover:border-accent/40"
                    >
                      pool · {pool.name ?? pool.id}
                      <ExtIcon className="size-3" aria-hidden />
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function TimelineTrack({
  items,
  now,
  totalMs,
}: {
  items: EndpointIncident[];
  now: number;
  totalMs: number;
}) {
  const cutoff = now - totalMs;
  return (
    <div className="relative h-6 rounded bg-border/30 overflow-hidden" role="presentation">
      {/* tick guides */}
      {[0.25, 0.5, 0.75].map((t) => (
        <span
          key={t}
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-border/60"
          style={{ left: `${t * 100}%` }}
        />
      ))}
      {items.map((i) => {
        const start = i.started_at ? Date.parse(i.started_at) : null;
        const end = i.ended_at ? Date.parse(i.ended_at) : now;
        if (!start || !Number.isFinite(start)) return null;
        const s = Math.max(start, cutoff);
        const e = Math.min(end, now);
        if (e < cutoff || s > now) return null;
        const left = ((s - cutoff) / totalMs) * 100;
        const width = Math.max(1.5, ((e - s) / totalMs) * 100);
        const tone = SEVERITY_TINT[i.state ?? "unknown"] ?? SEVERITY_TINT.unknown;
        const ongoing = !i.ended_at;
        return (
          <span
            key={i.id}
            className={classNames(
              "absolute top-1 bottom-1 rounded-sm transition-all",
              tone,
              ongoing && "ring-1 ring-paper/40",
            )}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${i.state ?? "unknown"} · ${durationLabel(i.started_at, i.ended_at)}${ongoing ? " · ongoing" : ""}${i.message ? ` · ${i.message}` : ""}`}
          >
            <span className="sr-only">
              {i.state} started <TimeAgo at={i.started_at} />
              {i.ended_at ? (
                <>
                  {" "}
                  ended <TimeAgo at={i.ended_at} />
                </>
              ) : (
                " ongoing"
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function hostKey(id: unknown): string {
  const key = asString(id);
  if (!key) return "—";
  const m = key.match(/^endpoint-sn-?\d+-(.+)$/i);
  return m ? m[1]! : key;
}
