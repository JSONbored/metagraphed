import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkline, type SparklinePoint } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { accountHistoryQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { AccountDay } from "@/lib/metagraphed/types";

const DEFAULT_HISTORY_LIMIT = 180;

type Scope = "all" | number;

interface AccountHistorySeriesDay extends AccountDay {
  scoped_netuids: number[];
}

function formatDay(day: string, withYear = false): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

function eventCountLabel(count: number): string {
  return `${formatNumber(count)} event${count === 1 ? "" : "s"}`;
}

function kindListLabel(kinds: string[]): string {
  if (kinds.length === 0) return "unknown kinds";
  if (kinds.length <= 4) return kinds.join(", ");
  return `${kinds.slice(0, 4).join(", ")} +${kinds.length - 4} more`;
}

function blockRangeLabel(firstBlock?: number | null, lastBlock?: number | null): string | null {
  if (firstBlock == null && lastBlock == null) return null;
  if (firstBlock != null && lastBlock != null) {
    if (firstBlock === lastBlock) return `block #${formatNumber(firstBlock)}`;
    return `blocks #${formatNumber(firstBlock)}-${formatNumber(lastBlock)}`;
  }
  const block = firstBlock ?? lastBlock;
  return block != null ? `block #${formatNumber(block)}` : null;
}

function mergeKinds(target: string[], incoming: string[]) {
  const seen = new Set(target);
  for (const kind of incoming) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    target.push(kind);
  }
}

