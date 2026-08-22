import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { RankedRails, type RankedRailItem } from "@jsonbored/ui-kit";
import { endpointIncidentsQuery, endpointsQuery, rpcPoolsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatRelative, humaniseSeconds } from "@/lib/metagraphed/format";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { useTimeRange, RANGE_HOURS, RANGE_LABEL } from "./time-range-context";
import type { Endpoint, EndpointIncident, RpcPool } from "@/lib/metagraphed/types";

interface Row {
  host: string;
  /** Seconds spent inside an incident within the active range (clamped). */
  seconds: number;
  count: number;
  ongoing: number;
  lastState: string;
  lastStart: string | undefined;
  href: string | undefined;
}

/**
 * Hosts ranked by time spent in an incident inside the active range (or by
 * incident count when no incident carries a start time). Rows deep-link to
 * the host subnet, or to the RPC pool when only that can be inferred.
 */
export function IncidentsTimeline({ className }: { className?: string }) {
  const { range } = useTimeRange();
  const totalMs = RANGE_HOURS[range] * 3_600_000;
  const now = Date.now();
  const cutoff = now - totalMs;

  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());
  const { data: eRes } = useSuspenseQuery(endpointsQuery({ limit: 500 }));
  const { data: pRes } = useSuspenseQuery(rpcPoolsQuery());

  const incidents = useMemo(() => (iRes.data ?? []) as EndpointIncident[], [iRes.data]);
  const endpoints = useMemo(() => (eRes.data ?? []) as Endpoint[], [eRes.data]);
  const pools = useMemo(() => (pRes.data ?? []) as RpcPool[], [pRes.data]);

  // Map endpoint_id → endpoint metadata so each host can deep-link.
  const endpointMap = useMemo(() => {
    const m = new Map<string, Endpoint>();
    for (const e of endpoints) {
      const id = asString(e.id);
      if (id) m.set(id, e);
    }
    return m;
  }, [endpoints]);

  // Pools we can identify the host as part of (best-effort).
  const poolByName = useMemo(() => {
    const m = new Map<string, RpcPool>();
    for (const p of pools) {
      const name = (asString(p.name) ?? asString(p.id) ?? "").toLowerCase();
      if (name) m.set(name, p);
    }
    return m;
  }, [pools]);

  const rows = useMemo<Row[]>(() => {
    const byHost = new Map<string, EndpointIncident[]>();
    for (const i of incidents) {
      const start = i.started_at ? Date.parse(i.started_at) : 0;
      // Resolved before the range began: out of scope. Ongoing ones always count.
      if (start && start < cutoff && !!i.ended_at) continue;
      const host = hostKey(i.endpoint_id);
      byHost.set(host, [...(byHost.get(host) ?? []), i]);
    }
    const out: Row[] = [];
    for (const [host, items] of byHost) {
      items.sort((a, b) => Date.parse(b.started_at ?? "0") - Date.parse(a.started_at ?? "0"));
      const sample = items[0]!;
      const endpointId = asString(sample.endpoint_id);
      const ep = endpointId ? endpointMap.get(endpointId) : undefined;
      const netuid =
        (sample.netuid as number | undefined) ?? (ep?.netuid as number | undefined) ?? null;
      const pool = asString(ep?.pool)
        ? poolByName.get(asString(ep?.pool)!.toLowerCase())
        : undefined;
      const poolName = pool ? (asString(pool.name) ?? asString(pool.id)) : undefined;
      const href =
        netuid != null
          ? `/subnets/${netuid}`
          : poolName
            ? `/apis/endpoints?q=${encodeURIComponent(poolName)}`
            : undefined;
      let seconds = 0;
      for (const i of items) {
        const start = i.started_at ? Date.parse(i.started_at) : NaN;
        if (!Number.isFinite(start)) continue;
        const end = i.ended_at ? Date.parse(i.ended_at) : now;
        const overlap = Math.min(end, now) - Math.max(start, cutoff);
        if (overlap > 0) seconds += overlap / 1000;
      }
      out.push({
        host,
        seconds,
        count: items.length,
        ongoing: items.filter((i) => !i.ended_at).length,
        lastState: String(sample.state ?? "unknown"),
        lastStart: sample.started_at,
        href,
      });
    }
    return out;
  }, [incidents, cutoff, now, endpointMap, poolByName]);

  const byDuration = rows.some((r) => r.seconds > 0);
  const items = useMemo<RankedRailItem[]>(
    () =>
      rows
        .map((r) => ({
          key: `host:${r.host}`,
          label: r.host,
          value: byDuration ? r.seconds : r.count,
          href: r.href,
          detail: [
            {
              key: "count",
              label: "incidents",
              value: r.ongoing > 0 ? `${r.count} (${r.ongoing} ongoing)` : String(r.count),
            },
            { key: "state", label: "last state", value: r.lastState },
            { key: "start", label: "last start", value: formatRelative(r.lastStart) },
          ],
        }))
        .sort((a, b) => b.value - a.value),
    [rows, byDuration],
  );

  return (
    <Panel
      title={`Incidents · ${RANGE_LABEL[range]}`}
      caption={
        byDuration
          ? "Hosts ranked by time spent in an incident inside the range."
          : "Hosts ranked by incident count; no incident in range carries a start time."
      }
      className={className}
    >
      {items.length === 0 ? (
        <EmptyState
          title="No incidents in this range"
          description="Widen the time range to see resolved incidents."
        />
      ) : (
        <RankedRails
          items={items}
          formatValue={byDuration ? (v) => humaniseSeconds(v) : (v) => formatNumber(v)}
          columns={
            byDuration
              ? { value: "Downtime", name: "Host", track: "in range" }
              : { value: "Incidents", name: "Host", track: "count" }
          }
          ariaLabel={`Hosts ranked by ${byDuration ? "incident time" : "incident count"} over ${RANGE_LABEL[range]}`}
          source="incidents"
        />
      )}
    </Panel>
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
