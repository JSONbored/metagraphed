import { useMemo } from "react";
import { X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { BrandIcon, Sparkline, TimeAgo } from "@jsonbored/ui-kit";
import { Chip } from "@/components/metagraphed/primitives";
import { EndpointUptimeBar } from "./endpoint-uptime-bar";
import { EndpointChipCluster } from "./endpoint-chip-cluster";
import { useLatencyHistory } from "@/hooks/use-latency-history";
import { endpointEligibility, ELIGIBILITY_LABEL } from "@/lib/metagraphed/endpoint-pool";
import { classNames } from "@/lib/metagraphed/format";
import type {
  Endpoint,
  EndpointIncident,
  Provider,
  RpcPool,
  Subnet,
} from "@/lib/metagraphed/types";

/**
 * Side-by-side comparison of 2-4 endpoints. Renders as a hairline card above
 * the operational list when the URL carries a non-empty `?compare=` set. Each
 * column exposes health, freshness, incident count, eligibility, and a
 * multi-point latency trend from the client-side history collector.
 */
export function EndpointComparePanel({
  endpoints,
  incidents,
  poolsById,
  providerById,
  subnetById,
  onRemove,
  onClear,
}: {
  endpoints: Endpoint[];
  incidents: EndpointIncident[];
  poolsById: ReadonlyMap<string, RpcPool>;
  providerById: ReadonlyMap<string, Provider>;
  subnetById: ReadonlyMap<number, Subnet>;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (endpoints.length === 0) return null;
  return (
    <section
      aria-label="Endpoint comparison"
      className="rounded border border-accent/40 bg-surface/60"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-display text-[12px] font-medium text-ink-strong">
            Compare — {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}
          </span>
          <span className="mg-type-micro text-ink-muted">side-by-side</span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="mg-focus-ring rounded px-1.5 py-0.5 mg-type-micro text-ink-muted hover:text-ink-strong"
        >
          Clear all
        </button>
      </header>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-full divide-x divide-border"
          style={{ gridTemplateColumns: `repeat(${endpoints.length}, minmax(240px, 1fr))` }}
        >
          {endpoints.map((endpoint) => (
            <CompareColumn
              key={endpoint.id}
              endpoint={endpoint}
              incidents={incidents}
              poolsById={poolsById}
              providerById={providerById}
              subnetById={subnetById}
              onRemove={() => onRemove(endpoint.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function healthLabel(h: Endpoint["health"]): string {
  return h ?? "unknown";
}
function healthColor(h: Endpoint["health"]): string {
  if (h === "ok") return "var(--health-ok)";
  if (h === "warn") return "var(--health-warn)";
  if (h === "down") return "var(--health-down)";
  return "var(--health-unknown)";
}

function CompareColumn({
  endpoint,
  incidents,
  poolsById,
  providerById,
  subnetById,
  onRemove,
}: {
  endpoint: Endpoint;
  incidents: EndpointIncident[];
  poolsById: ReadonlyMap<string, RpcPool>;
  providerById: ReadonlyMap<string, Provider>;
  subnetById: ReadonlyMap<number, Subnet>;
  onRemove: () => void;
}) {
  const series = useLatencyHistory(endpoint.id);
  const values = series.map((p) => p.v);
  const eligibility = endpointEligibility(endpoint, poolsById);
  const provider = endpoint.provider_slug ? providerById.get(endpoint.provider_slug) : undefined;
  const subnet = endpoint.netuid != null ? subnetById.get(endpoint.netuid) : undefined;
  const incidentCount = useMemo(
    () => incidents.filter((i) => i.endpoint_id === endpoint.id).length,
    [incidents, endpoint.id],
  );

  return (
    <div className="min-w-0 space-y-3 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mg-label mb-1">
            {endpoint.netuid === 0
              ? "Root"
              : endpoint.netuid != null
                ? `SN${endpoint.netuid}${subnet?.name ? ` · ${subnet.name}` : ""}`
                : "Unassigned"}
          </div>
          <div className="truncate font-mono text-[12px] font-medium text-ink-strong">
            {endpoint.url ?? endpoint.id}
          </div>
          {endpoint.provider_slug ? (
            <Link
              to="/providers/$slug"
              params={{ slug: endpoint.provider_slug }}
              className="mg-focus-ring mt-1 inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink-strong"
            >
              <BrandIcon
                url={provider?.website ?? provider?.homepage}
                iconUrl={provider?.icon_url}
                providerSlug={endpoint.provider_slug}
                name={provider?.name ?? endpoint.provider ?? endpoint.provider_slug}
                fallback={endpoint.provider_slug}
                size={12}
              />
              <span className="truncate">
                {endpoint.provider ?? provider?.name ?? endpoint.provider_slug}
              </span>
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove from comparison"
          className="mg-focus-ring rounded p-1 text-ink-muted hover:text-ink-strong"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Health">
          <span
            className={classNames(
              "inline-flex items-center gap-1 font-mono text-[11px] uppercase",
              endpoint.health === "ok"
                ? "text-health-ok"
                : endpoint.health === "warn"
                  ? "text-health-warn-text"
                  : endpoint.health === "down"
                    ? "text-health-down"
                    : "text-ink-muted",
            )}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ background: healthColor(endpoint.health) }}
              aria-hidden
            />
            {healthLabel(endpoint.health)}
          </span>
        </Field>
        <Field label="Latency">
          <span className="font-mono text-[11px] tabular-nums text-ink-strong">
            {endpoint.latency_ms != null ? `${Math.round(endpoint.latency_ms)}ms` : "—"}
          </span>
        </Field>
        <Field label="Access">
          <span className="mg-type-micro text-ink-muted">{ELIGIBILITY_LABEL[eligibility]}</span>
        </Field>
        <Field label="Incidents (retained)">
          <span
            className={classNames(
              "font-mono text-[11px] tabular-nums",
              incidentCount > 0 ? "text-health-warn-text" : "text-ink-strong",
            )}
          >
            {incidentCount}
          </span>
        </Field>
        <Field label="Freshness">
          <span className="font-mono text-[10px] text-ink-muted">
            probed <TimeAgo at={endpoint.last_probed_at} />
          </span>
        </Field>
        <Field label="Region · Kind">
          <span className="mg-type-micro text-ink-muted">
            {endpoint.region ?? "global"} · {endpoint.kind ?? "endpoint"}
          </span>
        </Field>
      </dl>

      <div>
        <div className="mg-label mb-1">Latency trend (observed)</div>
        <div className="h-[36px] border-y border-border">
          {values.length > 1 ? (
            <Sparkline
              values={values}
              points={series.map((p) => ({ t: new Date(p.t).toLocaleTimeString(), v: p.v }))}
              width={240}
              height={36}
              color={healthColor(endpoint.health)}
              fill={false}
              ariaLabel={`Latency trend for ${endpoint.url ?? endpoint.id}`}
              formatValue={(v) => `${Math.round(v)}ms`}
            />
          ) : (
            <div className="flex h-full items-center justify-center mg-type-micro text-ink-muted">
              Collecting samples…
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <EndpointChipCluster endpoint={endpoint} poolsById={poolsById} />
        {endpoint.archive ? <Chip tone="accent">Archive</Chip> : null}
      </div>

      <div>
        <div className="mg-label mb-1">7d uptime</div>
        <EndpointUptimeBar endpointId={endpoint.id} incidents={incidents} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mg-label">{label}</dt>
      <dd className="mt-0.5 min-w-0 truncate">{children}</dd>
    </div>
  );
}
