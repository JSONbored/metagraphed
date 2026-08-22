import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Crown, Swords } from "lucide-react";
import { subnetConvictionQuery } from "@/lib/metagraphed/queries";
import { CopyableCode, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import {
  rowGapPct,
  summarizeContest,
  type ContestStatus,
} from "@/lib/metagraphed/conviction-contest";
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

const alpha = (value: unknown) => (typeof value === "number" ? fmtAlpha(value) : "—");

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
  const leaderboard = useMemo(() => data?.leaderboard ?? [], [data?.leaderboard]);

  const king = data?.king ?? null;
  const summary = useMemo(() => summarizeContest(leaderboard, king), [leaderboard, king]);
  const challengerHotkey = summary.challenger?.hotkey ?? null;
  const summaryKing = summary.king;
  const status = summary.status;

  const columns = useMemo<Array<DataTableColumn<SubnetConvictionEntry>>>(
    () => [
      {
        key: "hotkey",
        label: "Hotkey",
        value: (entry) => entry.hotkey,
        render: (entry) => {
          const isKing = king != null && entry.hotkey === king;
          const isChallenger = entry.hotkey === challengerHotkey;
          const gap = rowGapPct(entry, summaryKing);
          const tone = isChallenger ? CHALLENGER_TONE[status] : null;
          const showLabel = isChallenger && tone?.label != null;
          return (
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
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-13 text-ink-muted">
                    owner
                  </span>
                ) : null}
              </div>
              {!isKing && gap != null ? (
                <div
                  className={classNames(
                    "flex items-center gap-1.5 text-11 tabular-nums",
                    tone?.className ?? "text-ink-muted",
                  )}
                >
                  {showLabel && tone?.Icon ? (
                    <tone.Icon aria-hidden className="size-3 shrink-0" />
                  ) : null}
                  <span className={showLabel ? "font-medium" : undefined}>
                    {fmtGapPct(gap)} behind{showLabel ? ` · ${tone.label}` : ""}
                  </span>
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        key: "locked_mass",
        label: "Locked mass",
        kind: "number",
        sortable: true,
        value: (entry) => entry.locked_mass,
        format: alpha,
      },
      {
        key: "conviction",
        label: "Conviction",
        kind: "number",
        sortable: true,
        value: (entry) => entry.conviction,
        format: alpha,
      },
    ],
    [king, challengerHotkey, summaryKing, status],
  );

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet conviction" />;
  }

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  return (
    <div className="space-y-3">
      {data?.queried_at_block != null ? (
        <p className="text-11 text-ink-muted">
          Rolled forward to block #{formatNumber(data.queried_at_block)}
          {data.unlock_rate != null ? ` · unlock_rate ${formatNumber(data.unlock_rate)}` : ""}
          {data.maturity_rate != null ? ` · maturity_rate ${formatNumber(data.maturity_rate)}` : ""}
        </p>
      ) : null}
      <DataTable
        rows={leaderboard}
        columns={columns}
        rowKey={(entry) => entry.hotkey}
        caption="Conviction leaderboard"
        link={RouterLink}
        empty={
          <EmptyState
            title="No active challengers"
            description="Conviction leaderboard entries appear once an account locks alpha to build conviction on this subnet -- most subnets have none at any given time."
          />
        }
      />
    </div>
  );
}
