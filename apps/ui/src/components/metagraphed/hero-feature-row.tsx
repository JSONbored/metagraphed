import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";

import { AnimatedTraceSparkline } from "@/components/metagraphed/charts/animated-trace-sparkline";
import { BrandIcon, Sparkline, TimeAgo } from "@jsonbored/ui-kit";
import {
  chainActivityQuery,
  healthQuery,
  subnetOhlcQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { ChainActivity, Subnet } from "@/lib/metagraphed/types";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * The UTC calendar-day string (YYYY-MM-DD) "today" means for this card,
 * derived from the API's own `observed_at` rather than the client clock so a
 * reader whose local time has already rolled to a new UTC day doesn't
 * disagree with what the server just measured. Falls back to the client
 * clock only when there's no reading yet (nothing has loaded) or the
 * timestamp is unusable.
 */
export function chainActivityTodayUtc(observedAt?: string | null): string {
  const d = observedAt ? new Date(observedAt) : new Date();
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  return base.toISOString().slice(0, 10);
}

/**
 * metagraphed#8354: `activity.days` covers the window's most recent UTC
 * calendar days INCLUDING the current, still-accumulating one --
 * buildChainActivity's own trim (src/chain-analytics.ts) keeps "today" and
 * only drops the OLDER boundary day, which is correct for a live "blocks
 * today" counter and wrong for a trend LINE: plotting a partial day's count
 * on equal footing with whole prior days draws a cliff that reads as "the
 * chain stopped producing blocks," when it's actually just "fewer hours have
 * elapsed today than in a full day" (the exact illusion the 2026-07-27 audit
 * flagged). This mirrors buildChainActivity's own convention for the OTHER
 * boundary -- exclude the partial day from what gets DRAWN, keep it for the
 * number that's supposed to grow over the day.
 */
export function splitChainActivityToday(
  days: ChainActivity["days"] | null | undefined,
  todayUtc: string,
): { fullDayBlockCounts: number[]; blocksToday: number } {
  const list = days ?? [];
  const todayEntry = list.find((d) => d.day === todayUtc);
  const fullDayBlockCounts = list
    .filter((d) => d.day !== todayUtc)
    .map((d) => d.block_count)
    .filter((v) => Number.isFinite(v));
  return { fullDayBlockCounts, blocksToday: todayEntry?.block_count ?? 0 };
}

/**
 * Two-up feature row that lives directly beneath the centered hero.
 * Left = neutral chain-throughput trace (7d). Right = compact live-subnet list
 * with per-row price sparklines. Everything renders skeletons/placeholders on
 * cold fetch so layout never jumps.
 */
export function HeroFeatureRow() {
  return (
    <section className="mt-10 md:mt-12 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <ChainThroughputCard />
      <LiveSubnetsCard />
    </section>
  );
}

/* ------------------------------ Left card ------------------------------ */

// #8249: was "extrinsics today, +/-N% in red-or-green" -- a stat that read as
// bad news on the very first paint whenever throughput merely dipped day over
// day (nothing wrong with the network, just noise). Replaced with a neutral
// pair the audit asked for -- blocks produced today + endpoints currently up
// -- and a permanently neutral-colored trace (no red/green direction at all)
// so the hero never opens on a negative-framed number.
function ChainThroughputCard() {
  const hydrated = useHydrated();
  const { data: activityData } = useQuery({ ...chainActivityQuery("7d"), enabled: hydrated });
  const { data: healthData } = useQuery({ ...healthQuery(), enabled: hydrated });
  const activity = hydrated ? activityData?.data : undefined;
  const health = hydrated ? healthData?.data : undefined;

  const todayUtc = useMemo(
    () => chainActivityTodayUtc(activity?.observed_at),
    [activity?.observed_at],
  );

  const { series, blocksToday } = useMemo(() => {
    const oldestFirst = activity?.days?.length ? [...activity.days].reverse() : [];
    const { fullDayBlockCounts, blocksToday: today } = splitChainActivityToday(
      oldestFirst,
      todayUtc,
    );
    return { series: fullDayBlockCounts, blocksToday: today };
  }, [activity, todayUtc]);

  const endpointsOk = health?.ok;
  const endpointsTotal =
    health != null
      ? (health.ok ?? 0) + (health.warn ?? 0) + (health.down ?? 0) + (health.unknown ?? 0)
      : undefined;

  return (
    <div className="mg-card-glow relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <div className="mg-type-caption text-ink-muted">Blocks today</div>
          <div className="mt-2 font-display text-3xl md:text-4xl font-semibold tabular-nums text-ink-strong leading-none">
            {activity ? formatNumber(blocksToday) : "—"}
          </div>
          {/* #8354: "today" is a live, still-accumulating count -- explicit
              about that (never appears as if it were a completed day's
              total) and carries the same freshness signal every other
              live-tier surface in this app already shows. */}
          {activity ? (
            <div className="mg-type-caption text-ink-muted">
              so far · <TimeAgo at={activity.observed_at} className="tabular-nums" />
            </div>
          ) : null}
        </div>
        <div className="min-w-0 text-right">
          <div className="mg-type-caption text-ink-muted">Endpoints up</div>
          <div className="mt-2 font-display text-3xl md:text-4xl font-semibold tabular-nums text-ink-strong leading-none">
            {endpointsTotal ? `${formatNumber(endpointsOk)}/${formatNumber(endpointsTotal)}` : "—"}
          </div>
        </div>
      </div>

      <div className="mt-4 px-1">
        {series.length >= 2 ? (
          <AnimatedTraceSparkline
            values={series}
            direction="flat"
            width={640}
            height={180}
            // #8354: today (still accumulating, not comparable to a whole
            // day's total) is deliberately excluded from this trend --
            // labeled by what's actually drawn, not the window the API call
            // asked for.
            ariaLabel={`Blocks produced per full UTC day over the last ${series.length} days`}
            className="w-full"
          />
        ) : (
          <div className="h-[180px] w-full animate-pulse rounded-md bg-surface-2" />
        )}
      </div>

      <div className="mt-1 flex flex-col items-start gap-1.5 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="mg-type-caption text-ink-muted">/api/v1/chain/activity</span>
        <Link
          to="/chain/blocks"
          className="inline-flex items-center gap-1.5 mg-type-label uppercase text-ink-strong transition-colors hover:text-accent"
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
  const subnets = useMemo(
    () => (hydrated ? ((data?.data as Subnet[] | undefined) ?? []) : []),
    [hydrated, data?.data],
  );

  const featured = useMemo(() => pickFeatured(subnets, 6), [subnets]);

  return (
    <div className="mg-card-glow flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="mg-type-caption text-ink-muted">Live subnets · 7d</div>
        <Link
          to="/subnets"
          className="inline-flex items-center gap-1 mg-type-caption text-ink-muted transition-colors hover:text-accent"
        >
          View all
          <ArrowUpRight className="size-3" />
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {featured.length === 0 &&
          Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3">
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
        className="mg-hover-lift flex items-center gap-3 px-4 py-3 text-sm"
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
          <div className="mg-type-caption text-ink-muted">SN{sn.netuid}</div>
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
            className="mg-type-data tabular-nums text-ink-strong"
            title="Latest alpha price in TAO"
          >
            {closes.length ? `${formatAlpha(closes.at(-1)!)} τ` : "—"}
          </span>
          <span
            className={`mg-type-data-sm tabular-nums ${deltaTone}`}
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
