import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Crown, Swords } from "lucide-react";
import { subnetConvictionQuery } from "@/lib/metagraphed/queries";
import { CopyableCode } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import {
  rowGapPct,
  summarizeContest,
  type ContestStatus,
} from "@/lib/metagraphed/conviction-contest";

const UNITS_PER_WHOLE = 1_000_000_000;

// locked_mass/conviction arrive as raw rao-scale integers (mirrors every
// other on-chain alpha/TAO amount in this codebase) -- divide before display.
function fmtAlpha(rawUnits: number): string {
  if (!Number.isFinite(rawUnits)) return "—";
  const whole = rawUnits / UNITS_PER_WHOLE;
  const magnitude = Math.abs(whole);
  if (magnitude >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M α`;
  if (magnitude >= 1_000) return `${(whole / 1_000).toFixed(1)}k α`;
  if (magnitude >= 1) return `${whole.toFixed(2)} α`;
  if (whole === 0) return "0 α";
  return `${whole.toFixed(4)} α`;
}

function fmtGapPct(pct: number): string {
  if (pct >= 100) return "-100%";
  if (pct >= 10) return `-${pct.toFixed(0)}%`;
  if (pct >= 1) return `-${pct.toFixed(1)}%`;
  return `-${pct.toFixed(2)}%`;
}

// Tone lookup for the top-challenger caption. `secure` gets a muted neutral
// tone -- the gap number is still shown but not colored (nothing urgent to
// signal); `uncontested` is unused here because a sole king has no
// challenger row to caption.
const CHALLENGER_TONE: Record<
  ContestStatus,
  { label: string | null; className: string; Icon: typeof AlertTriangle | null }
> = {
  "takeover-imminent": {
    label: "Takeover imminent",
    className: "text-health-down",
    Icon: AlertTriangle,
  },
  contested: {
    label: "Contested",
    className: "text-health-warn",
    Icon: Swords,
  },
  secure: { label: null, className: "text-ink-muted", Icon: null },
  uncontested: { label: null, className: "text-ink-muted", Icon: null },
};

/**
 * Live per-subnet ownership-contest leaderboard (#6638, frontend companion
 * #6715): who currently holds the most rolled conviction on this subnet --
 * i.e. how close it is to an automatic ownership flip. See
 * docs/conviction-lock-mechanism.md for the on-chain mechanism this rolls
 * forward from. Most subnets have no active challengers, so an empty
 * leaderboard is the common case, rendered as an EmptyState, not an error.
 *
 * Contest framing (#6883) is embedded IN the table itself: each non-king row
 * shows a compact gap-behind-king caption stacked under the hotkey, and the
 * top challenger's caption is tone-colored + labelled ("Takeover imminent" /
 * "Contested") when the gap is actually urgent. There is deliberately no
 * separate summary card above the table -- the section subtitle already asks
 * the question, and the table itself answers it, on the actual entry. The
 * caption lives INSIDE the hotkey cell rather than as a separate column so
 * every viewport (mobile 375, tablet 768, desktop) renders the framing
 * without horizontal scroll.
 */
export function SubnetConvictionLeaderboard({ netuid }: { netuid: number }) {
  const { data: res, isLoading, isError, error, refetch } = useQuery(subnetConvictionQuery(netuid));
  const data = res?.data;

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet conviction" />;
  }

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  const leaderboard = data?.leaderboard ?? [];

  if (leaderboard.length === 0) {
    return (
      <EmptyState
        title="No active challengers"
        description="Conviction leaderboard entries appear once an account locks alpha to build conviction on this subnet -- most subnets have none at any given time."
      />
    );
  }

  const summary = summarizeContest(leaderboard, data?.king ?? null);
  const challengerHotkey = summary.challenger?.hotkey ?? null;
  const rowTint =
    summary.status === "takeover-imminent"
      ? "bg-health-down/5"
      : summary.status === "contested"
        ? "bg-health-warn/5"
        : null;

  return (
    <div className="space-y-3">
      {data?.queried_at_block != null ? (
        <p className="font-mono text-[11px] text-ink-muted">
          Rolled forward to block #{formatNumber(data.queried_at_block)}
          {data.unlock_rate != null ? ` · unlock_rate ${formatNumber(data.unlock_rate)}` : ""}
          {data.maturity_rate != null ? ` · maturity_rate ${formatNumber(data.maturity_rate)}` : ""}
        </p>
      ) : null}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/40">
              <tr>
                <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Hotkey
                </th>
                <th className="px-4 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Locked mass
                </th>
                <th className="px-4 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Conviction
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leaderboard.map((entry) => {
                const isKing = data?.king != null && entry.hotkey === data.king;
                const isChallenger = entry.hotkey === challengerHotkey;
                const gap = rowGapPct(entry, summary.king);
                const tone = isChallenger ? CHALLENGER_TONE[summary.status] : null;
                const showLabel = isChallenger && tone?.label != null;
                return (
                  <tr
                    key={entry.hotkey}
                    className={classNames(
                      "mg-row-accent hover:bg-surface/40",
                      isChallenger && rowTint ? rowTint : null,
                    )}
                  >
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          {isKing ? (
                            <Crown
                              aria-label="Top-ranked (king)"
                              className="size-3.5 shrink-0 text-health-warn"
                            />
                          ) : null}
                          <CopyableCode value={entry.hotkey} className="max-w-full" />
                          {entry.is_owner ? (
                            <span
                              className={classNames(
                                "shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted",
                              )}
                            >
                              owner
                            </span>
                          ) : null}
                        </div>
                        {!isKing && gap != null ? (
                          <div
                            className={classNames(
                              "flex items-center gap-1.5 font-mono text-[11px] tabular-nums",
                              tone?.className ?? "text-ink-muted",
                            )}
                          >
                            {showLabel && tone?.Icon ? (
                              <tone.Icon aria-hidden className="size-3 shrink-0" />
                            ) : null}
                            <span className={showLabel ? "font-medium" : undefined}>
                              {fmtGapPct(gap)} behind
                              {showLabel ? ` · ${tone.label}` : ""}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top text-right font-mono text-[12px] tabular-nums text-ink">
                      {fmtAlpha(entry.locked_mass)}
                    </td>
                    <td className="px-4 py-2.5 align-top text-right font-mono text-[12px] tabular-nums text-ink-strong">
                      {fmtAlpha(entry.conviction)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
