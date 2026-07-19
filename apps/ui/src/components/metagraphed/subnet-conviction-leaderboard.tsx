import { useQuery } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { subnetConvictionQuery } from "@/lib/metagraphed/queries";
import type { SubnetConvictionEntry } from "@/lib/metagraphed/types";
import { CopyableCode } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, formatNumber } from "@/lib/metagraphed/format";

const UNITS_PER_WHOLE = 1_000_000_000;

// Gap thresholds are % of the king's conviction (see computeConvictionGap).
// Grounded in docs/conviction-lock-mechanism.md: conviction moves on a
// governance-controlled decay half-life (UnlockRate/MaturityRate, ~934,866
// blocks / ~130 days by default) -- a challenger closes roughly half of
// *their own* remaining headroom every half-life, not the whole gap in one
// step, so even a well-funded challenger needs several cycles to close a
// wide gap. Picked to read as: "days" of urgency vs. "months" of safety.
const SECURE_GAP_PCT = 20; // closing this needs multiple maturity half-lives (months) absent a large fresh lock
const CONTESTED_GAP_PCT = 5; // a real, watchable race -- not secure, not on the verge of flipping either
// gap < CONTESTED_GAP_PCT => "Takeover imminent": within reach of one sizeable top-up, or a bit of king-side decay

// Bittensor's fixed block time -- matches the ~12s/block conversion
// docs/conviction-lock-mechanism.md itself uses for UnlockRate/MaturityRate.
// Not governance-adjustable (unlike unlock_rate/maturity_rate), safe to
// hardcode for a display-only day conversion.
const BLOCK_SECONDS = 12;

export interface ConvictionGap {
  kingEntry: SubnetConvictionEntry;
  runnerUp: SubnetConvictionEntry | null;
  /** % of the king's conviction the runner-up is behind by; null = uncontested (no runner-up). */
  gapPct: number | null;
}

/**
 * Identifies the king and top active challenger from the leaderboard and
 * computes the gap between them, as a % of the king's conviction. Doesn't
 * trust array order or that `king` necessarily matches the top-conviction
 * row (both are true in practice, but this is presentation code -- sort
 * defensively rather than assume). Returns null only for an empty leaderboard.
 */
export function computeConvictionGap(
  leaderboard: SubnetConvictionEntry[],
  king: string | null,
): ConvictionGap | null {
  if (leaderboard.length === 0) return null;
  const sorted = [...leaderboard].sort((a, b) => b.conviction - a.conviction);
  const kingEntry = (king != null ? sorted.find((e) => e.hotkey === king) : undefined) ?? sorted[0];
  const runnerUp = sorted.find((e) => e.hotkey !== kingEntry.hotkey) ?? null;
  const rawGapPct =
    runnerUp != null && kingEntry.conviction > 0
      ? ((kingEntry.conviction - runnerUp.conviction) / kingEntry.conviction) * 100
      : null;
  // Clamp negative gaps (a data anomaly -- `king` disagreeing with the
  // actual top row) to 0 rather than surfacing a nonsensical negative %.
  const gapPct = rawGapPct == null ? null : Math.max(0, rawGapPct);
  return { kingEntry, runnerUp, gapPct };
}

/** Status-badge label + Tailwind classes for a gap%, mirroring the
 * border/bg/text `health-*` tone convention used by schema-drift.tsx. */
export function convictionUrgencyTone(gapPct: number | null): { label: string; cls: string } {
  if (gapPct == null || gapPct >= SECURE_GAP_PCT) {
    return {
      label: "Secure",
      cls: "border-health-ok/30 bg-health-ok/10 text-health-ok",
    };
  }
  if (gapPct >= CONTESTED_GAP_PCT) {
    return {
      label: "Contested",
      cls: "border-health-warn/40 bg-health-warn/10 text-health-warn",
    };
  }
  return {
    label: "Takeover imminent",
    cls: "border-health-down/40 bg-health-down/10 text-health-down",
  };
}

/**
 * Rough, explicitly-labeled estimate of how many blocks the runner-up would
 * need to close the gap purely via ordinary conviction maturation (conviction
 * matures toward locked_mass on a MaturityRate half-life, per
 * docs/conviction-lock-mechanism.md). Assumes the king's conviction holds
 * perfectly steady and the runner-up makes no further lock changes -- a
 * simplifying, worst-case-for-the-incumbent assumption, NOT a prediction of
 * what will actually happen. Returns null when there's no headroom for the
 * runner-up to ever clear the king this way (already at its own ceiling, or
 * its ceiling doesn't exceed the king's current conviction), or when
 * maturity_rate isn't available.
 */
export function estimateBlocksToOvertake(
  kingEntry: SubnetConvictionEntry,
  runnerUp: SubnetConvictionEntry,
  maturityRate: number | null,
): number | null {
  if (maturityRate == null || maturityRate <= 0) return null;
  const ceiling = runnerUp.locked_mass;
  if (ceiling <= kingEntry.conviction) return null; // can never clear the king by maturing alone
  if (runnerUp.conviction >= ceiling) return null; // no headroom left to mature
  const ratio = (ceiling - kingEntry.conviction) / (ceiling - runnerUp.conviction);
  if (!(ratio > 0) || !(ratio < 1)) return null;
  const blocks = -maturityRate * Math.log2(ratio);
  return Number.isFinite(blocks) && blocks > 0 ? Math.ceil(blocks) : null;
}

/** Formats a block count as a rough "~N days"/"~N months" string, or null input-through. */
export function formatBlocksAsDuration(blocks: number | null): string | null {
  if (blocks == null) return null;
  const days = (blocks * BLOCK_SECONDS) / 86_400;
  if (days < 1) return "<1 day";
  if (days < 30) {
    const n = Math.round(days);
    return `~${n} day${n === 1 ? "" : "s"}`;
  }
  const months = Math.round(days / 30);
  return `~${months} month${months === 1 ? "" : "s"}`;
}

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

  const gap = computeConvictionGap(leaderboard, data?.king ?? null);
  const tone = convictionUrgencyTone(gap?.gapPct ?? null);
  const overtakeBlocks =
    gap?.runnerUp != null
      ? estimateBlocksToOvertake(gap.kingEntry, gap.runnerUp, data?.maturity_rate ?? null)
      : null;
  const overtakeDuration = formatBlocksAsDuration(overtakeBlocks);

  return (
    <div className="space-y-3">
      {data?.queried_at_block != null ? (
        <p className="font-mono text-[11px] text-ink-muted">
          Rolled forward to block #{formatNumber(data.queried_at_block)}
          {data.unlock_rate != null ? ` · unlock_rate ${formatNumber(data.unlock_rate)}` : ""}
          {data.maturity_rate != null ? ` · maturity_rate ${formatNumber(data.maturity_rate)}` : ""}
        </p>
      ) : null}
      {gap != null ? (
        <div className="flex flex-wrap items-center gap-2" aria-label="Ownership-contest urgency">
          <span
            className={classNames(
              "rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
              tone.cls,
            )}
          >
            {tone.label}
          </span>
          {gap.gapPct != null ? (
            <span className="font-mono text-[11px] text-ink-muted">
              gap to king: {gap.gapPct.toFixed(1)}%
            </span>
          ) : (
            <span className="font-mono text-[11px] text-ink-muted">no active challenger</span>
          )}
          {overtakeDuration != null ? (
            <span className="font-mono text-[11px] text-ink-subtle-text">
              · est. {overtakeDuration} to overtake at current rate (estimate, assumes the king
              holds steady)
            </span>
          ) : null}
        </div>
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
