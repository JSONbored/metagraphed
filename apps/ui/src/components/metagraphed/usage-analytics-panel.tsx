import { useSuspenseQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Server, ShieldCheck, Wrench } from "lucide-react";
import { TimeAgo } from "@jsonbored/ui-kit";
import { usageAnalyticsQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import type { UsageAnalytics, UsageRoute, UsageTool } from "@/lib/metagraphed/types";
import { EmptyState, StaleBanner } from "./states";

export const USAGE_WINDOWS = ["24h", "7d", "30d"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

// Success rate is derived from the pair (never from a stored success_rate) so a
// zeroed/partial row can't disagree with itself — `null` when there's no
// traffic to divide by, so the tile shows "—" instead of a fake 0%/100%.
function successRate(calls: number, ok: number): number | null {
  return calls > 0 ? ok / calls : null;
}

function UsageStat({
  eyebrow,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  eyebrow: string;
  value: string;
  hint?: string;
  icon: typeof Activity;
  tone?: "default" | "ok" | "warn";
}) {
  return (
    <div
      className={classNames(
        "rounded border bg-card px-3 py-2.5",
        tone === "ok" && "border-health-ok/30",
        tone === "warn" && "border-health-warn/30",
        tone === "default" && "border-border",
      )}
    >
      <div className="flex items-center gap-1.5 text-ink-muted">
        <Icon className="size-3" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-widest">{eyebrow}</span>
      </div>
      <div className="mt-1 font-mono text-lg font-semibold text-ink-strong">{value}</div>
      {hint ? <div className="font-mono text-[10px] text-ink-muted">{hint}</div> : null}
    </div>
  );
}

function WindowSelector({
  window,
  onChange,
}: {
  window: UsageWindow;
  onChange: (w: UsageWindow) => void;
}) {
  return (
    <div
      className="inline-flex rounded border border-border bg-card p-0.5"
      role="group"
      aria-label="Usage window"
    >
      {USAGE_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={window === w}
          onClick={() => onChange(w)}
          className={classNames(
            "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
            window === w ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

// One shared table for both the route and MCP-tool breakdowns — same columns
// (name, calls, success, errors), same success/error derivation — so the two
// sections stay visually and numerically consistent.
function CallTable<T extends UsageRoute | UsageTool>({
  caption,
  nameHeading,
  rows,
  nameOf,
  keyOf,
}: {
  caption: string;
  nameHeading: string;
  rows: T[];
  nameOf: (row: T) => string;
  keyOf: (row: T) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded border border-border bg-card">
      <table className="w-full min-w-[26rem] text-sm">
        <caption className="px-3 pt-2 text-left mg-label">{caption}</caption>
        <thead className="bg-surface/50 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2 text-left font-normal">{nameHeading}</th>
            <th className="px-3 py-2 text-right font-normal">Calls</th>
            <th className="px-3 py-2 text-right font-normal">Success</th>
            <th className="px-3 py-2 text-right font-normal">Errors</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const ok = successRate(row.calls, row.ok_calls);
            const warn = row.error_rate != null && row.error_rate > 0.05;
            return (
              <tr key={keyOf(row)} className="mg-row-hover">
                <td className="max-w-0 px-3 py-2 font-mono text-[12px] text-ink-strong">
                  <span className="block truncate" title={nameOf(row)}>
                    {nameOf(row)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatNumber(row.calls)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-muted">
                  {pct(ok)}
                </td>
                <td
                  className={classNames(
                    "px-3 py-2 text-right font-mono tabular-nums",
                    warn ? "text-health-warn" : "text-ink-muted",
                  )}
                >
                  {pct(row.error_rate)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function UsageAnalyticsPanel({
  window,
  onWindowChange,
}: {
  window: UsageWindow;
  onWindowChange: (w: UsageWindow) => void;
}) {
  const { data } = useSuspenseQuery(usageAnalyticsQuery(window));
  const usage = data.data as UsageAnalytics;
  const s = usage.summary;
  const hasTraffic = s.total_calls > 0;
  const stale = isStaleFreshness(data.meta?.generated_at);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-ink-muted">
          {usage.observed_at ? (
            <>
              Updated <TimeAgo at={usage.observed_at} />
            </>
          ) : (
            "Route + MCP-tool traffic, aggregated per day"
          )}
        </p>
        <WindowSelector window={window} onChange={onWindowChange} />
      </div>

      {stale ? <StaleBanner generatedAt={data.meta?.generated_at} /> : null}

      {!hasTraffic ? (
        <EmptyState
          title="No usage recorded in this window yet"
          description="Route and MCP-tool call counts populate here once product-usage instrumentation is live — until then this window has no traffic to show."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <UsageStat
              icon={Activity}
              eyebrow="Total calls"
              value={formatNumber(s.total_calls)}
              hint={window}
            />
            <UsageStat
              icon={ShieldCheck}
              eyebrow="Success"
              value={pct(successRate(s.total_calls, s.ok_calls))}
              hint={`${formatNumber(s.ok_calls)} ok`}
              tone={s.error_rate != null && s.error_rate > 0.05 ? "warn" : "ok"}
            />
            <UsageStat
              icon={AlertTriangle}
              eyebrow="Errors"
              value={pct(s.error_rate)}
              hint={`${formatNumber(s.error_calls)} failed`}
              tone={s.error_rate != null && s.error_rate > 0.05 ? "warn" : "default"}
            />
            <UsageStat
              icon={Server}
              eyebrow="REST routes"
              value={formatNumber(s.route_calls)}
              hint={`${usage.routes.length} distinct`}
            />
            <UsageStat
              icon={Wrench}
              eyebrow="MCP tools"
              value={formatNumber(s.mcp_calls)}
              hint={`${usage.tools.length} distinct`}
            />
          </div>

          <CallTable
            caption="By route"
            nameHeading="Route"
            rows={usage.routes}
            nameOf={(r) => r.route}
            keyOf={(r) => r.route}
          />
          <CallTable
            caption="By MCP tool"
            nameHeading="Tool"
            rows={usage.tools}
            nameOf={(t) => t.tool}
            keyOf={(t) => t.tool}
          />
        </>
      )}
    </div>
  );
}
