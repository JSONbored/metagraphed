import { Link } from "@tanstack/react-router";
import {
  BrandIcon,
  CopyButton,
  ExternalLink,
  HealthPill,
  SparkLegend,
  TimeAgo,
} from "@jsonbored/ui-kit";

import { resolveEndpointCard } from "@/components/metagraphed/endpoint-card-fields";
import type { Endpoint, Provider, Subnet } from "@/lib/metagraphed/types";

export interface EndpointCardListProps {
  rows: Endpoint[];
  providerById: Map<string, Provider>;
  subnetById: Map<number, Subnet>;
  /** Freshness label passed through to each card's probe tooltips. */
  windowLabel: string;
  /** Layout classes for the wrapper — e.g. a responsive grid, or `md:hidden`
   *  when the list is only a mobile fallback for the desktop table. */
  className?: string;
}

/**
 * Renders endpoint rows as cards. Used both by the /endpoints grid view and as
 * the mobile fallback for the table view, whose eight columns are unreadable on
 * narrow viewports (see #3931).
 */
export function EndpointCardList({
  rows,
  providerById,
  subnetById,
  windowLabel,
  className,
}: EndpointCardListProps) {
  return (
    <div className={className}>
      {rows.map((e) => {
        const { provSlug, prov, sn, netuidLabel, kindLabel } = resolveEndpointCard(
          e,
          providerById,
          subnetById,
        );
        return (
          <div key={e.id} className="min-w-0 rounded border border-border bg-card p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {kindLabel}
              </span>
              <SparkLegend
                metric="Endpoint health"
                source="/api/v1/endpoints"
                windowLabel={windowLabel}
                updatedAt={e.last_probed_at}
                staleness="Falls back to last known state when the probe hasn't completed."
              >
                <HealthPill state={e.health} />
              </SparkLegend>
            </div>
            <div className="font-mono text-[11px] min-w-0">
              {e.url ? (
                <div className="flex items-center gap-1.5 min-w-0">
                  <ExternalLink href={e.url} className="min-w-0 text-[11px]">
                    {e.url}
                  </ExternalLink>
                  <CopyButton value={e.url} label="URL" compact />
                </div>
              ) : (
                "—"
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
              {e.netuid != null ? (
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: e.netuid }}
                  className="inline-flex items-center gap-1.5 font-mono hover:text-ink-strong"
                >
                  <BrandIcon
                    url={sn?.website}
                    iconUrl={sn?.icon_url}
                    netuid={e.netuid}
                    name={sn?.name}
                    fallback={e.netuid}
                    size={14}
                  />
                  sn{netuidLabel}
                </Link>
              ) : null}
              {provSlug ? (
                <Link
                  to="/providers/$slug"
                  params={{ slug: provSlug }}
                  className="inline-flex items-center gap-1.5 truncate max-w-[20ch] hover:underline"
                >
                  <BrandIcon
                    url={prov?.website ?? prov?.homepage}
                    iconUrl={prov?.icon_url}
                    repoUrl={prov?.repo}
                    providerSlug={provSlug}
                    name={prov?.name ?? e.provider ?? provSlug}
                    fallback={provSlug}
                    size={14}
                  />
                  <span className="truncate">{e.provider ?? prov?.name ?? provSlug}</span>
                </Link>
              ) : e.provider ? (
                <span className="truncate max-w-[18ch]">{e.provider}</span>
              ) : null}
              {e.region ? <span className="font-mono">{e.region}</span> : null}
              {e.latency_ms != null ? (
                <SparkLegend
                  metric="Latency"
                  source="/api/v1/endpoints (last probe)"
                  windowLabel={windowLabel}
                  updatedAt={e.last_probed_at}
                  staleness="No new measurement is taken between probes — last measured value is shown."
                >
                  <span className="font-mono ml-auto">{e.latency_ms}ms</span>
                </SparkLegend>
              ) : null}
            </div>
            <SparkLegend
              metric="Last probe"
              source="/api/v1/endpoints"
              windowLabel={windowLabel}
              updatedAt={e.last_probed_at}
              staleness="Rows older than the probe cycle are dimmed in tooltips elsewhere."
            >
              <span className="font-mono text-[10px] text-ink-muted">
                probed <TimeAgo at={e.last_probed_at} />
              </span>
            </SparkLegend>
          </div>
        );
      })}
    </div>
  );
}
