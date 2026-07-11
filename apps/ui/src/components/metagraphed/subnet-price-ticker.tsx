import { useMemo, useState } from "react";
import { useSuspenseQuery, useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { BrandIcon } from "@jsonbored/ui-kit";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { economicsQuery, subnetsQuery, subnetTrajectoryQuery } from "@/lib/metagraphed/queries";
import { healthColorVar } from "@/lib/health-tokens";
import type { Subnet } from "@/lib/metagraphed/types";

const UP = healthColorVar("ok");
const DOWN = healthColorVar("down");
const FLAT = "var(--ink-muted, #616b6c)";

function priceStr(v?: number) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 0.001) return `${v.toExponential(2)} τ`;
  return `${v < 1 ? v.toFixed(4) : v.toFixed(3)} τ`;
}

/**
 * Stock-ticker-style alpha-price marquee for the home hero (#1302). Each item is a
 * BrandIcon + name + current price + a gain/loss % and a sparkline coloured GREEN on a
 * rising trend / RED on a falling one (neutral until ≥2 price points exist).
 *
 * Price history comes from each subnet's /trajectory series (alpha_price_tao), fetched
 * non-blocking via useQueries so the marquee paints immediately on the current price
 * and the trends fill in as they load (and as the price backfill deepens the history).
 */
export function SubnetPriceTicker({ limit = 12 }: { limit?: number }) {
  const { data: ecoRes } = useSuspenseQuery(economicsQuery());
  const { data: subnetsRes } = useSuspenseQuery(subnetsQuery({ limit: 128 }));
  const [paused, setPaused] = useState(false);

  const items = useMemo(() => {
    const subnetByNetuid = new Map<number, Subnet>();
    for (const s of (subnetsRes.data ?? []) as Subnet[]) subnetByNetuid.set(s.netuid, s);

    return (ecoRes.data ?? [])
      .filter((e) => e.netuid !== 0 && typeof e.alpha_price_tao === "number")
      .map((e) => {
        const subnet = subnetByNetuid.get(e.netuid);
        return {
          netuid: e.netuid,
          name: e.name ?? subnet?.name ?? `Subnet ${e.netuid}`,
          price: e.alpha_price_tao as number,
          website: subnet?.website,
          slug: e.slug,
        };
      })
      .sort((a, b) => b.price - a.price)
      .slice(0, limit);
  }, [ecoRes.data, subnetsRes.data, limit]);

  // Per-subnet price history (non-blocking; deduped/cached by React Query).
  const trajectories = useQueries({
    queries: items.map((it) => subnetTrajectoryQuery(it.netuid)),
  });

  const trend = useMemo(() => {
    return items.map((it, i) => {
      const points = trajectories[i]?.data?.data?.points ?? [];
      const series = points
        .map((p) => p.alpha_price_tao)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      // Always anchor the line at the current price so a single live point still draws.
      const values = series.length ? series : [it.price];
      const first = values[0]!;
      const last = values[values.length - 1]!;
      const hasTrend = values.length >= 2 && first > 0;
      const changePct = hasTrend ? ((last - first) / first) * 100 : null;
      const dir = changePct == null ? 0 : changePct > 0 ? 1 : changePct < 0 ? -1 : 0;
      const color = dir > 0 ? UP : dir < 0 ? DOWN : FLAT;
      return { values, changePct, dir, color };
    });
  }, [items, trajectories]);

  if (items.length === 0) return null;

  // Duplicate so the CSS loop is seamless (matches the prior ticker).
  const loop = items.map((it, i) => ({ it, t: trend[i]! }));
  const rendered = [...loop, ...loop];

  return (
    <div
      className="mg-ticker mg-fade-in mg-fade-in-delay-3 mt-3 relative overflow-hidden border-y border-border/60"
      aria-label="Subnet alpha prices"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        className="mg-ticker-track flex items-center gap-6 py-2 whitespace-nowrap"
        style={{ animationPlayState: paused ? "paused" : "running" }}
      >
        {rendered.map(({ it, t }, i) => {
          const arrow = t.dir > 0 ? "▲" : t.dir < 0 ? "▼" : "";
          return (
            <Link
              key={`${it.netuid}-${i}`}
              to="/subnets/$netuid"
              params={{ netuid: it.netuid }}
              className="inline-flex items-center gap-2 text-[11px] hover:text-ink-strong transition-colors"
              title={`${it.name} · SN${it.netuid} · ${priceStr(it.price)}${
                t.changePct != null
                  ? ` · ${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(1)}%`
                  : ""
              }`}
            >
              <BrandIcon
                size={16}
                name={it.name}
                fallback={it.netuid}
                url={it.website}
                subnetSlug={it.slug}
                netuid={it.netuid}
              />
              <span className="font-medium text-ink-strong truncate max-w-[16ch]">{it.name}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                SN{it.netuid}
              </span>
              <span className="font-display font-semibold tabular-nums text-ink-strong">
                {priceStr(it.price)}
              </span>
              <span className="inline-block w-[44px] align-middle">
                <Sparkline
                  values={t.values}
                  width={44}
                  height={14}
                  interactive={false}
                  fill={false}
                  color={t.color}
                />
              </span>
              {t.changePct != null ? (
                <span className="font-mono tabular-nums text-[10px]" style={{ color: t.color }}>
                  {arrow} {t.changePct >= 0 ? "+" : ""}
                  {t.changePct.toFixed(1)}%
                </span>
              ) : null}
              <span aria-hidden className="text-ink-subtle">
                ·
              </span>
            </Link>
          );
        })}
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-paper to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-paper to-transparent"
      />
      <span
        aria-hidden
        className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-muted bg-paper px-1.5"
      >
        <Coins className="size-2.5" />
        alpha
      </span>
    </div>
  );
}
