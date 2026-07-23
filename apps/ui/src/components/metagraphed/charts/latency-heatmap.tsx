import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Filter } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@jsonbored/ui-kit";
import type { Endpoint } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";
import { Panel } from "@/components/metagraphed/primitives";

// Map heatmap "kind" buckets onto /endpoints `category` query values so chip
// clicks land on a pre-filtered view rather than the unfiltered list. The
// /endpoints route's search schema only accepts these category values
// (["all", "rpc", "wss", "api", "sse", "data", "other"]); archive collapses to
// rpc and grpc to api so we never emit a value the route would reject.
const KIND_TO_CATEGORY: Record<string, "rpc" | "wss" | "api" | "sse" | "all"> = {
  rpc: "rpc",
  wss: "wss",
  api: "api",
  sse: "sse",
  archive: "rpc",
  grpc: "api",
  other: "all",
};

interface Props {
  endpoints: Endpoint[];
  /** Only providers with at least this many tracked endpoints are shown. */
  minEndpoints?: number;
  /** Optional cap on rows shown to keep the matrix readable. */
  maxProviders?: number;
}

interface Cell {
  provider: string;
  kind: string;
  count: number;
  okCount: number;
  warnCount: number;
  downCount: number;
  avgLatency: number | null;
  endpoints: Endpoint[];
}

const KIND_ORDER = ["rpc", "wss", "archive", "api", "sse", "grpc", "other"];

function classifyKind(k?: string): string {
  const x = (k ?? "other").toLowerCase();
  return KIND_ORDER.includes(x) ? x : "other";
}

function latencyTone(p50: number | null, anyDown: boolean): string {
  if (anyDown) return "bg-health-down/70 hover:bg-health-down text-paper";
  if (p50 == null) return "bg-ink-subtle/15 text-ink-muted";
  if (p50 < 150) return "bg-health-ok/80 hover:bg-health-ok text-paper";
  if (p50 < 400) return "bg-health-ok/45 hover:bg-health-ok/70 text-ink-strong";
  if (p50 < 1000) return "bg-health-warn/70 hover:bg-health-warn text-paper";
  return "bg-health-down/70 hover:bg-health-down text-paper";
}

