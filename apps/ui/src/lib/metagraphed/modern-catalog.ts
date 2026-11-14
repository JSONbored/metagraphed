import { createV2ReadClient, type V2ReadClientOptions } from "../../../../../src/v2/client.ts";

/**
 * Scope selection for the v2 ("modern") read surface. The v2 API publishes
 * verified finney evidence only, so the catalog maps the UI's network
 * preference to that single supported chain and refuses everything else
 * before any read is constructed.
 */
export const MODERN_FINNEY_GENESIS =
  "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03";

export interface ModernCatalogScope {
  readonly origin: string;
  readonly network: string;
  readonly genesis: string;
}

export type ModernCatalogReader = ReturnType<typeof createV2ReadClient>;

export type ModernCatalogConfiguration =
  | { status: "ready"; scope: ModernCatalogScope }
  | { status: "unsupported-network" }
  | { status: "invalid-origin" };

/** The UI network ids the v2 surface serves, by their v2 network id. */
const SUPPORTED_NETWORKS: Record<string, { network: string; genesis: string }> = {
  mainnet: { network: "finney", genesis: MODERN_FINNEY_GENESIS },
};

/**
 * Map the hydrated API base and network preference onto a v2 read scope.
 * Origin validation is exactly the canonical client's: whatever it refuses
 * as a configuration never becomes a scope.
 */
export function modernCatalogConfiguration(
  origin: V2ReadClientOptions["origin"],
  networkId: string,
): ModernCatalogConfiguration {
  const supported = SUPPORTED_NETWORKS[networkId];
  if (!supported) return { status: "unsupported-network" };
  try {
    createV2ReadClient({ origin });
  } catch {
    return { status: "invalid-origin" };
  }
  return {
    status: "ready",
    scope: { origin, network: supported.network, genesis: supported.genesis },
  };
}

/** Cache-key prefix every modern read shares; restart invalidates the scope. */
export function modernCatalogKey(scope: ModernCatalogScope, restart: number) {
  return ["metagraphed", "v2", scope.origin, scope.network, scope.genesis, restart] as const;
}
