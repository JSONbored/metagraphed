import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { chainAlphaVolumeQuery } from "@/lib/metagraphed/queries";
import { healthColorVar } from "@/lib/health-tokens";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { InfoTooltip } from "@jsonbored/ui-kit";

const BULLISH_COLOR = healthColorVar("ok");
const BEARISH_COLOR = healthColorVar("down");
const NEUTRAL_COLOR = "var(--ink-muted)";

const SENTIMENT_META = {
  bullish: { label: "Bullish", Icon: TrendingUp, color: BULLISH_COLOR },
  bearish: { label: "Bearish", Icon: TrendingDown, color: BEARISH_COLOR },
  neutral: { label: "Neutral", Icon: Minus, color: NEUTRAL_COLOR },
} as const;

/**
 * Network-wide "mood" gauge (#6642, #5968 survey -- Tao.app's Fear & Greed-
 * style index finding): a first-class surfacing of the network.sentiment_ratio/
 * sentiment fields GET /api/v1/chain/alpha-volume already computes as a
 * byproduct of its 24h volume leaderboard -- no new sentiment math here, just
 * a dedicated widget for a figure that was previously buried on a different
 * route. Renders null while loading/on error/with no volume this window,
 * matching the home hero rail's own "never clutter a cold first paint"
 * convention (SubnetPriceTicker, HeroSubnetChips).
 */
export function NetworkMoodGauge() {
  const { data: res, isLoading, isError } = useQuery(chainAlphaVolumeQuery());
  if (isLoading || isError || !res) return null;

  const { network, subnet_count } = res.data;
  const { sentiment, sentiment_ratio } = network;
  if (sentiment_ratio == null) return null;

  const meta = SENTIMENT_META[sentiment];
  const Icon = meta.Icon;
  // Map -1..1 to 0..100% for the marker position on the bearish->bullish bar.
  const markerPct = ((Math.max(-1, Math.min(1, sentiment_ratio)) + 1) / 2) * 100;

  return (
    <Link
      id="network-mood-gauge"
      to="/subnets"
      className="mg-fade-in mg-fade-in-delay-3 mt-3 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 hover:border-ink/30 transition-colors"
      title={`Network mood: ${meta.label} (ratio ${sentiment_ratio.toFixed(2)}) -- net/gross 24h alpha buy vs sell volume across ${formatNumber(subnet_count)} subnets.`}
    >
      <Icon aria-hidden className="size-4 shrink-0" style={{ color: meta.color }} />
      <div className="min-w-0">
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-muted">
          Network mood
        </div>
        <div className="font-display text-sm font-semibold" style={{ color: meta.color }}>
          {meta.label}
        </div>
      </div>
      <div className="flex-1 min-w-[80px] max-w-[160px]">
        <div className="relative h-1.5 rounded-full bg-gradient-to-r from-[var(--health-down)] via-[var(--ink-muted)] to-[var(--health-ok)] opacity-70">
          <span
            aria-hidden
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-ink-strong"
            style={{ left: `${markerPct}%` }}
          />
        </div>
      </div>
      <span
        className={classNames(
          "shrink-0 font-mono text-[11px] tabular-nums",
          sentiment === "neutral" ? "text-ink-muted" : "",
        )}
        style={sentiment !== "neutral" ? { color: meta.color } : undefined}
      >
        {sentiment_ratio >= 0 ? "+" : ""}
        {(sentiment_ratio * 100).toFixed(0)}%
      </span>
      <InfoTooltip label="Net vs. gross 24h alpha buy/sell volume across every active subnet -- the same sentiment reading GET /api/v1/chain/alpha-volume already computes for its volume leaderboard, surfaced here as a first-class figure. Not a technical-analysis indicator." />
    </Link>
  );
}
