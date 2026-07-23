import { useMemo, useState } from "react";
import { CopyButton, ExternalLink } from "@jsonbored/ui-kit";
import { Chip } from "@/components/metagraphed/primitives";
import { CopyLinkButton } from "@/components/metagraphed/primitives/copy-link-button";
import { EndpointUptimeBar } from "./endpoint-uptime-bar";
import { EndpointChipCluster } from "./endpoint-chip-cluster";
import { Sparkline } from "@jsonbored/ui-kit";
import { useLatencyHistory, type LatencyPoint } from "@/hooks/use-latency-history";
import { classNames } from "@/lib/metagraphed/format";
import type { Endpoint, EndpointIncident, RpcPool } from "@/lib/metagraphed/types";

/**
 * Inline detail body rendered inside an expanded endpoint row.
 * Shows the full URL, region/provider chips, uptime bar, and a filterable
 * incident timeline built from /api/v1/endpoint-incidents. Latency trend is
 * seeded from server-provided probe_history when present and augmented with
 * the client-side latency-history collector so the trend keeps growing as
 * the user observes the endpoint over time.
 */
export function EndpointDetailDrawer({
  endpoint,
  incidents,
  poolsById,
}: {
  endpoint: Endpoint;
  incidents: EndpointIncident[];
  poolsById: ReadonlyMap<string, RpcPool>;
}) {
  const allRows = useMemo(
    () =>
      incidents
        .filter((i) => i.endpoint_id === endpoint.id)
        .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? ""))),
    [incidents, endpoint.id],
  );

  // Filter: state (down/warn/other), and pool membership (this endpoint's pool).
  const [stateFilter, setStateFilter] = useState<"all" | "down" | "warn" | "other">("all");
  const [poolOnly, setPoolOnly] = useState(false);
  const endpointPoolId = String(
    (endpoint as unknown as { pool_id?: string; pool?: string }).pool_id ??
      (endpoint as unknown as { pool_id?: string; pool?: string }).pool ??
      "",
  );

  const rows = useMemo(() => {
    let list = allRows;
    if (stateFilter !== "all") {
      list = list.filter((i) => {
        const s = String(i.state ?? "unknown");
        if (stateFilter === "other") return s !== "down" && s !== "warn";
        return s === stateFilter;
      });
    }
    if (poolOnly && endpointPoolId) {
      list = list.filter((i) => {
        const p = String(
          (i as Record<string, unknown>).pool_id ?? (i as Record<string, unknown>).pool ?? "",
        );
        return p === endpointPoolId;
      });
    }
    return list.slice(0, 12);
  }, [allRows, stateFilter, poolOnly, endpointPoolId]);

  // Build server-side samples (with timestamps when available).
  const serverSamples: LatencyPoint[] = useMemo(() => {
    const source = endpoint as Record<string, unknown>;
    const candidate = source.probe_history ?? source.latency_history ?? source.history;
    if (!Array.isArray(candidate)) return [];
    return candidate
      .map((entry, index) => {
        if (typeof entry === "number") return { t: Date.now() - (100 - index), v: entry };
        if (!entry || typeof entry !== "object") return null;
        const row = entry as Record<string, unknown>;
        const latency = typeof row.latency_ms === "number" ? row.latency_ms : undefined;
        if (latency == null || !Number.isFinite(latency)) return null;
        const atStr =
          typeof row.observed_at === "string"
            ? row.observed_at
            : typeof row.probed_at === "string"
              ? row.probed_at
              : typeof row.timestamp === "string"
                ? row.timestamp
                : null;
        const t = atStr ? Date.parse(atStr) : Date.now() - (100 - index);
        return { t: Number.isFinite(t) ? t : Date.now(), v: latency } as LatencyPoint;
      })
      .filter((p): p is LatencyPoint => p != null);
  }, [endpoint]);

  const series = useLatencyHistory(endpoint.id, serverSamples);
  const latencyValues = series.map((p) => p.v);

  const stateCounts = useMemo(() => {
    const counts = { down: 0, warn: 0, other: 0 } as Record<string, number>;
    for (const i of allRows) {
      const s = String(i.state ?? "unknown");
      if (s === "down") counts.down++;
      else if (s === "warn" || s === "degraded") counts.warn++;
      else counts.other++;
    }
    return counts;
  }, [allRows]);

  return (
    <div className="space-y-4 border-t border-border bg-surface/45 px-4 py-4 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="mg-label mb-1">Endpoint</div>
          <div className="flex items-center gap-1.5 min-w-0">
            {endpoint.url ? (
              <>
                <ExternalLink href={endpoint.url} className="truncate font-mono text-[12px]">
                  {endpoint.url}
                </ExternalLink>
                <CopyButton value={endpoint.url} label="URL" />
                <CopyLinkButton
                  hash={`endpoint-${endpoint.id}`}
                  tooltip="Copy deep link to this endpoint"
                  label="Copy deep link to endpoint"
                />
              </>
            ) : (
              <span className="font-mono text-[12px] text-ink-muted">no url</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <EndpointChipCluster endpoint={endpoint} poolsById={poolsById} />
            {endpoint.region ? <Chip tone="default">{endpoint.region}</Chip> : null}
            {endpoint.provider ? <Chip tone="default">{endpoint.provider}</Chip> : null}
          </div>
        </div>
        <div className="shrink-0">
          <div className="mg-label mb-1">Uptime 7d</div>
          <EndpointUptimeBar endpointId={endpoint.id} incidents={incidents} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,.75fr)]">
        <section aria-labelledby={`latency-${endpoint.id}`}>
          <div className="flex items-end justify-between gap-3">
            <div>
              <div id={`latency-${endpoint.id}`} className="mg-label">
                Latency trend
              </div>
              <p className="mt-1 text-[11px] text-ink-muted">
                Seeded from server probe history when published; augmented with client-observed
                samples as you monitor the endpoint.
              </p>
            </div>
            <span className="font-mono text-[11px] text-ink-strong">
              {endpoint.latency_ms != null ? `${endpoint.latency_ms}ms latest` : "No latest sample"}
            </span>
          </div>
          <div className="mt-3 border-y border-border py-3">
            {latencyValues.length > 1 ? (
              <Sparkline
                values={latencyValues}
                points={series.map((p) => ({ t: new Date(p.t).toLocaleString(), v: p.v }))}
                width={560}
                height={88}
                color="var(--accent)"
                fill={false}
                ariaLabel="Endpoint latency probe history"
                formatValue={(value) => `${Math.round(value)}ms`}
              />
            ) : (
              <div className="flex h-[88px] items-center justify-center border border-dashed border-border mg-type-micro text-ink-muted">
                Collecting latency samples — trend will grow as probes arrive
              </div>
            )}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {series
              .slice(-3)
              .reverse()
              .map((p, index) => (
                <div key={`${p.t}-${index}`} className="min-w-0 border-l border-border pl-2">
                  <div className="mg-label">{index === 0 ? "Latest" : `Prior ${index}`}</div>
                  <div className="mt-1 font-mono text-[11px] text-ink-strong">
                    {Math.round(p.v)}ms
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[9px] text-ink-muted">
                    {new Date(p.t).toLocaleString()}
                  </div>
                </div>
              ))}
          </div>
        </section>

        <section aria-labelledby={`incidents-${endpoint.id}`}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div id={`incidents-${endpoint.id}`} className="mg-label">
              Incident timeline
            </div>
            <span className="font-mono text-[10px] text-ink-muted tabular-nums">
              {allRows.length} total
            </span>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-1">
            {(
              [
                ["all", `All · ${allRows.length}`],
                ["down", `Down · ${stateCounts.down}`],
                ["warn", `Warn · ${stateCounts.warn}`],
                ["other", `Other · ${stateCounts.other}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setStateFilter(id)}
                aria-pressed={stateFilter === id}
                className={classNames(
                  "mg-focus-ring rounded border px-1.5 py-0.5 mg-type-micro",
                  stateFilter === id
                    ? "border-accent/50 bg-accent/10 text-accent-text"
                    : "border-border text-ink-muted hover:text-ink-strong",
                )}
              >
                {label}
              </button>
            ))}
            {endpointPoolId ? (
              <button
                type="button"
                onClick={() => setPoolOnly((v) => !v)}
                aria-pressed={poolOnly}
                className={classNames(
                  "mg-focus-ring ml-auto rounded border px-1.5 py-0.5 mg-type-micro",
                  poolOnly
                    ? "border-accent/50 bg-accent/10 text-accent-text"
                    : "border-border text-ink-muted hover:text-ink-strong",
                )}
                title={`Filter to this endpoint's pool (${endpointPoolId})`}
              >
                Pool only
              </button>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <div className="rounded border border-dashed border-border/70 px-3 py-2 text-[11px] text-ink-muted">
              {allRows.length === 0
                ? "No incidents recorded for this endpoint in the retained window."
                : "No incidents match the current filter."}
            </div>
          ) : (
            <ol className="space-y-1">
              {rows.map((inc) => {
                const affected = String(inc.endpoint_id ?? endpoint.id);
                return (
                  <li
                    key={inc.id}
                    id={`incident-${inc.id}`}
                    className="flex items-start gap-2 scroll-mt-32 rounded border border-border/60 bg-paper px-2 py-1.5 target:border-accent/60"
                  >
                    <span
                      className={
                        "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full " +
                        (String(inc.state) === "down"
                          ? "bg-health-down"
                          : String(inc.state) === "warn" || String(inc.state) === "degraded"
                            ? "bg-health-warn"
                            : "bg-ink-subtle")
                      }
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[11px] text-ink-strong">
                          {String(inc.state ?? "incident")}
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                            {inc.started_at ? new Date(inc.started_at).toLocaleString() : "—"}
                          </span>
                          <CopyLinkButton
                            hash={`incident-${inc.id}`}
                            tooltip="Copy link to this incident"
                            label="Copy link to incident"
                          />
                        </span>
                      </div>
                      {inc.message ? (
                        <div className="mt-0.5 truncate text-[11px] text-ink-muted">
                          {inc.message}
                        </div>
                      ) : null}
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-ink-subtle-text">
                        <a
                          href={`#endpoint-${affected}`}
                          className="mg-focus-ring hover:text-accent-text"
                        >
                          affected: {affected.slice(0, 12)}
                          {affected.length > 12 ? "…" : ""}
                        </a>
                        {inc.ended_at ? (
                          <span>· ended {new Date(inc.ended_at).toLocaleString()}</span>
                        ) : (
                          <span className="text-health-warn-text">· active</span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="mt-2 text-[10px] text-ink-subtle-text">
            Incident intervals come from /api/v1/endpoint-incidents. Latency series merges published
            probe samples with locally-observed samples — no synthetic values are generated.
          </p>
        </section>
      </div>
    </div>
  );
}
