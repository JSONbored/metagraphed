// Which artifacts exist for a non-default network (#8699).
//
// Side-effect free ON PURPOSE. This lives here rather than in
// scripts/build-network-registry.ts — the module that emits these files —
// because that script has a top-level await and runs the whole build on
// import. The Worker and the MCP server both need this list at runtime, so it
// has to be importable without executing anything.
//
// build-network-registry.ts imports it back, so the emitter and the capability
// matrix cannot disagree about what a non-mainnet network serves.
//
// WHY THIS EXISTS AT ALL: a route answers on testnet only when it is not
// mainnet-only AND its artifact is published for that network. Deriving
// availability from the mainnet-only predicate alone over-promises —
// /api/v1/testnet/surfaces, /profiles, /endpoints and /providers are all
// network-addressable yet 404, because nothing writes them. Verified against
// production 2026-07-30.
//
// Paths are in API_ROUTES' template form so they compare directly against a
// route's artifact_path.
export const NETWORK_PUBLISHED_ARTIFACT_PATHS: readonly string[] = [
  "/metagraph/subnets.json",
  "/metagraph/subnets/{netuid}.json",
  "/metagraph/coverage.json",
  "/metagraph/economics.json",
  // Not an emitted file: /api/v1/networks is computed live and answered before
  // any network gate, precisely so it never 404s. Listed here so the matrix
  // reports it as served — it is the one route guaranteed on every network.
  "/metagraph/networks.json",
];
