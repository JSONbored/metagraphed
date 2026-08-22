import { useQuery } from "@tanstack/react-query";
import { topHoldersQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatTao, formatRelative } from "@/lib/metagraphed/format";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import type { TopHolder } from "@/lib/metagraphed/types";

const SHOWN = 15;

/**
 * `/api/v1/accounts/top-holders` (#10300), published and rendered nowhere.
 *
 * The network-wide holder leaderboard. Two things it refuses to collapse:
 *
 * FREE AND DELEGATED ARE DIFFERENT POSITIONS. Delegated TAO is committed to a
 * validator and earning; free TAO is not. An account holding 10k free and one
 * holding 10k delegated have the same total and are doing opposite things, so
 * the split is shown rather than the total alone.
 *
 * THE FLOW WINDOWS CAN DISAGREE. The route publishes 7d, 30d and 90d because a
 * holder can be growing over the week and shrinking over the quarter. Showing
 * one window lets a short bounce read as a trend, so the panel names which
 * window it is showing and flags the holders whose direction is not consistent
 * across them.
 */
export function TopHoldersPanel() {
  const { data, isLoading, isError, error, refetch } = useQuery(topHoldersQuery(SHOWN));

  if (isLoading) return <Skeleton className="h-[240px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const h = data?.data;
  if (!h || h.accounts.length === 0) {
    return (
      <EmptyState
        title="No holder ranking"
        description="The network-wide holder leaderboard has not been captured."
      />
    );
  }

  return (
    <Panel>
      <p className="mb-3 text-10 text-ink-muted">
        Largest {formatNumber(Math.min(SHOWN, h.accounts.length))} TAO holders network-wide
        {h.account_count == null ? "" : ` of ${formatNumber(h.account_count)} ranked`}
        {h.captured_at ? ` · captured ${formatRelative(h.captured_at)}` : ""}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-10">
          <thead>
            <tr className="text-11 text-ink-muted">
              <th className="py-1 text-left">account</th>
              <th className="py-1 text-right">free</th>
              <th className="py-1 text-right">delegated</th>
              <th className="py-1 text-right">total</th>
              <th className="py-1 text-right">30d flow</th>
            </tr>
          </thead>
          <tbody>
            {h.accounts.slice(0, SHOWN).map((a) => (
              <tr key={a.ss58} className="border-t border-border/50">
                <td className="max-w-0 py-1">
                  <AddressDisplay ss58={a.ss58} fallback={a.ss58} />
                </td>
                <td className="py-1 text-right tabular-nums text-ink">{formatTao(a.free_tao)}</td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {formatTao(a.delegated_tao)}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">{formatTao(a.total_tao)}</td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {formatTao(a.net_flow_30d)}
                  {flowsDisagree(a) ? (
                    <span className="ml-1 text-ink-muted" aria-label="flow windows disagree">
                      *
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-11 text-ink-muted">
        * the 7d, 30d and 90d flows do not all point the same way — a move in one window is not a
        trend in the others.
      </p>
    </Panel>
  );
}

/** All three windows, so one number is never mistaken for the direction. */
export function flowTooltip(a: TopHolder): string {
  const part = (label: string, v: number | null) => `${label}: ${v == null ? "—" : formatTao(v)}`;
  return [part("7d", a.net_flow_7d), part("30d", a.net_flow_30d), part("90d", a.net_flow_90d)].join(
    " · ",
  );
}

/**
 * Whether the flow windows point in different directions.
 *
 * Only compares the windows that HAVE a value -- a missing window is not a
 * disagreement, and treating it as one would put a caveat marker on every
 * account with a gap in its history. Zero is treated as its own direction
 * rather than folded into positive or negative: no movement genuinely differs
 * from movement, and calling it "up" would invent a direction.
 */
export function flowsDisagree(a: TopHolder): boolean {
  const signs = [a.net_flow_7d, a.net_flow_30d, a.net_flow_90d]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.sign(v));
  return new Set(signs).size > 1;
}
