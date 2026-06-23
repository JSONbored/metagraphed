import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { economicsQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import type { Subnet } from "@/lib/metagraphed/types";

function priceStr(v?: number) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 0.001) return `${v.toExponential(2)} τ`;
  return `${v < 1 ? v.toFixed(4) : v.toFixed(3)} τ`;
}

/**
 * Additive alpha-price marquee for the home hero (#1302). Coexists with the
 * HeroTicker — does not replace it. Shows the top subnets by alpha price as a
 * BrandIcon + name + current price + a tiny sparkline.
 *
 * NB the /economics artifact carries a single live alpha_price_tao per subnet,
 * not a price time-series, and /trajectory's normalized points don't include
 * alpha_price either — so the sparkline renders a flat baseline (current price
 * only). It upgrades to a real trend the day /history (or trajectory) carries a
 * per-day alpha_price field; nothing else here changes.
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

  if (items.length === 0) return null;

  // Duplicate so the CSS loop is seamless (matches HeroTicker).
  const loop = [...items, ...items];

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
        {loop.map((it, i) => (
          <Link
            key={`${it.netuid}-${i}`}
            to="/subnets/$netuid"
            params={{ netuid: it.netuid }}
            className="inline-flex items-center gap-2 text-[11px] hover:text-ink-strong transition-colors"
            title={`${it.name} · SN${it.netuid} · ${priceStr(it.price)}`}
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
                values={[it.price]}
                width={44}
                height={14}
                interactive={false}
                fill={false}
                color="var(--accent, #7aa2ff)"
              />
            </span>
            <span aria-hidden className="text-ink-subtle">
              ·
            </span>
          </Link>
        ))}
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
