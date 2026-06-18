import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import type { Endpoint } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";

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
  p50Latency: number | null;
  endpoints: Endpoint[];
}

/** Median (p50) of the supplied latencies, or null when none are numeric. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
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
        const latencies = arr
          .map((e) => e.latency_ms)
          .filter((v): v is number => typeof v === "number");
        return {
          provider: p,
          kind: k,
          count: arr.length,
          okCount: arr.filter((e) => e.health === "ok").length,
          warnCount: arr.filter((e) => e.health === "warn").length,
          downCount: arr.filter((e) => e.health === "down").length,
          p50Latency: median(latencies),
          endpoints: arr,
        };
      });
    });

    return { rows: matrix, kinds: kindList, providers: providerList.map((p) => p.p) };
  }, [endpoints, minEndpoints, maxProviders]);

  if (providers.length === 0) {
    return (
      <div className="rounded border border-border bg-card p-4 text-xs text-ink-muted">
        No endpoint latency data yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Latency heatmap · provider × kind · cell = p50 latency of tracked endpoints
        </div>
        <div className="flex items-center gap-2.5 text-[10px] font-mono text-ink-muted">
          <Bucket cls="bg-health-ok/80" label="<150ms" />
          <Bucket cls="bg-health-ok/45" label="<400ms" />
          <Bucket cls="bg-health-warn/70" label="<1s" />
          <Bucket cls="bg-health-down/70" label="slow/down" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card text-left px-3 py-2 text-[10px] uppercase tracking-widest text-ink-muted border-b border-border">
                Provider
              </th>
              {kinds.map((k) => (
                <th
                  key={k}
                  className="px-2 py-2 text-[10px] uppercase tracking-widest text-ink-muted border-b border-border"
                >
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const p = providers[idx]!;
              return (
                <tr key={p} className="border-b border-border last:border-b-0">
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5 text-ink-strong border-r border-border">
                    <Link to="/providers/$slug" params={{ slug: p }} className="hover:text-accent">
                      {p}
                    </Link>
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
    </div>
  );
}

function Cell({ cell }: { cell: Cell }) {
  if (cell.count === 0) {
    return <div className="h-7 rounded bg-ink-subtle/10" aria-hidden />;
  }
  const tone = latencyTone(cell.p50Latency, cell.downCount > 0);
  const title =
    `${cell.provider} · ${cell.kind} · ${cell.count} endpoint${cell.count > 1 ? "s" : ""}` +
    (cell.p50Latency != null ? ` · p50 ${Math.round(cell.p50Latency)}ms` : "") +
    (cell.downCount ? ` · ${cell.downCount} down` : "") +
    (cell.warnCount ? ` · ${cell.warnCount} warn` : "");
  return (
    <div
      title={title}
      className={classNames(
        "h-7 rounded flex items-center justify-center text-[10px] font-medium transition-colors",
        tone,
      )}
    >
      {cell.p50Latency != null ? `${Math.round(cell.p50Latency)}` : cell.count}
    </div>
  );
}

function Bucket({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`size-2 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}
