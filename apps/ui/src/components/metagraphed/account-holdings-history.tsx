import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Sparkline,
  StackedAreaMini,
  type StackedAreaSeries,
  RangeControl,
} from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { accountPortfolioQuery, accountPositionHistoryQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { AccountPositionHistory, PortfolioPosition } from "@/lib/metagraphed/types";
import { CHART_PALETTE } from "@/lib/metagraphed/chart-palette";

// The issue's 30d/90d/1y/max control, mapped onto the position-history API's
// own window enum ("all" is the API spelling of "max").
const WINDOWS = [
  { id: "30d", label: "30D" },
  { id: "90d", label: "90D" },
  { id: "1y", label: "1Y" },
  { id: "all", label: "Max" },
] as const;
type Win = (typeof WINDOWS)[number]["id"];

/** Stacked-area band cap — matches the design system's 6-color categorical
 * chart ramp exactly, and the first page of small multiples below. */
const TOP_POSITIONS = 6;

/**
 * How many MORE small multiples each "+N more" click reveals.
 *
 * This is a hard cap on query fan-out, not just a display choice: every
 * revealed position costs one `/accounts/{ss58}/subnets/{netuid}/history`
 * request via `useQueries`, so revealing an entire portfolio at once would
 * fire one request per position (a real validator coldkey here holds 119).
 * Paging in fixed batches keeps concurrency bounded and only ever grows by
 * explicit user action — the same incremental `visibleCount` treatment the
 * Positions tab's own table uses for its long tail.
 */
const POSITIONS_PAGE_SIZE = 6;

const CHART_COLORS = CHART_PALETTE;

function taoStr(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  return `${v.toFixed(v < 10 ? 3 : 2)} τ`;
}

/** A position's own stake, in the token that position is actually denominated
 * in: TAO on root, that subnet's alpha everywhere else (metagraphed#10514). */
function stakeStr(v: number | null | undefined, netuid: number): string {
  const rendered = taoStr(v);
  return netuid === 0 || rendered === "—" ? rendered : `${rendered.slice(0, -1)}α`;
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
  const [visibleCount, setVisibleCount] = useState(TOP_POSITIONS);

  const portfolioResult = useQuery(accountPortfolioQuery(ss58));
  const positions = useMemo<PortfolioPosition[]>(() => {
    const all = portfolioResult.data?.data?.positions ?? [];
    return [...all].sort((a, b) => (b.stake_alpha ?? 0) - (a.stake_alpha ?? 0));
  }, [portfolioResult.data?.data?.positions]);

  // Never the whole portfolio: `visibleCount` starts at one page and only
  // grows a page at a time, so the query count below stays bounded (see
  // POSITIONS_PAGE_SIZE).
  const visiblePositions = positions.slice(0, visibleCount);

  // One query per visible position, bounded by visibleCount. React Query
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
    <RangeControl
      label="Holdings history window"
      options={WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
      value={win}
      onChange={setWin}
    />
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
        <span className="text-13 text-ink-muted">
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
        <Panel bodyClassName="space-y-3">
          <div className="text-13 text-ink-muted">
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
              <li key={s.id} className="flex items-center gap-1.5 text-13 text-ink-muted">
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
          <div className="mb-2 text-13 text-ink-muted">Per-position history</div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visiblePositions.map((pos, i) => {
              const history = historyResults[i]?.data?.data;
              const values = (history?.points ?? [])
                .map((p) => p.stake_tao)
                .filter((v): v is number => v != null && Number.isFinite(v));
              const color = CHART_COLORS[i % CHART_COLORS.length]!;
              return (
                <div key={pos.netuid} className="rounded border border-border/80 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: pos.netuid }}
                      className="font-mono text-13 text-ink-strong hover:text-accent hover:underline"
                    >
                      SN{pos.netuid}
                    </Link>
                    <span className="font-display text-13 font-semibold tabular-nums text-ink-strong">
                      {stakeStr(pos.stake_alpha, pos.netuid)}
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
                      <span className="text-13 text-ink-muted">No history yet</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {positions.length > visibleCount || visibleCount > TOP_POSITIONS ? (
            <div className="mt-3 flex justify-center gap-2">
              {positions.length > visibleCount ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + POSITIONS_PAGE_SIZE)}
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-3.5 py-1.5 text-11 text-ink-muted hover:border-ink/30 hover:text-ink-strong"
                >
                  Show{" "}
                  {formatNumber(Math.min(POSITIONS_PAGE_SIZE, positions.length - visibleCount))}{" "}
                  more
                  <span className="text-ink-subtle-text">
                    ({formatNumber(positions.length - visibleCount)} left)
                  </span>
                </button>
              ) : null}
              {visibleCount > TOP_POSITIONS ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount(TOP_POSITIONS)}
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-3.5 py-1.5 text-11 text-ink-muted hover:border-ink/30 hover:text-ink-strong"
                >
                  Show fewer
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
