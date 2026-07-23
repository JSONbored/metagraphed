import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { blocksQuery, healthQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { Tooltip, TooltipContent, TooltipTrigger, TimeAgo } from "@jsonbored/ui-kit";
import { formatNumber } from "@/lib/metagraphed/format";
import { getTaoMarket } from "@/lib/metagraphed/market.functions";
import type { Subnet } from "@/lib/metagraphed/types";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * Secondary "ecosystem" strip beneath the primary nav — matches the
 * production reference: pulse dot + BITTENSOR ECOSYSTEM, chain head,
 * τ price / active-subnets counter, curated count, endpoints up X/Y;
 * right-aligned network mkt cap + 24h vol (aggregated from /api/v1/subnets).
 * Renders "—" for any cell whose upstream is still cold — never a fabricated
 * number.
 */
export function RegistryTicker() {
  const hydrated = useHydrated();

  const subnetsQ = useQuery({ ...subnetsQuery({ limit: 128 }), retry: 0, enabled: hydrated });
  const healthQ = useQuery({ ...healthQuery(), retry: 0, enabled: hydrated });
  const blockQ = useQuery({ ...blocksQuery({ limit: 1 }), retry: 0, enabled: hydrated });
  // Same query key/staleTime as use-tao-price.ts's shared hook so this
  // global ticker's fetch dedupes against /subnets' own market-strip query
  // instead of hitting the (rate-limited, external) CoinPaprika API twice.
  const marketQ = useQuery({
    queryKey: ["tao-market"],
    queryFn: () => getTaoMarket(),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    enabled: hydrated,
  });

  // `enabled: false` prevents a pre-hydration fetch, but it does not hide data
  // that another route component already restored into the shared QueryClient.
  // Gate every rendered value too, so SSR and the first client pass are
  // guaranteed to produce the same placeholders.
  const subnets = hydrated ? ((subnetsQ.data?.data as Subnet[] | undefined) ?? []) : [];
  const app = subnets.filter((s) => s.netuid > 0);
  const curated = app.filter((s) => {
    const c = (s as { curation_level?: string }).curation_level;
    return c && c !== "native" && c !== "candidate";
  }).length;

  const h = hydrated ? healthQ.data?.data : undefined;
  const endpointsUp =
    typeof h?.ok === "number" && typeof h?.total === "number" ? `${h.ok}/${h.total}` : null;

  const head = blockQ.data?.data?.[0];
  const blockNumber = hydrated ? head?.block_number : undefined;

  const market = hydrated ? marketQ.data : undefined;

  return (
    <div className="hidden md:block border-t border-border/60 bg-surface/40">
      <div className="max-w-shell-max mx-auto px-4 md:px-8 h-9 flex items-center justify-between gap-6 text-[11px] font-mono">
        {/* Left cluster */}
        <div className="flex items-center gap-4 min-w-0 overflow-visible">
          <span className="inline-flex items-center gap-1.5 shrink-0 pl-1">
            <span className="mg-live-dot" aria-hidden />
            <span className="uppercase tracking-[0.22em] text-ink-muted">Bittensor ecosystem</span>
          </span>

          {blockNumber != null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/blocks/$ref"
                  params={{ ref: String(blockNumber) }}
                  className="hidden lg:inline-flex items-baseline gap-1.5 shrink-0 hover:opacity-80 transition-opacity"
                >
                  <span className="text-ink-muted">block</span>
                  <span className="text-ink-strong tabular-nums">#{formatNumber(blockNumber)}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Chain head · <TimeAgo at={head?.observed_at} />
              </TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-baseline gap-1.5 shrink-0">
                <span className="text-ink-muted">τ</span>
                <span className="text-ink-strong tabular-nums">{formatUsd(market?.price)}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Current TAO price · CoinPaprika
            </TooltipContent>
          </Tooltip>

          <Link
            to="/subnets"
            search={{ curation: "verified" } as never}
            className="hidden lg:inline-flex items-baseline gap-1.5 shrink-0 hover:opacity-80 transition-opacity"
          >
            <span className="text-ink-muted">curated</span>
            <span className="text-ink-strong tabular-nums">{curated || "—"}</span>
          </Link>

          {endpointsUp ? (
            <Link
              to="/health"
              className="hidden lg:inline-flex items-baseline gap-1.5 shrink-0 hover:opacity-80 transition-opacity"
            >
              <span className="text-ink-muted">endpoints up</span>
              <span className="text-ink-strong tabular-nums">{endpointsUp}</span>
            </Link>
          ) : null}
        </div>

        {/* Right cluster — market aggregates */}
        <div className="hidden min-[1120px]:flex items-center gap-4 shrink-0">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-ink-muted">mkt cap</span>
            <span className="text-ink-strong tabular-nums">
              {formatUsdCompact(market?.market_cap)}
            </span>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-ink-muted">24h vol</span>
            <span className="text-ink-strong tabular-nums">
              {formatUsdCompact(market?.volume_24h)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function formatUsd(v: number | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function formatUsdCompact(v: number | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
