/**
 * Route templates answered from a precomputed PROJECTION artifact (#9412).
 *
 * The third member of the family beside `src/live-chain-routes.ts` and
 * `src/chain-history-routes.ts`, and separate from both for the same reason
 * they are separate from each other: all three are "served on a network
 * without publishing a per-route artifact", which is what the capability
 * matrix needs to know, but what makes each one servable differs, and the
 * difference decides what happens when a network is added.
 *
 *   live-chain     reads chain STATE at request time. Works on any chain
 *                  running a compatible runtime, the moment an endpoint exists.
 *   chain-history  reads DECODED history from that network's Iceberg
 *                  namespace. Works once a decode lane has run.
 *   projection     reads a CARD a cron precomputed from that namespace. Works
 *                  once the decode lane has run AND the projection lane has
 *                  ticked over it -- a strictly later moment, which is why
 *                  these are not simply rows in the history list.
 *
 * DERIVED, NOT TRUSTED, like both siblings: this list is not the authority on
 * what the router does. `dispatchProjectionRoute` in workers/api.ts is, and
 * tests/projection-networks.test.ts holds the two together in both directions
 * -- a route here the router still gates would make the matrix promise a 404,
 * and a route the router serves that this omits would hide a working route.
 */
export const PROJECTION_ROUTE_PATHS: readonly string[] = [
  "/api/v1/blocks/summary",
  "/api/v1/chain/activity",
  "/api/v1/chain/alpha-volume",
  "/api/v1/chain/calls",
  "/api/v1/chain/deregistrations",
  "/api/v1/chain/fees",
  "/api/v1/chain/registrations",
  "/api/v1/chain/signers",
  "/api/v1/chain/stake-flow",
  "/api/v1/chain/stake-moves",
  "/api/v1/chain/stake-transfers",
  "/api/v1/chain/transfer-pairs",
  "/api/v1/chain/transfers",
];

export const PROJECTION_ROUTE_SET: ReadonlySet<string> = new Set(
  PROJECTION_ROUTE_PATHS,
);

/** Whether a route template is answered from a precomputed projection. */
export function isProjectionRouteTemplate(path: string): boolean {
  return PROJECTION_ROUTE_SET.has(path);
}
