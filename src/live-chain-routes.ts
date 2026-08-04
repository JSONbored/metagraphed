/**
 * Route templates answered from live chain storage rather than from an
 * artifact (#8700).
 *
 * WHY THIS LIST HAS TO EXIST. The capability matrix (#8699) decides whether a
 * route is served on a non-default network with:
 *
 *     not mainnet-only  AND  the artifact is published for that network
 *
 * That was a complete model while every non-mainnet route was artifact-backed.
 * It is not any more: these thirteen routes read `state_getStorage` (or the
 * EVM address-mapping precompile) at request time and publish no artifact at
 * all, so the artifact half of the test reports them unserved while the router
 * happily answers them 200. A matrix that under-reports is the same class of
 * defect as one that over-reports -- #8699 exists to make 404s predictable,
 * and a *false* 404 in the matrix sends an agent away from a route that works.
 *
 * So the condition becomes:
 *
 *     not mainnet-only  AND  (artifact published for the network  OR  live chain)
 *
 * DERIVED, NOT TRUSTED. This list is not the authority on what the router
 * does -- `dispatchLiveChainRoute` in workers/api.ts is. tests/
 * live-chain-routes.test.ts drives every API_ROUTES template through that
 * dispatcher and asserts the set it answers is exactly this list, in both
 * directions, so a route added to the dispatcher without being added here (or
 * the reverse) fails CI rather than silently skewing the matrix. That is the
 * same discipline MAINNET_ONLY_ROUTE_PATHS is held to, one layer down.
 */
export const LIVE_CHAIN_ROUTE_PATHS: readonly string[] = [
  "/api/v1/accounts/{ss58}/balance",
  "/api/v1/accounts/{ss58}/children",
  "/api/v1/accounts/{ss58}/parents",
  "/api/v1/accounts/{ss58}/root-claim",
  // #9399. Answers on every network -- it reads whichever chain the prefix selects,
  // like its per-subnet sibling below. Listing it is what makes the capability matrix
  // report it as served rather than as a route that exists and is not offered.
  "/api/v1/chain/burn",
  "/api/v1/crowdloans",
  "/api/v1/crowdloans/{crowdloan_id}",
  "/api/v1/evm/address/{h160}",
  "/api/v1/network/parameters",
  "/api/v1/network/randomness",
  "/api/v1/subnets/{netuid}/burn",
  "/api/v1/subnets/{netuid}/lease",
  "/api/v1/subnets/{netuid}/recycled",
  "/api/v1/sudo/key",
];

export const LIVE_CHAIN_ROUTE_SET: ReadonlySet<string> = new Set(
  LIVE_CHAIN_ROUTE_PATHS,
);

/** Whether a route template is answered from live chain state. */
export function isLiveChainRouteTemplate(path: string): boolean {
  return LIVE_CHAIN_ROUTE_SET.has(path);
}
