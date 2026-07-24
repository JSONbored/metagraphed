import { useQuery } from "@tanstack/react-query";
import {
  endpointIncidentsQuery,
  subnetHealthMapQuery,
  subnetHealthQuery,
  type SubnetHealthEntry,
} from "@/lib/metagraphed/queries";
import {
  resolveSubnetProbeHealth,
  worstActiveIncidentHealth,
} from "@/lib/metagraphed/subnet-probe-health";
import { useHydrated } from "@/hooks/use-hydrated";
import type { EndpointIncident, HealthState, HealthSummary } from "@/lib/metagraphed/types";

export interface SubnetProbeHealthSources {
  mapData?: { data?: Record<number, SubnetHealthEntry> };
  detailData?: { data?: HealthSummary };
  incidentsData?: { data?: EndpointIncident[] };
}

/**
 * Pure combine/gate step behind {@link useSubnetProbeHealth}, split out so it's
 * directly unit-testable (this suite has no RTL/jsdom, so hooks are tested via
 * their exported pure functions rather than `renderHook`).
 *
 * These are plain (non-suspense) queries, so their cache can already be
 * resolved by hydration time even though SSR committed "unknown" — stay
 * "unknown" until hydration completes so both passes agree.
 */
export function combineSubnetProbeHealth(
  netuid: number,
  hydrated: boolean,
  sources: SubnetProbeHealthSources,
): HealthState {
  if (!hydrated) return resolveSubnetProbeHealth({});
  const mapHealth = sources.mapData?.data?.[netuid]?.health;
  const summary = sources.detailData?.data;
  const incidentHealth = worstActiveIncidentHealth(sources.incidentsData?.data, netuid);
  return resolveSubnetProbeHealth({
    mapHealth,
    summary: summary
      ? {
          ok: summary.ok,
          warn: summary.warn,
          down: summary.down,
          unknown: summary.unknown,
        }
      : undefined,
    incidentHealth,
  });
}

/**
 * Canonical probe-derived health for one subnet (#5332). Shared by the subnet
 * masthead HealthPill. Backed by `/api/v1/health` (map) → per-subnet `/health`
 * count rollup → active endpoint-incidents for this netuid when the rollup is
 * still unknown. Never by profile/chain lifecycle `status`.
 */
export function useSubnetProbeHealth(netuid: number): HealthState {
  const mapQ = useQuery(subnetHealthMapQuery());
  const detailQ = useQuery(subnetHealthQuery(netuid));
  const incidentsQ = useQuery({ ...endpointIncidentsQuery(), retry: 0 });
  const hydrated = useHydrated();
  return combineSubnetProbeHealth(netuid, hydrated, {
    mapData: mapQ.data,
    detailData: detailQ.data,
    incidentsData: incidentsQ.data,
  });
}
