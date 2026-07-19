import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, Crown, MinusCircle, ShieldCheck, Swords } from "lucide-react";
import { subnetConvictionQuery } from "@/lib/metagraphed/queries";
import {
  summarizeContest,
  type ContestStatus,
  type ContestSummary,
} from "@/lib/metagraphed/conviction-contest";
import { CopyableCode, KeyChip } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { SubnetConvictionEntry } from "@/lib/metagraphed/types";

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

function fmtGap(pct: number): string {
  if (pct < 1) return "<1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

const STATUS_LABEL: Record<ContestStatus, string> = {
  uncontested: "Uncontested",
  secure: "Secure",
  contested: "Contested",
  "takeover-imminent": "Takeover imminent",
};

const STATUS_DESC: Record<ContestStatus, string> = {
  uncontested: "No active challenger has built up conviction against the current king.",
  secure: "The king holds a lead the top challenger can't realistically close in one epoch.",
  contested: "The top challenger is within striking distance of the king.",
  "takeover-imminent": "A single strong lock top-up could flip ownership.",
};

// Tone tokens mirror StatTile's palette (border-health-*/40, text-health-*)
// so the summary reads as part of the existing KPI-tile system instead of a
// new visual language of its own.
const STATUS_TONE: Record<
  ContestStatus,
  { icon: typeof ShieldCheck; border: string; text: string; bar: string }
> = {
  uncontested: {
    icon: MinusCircle,
    border: "border-border",
    text: "text-ink-strong",
    bar: "bg-ink-muted/50",
  },
  secure: {
    icon: ShieldCheck,
    border: "border-health-ok/40",
    text: "text-health-ok",
    bar: "bg-health-ok",
  },
  contested: {
    icon: Swords,
    border: "border-health-warn/40",
    text: "text-health-warn",
    bar: "bg-health-warn",
  },
  "takeover-imminent": {
    icon: AlertOctagon,
    border: "border-health-down/40",
    text: "text-health-down",
    bar: "bg-health-down",
  },
};

/**
 * Contest summary strip -- the direct answer to the section's "how close is
 * this subnet to an automatic ownership flip" subtitle. Same tone-colored
 * border + eyebrow + value + hint vocabulary as ConcentrationLoader's
 * StatTiles, plus a proportion bar that literally shows the challenger's
 * conviction as a fraction of the king's.
 */
function ContestSummaryCard({ summary }: { summary: ContestSummary }) {
  const tone = STATUS_TONE[summary.status];
  const Icon = tone.icon;
  const { king, challenger, gapPct } = summary;

  return (
    <div className={classNames("rounded-xl border bg-card p-4 sm:p-5", tone.border)}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:items-center md:gap-6">
        <div className="flex items-start gap-3">
          <Icon aria-hidden className={classNames("size-5 shrink-0 mt-0.5", tone.text)} />
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Contest status
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span
                className={classNames(
                  "font-display text-lg font-semibold leading-none sm:text-xl",
                  tone.text,
                )}
              >
                {STATUS_LABEL[summary.status]}
              </span>
              {gapPct != null ? (
                <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                  king leads by {fmtGap(gapPct)}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-[12px] leading-snug text-ink-muted">
              {STATUS_DESC[summary.status]}
            </p>
          </div>
        </div>

        {king != null && challenger != null ? (
          <ContestRatio king={king} challenger={challenger} barClass={tone.bar} />
        ) : king != null ? (
          <SoleKingCard king={king} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * King vs top challenger, drawn as two hotkey rows with proportional bars.
 * The king's bar is always full-width (100% of the reference); the challenger
 * fills the fraction of the king's conviction they've already built up -- so
 * a nearly-full challenger bar is literally the picture of an imminent flip.
 */
function ContestRatio({
  king,
  challenger,
  barClass,
}: {
  king: SubnetConvictionEntry;
  challenger: SubnetConvictionEntry;
  barClass: string;
}) {
  const fillPct =
    king.conviction > 0
      ? Math.min(100, Math.max(0, (challenger.conviction / king.conviction) * 100))
      : 0;

  return (
    <div className="min-w-0 space-y-2.5">
      <ContestantRow
        role="king"
        hotkey={king.hotkey}
        value={king.conviction}
        widthPct={100}
        barClass="bg-ink-muted/50"
      />
      <ContestantRow
        role="challenger"
        hotkey={challenger.hotkey}
        value={challenger.conviction}
        widthPct={fillPct}
        barClass={barClass}
      />
    </div>
  );
}

function ContestantRow({
  role,
  hotkey,
  value,
  widthPct,
  barClass,
}: {
  role: "king" | "challenger";
  hotkey: string;
  value: number;
  widthPct: number;
  barClass: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {role === "king" ? <Crown aria-hidden className="size-3 text-health-warn" /> : null}
          {role === "king" ? "king" : "top challenger"}
        </span>
        <KeyChip value={hotkey} label={`${role} hotkey`} className="min-w-0" />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-strong">
          {fmtAlpha(value)}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${role} conviction ${fmtAlpha(value)}`}
        className="relative h-1.5 rounded-full bg-surface overflow-hidden"
      >
        <span
          className={classNames("absolute inset-y-0 left-0 rounded-full", barClass)}
          style={{ width: `${Math.max(2, widthPct)}%` }}
        />
      </div>
    </div>
  );
}

function SoleKingCard({ king }: { king: SubnetConvictionEntry }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface/40 p-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          <Crown aria-hidden className="size-3 text-health-warn" />
          king
        </span>
        <KeyChip value={king.hotkey} label="king hotkey" className="min-w-0" />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-strong">
          {fmtAlpha(king.conviction)}
        </span>
      </div>
    </div>
  );
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

  const summary = summarizeContest(leaderboard, data?.king ?? null);

  return (
    <div className="space-y-3">
      {data?.queried_at_block != null ? (
        <p className="font-mono text-[11px] text-ink-muted">
          Rolled forward to block #{formatNumber(data.queried_at_block)}
          {data.unlock_rate != null ? ` · unlock_rate ${formatNumber(data.unlock_rate)}` : ""}
          {data.maturity_rate != null ? ` · maturity_rate ${formatNumber(data.maturity_rate)}` : ""}
        </p>
      ) : null}
      <ContestSummaryCard summary={summary} />
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
                const isTopChallenger =
                  summary.challenger != null && entry.hotkey === summary.challenger.hotkey;
                return (
                  <tr
                    key={entry.hotkey}
                    className={classNames(
                      "mg-row-accent hover:bg-surface/40",
                      isTopChallenger &&
                        (summary.status === "takeover-imminent"
                          ? "bg-health-down/5"
                          : summary.status === "contested"
                            ? "bg-health-warn/5"
                            : undefined),
                    )}
                  >
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
