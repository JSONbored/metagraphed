import { ChevronDown } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo } from "react";
import { BrandIcon, CopyButton, ExternalLink, Sparkline, TimeAgo } from "@jsonbored/ui-kit";
import { EndpointDetailDrawer } from "./endpoint-detail-drawer";
import { EndpointUptimeBar } from "./endpoint-uptime-bar";
import { recordLatencyObservations } from "@/hooks/use-latency-history";
import { endpointEligibility, ELIGIBILITY_LABEL } from "@/lib/metagraphed/endpoint-pool";
import { classNames } from "@/lib/metagraphed/format";
import type {
  Endpoint,
  EndpointIncident,
  Provider,
  RpcPool,
  Subnet,
} from "@/lib/metagraphed/types";

interface EndpointOperationalListProps {
  rows: Endpoint[];
  incidents: EndpointIncident[];
  poolsById: ReadonlyMap<string, RpcPool>;
  providerById: ReadonlyMap<string, Provider>;
  subnetById: ReadonlyMap<number, Subnet>;
  expandedId: string | null;
  onToggle: (id: string) => void;
  compareIds?: ReadonlySet<string>;
  onToggleCompare?: (id: string) => void;
  compareMax?: number;
}

function latencySeries(endpoint: Endpoint): number[] {
  const source = endpoint as Record<string, unknown>;
  const candidate = source.probe_history ?? source.latency_history ?? source.history;
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map((entry) => {
      if (typeof entry === "number") return entry;
      if (entry && typeof entry === "object" && "latency_ms" in entry) {
        return (entry as { latency_ms?: unknown }).latency_ms;
      }
      return undefined;
    })
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .slice(-24);
}

function healthColor(health: Endpoint["health"]): string {
  if (health === "ok") return "var(--health-ok)";
  if (health === "warn") return "var(--health-warn)";
  if (health === "down") return "var(--health-down)";
  return "var(--health-unknown)";
}

function railClass(health: Endpoint["health"]): string {
  if (health === "ok") return "bg-health-ok";
  if (health === "warn") return "bg-health-warn";
  if (health === "down") return "bg-health-down";
  return "bg-ink-subtle/40";
}

function latencyTone(ms: number | null | undefined): string {
  if (ms == null) return "text-ink-muted";
  if (ms < 150) return "text-health-ok";
  if (ms < 400) return "text-ink-strong";
  if (ms < 900) return "text-health-warn-text";
  return "text-health-down";
}

type Group = { netuid: number | "root" | "unassigned"; label: string; rows: Endpoint[] };

function groupByNetuid(rows: Endpoint[], subnetById: ReadonlyMap<number, Subnet>): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    let key: string;
    let netuid: Group["netuid"];
    let label: string;
    if (r.netuid == null) {
      key = "unassigned";
      netuid = "unassigned";
      label = "Unassigned";
    } else if (r.netuid === 0) {
      key = "root";
      netuid = "root";
      label = "Root · Subtensor base layer";
    } else {
      key = String(r.netuid);
      netuid = r.netuid;
      const sn = subnetById.get(r.netuid);
      label = `SN${r.netuid}${sn?.name ? ` · ${sn.name}` : ""}`;
    }
    const g = map.get(key) ?? { netuid, label, rows: [] };
    g.rows.push(r);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => {
    const av = a.netuid === "root" ? -1 : a.netuid === "unassigned" ? 9999 : (a.netuid as number);
    const bv = b.netuid === "root" ? -1 : b.netuid === "unassigned" ? 9999 : (b.netuid as number);
    return av - bv;
  });
}

