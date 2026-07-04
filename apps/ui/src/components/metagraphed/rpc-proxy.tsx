import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Zap, GitBranch, Database, ShieldCheck, Gauge, ArrowUpDown } from "lucide-react";
import { API_BASE } from "@/lib/metagraphed/config";
import { useNetwork } from "@/hooks/use-api-base";
import { rpcUsageQuery } from "@/lib/metagraphed/queries";
import { CopyButton } from "./copy-button";
import { TimeAgo } from "./time-ago";
import { EmptyState, StaleBanner } from "./states";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import type { RpcUsage } from "@/lib/metagraphed/types";

// The proxy is one service fronting multiple chains (finney + test today). Map
// the selected network to its chain segment + a label; the hero shows the URL
// for whichever network the selector is on.
const PROXY_CHAINS: Record<string, { chain: string; label: string }> = {
  mainnet: { chain: "finney", label: "finney · mainnet" },
  testnet: { chain: "test", label: "test · testnet" },
};

// Single-quote the URL so a copy-pasted curl command can't let the shell
// interpret characters in it.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function curlFor(url: string): string {
  return `curl -s ${shellSingleQuote(url)} \\
  -X POST -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}'`;
}

const HOW_IT_WORKS: { icon: typeof Zap; title: string; body: string }[] = [
  {
    icon: ArrowUpDown,
    title: "Health-aware load balancing",
    body: "Requests fan out across the public endpoint pool, weighted by live probe health and score.",
  },
  {
    icon: GitBranch,
    title: "Block-height routing",
    body: "Nodes trailing the freshest reported tip are demoted behind synced peers, so reads hit current state.",
  },
  {
    icon: Zap,
    title: "Automatic failover",
    body: "A dead or transient upstream is retried against the next-best endpoint — transparent to the caller.",
  },
  {
    icon: Database,
    title: "Edge caching",
    body: "Block-pinned reads (chain_getBlockHash/Block/Header) are cached at the edge for instant repeat hits.",
  },
  {
    icon: ShieldCheck,
    title: "Read-only + rate-limited",
    body: "Only safe read methods pass the allowlist; 100 requests/min per client keeps the pool healthy.",
  },
];

