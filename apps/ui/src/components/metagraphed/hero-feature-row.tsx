import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";

import {
  AnimatedTraceSparkline,
  directionFor,
} from "@/components/metagraphed/charts/animated-trace-sparkline";
import { BrandIcon, Sparkline } from "@jsonbored/ui-kit";
import { chainActivityQuery, subnetOhlcQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * Two-up feature row that lives directly beneath the centered hero.
 * Left = animated chain-throughput trace (7d). Right = compact live-subnet list
 * with per-row price sparklines. Everything renders skeletons/placeholders on
 * cold fetch so layout never jumps.
 */
export function HeroFeatureRow() {
  return (
    <section className="mt-10 md:mt-14 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <ChainThroughputCard />
      <LiveSubnetsCard />
    </section>
  );
}

/* ------------------------------ Left card ------------------------------ */

function ChainThroughputCard() {
  const hydrated = useHydrated();
  const { data } = useQuery({ ...chainActivityQuery("7d"), enabled: hydrated });
  const activity = hydrated ? data?.data : undefined;

  const { series, latest, deltaPct, dir } = useMemo(() => {
    const days = activity?.days?.length ? [...activity.days].reverse() : [];
    const s = days.map((d) => d.extrinsic_count).filter((v) => Number.isFinite(v));
    const last = s.at(-1) ?? 0;
    const first = s[0] ?? last;
    const delta = first ? ((last - first) / first) * 100 : 0;
    return {
      series: s,
      latest: last,
      deltaPct: delta,
      dir: s.length ? directionFor(s) : ("flat" as const),
    };
  }, [activity]);

  const deltaTone =
    dir === "up" ? "text-health-ok" : dir === "down" ? "text-health-down" : "text-ink-muted";

  return (
    <div className="mg-card-glow relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">
            Chain throughput · 7d
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <div className="font-display text-3xl md:text-4xl font-semibold tabular-nums text-ink-strong leading-none">
              {series.length ? formatNumber(latest) : "—"}
            </div>
            {series.length > 0 && (
              <span className={`font-mono text-xs tabular-nums ${deltaTone}`}>
                {deltaPct >= 0 ? "+" : ""}
                {deltaPct.toFixed(1)}%
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-subtle-text">
            extrinsics · last day
          </div>
        </div>
      </div>

      <div className="mt-4 px-1">
        {series.length >= 2 ? (
          <AnimatedTraceSparkline
            values={series}
            direction={dir}
            width={640}
            height={180}
            ariaLabel="Chain throughput over the last 7 days"
            className="w-full"
          />
        ) : (
          <div className="h-[180px] w-full animate-pulse rounded-lg bg-surface-2" />
        )}
      </div>

      <div className="mt-1 flex items-center justify-between border-t border-border px-5 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          /api/v1/chain/activity
        </span>
        <Link
          to="/blocks"
          className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-strong transition-colors hover:text-accent"
        >
          Open the block explorer
          <ArrowUpRight className="size-3" />
        </Link>
      </div>
    </div>
  );
}

/* ----------------------------- Right card ----------------------------- */

function LiveSubnetsCard() {
  const hydrated = useHydrated();
  const { data } = useQuery({ ...subnetsQuery({ limit: 128 }), enabled: hydrated });
  const subnets = hydrated ? ((data?.data as Subnet[] | undefined) ?? []) : [];

  const featured = useMemo(() => pickFeatured(subnets, 6), [subnets]);

  return (
    <div className="mg-card-glow flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">
          Live subnets · 7d
        </div>
        <Link
          to="/subnets"
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted transition-colors hover:text-accent"
        >
          View all
          <ArrowUpRight className="size-3" />
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {featured.length === 0 &&
          Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-3">
              <div className="size-7 shrink-0 animate-pulse rounded-md bg-surface-2" />
              <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
              <div className="ml-auto h-4 w-20 animate-pulse rounded bg-surface-2" />
            </li>
          ))}
        {featured.map((sn) => (
          <LiveSubnetRow key={sn.netuid} sn={sn} />
        ))}
      </ul>
    </div>
  );
}

function LiveSubnetRow({ sn }: { sn: Subnet }) {
  const { data } = useQuery({
    ...subnetOhlcQuery(sn.netuid, { interval: "1h", days: 7 }),
    enabled: sn.netuid > 0,
  });
  const closes = useMemo(() => {
    const candles = (data?.data?.candles ?? []) as Array<{ close?: number }>;
    return candles
      .map((c) => (typeof c.close === "number" ? c.close : NaN))
      .filter((v) => Number.isFinite(v));
  }, [data]);

  const deltaPct =
    closes.length >= 2 && closes[0] ? ((closes.at(-1)! - closes[0]) / closes[0]) * 100 : null;
  const dir: "up" | "down" | "flat" =
    deltaPct == null ? "flat" : deltaPct > 0.5 ? "up" : deltaPct < -0.5 ? "down" : "flat";
  const strokeColor =
    dir === "up" ? "var(--health-ok)" : dir === "down" ? "var(--health-down)" : "var(--ink-muted)";
  const deltaTone =
    dir === "up" ? "text-health-ok" : dir === "down" ? "text-health-down" : "text-ink-muted";

  return (
    <li>
      <Link
        to="/subnets/$netuid"
        params={{ netuid: sn.netuid }}
        className="mg-hover-lift flex items-center gap-3 px-5 py-3 text-sm"
      >
        <BrandIcon
          name={sn.name}
          netuid={sn.netuid}
          fallback={sn.symbol ?? sn.netuid}
          size={28}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ink-strong">{sn.name ?? `Subnet ${sn.netuid}`}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            SN{sn.netuid}
          </div>
        </div>
        <div className="hidden shrink-0 sm:block">
          {closes.length >= 2 ? (
            <Sparkline
              values={closes}
              width={72}
              height={22}
              interactive={false}
              color={strokeColor}
              ariaLabel={`${sn.name ?? "Subnet"} 7-day price trend`}
            />
          ) : (
            <div className="h-[22px] w-[72px] rounded bg-surface-2/60" />
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-0.5">
          <span
            className="font-mono text-[11px] tabular-nums text-ink-strong"
            title="Latest alpha price in TAO"
          >
            {closes.length ? `${formatAlpha(closes.at(-1)!)} τ` : "—"}
          </span>
          <span
            className={`font-mono text-[10px] tabular-nums ${deltaTone}`}
            title="Alpha price change over the last 7 days"
          >
            {deltaPct == null ? "—" : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`}
          </span>
        </div>
      </Link>
    </li>
  );
}

function formatAlpha(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

/* ----------------------------- helpers ----------------------------- */

function pickFeatured(subnets: Subnet[], n: number): Subnet[] {
  if (!subnets.length) return [];
  // Prefer adapter-backed / verified curation, then by descending market cap /
  // participant count as a rough popularity proxy. Skip root (netuid 0).
  const app = subnets.filter((s) => s.netuid > 0);
  const score = (s: Subnet) => {
    const c = (s as unknown as { curation?: string }).curation ?? "";
    const curationRank =
      c === "adapter" ? 4 : c === "native" ? 3 : c === "verified" ? 3 : c === "pilot" ? 2 : 1;
    const size = Number(
      (s as unknown as { participants?: number }).participants ??
        (s as unknown as { neuron_count?: number }).neuron_count ??
        0,
    );
    return curationRank * 1e6 + size;
  };
  return [...app].sort((a, b) => score(b) - score(a)).slice(0, n);
}