export function EndpointOperationalList({
  rows,
  incidents,
  poolsById,
  providerById,
  subnetById,
  expandedId,
  onToggle,
  compareIds,
  onToggleCompare,
  compareMax = 4,
}: EndpointOperationalListProps) {
  const groups = useMemo(() => groupByNetuid(rows, subnetById), [rows, subnetById]);

  // Snapshot current latency values into the client-side history collector so
  // sparklines gain a real multi-point trace even when the backend only ships
  // a single latest sample per endpoint.
  useEffect(() => {
    recordLatencyObservations(rows.map((r) => ({ id: r.id, latency_ms: r.latency_ms ?? null })));
  }, [rows]);

  return (
    <div role="list" aria-label="Endpoint directory" className="space-y-6">
      {groups.map((group) => {
        const okCount = group.rows.filter((r) => r.health === "ok").length;
        const warnCount = group.rows.filter((r) => r.health === "warn").length;
        const downCount = group.rows.filter((r) => r.health === "down").length;
        const sn = typeof group.netuid === "number" ? subnetById.get(group.netuid) : undefined;
        return (
          <section key={String(group.netuid)} aria-labelledby={`group-${group.netuid}`}>
            <header
              className="mg-section-rule sticky z-10 -mx-1 flex items-center justify-between gap-3 bg-paper/92 px-1 py-2 backdrop-blur"
              style={{ top: "calc(var(--mg-sticky-offset, 3.5rem) + 3.75rem)" }}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {typeof group.netuid === "number" ? (
                  <BrandIcon
                    url={sn?.website}
                    iconUrl={sn?.icon_url}
                    netuid={group.netuid}
                    name={sn?.name}
                    fallback={group.netuid}
                    size={20}
                  />
                ) : (
                  <span className="mg-live-dot" aria-hidden />
                )}
                <h3
                  id={`group-${group.netuid}`}
                  className="truncate font-display text-[13px] font-medium text-ink-strong"
                >
                  {group.label}
                </h3>
                {typeof group.netuid === "number" && group.netuid !== 0 ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: group.netuid }}
                    className="mg-focus-ring font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-accent-text"
                  >
                    Open subnet →
                  </Link>
                ) : null}
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {okCount ? <span className="text-health-ok">{okCount} live</span> : null}
                {warnCount ? <span className="text-health-warn-text">{warnCount} warn</span> : null}
                {downCount ? <span className="text-health-down">{downCount} down</span> : null}
                <span className="text-ink-subtle-text">·</span>
                <span>{group.rows.length} total</span>
              </div>
            </header>

            <div className="border-y border-border bg-card/40">
              {group.rows.map((endpoint, idx) => {
                const open = expandedId === endpoint.id;
                const providerSlug = endpoint.provider_slug;
                const provider = providerSlug ? providerById.get(providerSlug) : undefined;
                const series = latencySeries(endpoint);
                const eligibility = endpointEligibility(endpoint, poolsById);
                return (
                  <Fragment key={endpoint.id}>
                    <article
                      id={`endpoint-${endpoint.id}`}
                      role="listitem"
                      className={classNames(
                        "group relative scroll-mt-32 transition-colors",
                        idx > 0 && "border-t border-border",
                        open ? "bg-surface/70" : "hover:bg-surface/50",
                      )}
                    >
                      {/* Full-height health rail — the strongest visual signal per row. */}
                      <span
                        className={classNames(
                          "pointer-events-none absolute inset-y-0 left-0 w-[3px]",
                          railClass(endpoint.health),
                          open ? "opacity-100" : "opacity-70 group-hover:opacity-100",
                        )}
                        aria-hidden
                      />
                      {onToggleCompare ? (
                        <label
                          className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded border border-border bg-paper/85 px-1 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-muted backdrop-blur hover:text-ink-strong"
                          onClick={(e) => e.stopPropagation()}
                          title={
                            compareIds?.has(endpoint.id)
                              ? "Remove from comparison"
                              : (compareIds?.size ?? 0) >= compareMax
                                ? `Compare limit of ${compareMax} reached`
                                : "Add to comparison"
                          }
                        >
                          <input
                            type="checkbox"
                            checked={compareIds?.has(endpoint.id) ?? false}
                            disabled={
                              !compareIds?.has(endpoint.id) && (compareIds?.size ?? 0) >= compareMax
                            }
                            onChange={() => onToggleCompare(endpoint.id)}
                            className="mg-focus-ring size-3 accent-current"
                            aria-label={`Compare ${endpoint.url ?? endpoint.id}`}
                          />
                          <span className="hidden sm:inline">Compare</span>
                        </label>
                      ) : null}
                      {/* This row hosts nested interactive elements (the URL link,
                          its CopyButton) inside a click-to-expand surface. A
                          <button> may not contain another <button> or an <a>
                          per the HTML spec -- browsers silently un-nest it,
                          which desyncs SSR from the client and throws a
                          hydration mismatch. A div with button semantics
                          avoids the invalid nesting while keeping the same
                          keyboard/AT behavior. */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onToggle(endpoint.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onToggle(endpoint.id);
                          }
                        }}
                        aria-expanded={open}
                        aria-controls={`endpoint-detail-${endpoint.id}`}
                        className="mg-focus-ring block w-full cursor-pointer text-left"
                      >
                        <div
                          className={classNames(
                            "grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 pr-3 py-4 lg:grid-cols-[minmax(0,1fr)_11rem_11rem_auto] lg:items-center lg:pr-4",
                            onToggleCompare ? "pl-4 lg:pl-6 pt-8 lg:pt-4" : "pl-4 lg:pl-6",
                          )}
                        >
                          {/* Headline: kind chip + URL as h4 */}
                          <div className="min-w-0">
                            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                              <span className="text-ink-strong">{endpoint.kind ?? "endpoint"}</span>
                              <span className="text-ink-subtle-text" aria-hidden>
                                ·
                              </span>
                              <span>{endpoint.region ?? "global"}</span>
                              <span className="text-ink-subtle-text" aria-hidden>
                                ·
                              </span>
                              <span>{ELIGIBILITY_LABEL[eligibility]}</span>
                              {endpoint.archive ? (
                                <>
                                  <span className="text-ink-subtle-text" aria-hidden>
                                    ·
                                  </span>
                                  <span className="text-accent-text">Archive</span>
                                </>
                              ) : null}
                            </div>
                            <div
                              className="flex min-w-0 items-center gap-1.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {endpoint.url ? (
                                <>
                                  <ExternalLink
                                    href={endpoint.url}
                                    className="truncate font-mono text-[13px] font-medium text-ink-strong hover:text-accent-text"
                                  >
                                    {endpoint.url}
                                  </ExternalLink>
                                  <CopyButton value={endpoint.url} label="endpoint URL" />
                                </>
                              ) : (
                                <span className="font-mono text-[13px] text-ink-muted">
                                  URL unavailable
                                </span>
                              )}
                            </div>
                            {providerSlug ? (
                              <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                                <Link
                                  to="/providers/$slug"
                                  params={{ slug: providerSlug }}
                                  className="mg-focus-ring inline-flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink-strong"
                                >
                                  <BrandIcon
                                    url={provider?.website ?? provider?.homepage}
                                    iconUrl={provider?.icon_url}
                                    repoUrl={provider?.repo}
                                    providerSlug={providerSlug}
                                    name={provider?.name ?? endpoint.provider ?? providerSlug}
                                    fallback={providerSlug}
                                    size={14}
                                  />
                                  <span className="truncate">
                                    {endpoint.provider ?? provider?.name ?? providerSlug}
                                  </span>
                                </Link>
                              </div>
                            ) : endpoint.provider ? (
                              <div className="mt-1.5 text-[11px] text-ink-muted">
                                {endpoint.provider}
                              </div>
                            ) : null}
                          </div>

                          {/* Latency block: big number + sparkline underneath */}
                          <div className="min-w-0">
                            <div className="mg-label mb-0.5 lg:hidden">Latency</div>
                            <div className="flex items-baseline gap-1.5">
                              <span
                                className={classNames(
                                  "font-mono text-[20px] leading-none tabular-nums",
                                  latencyTone(endpoint.latency_ms),
                                )}
                              >
                                {endpoint.latency_ms != null
                                  ? Math.round(endpoint.latency_ms)
                                  : "—"}
                              </span>
                              {endpoint.latency_ms != null ? (
                                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                                  ms
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1.5 h-[18px]">
                              {series.length > 1 ? (
                                <Sparkline
                                  values={series}
                                  width={132}
                                  height={18}
                                  color={healthColor(endpoint.health)}
                                  fill={false}
                                  interactive={false}
                                  ariaLabel="Recent endpoint latency"
                                />
                              ) : (
                                <div className="h-full border-b border-dashed border-border/60" />
                              )}
                            </div>
                          </div>

                          {/* 7d uptime */}
                          <div className="min-w-0">
                            <div className="mg-label mb-1 lg:hidden">7d uptime</div>
                            <EndpointUptimeBar endpointId={endpoint.id} incidents={incidents} />
                            <div className="mt-1 font-mono text-[10px] text-ink-muted">
                              probed <TimeAgo at={endpoint.last_probed_at} />
                            </div>
                          </div>

                          <ChevronDown
                            className={classNames(
                              "hidden size-4 shrink-0 text-ink-muted transition-transform lg:block",
                              open && "rotate-180 text-accent-text",
                            )}
                            aria-hidden
                          />
                        </div>
                      </div>

                      {open ? (
                        <div id={`endpoint-detail-${endpoint.id}`} className="pl-4 lg:pl-6">
                          <EndpointDetailDrawer
                            endpoint={endpoint}
                            incidents={incidents}
                            poolsById={poolsById}
                          />
                        </div>
                      ) : null}
                    </article>
                  </Fragment>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