export function LatencyHeatmap({ endpoints, minEndpoints = 1, maxProviders = 20 }: Props) {
  const { rows, kinds, providers } = useMemo(() => {
    const grouped = new Map<string, Map<string, Endpoint[]>>();
    for (const e of endpoints) {
      const p = e.provider ?? e.provider_slug ?? "unknown";
      const k = classifyKind(e.kind);
      if (!grouped.has(p)) grouped.set(p, new Map());
      const inner = grouped.get(p)!;
      inner.set(k, [...(inner.get(k) ?? []), e]);
    }
    const providerList = [...grouped.entries()]
      .map(([p, m]) => {
        const total = [...m.values()].reduce((a, arr) => a + arr.length, 0);
        return { p, total };
      })
      .filter((r) => r.total >= minEndpoints)
      .sort((a, b) => b.total - a.total)
      .slice(0, maxProviders);

    const presentKinds = new Set<string>();
    for (const { p } of providerList) {
      const m = grouped.get(p)!;
      for (const k of m.keys()) presentKinds.add(k);
    }
    const kindList = KIND_ORDER.filter((k) => presentKinds.has(k));

    const matrix: Cell[][] = providerList.map(({ p }) => {
      const inner = grouped.get(p)!;
      return kindList.map((k) => {
        const arr = inner.get(k) ?? [];
        // Prefer real latency_ms, then probe p50, then p95 as a last resort.
        // Never fall through to freshness — these are millisecond measurements.
        const latencies = arr
          .map((e) => {
            const v =
              (typeof e.latency_ms === "number" ? e.latency_ms : undefined) ??
              (typeof (e as Record<string, unknown>).latency_p50_ms === "number"
                ? ((e as Record<string, unknown>).latency_p50_ms as number)
                : undefined) ??
              (typeof (e as Record<string, unknown>).latency_p95_ms === "number"
                ? ((e as Record<string, unknown>).latency_p95_ms as number)
                : undefined);
            return v;
          })
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const avg =
          latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
        return {
          provider: p,
          kind: k,
          count: arr.length,
          okCount: arr.filter((e) => e.health === "ok").length,
          warnCount: arr.filter((e) => e.health === "warn").length,
          downCount: arr.filter((e) => e.health === "down").length,
          avgLatency: avg,
          endpoints: arr,
        };
      });
    });

    return { rows: matrix, kinds: kindList, providers: providerList.map((p) => p.p) };
  }, [endpoints, minEndpoints, maxProviders]);

  if (providers.length === 0) {
    return (
      <Panel as="div" dense bodyClassName="text-xs text-ink-muted">
        No endpoint latency data yet.
      </Panel>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Panel as="div" flush className="overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Latency heatmap · provider × kind
          </div>
          <div
            className="flex flex-wrap items-center gap-2.5 text-[10px] font-mono text-ink-muted"
            role="list"
            aria-label="Latency legend"
          >
            <LegendBucket cls="bg-health-ok/80" label="<150ms" hint="Fast — p50 under 150ms" />
            <LegendBucket cls="bg-health-ok/45" label="<400ms" hint="Healthy — p50 under 400ms" />
            <LegendBucket
              cls="bg-health-warn/70"
              label="<1s"
              hint="Degraded — p50 under 1 second"
            />
            <LegendBucket
              cls="bg-health-down/70"
              label="slow/down"
              hint="Slow (>1s) or one or more endpoints down"
            />
          </div>
        </div>
        <div className="w-full overflow-x-auto [scrollbar-gutter:stable]">
          <table
            className="w-full min-w-[480px] text-[11px] font-mono"
            role="table"
            aria-label="Endpoint latency by provider and kind"
          >
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card text-left px-3 py-2 mg-type-micro text-ink-muted border-b border-border">
                  Provider
                </th>
                {kinds.map((k) => (
                  <th
                    key={k}
                    className="px-2 py-2 mg-type-micro text-ink-muted border-b border-border"
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={0}
                          className="cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded px-0.5"
                        >
                          {k}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-[11px]">
                        {KIND_HINT[k] ?? k}
                      </TooltipContent>
                    </Tooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const p = providers[idx]!;
                const total = row.reduce((a, c) => a + c.count, 0);
                return (
                  <tr key={p} className="border-b border-border last:border-b-0">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1.5 text-ink-strong border-r border-border">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            to="/providers/$slug"
                            params={{ slug: p }}
                            className="block max-w-[12ch] truncate hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
                          >
                            {p}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-[11px]">
                          {p} · {total} endpoint{total === 1 ? "" : "s"}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    {row.map((cell) => (
                      <td key={cell.kind} className="p-1 align-middle">
                        <Cell cell={cell} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </TooltipProvider>
  );
}

const KIND_HINT: Record<string, string> = {
  rpc: "HTTP JSON-RPC endpoints",
  wss: "WebSocket subscription endpoints",
  archive: "Archive-node RPC endpoints",
  api: "REST / gRPC application APIs",
  sse: "Server-sent event streams",
  grpc: "gRPC application endpoints",
  other: "Endpoints that don't fit a standard kind",
};

function Cell({ cell }: { cell: Cell }) {
  if (cell.count === 0) {
    return <div className="h-7 rounded bg-ink-subtle/10" aria-hidden />;
  }
  const tone = latencyTone(cell.avgLatency, cell.downCount > 0);
  const title =
    `${cell.provider} · ${cell.kind} · ${cell.count} endpoint${cell.count > 1 ? "s" : ""}` +
    (cell.avgLatency != null ? ` · avg ${Math.round(cell.avgLatency)}ms` : "") +
    (cell.downCount ? ` · ${cell.downCount} down` : "") +
    (cell.warnCount ? ` · ${cell.warnCount} warn` : "");

  // Affected pools / subnets (deduped) for direct linking. netuid is a number.
  const subnets = Array.from(
    new Set(cell.endpoints.map((e) => e.netuid).filter((v): v is number => typeof v === "number")),
  ).slice(0, 12);
  const pools = Array.from(
    new Set(
      cell.endpoints
        .map((e) => e.pool)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ).slice(0, 8);

  const ariaSummary =
    `${cell.provider} · ${cell.kind} · ${cell.count} endpoint${cell.count > 1 ? "s" : ""}` +
    (cell.avgLatency != null ? `, average ${Math.round(cell.avgLatency)} milliseconds` : "") +
    (cell.downCount ? `, ${cell.downCount} down` : "") +
    (cell.warnCount ? `, ${cell.warnCount} warn` : "");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={ariaSummary}
          className={classNames(
            "relative h-7 w-full rounded flex items-center justify-center text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
            tone,
          )}
        >
          <span aria-hidden>
            {cell.avgLatency != null ? `${Math.round(cell.avgLatency)}` : cell.count}
          </span>
          {cell.downCount > 0 || cell.warnCount > 0 ? (
            <span className="absolute top-0.5 right-0.5 flex items-center gap-0.5" aria-hidden>
              {cell.downCount > 0 ? (
                <span className="inline-flex h-3 min-w-[12px] items-center justify-center rounded-sm bg-health-down/95 px-0.5 text-[9px] font-mono leading-none text-paper">
                  {cell.downCount}
                </span>
              ) : null}
              {cell.warnCount > 0 ? (
                <span className="inline-flex h-3 min-w-[12px] items-center justify-center rounded-sm bg-health-warn/95 px-0.5 text-[9px] font-mono leading-none text-paper">
                  {cell.warnCount}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-[min(92vw,20rem)] p-3 mg-fade-in"
        aria-label="Endpoint cell details"
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 min-w-0 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted truncate">
              {cell.provider} · {cell.kind}
            </h3>
            <span className="font-mono text-[10px] text-ink-strong tabular-nums shrink-0">
              {cell.avgLatency != null ? `${Math.round(cell.avgLatency)}ms avg` : "—"}
            </span>
          </div>
          <div
            className="grid grid-cols-3 gap-1.5 text-[10px] font-mono"
            role="list"
            aria-label="Health breakdown"
          >
            <CellStat color="text-health-ok" label="ok" value={cell.okCount} />
            <CellStat color="text-health-warn" label="warn" value={cell.warnCount} />
            <CellStat color="text-health-down" label="down" value={cell.downCount} />
          </div>
          <div className="border-t border-border pt-2 space-y-2">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center">
              <Link
                to="/providers/$slug"
                params={{ slug: cell.provider }}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
              >
                open provider <ExternalLink className="size-3" />
              </Link>
              <Link
                to="/endpoints"
                search={
                  {
                    provider: cell.provider,
                    category: KIND_TO_CATEGORY[cell.kind] ?? "all",
                  } as never
                }
                className="sm:ml-auto inline-flex items-center gap-1 rounded border border-border bg-paper px-1.5 py-0.5 mg-type-micro text-ink-muted hover:text-accent hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors"
                aria-label={`Open endpoints filtered to ${cell.provider} ${cell.kind}`}
              >
                <Filter className="size-3" /> filter endpoints
              </Link>
            </div>
            {subnets.length > 0 ? (
              <ChipGroup label="Affected subnets" id={`chips-sn-${cell.provider}-${cell.kind}`}>
                {subnets.map((n) => (
                  <Tooltip key={n}>
                    <TooltipTrigger asChild>
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: n }}
                        search={{ tab: "endpoints" } as never}
                        hash="endpoints"
                        className="inline-flex h-6 items-center rounded border border-border bg-paper px-2 font-mono text-[10px] text-ink hover:border-accent/60 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors"
                        aria-label={`Jump to subnet ${n} endpoints`}
                      >
                        SN{n}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[11px]">
                      Jump to SN{n} · {cell.kind} endpoints
                    </TooltipContent>
                  </Tooltip>
                ))}
              </ChipGroup>
            ) : null}
            {pools.length > 0 ? (
              <ChipGroup label="Affected pools" id={`chips-pool-${cell.provider}-${cell.kind}`}>
                {pools.map((p) => (
                  <Tooltip key={p}>
                    <TooltipTrigger asChild>
                      <Link
                        to="/endpoints"
                        search={{ q: p } as never}
                        hash={`pool-${p}`}
                        className="inline-flex h-6 max-w-[16ch] items-center truncate rounded border border-border bg-paper px-2 font-mono text-[10px] text-ink hover:border-accent/60 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors"
                        aria-label={`Scroll to pool ${p} in endpoints`}
                      >
                        {p}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      className="font-mono text-[11px] break-all max-w-[90vw]"
                    >
                      {p}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </ChipGroup>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChipGroup({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div>
      <div id={id} className="mg-type-micro text-ink-muted mb-1">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5" role="list" aria-labelledby={id}>
        {children}
      </div>
    </div>
  );
}

function CellStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded border border-border bg-paper px-2 py-1 text-center" role="listitem">
      <div className={classNames("tabular-nums text-[12px] font-semibold", color)}>{value}</div>
      <div className="mg-type-micro text-ink-muted">{label}</div>
    </div>
  );
}

function LegendBucket({ cls, label, hint }: { cls: string; label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 cursor-help rounded px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          tabIndex={0}
          role="listitem"
        >
          <span className={`size-2 rounded-sm ${cls}`} aria-hidden />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
