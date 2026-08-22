import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LineWithWindow, RangeControl } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { toLinePoints } from "@/components/metagraphed/metric-history";
import { accountHistoryQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { AccountDay } from "@/lib/metagraphed/types";

const DEFAULT_HISTORY_LIMIT = 180;

type Scope = "all" | number;

interface AccountHistorySeriesDay extends AccountDay {
  scoped_netuids: number[];
}

function formatDay(day: string, withYear = false): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

function eventCountLabel(count: number): string {
  return `${formatNumber(count)} event${count === 1 ? "" : "s"}`;
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

  const points = useMemo(
    () =>
      toLinePoints(
        scopedDays,
        (day) => day.day,
        (day) => day.event_count,
      ),
    [scopedDays],
  );

  const totalEvents = scopedDays.reduce((sum, day) => sum + day.event_count, 0);
  const firstDay = scopedDays[0]?.day;
  const lastDay = scopedDays[scopedDays.length - 1]?.day;

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="account history" />;
  }

  if (days.length === 0 || scopedDays.length === 0 || points.length === 0) {
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
        <RangeControl
          label="Activity scope"
          options={[
            { value: "all", label: "All subnets" },
            ...availableNetuids.map((netuid) => ({ value: String(netuid), label: `SN${netuid}` })),
          ]}
          value={scope === "all" ? "all" : String(scope)}
          onChange={(next) => setScope(next === "all" ? "all" : Number(next))}
        />
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
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

      <LineWithWindow
        points={points}
        window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
        unit="events per day"
        formatValue={eventCountLabel}
        ariaLabel="Daily account activity history"
        source={`account-${ss58}-activity`}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-11 text-ink-muted">
        <span>{scope === "all" ? "aggregated across subnets" : `filtered to SN${scope}`}</span>
        <span>first-party chain events only</span>
      </div>
    </div>
  );
}

function MetricBlock({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="text-13 text-ink-muted">{label}</div>
      <div className="mt-2 font-display text-28 font-semibold text-ink-strong">{value}</div>
      <div className="mt-1 text-13 text-ink-muted">{hint}</div>
    </div>
  );
}
