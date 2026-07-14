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
  const mapHealth = mapQ.data?.data?.[netuid]?.health;
  const summary = detailQ.data?.data;
  const incidentHealth = worstActiveIncidentHealth(
    incidentsQ.data?.data as EndpointIncident[] | undefined,
    netuid,
  );
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
