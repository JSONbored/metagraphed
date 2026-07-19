import { useQuery } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { subnetConvictionQuery } from "@/lib/metagraphed/queries";
import { CopyableCode } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import {
  convictionContest,
  type ConvictionContestStatus,
} from "@/lib/metagraphed/conviction-contest";

const UNITS_PER_WHOLE = 1_000_000_000;

// How the contest gap reads at a glance (#6883). Down/warn/muted tones follow
// the health palette used elsewhere so "takeover imminent" reads as the alarm.
const CONTEST_STATUS_META: Record<ConvictionContestStatus, { label: string; className: string }> = {
  "takeover-imminent": {
    label: "Takeover imminent",
    className: "border-health-down/40 bg-health-down/10 text-health-down",
  },
  contested: {
    label: "Contested",
    className: "border-health-warn/40 bg-health-warn/10 text-health-warn",
  },
  secure: {
    label: "Secure",
    className: "border-border bg-surface/40 text-ink-muted",
  },
};

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

/**
 * Live per-subnet ownership-contest leaderboard (#6638, frontend companion
 * #6715): who currently holds the most rolled conviction on this subnet --
 * i.e. how close it is to an automatic ownership flip. See
 * docs/conviction-lock-mechanism.md for the on-chain mechanism this rolls
 * forward from. Most subnets have no active challengers, so an empty
 * leaderboard is the common case, rendered as an EmptyState, not an error.
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

  const contest = convictionContest(leaderboard);
  const contestMeta = CONTEST_STATUS_META[contest.status];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={classNames(
            "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
            contestMeta.className,
          )}
        >
          {contestMeta.label}
        </span>
        <span className="font-mono text-[11px] text-ink-muted">
          {contest.gapPct != null
            ? `Leader is ${contest.gapPct.toFixed(1)}% ahead of the top challenger`
            : "No active challenger"}
        </span>
      </div>
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
                return (
                  <tr key={entry.hotkey} className="mg-row-accent hover:bg-surface/40">
                    <td className="px-4 py-2.5">
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
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                      {fmtAlpha(entry.locked_mass)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
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
