import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { Sparkline, TimeAgo } from "@jsonbored/ui-kit";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { blocksQuery, chainActivityQuery } from "@/lib/metagraphed/queries";
import { formatNumber, classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { Block } from "@/lib/metagraphed/types";

/**
 * LiveBlockRail — always-on band directly under the masthead.
 *
 * Left  : latest indexed block (# + hash + author + counts + observed).
 * Mid   : last N blocks as a mini cadence strip (bar per block, height = ext).
 * Right : 7d blocks/day sparkline from /api/v1/chain/activity.
 *
 * Auto-refreshes every 12s, matching Bittensor's block cadence.
 */
export function LiveBlockRail() {
  // First-page blocks feed, polled — that's where "latest" lives.
  const refetchInterval = useRefetchInterval(12_000, true);
  const rows = (useSuspenseQuery({
    ...blocksQuery({ limit: 30 }),
    refetchInterval,
  }).data.data ?? []) as Block[];
  const chrono = [...useSuspenseQuery(chainActivityQuery()).data.data.days].reverse();

  if (rows.length === 0) return null;
  const latest = rows[0]!;
  // Newest-first from the API → left-to-right chronology in the strip.
  const strip = [...rows].reverse();
  const maxExt = Math.max(1, ...strip.map((b) => b.extrinsic_count ?? 0));

  const daily = chrono.map((d) => d.block_count);
  const dailyPts = chrono.map((d) => ({ t: d.day, v: d.block_count }));

  return (
    <div
      className="mb-3 grid grid-cols-1 gap-3 rounded-lg border border-border bg-card p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)]"
      role="status"
      aria-live="polite"
    >
      {/* LATEST BLOCK. Not a single wrapping <Link>: AccountAddress below
          renders its own <a>/<button> (account link + copy button), and an
          anchor/button can't contain another without invalid HTML nesting
          (breaks hydration). The block number is its own link instead. */}
      <div className="flex items-center gap-3 rounded border border-transparent px-2 py-1.5">
        <span aria-hidden className="relative inline-flex size-2 items-center justify-center">
          <span className="absolute inline-flex size-2 animate-ping rounded-full bg-health-ok/60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-health-ok" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="mg-type-micro text-ink-muted">Latest</span>
            <Link
              to="/blocks/$ref"
              params={{ ref: String(latest.block_number) }}
              className="mg-focus-ring rounded font-mono text-[14px] font-semibold tabular-nums text-ink-strong hover:text-accent"
            >
              #{formatNumber(latest.block_number)}
            </Link>
            <span className="font-mono text-[10px] text-ink-muted">
              <TimeAgo at={latest.observed_at} />
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span className="truncate" title={latest.block_hash}>
              {shortHash(latest.block_hash) ?? "—"}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate">
              <AccountAddress ss58={latest.author} compact fallback="no author" />
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
            {formatNumber(latest.extrinsic_count ?? 0)} ext ·{" "}
            {formatNumber(latest.event_count ?? 0)} evt
          </div>
        </div>
      </div>

      {/* MINI CADENCE STRIP */}
      <div className="flex flex-col justify-center gap-1.5 px-1">
        <div className="mg-type-micro text-ink-muted">Recent blocks · extrinsic density</div>
        <ol className="flex h-8 items-end gap-[2px]" aria-label="Recent block extrinsic density">
          {strip.map((b) => {
            const ext = b.extrinsic_count ?? 0;
            const h = Math.max(6, Math.round((ext / maxExt) * 100));
            const isLatest = b.block_number === latest.block_number;
            return (
              <Link
                key={b.block_hash || b.block_number}
                to="/blocks/$ref"
                params={{ ref: String(b.block_number) }}
                title={`#${formatNumber(b.block_number)} · ${formatNumber(ext)} ext`}
                className={classNames(
                  "block w-[6px] min-w-[6px] rounded-sm transition-colors",
                  isLatest ? "bg-accent" : "bg-ink-strong/25 hover:bg-ink-strong/50",
                )}
                style={{ height: `${h}%` }}
                aria-label={`Block #${formatNumber(b.block_number)}`}
              />
            );
          })}
        </ol>
      </div>

      {/* 7D THROUGHPUT */}
      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2 md:border-l md:border-t-0 md:pl-3 md:pt-0">
        <div>
          <div className="mg-type-micro text-ink-muted">Blocks · last 7d</div>
          <div className="mt-0.5 font-mono text-[14px] font-semibold tabular-nums text-ink-strong">
            {formatNumber(daily.reduce((s, n) => s + n, 0))}
          </div>
        </div>
        {daily.length > 0 ? (
          <Sparkline
            values={daily}
            points={dailyPts}
            width={140}
            height={36}
            ariaLabel="Daily block throughput, oldest to newest"
            formatValue={formatNumber}
          />
        ) : null}
      </div>
    </div>
  );
}
