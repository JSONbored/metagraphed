import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Sparkline, StackedAreaMini, type StackedAreaSeries } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { accountPortfolioQuery, accountPositionHistoryQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { AccountPositionHistory, PortfolioPosition } from "@/lib/metagraphed/types";

// The issue's 30d/90d/1y/max control, mapped onto the position-history API's
// own window enum ("all" is the API spelling of "max").
const WINDOWS = [
  { id: "30d", label: "30D" },
  { id: "90d", label: "90D" },
  { id: "1y", label: "1Y" },
  { id: "all", label: "Max" },
] as const;
type Win = (typeof WINDOWS)[number]["id"];

/** Stacked-area band cap — matches the small-multiples "top 6" and the
 * design system's 6-color categorical chart ramp exactly. */
const TOP_POSITIONS = 6;

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

function taoStr(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  return `${v.toFixed(v < 10 ? 3 : 2)} τ`;
}

/** Align each position's daily points onto one shared, sorted date axis.
 * A date a position has no row for reads as 0 stake — the position didn't
 * exist (or held nothing) that day, which is exactly what a stacked band
 * should show. Exported for tests. */
export function alignHoldingsSeries(
  histories: Array<{ netuid: number; history: AccountPositionHistory | undefined }>,
): { dates: string[]; series: Array<{ netuid: number; values: number[] }> } {
  const dateSet = new Set<string>();
  for (const h of histories) {
    for (const p of h.history?.points ?? []) dateSet.add(p.snapshot_date);
  }
  const dates = [...dateSet].sort();
  const series = histories.map((h) => {
    const byDate = new Map<string, number>();
    for (const p of h.history?.points ?? []) {
      if (p.stake_tao != null && Number.isFinite(p.stake_tao)) {
        byDate.set(p.snapshot_date, p.stake_tao);
      }
    }
    return { netuid: h.netuid, values: dates.map((d) => byDate.get(d) ?? 0) };
  });
  return { dates, series };
}

/** #8370: the account History tab — staked holdings over time.
 *
 * (a) A stacked area of staked TAO by subnet across the account's top
 * positions; (b) per-position small-multiple sparklines, top 6 by current
 * value with the long tail behind a "+N more" expander. Both windowed, both
 * labeling their actual data extent when depth is partial (the genesis
 * backfill, #8368, grows it from behind).
 *
 * Scope note vs. the issue text: the issue sketches "free vs staked TAO"
 * as the stack split, but no free-balance HISTORY series exists on any
 * endpoint — /accounts/{ss58}/balance is a live single-point RPC read, and
 * src/account-position-history.ts documents balance reconstruction as out
 * of scope. Under the issue's own "existing endpoints only" constraint the
 * honest stack is staked TAO decomposed BY SUBNET (position history), which
 * tells the same holdings-over-time story with strictly more structure;
 * free balance stays a live snapshot in the KPI band above.
 */
export function AccountHoldingsHistory({ ss58 }: { ss58: string }) {
  const [win, setWin] = useState<Win>("90d");
  const [showAll, setShowAll] = useState(false);

  const portfolioResult = useQuery(accountPortfolioQuery(ss58));
  const positions = useMemo<PortfolioPosition[]>(() => {
    const all = portfolioResult.data?.data?.positions ?? [];
    return [...all].sort((a, b) => (b.stake_tao ?? 0) - (a.stake_tao ?? 0));
  }, [portfolioResult.data?.data?.positions]);

  const topPositions = positions.slice(0, TOP_POSITIONS);
  const visiblePositions = showAll ? positions : topPositions;

  // One bounded query per visible position (6 until expanded). React Query
  // dedupes with the Positions tab's per-row expander, which reads the same
  // (ss58, netuid, window) keys.
  const historyResults = useQueries({
    queries: visiblePositions.map((pos) => accountPositionHistoryQuery(ss58, pos.netuid, win)),
  });
  const anyLoading = portfolioResult.isLoading || historyResults.some((r) => r.isLoading);
  const histories = visiblePositions.map((pos, i) => ({
    netuid: pos.netuid,
    history: historyResults[i]?.data?.data,
  }));

  // Cheap enough (≤6 series × ≤~365 points) to recompute per render — no memo
  // gymnastics over the useQueries result array's identity.
  const aligned = alignHoldingsSeries(histories.slice(0, TOP_POSITIONS));

  const stacked: StackedAreaSeries[] = aligned.series.map((s, i) => ({
    id: `sn${s.netuid}`,
    label: `SN${s.netuid}`,
    values: s.values,
    color: CHART_COLORS[i % CHART_COLORS.length]!,
  }));
  const hasChartData = stacked.some((s) => s.values.some((v) => v > 0));
  const extentStart = aligned.dates[0] ?? null;
  const extentEnd = aligned.dates[aligned.dates.length - 1] ?? null;

  const windowSelector = (
    <div
      role="tablist"
      aria-label="Holdings history window"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {WINDOWS.map((w) => (
        <button
          key={w.id}
          type="button"
          role="tab"
          aria-selected={w.id === win}
          onClick={() => setWin(w.id)}
          className={classNames(
            "px-2.5 py-1 mg-type-label uppercase rounded transition-colors",
            w.id === win ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );

  if (portfolioResult.isError) {
    return (
      <ErrorState
        error={portfolioResult.error}
        onRetry={() => void portfolioResult.refetch()}
        context="holdings history"
      />
    );
  }

  if (!portfolioResult.isLoading && positions.length === 0) {
    return (
      <EmptyState
        title="No positions to chart"
        description="This account has no registered positions, so there's no holdings history to draw yet."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mg-type-caption text-ink-muted">
          {extentStart && extentEnd ? (
            <>
              History begins {extentStart}
              {extentEnd !== extentStart ? ` · latest ${extentEnd}` : ""} — depth grows as the
              genesis backfill lands.
            </>
          ) : null}
        </span>
        {windowSelector}
      </div>

      {anyLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !hasChartData ? (
        <EmptyState
          title="No history yet"
          description="Daily snapshots will appear here once enough chain history has accumulated for these positions."
        />
      ) : (
        <Panel as="div" dense bodyClassName="space-y-3">
          <div className="mg-type-caption text-ink-muted">
            Staked τ by subnet
            {positions.length > TOP_POSITIONS
              ? ` · top ${TOP_POSITIONS} positions by current value`
              : ""}
          </div>
          <StackedAreaMini
            series={stacked}
            labels={aligned.dates}
            width={720}
            height={180}
            formatValue={(v) => taoStr(v)}
            ariaLabel={`Staked TAO by subnet over time for ${stacked.length} positions`}
          />
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {stacked.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 mg-type-caption text-ink-muted">
                <span
                  aria-hidden
                  className="inline-block size-2 rounded"
                  style={{ background: s.color }}
                />
                {s.label}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {!anyLoading && hasChartData ? (
        <div>
          <div className="mb-2 mg-type-caption text-ink-muted">Per-position history</div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visiblePositions.map((pos, i) => {
              const history = historyResults[i]?.data?.data;
              const values = (history?.points ?? [])
                .map((p) => p.stake_tao)
                .filter((v): v is number => v != null && Number.isFinite(v));
              const color = CHART_COLORS[i % CHART_COLORS.length]!;
              return (
                <div
                  key={pos.netuid}
                  className="rounded-2xl border border-border/80 mg-glass px-4 py-3 mg-card-glow"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: pos.netuid }}
                      className="font-mono mg-type-caption text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{pos.netuid}
                    </Link>
                    <span className="font-display text-sm font-semibold tabular-nums text-ink-strong">
                      {taoStr(pos.stake_tao)}
                    </span>
                  </div>
                  <div className="mt-2">
                    {values.length > 0 ? (
                      <Sparkline
                        values={values}
                        color={color}
                        // Sparkline clamps its container to `width`, so this
                        // is sized past the widest card in the 1/2/3-column
                        // grid rather than left short of the card's edge.
                        width={520}
                        height={36}
                        formatValue={taoStr}
                        ariaLabel={`SN${pos.netuid} staked TAO history`}
                      />
                    ) : (
                      <span className="mg-type-caption text-ink-muted">No history yet</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {positions.length > TOP_POSITIONS ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll((s) => !s)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 mg-type-data text-ink-muted hover:border-ink/30 hover:text-ink-strong"
              >
                {showAll ? "Show fewer" : `+${formatNumber(positions.length - TOP_POSITIONS)} more`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