export function ProxyHero() {
  const { network } = useNetwork();
  const { chain, label } = PROXY_CHAINS[network.id] ?? PROXY_CHAINS.mainnet;
  const proxyUrl = `${API_BASE}/rpc/v1/${chain}`;
  const curlExample = curlFor(proxyUrl);
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded border border-health-ok/40 bg-health-ok/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-health-ok">
          <span className="size-1.5 rounded-full bg-health-ok" />
          Live
        </span>
        <span className="mg-label">Load-balanced reverse proxy</span>
        <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accent">
          {label}
        </span>
      </div>
      <h2 className="mt-2 font-display text-lg font-semibold text-ink-strong">
        One endpoint for Bittensor RPC
      </h2>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-muted">
        POST JSON-RPC to a single URL and Metagraphed routes it across the healthiest, most in-sync
        public endpoints — with failover, edge caching, and abuse controls. No key, no account, no
        single point of failure.
      </p>

      <div className="mt-4 flex items-center gap-2 rounded border border-border bg-card px-3 py-2">
        <span className="mg-label">POST</span>
        <code className="flex-1 truncate font-mono text-[13px] text-ink-strong">{proxyUrl}</code>
        <CopyButton value={proxyUrl} label="proxy URL" />
      </div>

      <div className="mt-2 rounded border border-border bg-paper">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="mg-label">Try it</span>
          <CopyButton value={curlExample} label="curl command" />
        </div>
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
          {curlExample}
        </pre>
      </div>

      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {HOW_IT_WORKS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-2.5">
            <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <div>
              <p className="text-[12px] font-medium text-ink-strong">{title}</p>
              <p className="text-[11px] leading-snug text-ink-muted">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null | undefined): string {
  return value == null ? "—" : `${formatNumber(value)} ms`;
}

function UsageStat({
  eyebrow,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  eyebrow: string;
  value: string;
  hint?: string;
  icon: typeof Zap;
  tone?: "default" | "ok" | "warn";
}) {
  return (
    <div
      className={classNames(
        "rounded border bg-card px-3 py-2.5",
        tone === "ok" && "border-health-ok/30",
        tone === "warn" && "border-health-warn/30",
        tone === "default" && "border-border",
      )}
    >
      <div className="flex items-center gap-1.5 text-ink-muted">
        <Icon className="size-3" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-widest">{eyebrow}</span>
      </div>
      <div className="mt-1 font-mono text-lg font-semibold text-ink-strong">{value}</div>
      {hint ? <div className="font-mono text-[10px] text-ink-muted">{hint}</div> : null}
    </div>
  );
}

export function ProxyUsagePanel() {
  const [window, setWindow] = useState<"7d" | "30d">("7d");
  const { data } = useSuspenseQuery(rpcUsageQuery(window));
  const usage = data.data as RpcUsage;
  const s = usage.summary;
  const hasTraffic = s.total_requests > 0;
  const stale = isStaleFreshness(data.meta?.generated_at);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-ink-muted">
          {usage.observed_at ? (
            <>
              Updated <TimeAgo at={usage.observed_at} />
            </>
          ) : (
            "Live from the proxy telemetry"
          )}
        </p>
        <div className="inline-flex rounded border border-border bg-card p-0.5">
          {(["7d", "30d"] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={classNames(
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
                window === w ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {stale ? <StaleBanner generatedAt={data.meta?.generated_at} /> : null}

      {!hasTraffic ? (
        <EmptyState
          title="No proxied traffic in this window yet"
          description="The proxy is live and ready — usage analytics populate here as soon as clients start routing requests through it."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <UsageStat
              icon={Zap}
              eyebrow="Requests"
              value={formatNumber(s.total_requests)}
              hint={window}
            />
            <UsageStat
              icon={Gauge}
              eyebrow="p50"
              value={ms(s.latency_ms.p50)}
              hint={`p95 ${ms(s.latency_ms.p95)}`}
            />
            <UsageStat
              icon={ShieldCheck}
              eyebrow="Success"
              value={pct(s.total_requests ? s.ok_requests / s.total_requests : null)}
              hint={`${formatNumber(s.ok_requests)} ok`}
              tone={s.error_rate != null && s.error_rate > 0.05 ? "warn" : "ok"}
            />
            <UsageStat
              icon={Zap}
              eyebrow="Errors"
              value={pct(s.error_rate)}
              hint={`${formatNumber(s.error_requests)} failed`}
              tone={s.error_rate != null && s.error_rate > 0.05 ? "warn" : "default"}
            />
            <UsageStat
              icon={ArrowUpDown}
              eyebrow="Failover"
              value={pct(s.failover_rate)}
              hint={`${formatNumber(s.failover_requests)} retried`}
            />
            <UsageStat
              icon={Database}
              eyebrow="Cache hits"
              value={pct(s.cache_hit_rate)}
              hint={`${formatNumber(s.cache_hits)} served`}
            />
          </div>

          {usage.networks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="mg-label">By network</span>
              {usage.networks.map((n) => (
                <span
                  key={n.network}
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-0.5 font-mono text-[11px]"
                >
                  <span className="text-ink-strong">{n.network}</span>
                  <span className="text-ink-muted">{formatNumber(n.requests)}</span>
                </span>
              ))}
            </div>
          ) : null}

          {usage.endpoints.length > 0 ? (
            <div className="rounded border border-border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="px-3 pt-2 text-left mg-label">
                  Per-endpoint distribution
                </caption>
                <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Endpoint</th>
                    <th className="px-3 py-2 text-left">Provider</th>
                    <th className="px-3 py-2 text-right">Requests</th>
                    <th className="px-3 py-2 text-right">Share</th>
                    <th className="px-3 py-2 text-right">Errors</th>
                    <th className="px-3 py-2 text-right">Avg latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {usage.endpoints.map((e) => {
                    const share = s.total_requests ? e.requests / s.total_requests : null;
                    return (
                      <tr key={e.endpoint_id ?? e.rank} className="mg-row-hover">
                        <td className="px-3 py-2 font-mono text-[12px] text-ink-strong">
                          {e.endpoint_id ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-[12px] text-ink-muted">
                          {e.provider ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatNumber(e.requests)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink-muted">
                          {pct(share)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink-muted">
                          {pct(e.error_rate)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink-muted">
                          {ms(e.avg_latency_ms)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
