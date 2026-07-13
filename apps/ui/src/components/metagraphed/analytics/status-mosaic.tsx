import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { endpointsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { InfoTooltip } from "@jsonbored/ui-kit";
import { useTimeRange, RANGE_HOURS, RANGE_LABEL } from "./time-range-context";
import type { Endpoint, HealthState } from "@/lib/metagraphed/types";

const TONE: Record<string, string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  down: "bg-health-down",
  unknown: "bg-border",
};

/**
 * Dense status mosaic: one tile per probed endpoint, tinted by current
 * health state. Hover a tile to peek metadata; click to jump to the host
 * subnet. Useful as a single-glance "is anything red right now?" view.
 */
export function StatusMosaic({ className, limit = 240 }: { className?: string; limit?: number }) {
  const { range } = useTimeRange();
  const cutoff = Date.now() - RANGE_HOURS[range] * 3_600_000;
  const { data: res } = useSuspenseQuery(endpointsQuery({ limit }));
  const allEndpoints = (res.data ?? []) as Endpoint[];
  const endpoints = useMemo(
    () =>
      allEndpoints.filter((e) => {
        if (!e.last_probed_at) return true; // keep unprobed
        const t = Date.parse(e.last_probed_at);
        if (!Number.isFinite(t)) return true;
        return t >= cutoff;
      }),
    [allEndpoints, cutoff],
  );
  const [filter, setFilter] = useState<HealthState | "all">("all");

  const counts = useMemo(() => {
    const c: Record<string, number> = { ok: 0, warn: 0, down: 0, unknown: 0 };
    for (const e of endpoints) c[e.health ?? "unknown"] = (c[e.health ?? "unknown"] ?? 0) + 1;
    return c;
  }, [endpoints]);

  const rows =
    filter === "all" ? endpoints : endpoints.filter((e) => (e.health ?? "unknown") === filter);

  return (
    <div className={classNames("rounded-lg border border-border bg-card p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Status mosaic · {RANGE_LABEL[range]}
          </div>
          <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
            {rows.length} endpoint{rows.length === 1 ? "" : "s"}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {(["all", "ok", "warn", "down", "unknown"] as const).map((k) => {
            const active = filter === k;
            const n = k === "all" ? endpoints.length : (counts[k] ?? 0);
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={classNames(
                  "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                  active
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border text-ink-muted hover:text-ink-strong hover:border-ink-muted/50",
                )}
                aria-pressed={active}
              >
                {k !== "all" ? (
                  <span
                    className={classNames("inline-block size-1.5 rounded-sm", TONE[k])}
                    aria-hidden
                  />
                ) : null}
                {k} <span className="text-ink-muted/80 tabular-nums">{n}</span>
              </button>
            );
          })}
          <InfoTooltip label="One tile per monitored endpoint, colored by latest probe state. Click a tile to open the host subnet." />
        </div>
      </div>
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(14px, 1fr))" }}
        role="list"
      >
        {rows.map((e) => {
          const state = (e.health ?? "unknown") as HealthState;
          const tile = (
            <span
              className={classNames(
                "block aspect-square rounded-[2px] transition-transform hover:scale-110 hover:ring-1 hover:ring-accent/60",
                TONE[state] ?? TONE.unknown,
              )}
              title={`${e.kind ?? "endpoint"} · ${e.provider ?? e.provider_slug ?? "—"} · ${state}${
                e.latency_ms != null ? ` · ${e.latency_ms}ms` : ""
              }${e.netuid != null ? ` · SN${e.netuid}` : ""}`}
            />
          );
          return (
            <span key={e.id} role="listitem">
              {e.netuid != null ? (
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: e.netuid }}
                  className="block focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded-[2px]"
                >
                  {tile}
                </Link>
              ) : (
                tile
              )}
            </span>
          );
        })}
        {rows.length === 0 ? (
          <div className="col-span-full py-6 text-center font-mono text-[10px] text-ink-muted">
            No endpoints match this filter.
          </div>
        ) : null}
      </div>
    </div>
  );
}
