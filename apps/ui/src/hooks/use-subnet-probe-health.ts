import { useQuery } from "@tanstack/react-query";
import {
  endpointIncidentsQuery,
  subnetHealthMapQuery,
  subnetHealthQuery,
} from "@/lib/metagraphed/queries";
import {
  resolveSubnetProbeHealth,
  worstActiveIncidentHealth,
} from "@/lib/metagraphed/subnet-probe-health";
import { useHydrated } from "@/hooks/use-hydrated";
import type { EndpointIncident, HealthState } from "@/lib/metagraphed/types";

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
  // These are plain (non-suspense) queries, so their cache can already be
  // resolved by hydration time even though SSR committed "unknown" — stay
  // "unknown" until hydration completes so both passes agree.
  const hydrated = useHydrated();
  const mapHealth = hydrated ? mapQ.data?.data?.[netuid]?.health : undefined;
  const summary = hydrated ? detailQ.data?.data : undefined;
  const incidentHealth = hydrated
    ? worstActiveIncidentHealth(incidentsQ.data?.data as EndpointIncident[] | undefined, netuid)
    : undefined;
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
