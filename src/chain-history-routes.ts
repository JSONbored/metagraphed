/**
 * Route templates answered from the chain-history lakehouse rather than from a
 * published artifact (#8700).
 *
 * The sibling of `src/live-chain-routes.ts`, and separate from it on purpose.
 * Both are "served on a network without publishing an artifact", which is what
 * the capability matrix needs to know — but they are served that way for
 * different reasons, and the difference decides what happens when a network is
 * added:
 *
 *   live-chain    reads chain STATE at request time. Works on any chain running
 *                 a compatible runtime, the moment an endpoint exists.
 *   chain-history reads DECODED history from that network's Iceberg namespace.
 *                 Works only where a decode lane has actually run.
 *
 * So a third network would get the live routes immediately and these only once
 * its lane is filling `chain_<network>`. Collapsing them into one list would
 * lose exactly that distinction and invite opening these before their data
 * exists — which #8700's own rule forbids, because a route returning `[]`
 * forever reads as broken rather than unsupported.
 *
 * DERIVED, NOT TRUSTED, the same as its sibling: this list is not the authority
 * on what the router does. `dispatchChainHistoryRoute` in workers/api.ts is,
 * and tests/chain-history-networks.test.ts holds the two together.
 */
export const CHAIN_HISTORY_ROUTE_PATHS: readonly string[] = [
  "/api/v1/blocks",
  "/api/v1/blocks/{ref}",
  "/api/v1/blocks/{ref}/chain-events",
  "/api/v1/blocks/{ref}/events",
  "/api/v1/blocks/{ref}/extrinsics",
  "/api/v1/chain-events",
  "/api/v1/chain-events/stats",
  "/api/v1/extrinsics",
  "/api/v1/extrinsics/{hash}",
];

export const CHAIN_HISTORY_ROUTE_SET: ReadonlySet<string> = new Set(
  CHAIN_HISTORY_ROUTE_PATHS,
);

/** Whether a route template is answered from decoded chain history. */
export function isChainHistoryRouteTemplate(path: string): boolean {
  return CHAIN_HISTORY_ROUTE_SET.has(path);
}
