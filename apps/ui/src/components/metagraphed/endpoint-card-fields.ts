import type { Endpoint, Provider, Subnet } from "@/lib/metagraphed/types";

/** The subset of display fields a single endpoint card derives from a row plus
 *  the provider/subnet lookup maps. Kept pure (no JSX) so every branch is
 *  unit-testable apart from the DOM. */
export interface EndpointCardFields {
  provSlug?: string;
  prov?: Provider;
  sn?: Subnet;
  /** Zero-padded netuid label (e.g. "021"), or null when the row has no netuid. */
  netuidLabel: string | null;
  /** Endpoint kind, falling back to a generic label when unspecified. */
  kindLabel: string;
}

/**
 * Resolve the derived fields a card needs from an endpoint row and the
 * provider/subnet lookup maps. Pure so the missing-netuid, missing-provider and
 * missing-kind branches are exercised by unit tests without rendering.
 */
export function resolveEndpointCard(
  e: Endpoint,
  providerById: Map<string, Provider>,
  subnetById: Map<number, Subnet>,
): EndpointCardFields {
  const provSlug = e.provider_slug;
  const prov = provSlug ? providerById.get(provSlug) : undefined;
  const sn = e.netuid != null ? subnetById.get(e.netuid) : undefined;
  return {
    provSlug,
    prov,
    sn,
    netuidLabel: e.netuid != null ? String(e.netuid).padStart(3, "0") : null,
    kindLabel: e.kind ?? "endpoint",
  };
}