function aggregateAllSubnets(days: AccountDay[]): AccountHistorySeriesDay[] {
  const byDay = new Map<string, AccountHistorySeriesDay>();
  for (const day of days) {
    const existing = byDay.get(day.day);
    if (existing) {
      existing.event_count += day.event_count;
      mergeKinds(existing.event_kinds, day.event_kinds);
      if (day.first_block != null) {
        existing.first_block =
          existing.first_block == null
            ? day.first_block
            : Math.min(existing.first_block, day.first_block);
      }
      if (day.last_block != null) {
        existing.last_block =
          existing.last_block == null
            ? day.last_block
            : Math.max(existing.last_block, day.last_block);
      }
      if (day.netuid != null && !existing.scoped_netuids.includes(day.netuid)) {
        existing.scoped_netuids.push(day.netuid);
        existing.scoped_netuids.sort((a, b) => a - b);
      }
      continue;
    }
    byDay.set(day.day, {
      ...day,
      event_kinds: [...day.event_kinds],
      scoped_netuids: day.netuid != null ? [day.netuid] : [],
    });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function filterOneSubnet(days: AccountDay[], netuid: number): AccountHistorySeriesDay[] {
  return days
    .filter((day) => day.netuid === netuid)
    .map((day) => ({
      ...day,
      event_kinds: [...day.event_kinds],
      scoped_netuids: [netuid],
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function scopeLabel(day: AccountHistorySeriesDay, scope: Scope): string {
  if (scope !== "all") return `SN${scope}`;
  if (day.scoped_netuids.length === 0) return "unscoped";
  if (day.scoped_netuids.length === 1) return `SN${day.scoped_netuids[0]}`;
  return `${day.scoped_netuids.length} subnets`;
}

function hoverLabel(day: AccountHistorySeriesDay, scope: Scope): string {
  const parts = [
    formatDay(day.day, true),
    scopeLabel(day, scope),
    kindListLabel(day.event_kinds),
    blockRangeLabel(day.first_block, day.last_block),
  ].filter(Boolean);
  return parts.join(" · ");
}

export function AccountHistoryChart({ ss58 }: { ss58: string }) {
  const [scope, setScope] = useState<Scope>("all");
  const { data, isLoading, isError, error, refetch } = useQuery(
    accountHistoryQuery(ss58, { limit: DEFAULT_HISTORY_LIMIT }),
  );

  const days = useMemo(() => data?.data.days ?? [], [data?.data.days]);
  const availableNetuids = useMemo(() => {
    return [
      ...new Set(
        days.map((day) => day.netuid).filter((netuid): netuid is number => netuid != null),
      ),
    ].sort((a, b) => a - b);
  }, [days]);

  const scopedDays = useMemo(
    () => (scope === "all" ? aggregateAllSubnets(days) : filterOneSubnet(days, scope)),
    [days, scope],
  );

  const values = scopedDays.map((day) => day.event_count);
  const points = useMemo<SparklinePoint[]>(
    () => scopedDays.map((day) => ({ t: hoverLabel(day, scope), v: day.event_count })),
    [scopedDays, scope],
  );

  const totalEvents = scopedDays.reduce((sum, day) => sum + day.event_count, 0);
  const firstDay = scopedDays[0]?.day;
  const lastDay = scopedDays[scopedDays.length - 1]?.day;

  if (isLoading) {
    return <Skeleton className="h-56 w-full" />;
  }

  if (isError) {
    return (
      <ErrorState error={error} context="account history" onRetry={() => refetch()} />
    );
  }

  if (days.length === 0 || scopedDays.length === 0) {
    return (
      <EmptyState
        title="No daily hotkey activity yet"
        description="This rollup is keyed by hotkey activity only. A coldkey-only ss58 or an account without recent indexed hotkey events returns an empty history."
      />
    );
  }

  return (
    <div className="space-y-4">
      {availableNetuids.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            scope
          </span>
          <div className="inline-flex flex-wrap rounded-full border border-border/80 bg-card/80 p-1 shadow-[0_18px_50px_-44px_rgba(15,23,42,0.45)]">
            <button
              type="button"
              onClick={() => setScope("all")}
              className={classNames(
                "rounded-full px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors",
                scope === "all"
                  ? "bg-ink-strong text-paper shadow-[0_12px_30px_-24px_rgba(15,23,42,0.85)]"
                  : "text-ink-muted hover:text-ink-strong",
              )}
            >
              all subnets
            </button>
            {availableNetuids.map((netuid) => (
              <button
                key={netuid}
                type="button"
                onClick={() => setScope(netuid)}
                className={classNames(
                  "rounded-full px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors",
                  scope === netuid
                    ? "bg-ink-strong text-paper shadow-[0_12px_30px_-24px_rgba(15,23,42,0.85)]"
                    : "text-ink-muted hover:text-ink-strong",
                )}
              >
                SN{netuid}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[1.75rem] border border-border/80 bg-card/95 shadow-[0_32px_100px_-70px_rgba(15,23,42,0.55)]">
        <div className="grid gap-4 border-b border-border/70 px-5 py-5 md:grid-cols-3">
          <MetricBlock
            label="Total activity"
            value={eventCountLabel(totalEvents)}
            hint="indexed events"
          />
          <MetricBlock
            label="Active days"
            value={formatNumber(scopedDays.length)}
            hint="non-zero sessions"
          />
          <MetricBlock
            label="Tracked range"
            value={
              firstDay && lastDay ? `${formatDay(firstDay)} to ${formatDay(lastDay, true)}` : "—"
            }
            hint="UTC daily rollup"
          />
        </div>

        <div className="bg-[linear-gradient(180deg,rgba(45,212,191,0.08),rgba(45,212,191,0.02)_42%,transparent)] px-4 py-4 md:px-5 md:py-5">
          <div className="rounded-[1.4rem] border border-border/70 bg-paper/70 px-4 py-4 md:px-5 md:py-5">
            <Sparkline
              values={values}
              points={points}
              width={1040}
              height={132}
              ariaLabel="Daily account activity history"
              formatValue={eventCountLabel}
            />
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
              <span>
                {scope === "all" ? "aggregated across subnets" : `filtered to SN${scope}`}
              </span>
              <span>hover to inspect event kinds</span>
              <span>first-party chain events only</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricBlock({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </div>
      <div className="mt-2 font-display text-xl font-semibold tracking-[-0.02em] text-ink-strong">
        {value}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">
        {hint}
      </div>
    </div>
  );
}
